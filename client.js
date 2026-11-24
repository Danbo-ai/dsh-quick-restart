/**
 * dsh-quick-restart browser half.
 *
 * One surface: a footer action at the bottom of the left sidebar, stacked just
 * above the Settings control (`sidebar.footer.action`, a root list slot the
 * sidebar shell renders inside `.footerActions`).
 *
 * Two deliberate choices, both measured rather than guessed:
 *
 * 1. The button drives its own DOM instead of React state. Slot content is
 *    painted by the shell, and a click there reaches the node (a native
 *    listener fires) while React's state update from the same closure never
 *    re-renders the visible button. Keeping the phase in module scope and
 *    writing class/text/title straight onto the node makes the action work
 *    regardless of which render pass owns the node.
 * 2. Arming is two-step: the first click only arms it for three seconds, the
 *    second one calls the host. A restart closes every window, so a stray
 *    click must never be enough.
 * 3. The footer lane is normalised, not just occupied. The sidebar lets every
 *    occupant own its button geometry, so plugin actions rendered side by side
 *    with the host's own rows disagree about indents and row height. This
 *    module marks the lane container and gives every occupant the sidebar's
 *    row contract (see CSS).
 * @module dsh-quick-restart/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-quick-restart',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const STATUS_URL = '/plugins/dsh-quick-restart/status';
    const RESTART_URL = '/plugins/dsh-quick-restart/restart';
    const HINT = '重启 DSH 桌面壳（插件更新后使用）';

    /** How long the "确认重启？" state waits for the second click. */
    const CONFIRM_MS = 3000;

    /** Button copy per phase. */
    const LABEL = {
      idle: '重启',
      confirm: '确认重启？',
      sending: '重启中…',
      done: '重启中…',
      error: '重试',
    };

    /** Phase lives outside React, see the module comment. */
    let phase = 'idle';
    let message = '';
    let confirmTimer = null;

    /**
     * The sidebar hands the slot a `wide` flag: wide shows the label, the
     * collapsed rail shows the glyph only. Colours inherit from the sidebar so
     * the action follows the active theme instead of carrying its own palette.
     */
    /**
     * Marker attribute set on the lane container (the sidebar's own
     * `.footerActions`). The footer is a plain flex row that lets every
     * occupant keep its own button geometry, so three plugins in it render
     * three different indents and heights. Rows here follow the sidebar's own
     * row contract instead — 32px tall, inline padding of
     * `row-padding - paint-inset` behind a transparent paint-inset border, a
     * 6px label gap and a 16px glyph — which is exactly what the workspace
     * rows and the panel rows above use, so the actions line up with them.
     */
    const LANE_ATTR = 'data-dsh-qr-lane';

    const CSS = `
.dsh-qr-dock {
  display: flex;
  align-items: center;
  min-width: 0;
  width: 100%;
}
.dsh-qr-btn {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: var(--dsh-sidebar-label-gap, 6px);
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: 32px;
  padding: 5px calc(var(--dsh-sidebar-row-padding, 12px) - var(--dsh-sidebar-paint-inset, 3px));
  border: 0;
  border-inline: var(--dsh-sidebar-paint-inset, 3px) solid transparent;
  border-radius: var(--dsw-radius-md, 12px);
  background: transparent;
  background-clip: padding-box;
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  text-align: start;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.dsh-qr-dock[data-wide='0'] {
  justify-content: center;
}
.dsh-qr-dock[data-wide='0'] .dsh-qr-btn {
  justify-content: center;
  width: auto;
  min-width: 32px;
  padding: 0;
  border-inline: 0;
}
.dsh-qr-btn:hover:not(:disabled) {
  background-color: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 10%, transparent));
}
.dsh-qr-btn:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
.dsh-qr-btn:disabled { cursor: default; }
.dsh-qr-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 16px;
  height: 16px;
  font-size: 15px;
  line-height: 1;
}
.dsh-qr-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-qr-confirm {
  color: var(--dsw-alias-warn-label, #B45309);
  font-weight: 600;
}
.dsh-qr-error { color: var(--dsw-alias-error-label, #B42318); }

/* The lane itself: one row per action, stacked in order. The slot ships as
   display:contents; giving it a box keeps the shell's container untouched and
   still lets this module own the stacking. */
[${LANE_ATTR}] {
  display: flex !important;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  min-width: 0;
}
/* Every occupant's seat wrapper becomes a full-width row box, so side margins
   and fixed widths stop deciding where a row starts. */
[${LANE_ATTR}] > *:not(button) {
  display: flex !important;
  align-items: center;
  flex: 0 0 auto !important;
  box-sizing: border-box;
  width: 100% !important;
  min-width: 0 !important;
  max-width: 100% !important;
  height: auto !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
}
/* ...and every seat's button becomes the shared row. The doubled attribute
   raises specificity above the occupant stylesheets that ship their own
   geometry. */
/* ...and every seat's button becomes the shared row. Occupants that ship their
   geometry as an inline style attribute on the button (a declared style beats a
   plain rule) are why the box metrics below carry \`!important\`: the lane, not
   the occupant, decides where a row starts and how tall it is. Colours stay
   with the occupant so its own state tints keep working. */
[${LANE_ATTR}][${LANE_ATTR}] > button,
[${LANE_ATTR}][${LANE_ATTR}] > * > button {
  display: flex !important;
  align-items: center !important;
  justify-content: flex-start !important;
  gap: var(--dsh-sidebar-label-gap, 6px) !important;
  flex: 1 1 auto !important;
  box-sizing: border-box !important;
  width: 100% !important;
  min-width: 0 !important;
  height: 32px !important;
  min-height: 32px !important;
  margin: 0 !important;
  padding: 5px calc(var(--dsh-sidebar-row-padding, 12px) - var(--dsh-sidebar-paint-inset, 3px)) !important;
  border: 0 !important;
  border-inline: var(--dsh-sidebar-paint-inset, 3px) solid transparent !important;
  border-radius: var(--dsw-radius-md, 12px) !important;
  background: transparent !important;
  background-clip: padding-box !important;
  font: inherit !important;
  font-size: 14px !important;
  line-height: 22px !important;
  text-align: start !important;
  cursor: pointer !important;
  overflow: hidden;
}
/* Hover and focus paint the whole seat, so every occupant answers the pointer
   with the same rectangle no matter how it styles its own button. */
[${LANE_ATTR}] > *:not(button) {
  border-radius: var(--dsw-radius-md, 12px);
}
[${LANE_ATTR}] > *:hover > button,
[${LANE_ATTR}] > button:hover {
  background-color: var(--dsw-alias-interactive-bg-hover) !important;
}
[${LANE_ATTR}][${LANE_ATTR}] > button:focus-visible,
[${LANE_ATTR}][${LANE_ATTR}] > * > button:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
[${LANE_ATTR}] svg { flex: none; }
.dsh-qr-sending .dsh-qr-icon,
.dsh-qr-done .dsh-qr-icon { animation: dsh-qr-spin 1.1s linear infinite; }
@keyframes dsh-qr-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .dsh-qr-sending .dsh-qr-icon,
  .dsh-qr-done .dsh-qr-icon { animation: none; }
}
`;

    /**
     * The lane is the slot node itself: the sidebar renders it as
     * `display: contents`, so the actions are laid out by the sidebar's own
     * `.footerActions` box. Giving the slot a real box makes it the one place
     * that decides row after row instead of leaving each occupant to its own
     * geometry. (Only the slot is touched, never the shell's container.)
     */
    function laneHost(node) {
      if (node === null || node === undefined) return null;
      return typeof node.closest === 'function' ? node.closest('[data-slot="sidebar.footer.action"]') : null;
    }

    /** Write the current phase onto the button node. */
    function paint(button) {
      if (button === null || button === undefined) return;
      const known = typeof LABEL[phase] === 'string';
      const shown = known ? phase : 'idle';
      button.className = `dsh-qr-btn dsh-qr-${shown}`;
      button.title = message === '' ? HINT : message;
      button.disabled = shown === 'sending' || shown === 'done';
      const text = button.querySelector('.dsh-qr-text');
      if (text !== null) text.textContent = LABEL[shown];
    }

    function clearConfirm() {
      if (confirmTimer !== null) {
        window.clearTimeout(confirmTimer);
        confirmTimer = null;
      }
    }

    async function fire(button) {
      clearConfirm();
      phase = 'sending';
      message = '';
      paint(button);
      try {
        const response = await fetch(RESTART_URL, {
          method: 'POST',
          headers: { accept: 'application/json' },
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`);
        phase = 'done';
        message = data?.already === true ? '已在重启中，等窗口重新打开' : '正在重启，窗口稍后自动打开';
      } catch (error) {
        phase = 'error';
        message = error instanceof Error ? error.message : '重启失败';
      }
      paint(button);
    }

    function advance(button) {
      if (phase === 'idle') {
        phase = 'confirm';
        message = '再点一次立即重启';
        paint(button);
        clearConfirm();
        confirmTimer = window.setTimeout(() => {
          confirmTimer = null;
          if (phase !== 'confirm') return;
          phase = 'idle';
          message = '';
          paint(button);
        }, CONFIRM_MS);
        return;
      }
      if (phase === 'confirm') {
        void fire(button);
        return;
      }
      if (phase === 'error') {
        phase = 'idle';
        message = '';
        paint(button);
      }
    }

    /**
     * One surface failing must never take the sidebar down: the slot renders
     * inside the shell, so a thrown render would blank the whole column.
     */
    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error) {
        console.warn('[quick-restart] surface failed', error);
      }

      render() {
        return this.state.failed ? null : this.props.children;
      }
    }

    function Dock(props) {
      const wide = props !== null && typeof props === 'object' && props.wide !== false;
      // `null` = still asking the host, `false` = plain `dsh web`, no button.
      const [supported, setSupported] = React.useState(null);
      const buttonRef = React.useRef(null);

      React.useEffect(() => {
        let cancelled = false;
        fetch(STATUS_URL, { headers: { accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
          .then((data) => {
            if (cancelled) return;
            setSupported(data !== null && typeof data === 'object' && data.supported === true);
          })
          .catch(() => {
            if (!cancelled) setSupported(false);
          });
        return () => {
          cancelled = true;
          clearConfirm();
        };
      }, []);

      React.useEffect(() => {
        if (supported !== true) return undefined;
        const button = buttonRef.current;
        if (button === null) return undefined;
        paint(button);
        const lane = laneHost(button);
        if (lane !== null) {
          // Narrow rail: occupants keep their own (centred icon) geometry, so the
          // lane marker only goes on while the footer shows the wide rows.
          if (wide) lane.setAttribute(LANE_ATTR, '');
          else lane.removeAttribute(LANE_ATTR);
        }
        const onClick = (event) => {
          event.preventDefault();
          advance(button);
        };
        button.addEventListener('click', onClick);
        return () => {
          button.removeEventListener('click', onClick);
        };
      }, [supported, wide]);

      if (supported !== true) return null;

      return h(
        'div',
        { className: 'dsh-qr-dock', 'data-wide': wide ? '1' : '0' },
        h(
          'button',
          {
            type: 'button',
            ref: buttonRef,
            className: `dsh-qr-btn dsh-qr-${LABEL[phase] === undefined ? 'idle' : phase}`,
            title: message === '' ? HINT : message,
            'aria-label': '重启 DSH',
          },
          h('span', { className: 'dsh-qr-icon', 'aria-hidden': 'true' }, '⟳'),
          wide ? h('span', { className: 'dsh-qr-text' }, LABEL[phase] ?? LABEL.idle) : null,
        ),
      );
    }

    function Guarded(props) {
      return h(Boundary, null, h(Dock, props));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          ctx.effect(() => {
            const style = document.createElement('style');
            style.setAttribute('data-dsh-quick-restart', '');
            style.textContent = CSS;
            document.head.appendChild(style);
            return () => {
              style.remove();
            };
          }, 'quick-restart: styles');
        } catch (error) {
          console.warn('[quick-restart] styles unavailable', error);
        }

        try {
          ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'quick-restart', order: 10 },
            Guarded,
          ));
        } catch (error) {
          console.warn('[quick-restart] slot registry unavailable', error);
        }
      },
    };
  },
});
