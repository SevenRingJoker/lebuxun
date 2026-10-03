# 1.1 真 PTY 终端 实施计划

> 状态：✅ 完成（2026-10-02）。typecheck/1042 单测/build/CDP 冒烟 7-7 全通过；
> 旧哨兵通道原样保留；i18n 双语已接入。人工手感验收（npm init / node REPL / watch）待用户执行。

## 一、现状研究结论

**主进程（`src/main/`）**
- `handlers/terminal.ts`：**单例** TerminalSession，`spawn` cmd.exe/posix shell（管道 stdin，非 TTY），靠 `echo 哨兵=退出码` 判定命令结束；Windows 保持 GBK 代码页 + iconv-lite 双向转码；用户输入与 AI 命令共用同一 shell、队列串行。导出 `runTerminalForAi()`（一次性命令、结构化输出/退出码/诊断）、`setTerminalCwd()`。
- `terminal/shellProbe.ts`（纯函数、可单测）：Windows **固定 cmd.exe**（args `/V:ON /Q`、gbk），POSIX 按 `$SHELL` 探测 bash/zsh/fish；提供 buildCommandLine（哨兵包装）、parseMarkerLine、isWithinWorkspace、resolveCwd。
- `handlers/terminalServer.ts`：进程内 MCP，`run_terminal_command`（走 runTerminalForAi，描述明确要求非交互）+ 后台任务三工具（start/list/stop，走 backgroundTasks）。
- `handlers/backgroundTasks.ts`：独立的后台长任务运行器，Windows `taskkill /pid /T /F`、POSIX 进程组 SIGTERM→SIGKILL。**本项不改**。
- `ai/bashGate.ts`（纯函数）：三层规则——破坏命令永久拒绝 / INTERACTIVE_RULES（vue create、npm create|init 非 -y、yarn|pnpm create、django/rails/composer、apt install 无 -y、git commit 无 -m）命中即硬拦 / 项目创建依赖图谱。`gateBashCommand(cmd, ctx): string | null`；scheduler 的薄壳 `preflightBash`（scheduler.ts L1536）委托调用，bash 与 run_terminal_command 执行前检查。

**渲染端**
- `components/TerminalPanel.vue`：自渲染——输出按行追加进 `lines`（cmd/out/info/fix 四类），`input` 单行文本框发 `terminal:run`；无多终端 Tab；有命令历史（↑/↓）、清屏、重启、高度拖拽（220px 默认）、后台任务管理弹窗、失败命令「🔧 AI 修复」入口。挂载于 EditorPanel 内编辑器下方。
- preload：`window.api.terminal` 仅有 start/run/cwd/onEvent + task* 五个后台任务 API，事件通道单一 `terminal:event`。

**依赖**：package.json **无 node-pty、无 @xterm/\***（`iconv-lite` 未登记但已在 node_modules 中被旧代码使用，本项不处理）。

**结论**：采用「**PTY 新增层 + 旧哨兵管道保留为非 PTY 回退**」双轨并存——用户终端全部走真 PTY；AI 一次性命令仍走旧管道拿结构化结果（现有单测零冲击）；AI 交互命令走 PTY，经审批启动。

## 二、文件与改动模块

### 新增依赖
- 运行依赖：`node-pty`（主进程，原生模块）
- 运行依赖：`@xterm/xterm`、`@xterm/addon-fit`、`@xterm/addon-web-links`（渲染端）
- 开发依赖：`@electron/rebuild`（把 node-pty 针对 Electron ABI 重编译）
- package.json `build.asarUnpack` 增加 `node_modules/node-pty/**`（.node 原生模块必须解包）

### 新增文件
- `src/main/terminal/ptySession.ts`：PTY 会话封装
- `src/main/terminal/ptySession.test.ts`：shell 探测纯函数单测
- `src/main/handlers/ptyManager.ts`：多 PTY 实例管理 + IPC 注册

### 修改文件
- `src/main/handlers/terminalServer.ts`：`run_terminal_command` 增加 `interactive` 参数与 PTY 分支
- `src/main/ai/bashGate.ts`：交互式规则从硬拦改为 verdict 分类（破坏命令仍永久拒绝）
- `src/main/ai/bashGate.test.ts`：断言随 verdict 类型更新 + 新增 interactive 分类用例
- `src/main/ai/scheduler.ts`：preflightBash 适配新 verdict；interactive 审批通过后走 PTY
- `src/preload/index.ts` + `src/preload/index.d.ts`：terminal 块增加 pty* API 与 pty 事件
- `src/renderer/src/api.d.ts`：PTY 事件/结果类型
- `src/renderer/src/components/TerminalPanel.vue`：xterm.js + 多终端 Tab 改造
- `src/renderer/src/locales/zh-CN.ts` + `en.ts`：终端相关新文案

## 三、实施步骤（依赖顺序）

1. **装依赖 + 重编译验证**：安装上述依赖，执行 `electron-rebuild -f -w node-pty`；起一个最小 node 脚本确认 `pty.spawn` 在本机 ConPTY 可用（Win10 1809+，node-pty 自动回退 winpty）。
2. **ptySession.ts**：
   - `resolvePtyShell(platform, env, exists)` 纯函数：Windows 候选 `pwsh.exe`（PowerShell 7）→ `powershell.exe` → cmd.exe（用 exists 探测绝对路径，找不到则用文件名交给系统 PATH）；POSIX 复用 shellProbe 的 `$SHELL` 探测逻辑。
   - `PtySession` 类：构造参数 `{ id, cwd, shell?, cols, rows }`，内部 `node-pty spawn`（windowsHide、env 透传、**UTF-8**）；暴露 `onData(cb)`、`onExit(cb, code)`、`write(data)`、`resize(cols, rows)`、`kill()`；kill 时 Windows 额外 `taskkill /pid /T /F` 兜底树杀（npm run dev 等孙进程），POSIX 杀进程组。
3. **ptyManager.ts**：
   - Map<id, PtySession>；`create({cwd,shell?})`（生成短 id、默认 80×24）、`write(id,data)`、`resize(id,cols,rows)`、`kill(id)`、`list()`（返回 id/shell/存活态）。
   - IPC：`terminal:ptyCreate`、`terminal:ptyWrite`、`terminal:ptyResize`、`terminal:ptyKill`、`terminal:ptyList`。
   - 事件广播：`terminal:ptyData` `{id,data}`、`terminal:ptyExit` `{id,code}`。
   - 导出 `runInteractiveInPty(command, cwd): {terminalId}`：创建一个 shell 名称标记「AI」的会话，`write(command + 换行)`，不回收结果。
   - 在主进程入口接线 `registerPtyHandlers()`；工作区切换时新终端默认 cwd 用新工作区（已有会话不强杀）。
4. **bashGate verdict 改造**：
   - 新类型 `BashGateVerdict = { kind: 'deny'; message: string } | { kind: 'interactive'; message: string } | null`。
   - DESTRUCTIVE 命中 → `{kind:'deny'}`；INTERACTIVE 命中 → `{kind:'interactive', message: 建议用 PTY 运行}`；其余检查（依赖图谱/顺序锁不通过）→ `{kind:'deny'}`；放行 → null。
   - 保留一个薄兼容导出 `gateBashMessage(cmd,ctx): string|null` 供 replanSanitize 等现有调用点使用（interactive 在重规划场景视同拦截文本）。
5. **scheduler 适配**：
   - `preflightBash` 返回 verdict：deny → 照旧返回错误文本；interactive → 走**现有权限审批条**（把该命令作为需批准动作推送渲染端，复用 permissions ask 通道）：批准 → 调 `runInteractiveInPty`，工具返回「已在终端 #id 启动，用户可继续交互」；拒绝 → 返回用户拒绝文本。
   - `run_terminal_command` 显式带 `interactive:true`：跳过 interactive verdict 拦截（deny 仍拦），直接走 PTY 分支。
6. **terminalServer.ts**：inputSchema 加 `interactive: z.boolean().nullish()`；true → `runInteractiveInPty` 并立即返回 terminalId；false/缺省 → 旧 runTerminalForAi 路径。更新工具描述（交互程序如 npm init、REPL、watch 用 interactive:true）。
7. **preload + 类型**：terminal 块新增 `ptyCreate/ptyWrite/ptyResize/ptyKill/ptyList/onPtyData/onPtyExit`；index.d.ts、renderer api.d.ts 同步。
8. **TerminalPanel.vue 改造**：
   - 输出区替换为 xterm.js（每 Tab 一个 Terminal 实例 + FitAddon + WebLinksAddon）；主题用 cyber 配色（背景 `#0b0f16`、青色光标）。
   - 顶部终端 Tab 栏：多终端切换、`+` 新建（ptyCreate）、Tab 上 × 关闭（ptyKill）；xterm `onData` → ptyWrite；订阅 onPtyData 按 id 写入对应实例、onPtyExit 标记 Tab「已结束」（保留回看，关闭 Tab 才销毁组件实例）。
   - FitAddon：面板高度拖拽、窗口 resize、Tab 切换（容器 display 切换后尺寸为 0，切回需重新 fit）→ `fit()` 并 ptyResize 同步行列。
   - 保留：折叠态细条、高度拖拽、后台任务弹窗。
   - 「AI 修复」入口迁移：xterm 右键菜单——有选中文本时「送 AI 诊断」（沿用 scholar:fix-terminal-error 事件，summary 用选中文本末几行）；无选中则禁用。
   - 移除：旧 lines 自渲染、单行 input、前端命令历史（shell 自己提供）、MARKER_RE。
9. **i18n**：新/关闭终端、AI 终端、交互审批文案双语键。

## 四、依赖与注意事项

- node-pty 是**原生模块**：dev 必须经 @electron/rebuild 对齐 Electron 33 ABI；打包 asarUnpack 必须配置，否则运行时找不到 .node。
- 旧 `terminal:event`/`terminal:run` 通道与 TerminalSession 保留（AI 非交互命令、非 PTY 回退），两套通道并存不互通。
- PTY 统一 UTF-8：PowerShell 7 默认 UTF-8 输出；Windows PowerShell 5.1 少数原生命令仍可能发 GBK 字节（极少见），主进程不做转码，必要时用户选 pwsh 7。
- 交互审批复用现有权限审批 UI，不新造弹窗。
- 网络盘 D: 文件监听不触发重建是既有问题，dev 调试改源码须重启。

## 五、验证

- `npm run typecheck` 双端零错误。
- `npm test`：新增 ptySession 探测单测 + bashGate verdict 用例；总数在 1025 基线上只增不减。
- `npm run build` 通过。
- **CDP 真窗冒烟**（临时脚本，用完即删）：
  1. ptyCreate 建 2 终端 → Tab 渲染；ptyWrite 写简单命令 → onPtyData 收到回显/输出；ptyResize 不报错；ptyKill → ptyExit。
  2. AI 工具 `run_terminal_command interactive:true` 跑 `node -e`/REPL 类（node -i）→ 返回 terminalId，终端 Tab 出现「AI」会话并可继续输入。
  3. 交互审批：构造 interactive 命令 → 审批条出现 → 批准后 PTY 启动；拒绝路径。
- **人工验收清单**：npm init（临时目录）、node REPL、npm run dev watch 三类各跑一次；验证彩色输出、Ctrl+C 中断、窗口缩放/面板拖拽不花屏。

## 六、风险与应对

| 风险 | 应对 |
|------|------|
| node-pty 重编译失败（构建工具链缺失） | 先做步骤 1 的最小验证；编译不过则安装 windows-build-tools / VS Code build tools；极端情况本次交付阻断，先停在研究结论 |
| ConPTY 异常（花屏/残留） | node-pty 自动回退 winpty；再异常时用户终端可回退旧管道面板（保留开关），AI 链路不受影响 |
| verdict 类型改造波及 scheduler 多处 | 保留 gateBashMessage 兼容层；bashGate 单测同步更新，逐调用点核对 |
| xterm Tab 切换后 fit 尺寸为 0 | Tab 激活后 nextTick 再 fit()；面板已有 ResizeObserver 兜底 |
| 交互审批体验打断 AI 流 | 审批走现有异步通道，模型收到明确的「等待用户/用户拒绝」结构化返回，可重规划 |

## 七、明确不做

- backgroundTasks 旧后台任务运行器不改（后续 2.2 abort 项再统一信号）。
- 终端输出不做跨会话持久化与回放。
- PTY 与 git index 同步；多终端列表不跨重启恢复。
- 旧 GBK/iconv 管道代码不删除（回退保留）。
