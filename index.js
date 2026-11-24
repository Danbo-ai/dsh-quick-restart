/**
 * dsh-quick-restart host half.
 *
 * The shell has no restart IPC: Electron's main process exposes no quit or
 * relaunch channel to plugins (`DESKTOP_IPC` in its `lib/main.js` carries
 * neither), and a host process that exits on its own is reported as a crash by
 * the parent. So the only honest way to offer one button is to hand the job to
 * a detached script that survives the teardown:
 *
 *   kill the Electron main process → wait for its descendants to leave →
 *   Start-Process the same executable again.
 *
 * Killing only the main pid is deliberate. Its children (desktop host, gpu,
 * renderers) drop their pipe and exit gracefully, which is what flushes the
 * session log; a tree kill would cut that short. See `lib/script.js` for the
 * script itself.
 *
 * Two routes live on this module:
 *   GET  /plugins/dsh-quick-restart/status   capability report for the button
 *   POST /plugins/dsh-quick-restart/restart  arm the detached restart script
 * @module dsh-quick-restart
 */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { quotePowerShell, scriptBody, scriptPath } from './lib/script.js';

export const name = 'quick-restart';
// Nothing to inject: every service is read lazily through `ctx.get`, so the
// plugin still mounts when the web server binds after it.
export const inject = [];

const BASE_PATH = '/plugins/dsh-quick-restart';
const STATUS_PATH = `${BASE_PATH}/status`;
const RESTART_PATH = `${BASE_PATH}/restart`;

/** Candidate service keys for the web server, newest first. */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'];

/**
 * Markers only the desktop shell's host process carries.
 *
 * Both modes run `DeepSeek Harness.exe --expose-internals <...>@deepseek-ai/
 * dsh-desktop-host/lib/<entry>.js` — `dsh web` goes through `lib/cli.js`, the
 * desktop shell's host through `lib/index.js`. So the executable path, the
 * `--expose-internals` flag and the package name all match in both modes; the
 * entry script is the part that differs.
 */
const DESKTOP_HOST_PACKAGE = 'dsh-desktop-host';
const DESKTOP_HOST_ENTRY = `${DESKTOP_HOST_PACKAGE}/lib/index.js`;

/** A second click inside this window reports the armed restart instead of arming again. */
const COOLDOWN_MS = 15_000;

/**
 * Cross-request memory. Only used to answer "did my click land" and to keep a
 * double click from writing a second script; nothing is persisted, because a
 * restart clears this module anyway.
 */
const state = {
  restartingAt: 0,
  lastAt: 0,
  lastError: '',
};

/**
 * Whether this host was started by the Electron desktop shell.
 * @param {readonly string[]} [argv]
 */
function isDesktopHost(argv = process.argv) {
  return argv.some((arg) => {
    if (typeof arg !== 'string') return false;
    return arg.replace(/\\/g, '/').includes(DESKTOP_HOST_ENTRY);
  });
}

/**
 * Who to restart, discovered from the running process — never from config.
 *
 * A config file would go stale the moment the shell moves or the user launches
 * a second build; `process.ppid` / `process.execPath` are true by construction.
 * @returns `{ ok: true, pid, exe }` or `{ ok: false, reason }`.
 */
function resolveTarget() {
  if (process.platform !== 'win32') {
    return { ok: false, reason: 'restart is only implemented for the Windows desktop shell' };
  }
  const pid = process.ppid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 4) {
    return { ok: false, reason: 'cannot resolve the desktop main process pid' };
  }
  const exe = process.execPath;
  if (typeof exe !== 'string' || exe === '' || !existsSync(exe)) {
    return { ok: false, reason: 'cannot resolve the desktop executable path' };
  }
  if (!isDesktopHost()) {
    return { ok: false, reason: 'not running inside the desktop shell (plain `dsh web` has no window to relaunch)' };
  }
  return { ok: true, pid, exe };
}

/**
 * Write the script and hand it to a launcher that can outlive us.
 *
 * Spawning the script directly with `detached: true` does not work here: the
 * combination `CREATE_NO_WINDOW` (from `windowsHide`) + `CREATE_NEW_PROCESS_GROUP`
 * (from `detached`) leaves PowerShell without a console, and it exits 0 within
 * ~130 ms without running a single line — measured, not assumed. Going through
 * `Start-Process` gives the script its own process, so killing the shell that
 * spawned it cannot take the restart down with it.
 * @returns the script path that was started.
 */
/**
 * Environment for the restart chain.
 *
 * The host runs as a Node runtime inside Electron's own binary, so this process
 * carries `ELECTRON_RUN_AS_NODE=1`. Children inherit it, and a window started
 * with it in the environment comes up as a bare Node process — it exits at once,
 * so the app closes and never comes back (measured in the field, 2026-11-23).
 * Stripping it here also covers the script that `Start-Process` spawns; the
 * generated script drops it again right before the relaunch.
 */
function cleanEnv(env = process.env) {
  const next = { ...env };
  delete next.ELECTRON_RUN_AS_NODE;
  delete next.ELECTRON_NO_ATTACH_CONSOLE;
  return next;
}

function armRestart(target) {
  const file = scriptPath();
  writeFileSync(file, scriptBody(target), 'utf8');
  const argumentList = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    file,
  ]
    .map((arg) => quotePowerShell(arg))
    .join(',');
  const launcher = `Start-Process -FilePath 'powershell.exe' -ArgumentList @(${argumentList}) -WindowStyle Hidden`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', launcher], {
    cwd: tmpdir(),
    // The host is a Node runtime inside Electron's binary, so this process
    // carries ELECTRON_RUN_AS_NODE=1. Anything spawned from it inherits that,
    // and a window started with it comes up as a bare Node process that exits
    // immediately — the app closes and never returns. The restart chain starts
    // from a clean environment instead.
    env: cleanEnv(),
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => {
    /* reported by the caller through the script path and the log */
  });
  child.unref();
  return file;
}

function writeJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function deny(res, status, error) {
  writeJson(res, status, { ok: false, error });
}

/**
 * Register both routes once the web server and the connection fence are bound.
 * Both may bind after this plugin under concurrent activation, so we try at
 * mount, through `ctx.inject`, and again on each service binding.
 * @returns a disposer for the registration.
 */
function registerRoutes(ctx) {
  const registry = { registered: false, disposers: [] };

  const read = (key) => {
    try {
      return ctx.get(key);
    } catch {
      return undefined;
    }
  };

  /**
   * Same fence the host uses for its own routes: an unauthenticated or
   * non-loopback request never reaches the restart path.
   */
  const fence = (req, res) => {
    const gate = read('connection');
    if (gate === undefined) {
      deny(res, 503, 'authentication unavailable');
      return false;
    }
    const rejection = gate.requestRejection(req);
    if (rejection !== undefined) {
      deny(res, rejection, rejection === 503 ? 'authentication unavailable' : 'unauthorized');
      return false;
    }
    return true;
  };

  const statusHandler = (req, res) => {
    if (!fence(req, res)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    const target = resolveTarget();
    writeJson(res, 200, {
      supported: target.ok,
      ...(target.ok ? { pid: target.pid, exe: target.exe } : { reason: target.reason }),
      restartingAt: state.restartingAt === 0 ? null : new Date(state.restartingAt).toISOString(),
      lastAt: state.lastAt === 0 ? null : new Date(state.lastAt).toISOString(),
      lastError: state.lastError === '' ? null : state.lastError,
    });
  };

  const restartHandler = (req, res) => {
    if (!fence(req, res)) return;
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    const target = resolveTarget();
    if (!target.ok) {
      deny(res, 409, target.reason);
      return;
    }
    const now = Date.now();
    if (now - state.restartingAt < COOLDOWN_MS) {
      // The first click already armed a script; a second one must not arm
      // another (two scripts would race on the single-instance lock).
      writeJson(res, 202, {
        ok: true,
        already: true,
        pid: target.pid,
        armedAt: new Date(state.restartingAt).toISOString(),
      });
      return;
    }
    try {
      const file = armRestart(target);
      state.restartingAt = now;
      state.lastAt = now;
      state.lastError = '';
      ctx.logger?.info?.(`quick-restart: armed for pid ${target.pid} (${file})`);
      writeJson(res, 200, {
        ok: true,
        pid: target.pid,
        exe: target.exe,
        script: file,
        armedAt: new Date(now).toISOString(),
      });
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      ctx.logger?.warn?.(`quick-restart: cannot arm the restart script: ${state.lastError}`);
      deny(res, 500, `cannot arm the restart script: ${state.lastError}`);
    }
  };

  const attempt = () => {
    if (registry.registered) return;
    const server = read(WEB_SERVER_KEYS[0]) ?? read(WEB_SERVER_KEYS[1]);
    if (server === undefined || typeof server.register !== 'function') return;
    try {
      registry.disposers = [
        server.register({ kind: 'exact', path: STATUS_PATH, handler: statusHandler }),
        server.register({ kind: 'exact', path: RESTART_PATH, handler: restartHandler }),
      ];
      registry.registered = true;
    } catch {
      registry.registered = false;
    }
  };

  attempt();
  try {
    ctx.inject?.(['webServer'], () => attempt());
  } catch {
    /* injection is a best-effort retry path */
  }
  ctx.on?.('internal/service', () => {
    attempt();
  });

  return () => {
    for (const dispose of registry.disposers) dispose?.();
    registry.disposers = [];
    registry.registered = false;
  };
}

export function apply(ctx) {
  ctx.effect(() => registerRoutes(ctx), 'quick-restart: routes');
  const target = resolveTarget();
  ctx.logger?.info?.(
    target.ok
      ? `quick-restart: ready (target pid ${target.pid}, ${target.exe})`
      : `quick-restart: unavailable — ${target.reason}`,
  );
}

export { RESTART_PATH, STATUS_PATH };
