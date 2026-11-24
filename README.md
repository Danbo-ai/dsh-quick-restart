# dsh-quick-restart

在 DSH 桌面壳的**左侧栏底部动作区**（「进展」与账户头像之间）加一个「重启」入口：点两次就把当前 DSH 完整关掉并用同一个
可执行文件重新拉起来。插件更新后不用再去托盘退出、再双击图标。

## 为什么需要它

DSH 桌面壳（Electron）没有给插件留任何重启通道：

| 检查项 | 结论 |
|---|---|
| 主进程 IPC 白名单 `DESKTOP_IPC`（`app.asar/lib/main.js`） | 只有 fileSave / clipboard / shortcuts / boot / browser / directory / updates 等，**没有 restart / quit / relaunch** |
| 窗口菜单「文件 / 编辑 / 视图 / 帮助」 | 是 Electron **原生菜单**，网页 bundle 里搜不到这些文案，插件加不进去 |
| 应用菜单里的「重启 App Host」 | 只在 `development` 模式出现，正式版没有 |
| 宿主进程自行退出 | 主进程 `child.once("close")` 无条件判定失败，会弹崩溃恢复框 |

所以唯一能做到「一键」的路径是：**宿主插件起一个脱离进程树的脚本，由脚本杀主进程再重新拉起**。

## 界面

- 位置：注册在侧栏插槽 `sidebar.footer.action`，渲染成**左侧栏底部的一行动作**：位于 teamplan 的「进展」下面、
  账户头像行上面，与它们左对齐。
- 形态：32px 高的行内按钮，图标 `⟳` + 文字「重启」；侧栏收起成窄条时只显示居中的图标（插槽传入 `wide=0`）。
- 交互：第一次点击变成「确认重启？」并 3 秒后自动回弹；第二次点击立即执行；执行中显示「重启中…」并禁用；
  失败显示「重试」并把服务端理由放进 `title`。
- 降级：在普通 `dsh web`（非桌面壳）里**不渲染**按钮——那里没有窗口可以重开。

### 为什么点击处理写成原生 DOM 操作

侧栏插槽里的内容，点击落不到 React 的合成事件上：实测 `.dsh-qr-btn` 的 fiber 上确实挂着 `onClick`，
但真实点击或手动调用都不改变 DOM；同一个插槽里 teamplan 的按钮也一样点不动（侧栏原生项正常）。
所以这个按钮的状态机放在模块作用域，点击走**原生 `addEventListener` + 直接改 DOM**（`className` / `title` /
`textContent`），React 只负责把它挂进插槽。

> 早先版本挂在 `shell.overlay`（网页右上角浮动胶囊），因浮层被外壳的 `z-index:1000` 全屏层盖住、
> 需要搬到 `<body>` 才能点，遂改为侧栏槽位；侧栏是普通文档流，不再有遮挡问题。

### 页脚这一排为什么能对齐

`sidebar.footer.action` 是个**共享座位**：teamplan 的「进展」、`ds-harness-remote` 的「Remote」和这个插件
都往里面塞自己的按钮，各自带自己的按钮几何，所以默认会出现「三行高度不同、图标与文字的起始 x 不同」。
本插件挂载时给**插槽节点本身**打标记 `data-dsh-qr-lane`，再用一组作用域限定在
`[data-dsh-qr-lane]` 内的规则把座位与行统一成侧栏的通用行几何：

| 量 | 值 | 依据 |
|---|---|---|
| 行高 / 座位高 | 32px | 与工作区行、面板行一致 |
| 行内边距 | `5px 9px` + `border-inline:3px transparent` | 图标落在 x=20 |
| 图标 | 16×16，中心 x=28 | 与账户头像中心 x=28 同一条脊线 |
| 文字起点 | x=42 | 与工作区行文字同一条基线 |
| 行间距 | 2px | `flex-direction:column;gap:2px` |

实现上有三个必须知道的细节：

- **只在宽版页脚生效**。`wide=0`（窄轨道）时本插件撤掉车道标记，占位者保留各自的居中图标几何，不会被强行拉成整行。
- **几何要带 `!important`**。占用者可能把按钮几何写成行内 `style`（teamplan 就是：`height:42px;
  margin:1px 2px;padding:0 9px`），行内声明会压过普通规则，不带 `!important` 改不动它。
- **hover 画在座位上**，不画在按钮上：这样无论占用者自己怎么给按钮上色，指针悬停时都是同一个矩形。
  焦点环仍留给按钮自己的 `:focus-visible`。

作用范围只有这个插槽内的座位与按钮，侧栏其它地方（工作区行、面板行、账户行）一概不碰——它们是宿主
自己的几何，账户行 44px 高、头像 24px 宽，所以文字起点是 x=48 而不是 42，这是头像尺寸带来的正常差异。

## 它到底做了什么

宿主半体（`index.js`）在收到 `POST /plugins/dsh-quick-restart/restart` 后：

1. 从运行时自己推断重启目标，**不读任何配置文件**：
   - 主进程 pid = `process.ppid`
   - 可执行文件 = `process.execPath`
   - **是否桌面壳**：`process.argv` 里必须出现 `dsh-desktop-host/lib/index.js`。可执行文件路径和
     `--expose-internals` 都区分不了两种模式——`dsh web` 的 CLI 走的是同一个 `DeepSeek Harness.exe`，
     也同样带 `--expose-internals`，只有启动脚本 `lib/cli.js` ↔ `lib/index.js` 不同。判据判错会把正在跑
     `dsh web` 的实例杀掉（实测踩过）。
2. 把一段 PowerShell 写到 `%TEMP%\dsh-quick-restart.ps1`，再用 `Start-Process -WindowStyle Hidden`
   把它交给一个独立进程（见下方「为什么用 Start-Process」）。
3. 立即返回 `{ ok: true, pid, armedAt }`，让页面收到「正在重启」。

脚本（在宿主已死之后继续运行）：

```
延迟 900ms  → 快照自己的后代进程
            → Stop-Process 主进程（只杀主进程，不带 /T）
            → 轮询等待快照里的后代自行退出（最多 12s）
            → 兜底：只杀快照里的 pid（不按进程名）
            → 清掉 ELECTRON_RUN_AS_NODE 后 Start-Process 同一个 exe（工作目录 = exe 所在目录）
            → 等 3 秒确认窗口活着；若立刻退出就重试一次，仍失败则交给 explorer 启动
```

**为什么必须先清 `ELECTRON_RUN_AS_NODE`**：宿主本身是「用 Electron 的二进制跑 Node」（`ELECTRON_RUN_AS_NODE=1`），
它派生的脚本会继承这个变量，于是 `Start-Process` 拉起来的「新窗口」其实是一个**裸 Node 进程**——没有窗口、
立刻退出。2026-11-23 实测就是这样：日志写到 `relaunched`、窗口却再没回来，因为 `relaunched` 只代表进程已创建。
现在启动链两处都清掉了这个变量（`index.js` 的 `cleanEnv()` + 脚本里的 `Remove-Item Env:...`），并且
**确认窗口活过 3 秒**才算成功，日志会给出 `relaunched pid N` 或 `relaunch exited early: code N`。

**为什么只杀主进程**：宿主子进程监听 `process.once("disconnect")` 并调用 `stop()`，主进程一死它
就走优雅关闭、把会话日志落盘；`taskkill /T` 会直接切断这条路径。

**为什么兜底只杀快照 pid**：按进程名杀会波及同一台机器上第二份 DSH 安装或用户另开的窗口。快照在杀
主进程之前取，覆盖当时的整棵子树，且排除脚本自己（它本身是宿主的后代，否则会等自己再自杀）。

**为什么用 Start-Process 而不是 node 的 `detached: true`**：`detached` + `windowsHide` + `stdio:'ignore'`
组合出来的 PowerShell 没有控制台，约 130ms 后以 exit 0 退出、一行都不执行（实测）。走 `Start-Process`
才能拿到一个真正独立、能在宿主被杀后继续跑的进程。

耗时：正常情况 2~6 秒重开（含 3 秒存活确认）；如果后代进程不肯退出，最长 12 秒后强杀再重开。

日志：`%TEMP%\dsh-quick-restart.log`，一行一步，重启失败时先看它（正常一轮：`restart requested` → `descendants` → `killed main process` → `relaunched pid N`）。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/plugins/dsh-quick-restart/status` | `{ supported, pid?, exe?, reason?, restartingAt, lastAt, lastError }` |
| POST | `/plugins/dsh-quick-restart/restart` | 武装脚本。15 秒内重复请求返回 `202 { already: true }`，不会起第二个脚本 |

两个路由都过宿主自身的认证围栏（`ctx.get('connection').requestRejection`），未认证请求到不了重启路径。

## 安装

```bash
# 在 DSH 会话里
plugin_manager install_bundle target=D:\dsh-project\plugin\小需求\dsh-quick-restart
```

或先在测试区验证（见根目录 `docs/` 的隔离测试环境说明）。

装好后刷新一次页面，左侧栏底部（「进展」与头像之间）出现「重启」按钮。

## 验证记录

已在测试区（`D:\dsh-staging`，纯 `dsh web`）实测：

1. 插件装上后宿主正常启动，`--dump-config` 出现 `- id: quick-restart`。
2. `GET /status` → `supported:false` + 明确的 reason；`POST /restart` → `409`，**不写脚本、不杀进程**，
   实例继续存活（这是修掉「误杀 `dsh web`」之后的结果）。
3. 带 token 打开页面：插件样式已注入、按钮不出现（预期，web 模式无窗口可重开），页面无报错。
4. 临时把测试区的 `status` 改成恒报 `supported:true`（只改测试区副本，测完已还原），在真实页面里验证了完整交互链路：
   真实鼠标点击一次 → 变「确认重启？」（`title`「再点一次立即重启」）→ 约 3 秒自动回弹成「重启」；
   窗口期内再点一次 → POST → 服务端 409 → 显示「重试」并把原因放进 `title`。按钮位置实测 `rect x=8 y=715 w=67 h=32`，
   位于 `[data-slot="sidebar.footer.action"]` 内、teamplan「进展」之上、账户头像行之下。
5. 用替身进程树（root + 2 个后代）跑了一遍生成的脚本：root 被杀、后代清空、`Start-Process` 重新拉起生效、
   日志逐行完整（`restart requested` → `descendants` → `killed main process` → `relaunched`）。
6. 页脚对齐（测试区实测，注入与真实按钮同构的座位后量 `getBoundingClientRect`）：teamplan「进展」座位
   `8..272 h=32`、按钮 `h=32` / `padding 5px 9px` / `border-inline 3px`、图标 `x=20 w=16`、文字 `x=42`；
   「重启」行读数完全相同；工作区行同样是图标 `x=20`、文字 `x=42`、`h=32`；两行间距 2px。
   账户行头像 `x=16 w=24`（中心 28，与图标中心同一条脊线），文字因头像更宽落在 `x=48`，属正常差异。

7. 线上首次真实点击（2026-11-23 15:19）：窗口关闭成功，但**没有重新打开**。日志停在 `relaunched`（15:19:15），
   进程表里也没有 15:19 启动的实例——`Start-Process` 创建了进程，只是那进程立刻退出。
   原因：宿主自己就是带 `ELECTRON_RUN_AS_NODE=1` 跑起来的 Node，脚本继承了这个变量，新窗口于是被当成裸 Node
   启动、立刻退出。复现：`ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" -e "console.log(1)"` 会以 Node 身份直接执行。
   修法：启动链两处清掉该变量（`cleanEnv()` + `Remove-Item Env:ELECTRON_RUN_AS_NODE`），补 `-WorkingDirectory`、
   3 秒存活确认、一次重试与 explorer 兜底。语法与替身已复验；**线上再点一次的真实重开待确认**。
8. 线上真实重开（2026-11-23 15:32，用户操作）：日志 `restart requested: pid 49836` → `descendants: 20` →
   `killed main process 49836` → **`relaunched pid 45028`**；3 秒存活确认通过，新窗口自动打开（端口随之变化）。
   用户确认「这次好了」。

线上桌面壳的按钮点击（真实关闭窗口再重开）由你点一下确认，这一步我不替你按。

## 验证清单

1. 按钮出现在左侧栏底部、「进展」下面、头像上面，与它们左对齐。
2. 点一次 → 「确认重启？」，3 秒不动自动回弹。
3. 点两次 → 「重启中…」，窗口关闭，约 3–6 秒后新窗口打开。
4. 重启后 DSH 正常进入上次的工作区，会话列表完整。
5. 快速连点两次以上 → 只起一个脚本（`%TEMP%\dsh-quick-restart.log` 只有一组记录）。
6. 普通 `dsh web` 打开 → 不出现按钮。

## 已知限制

- **仅 Windows 桌面壳**。无桌面壳（`dsh web`）时按钮不渲染。
- **端口会变**：桌面壳以 `--port 0` 启动，重启后端口随机，浏览器里收藏的旧地址会失效（桌面壳自己会开新窗口）。
- **重启期间前端无响应**：旧 web server 已随进程结束，页面会显示断连，属正常。
- 强制结束主进程，未落盘的少量内存态（未提交的表单草稿等）会丢失；会话记录按 append 写入，风险低。

## 回滚

```bash
plugin_manager set_bundle target=dsh-quick-restart enabled=false
```

或删除 profile 里的 bundle 条目后重启（此时就得手动重启一次了）。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主半体：状态/重启路由、目标推断、脚本生成与 spawn |
| `client.js` | 客户端半体：`sidebar.footer.action` 里的「重启」按钮、两段式确认、状态样式 |
| `cordis.patch.yml` | bundle 挂载补丁 |
| `package.json` | 包清单与 `dsh.client` 声明 |
