# P1⑫ 终端增强 实施计划

## 现状

- `src/main/handlers/terminal.ts`：单例持久 shell + 命令队列 + 哨兵取退出码。已有 win32/posix 双分支（posix 用 `$SHELL || /bin/bash`、UTF-8、`$?` 哨兵），但：
  1. POSIX 无候选 shell 探测、无 fish 适配（`$?`/`( )` 语法 fish 不支持）；
  2. 所有命令只能前台串行，`npm run dev` 等长任务会占死队列（超时上限 600s）；
  3. 失败命令无结构化诊断，AI 与用户都要自己翻输出。
- `terminalServer.ts` 仅 1 个工具 `run_terminal_command`。
- `TerminalPanel.vue` 无后台任务视图、无失败修复入口。

## 本期范围（初版）

### 1. shell 探测纯函数层（零 IO/零 electron）

新增 `src/main/terminal/shellProbe.ts` + `shellProbe.test.ts`：

- `resolveShellProfile(platform, env)` →
  `{ kind: 'cmd' | 'posix' | 'fish', command, args, encoding: 'gbk' | 'utf8' }`
  - win32：`cmd.exe /V:ON /Q`（env.ComSpec 优先），GBK —— 与现状完全一致；
  - posix：`env.SHELL` → 按 basename 识别 zsh/bash/fish；无 SHELL 时候选 `['/bin/zsh','/bin/bash','/bin/sh']` 首个存在（探测由调用方做 existsSync，纯函数接收 `exists` 注入便于测试）；fish 单独 kind。
- `buildCommandLine(profile, { command, cwd?, currentCwd, marker })`：
  - cmd：`cd /d "d" & ( c ) & echo M=!ERRORLEVEL!`（现状）
  - posix：`cd "d" && ( c ); echo M=$?`（现状）
  - fish：`cd "d"; and begin c; end; echo M=$status`
  - 无 cwd 变化时省略 cd 段。
- `MARKER_LINE_RE`（marker 名注入）与「结果行精确匹配」解析抽为纯函数 `parseMarkerLine(line, marker): number | null`，terminal.ts 复用。

### 2. 错误诊断纯函数层

新增 `src/main/terminal/commandError.ts` + `commandError.test.ts`：

- `analyzeCommandError(command, output, exitCode)` → `{ summary: string; hints: string[]; tail: string } | null`
- 规则（命中关键字取首条/前 3 条）：
  - `'xxx' 不是内部或外部命令` / `command not found` → 缺失命令提示；
  - `npm ERR!` / `error TSxxxx` / `Module not found` / `Cannot find module` / `EADDRINUSE` / `ELIFECYCLE` / `SyntaxError` / `failed to compile`；
- tail = 末尾 1500 字符（错误结论通常在尾部）；exitCode 0 或无输出返回 null。
- 用途：① terminalServer 工具结果附加 `诊断摘要` 段，帮 AI 快速定位；② 前端「AI 修复」按钮构造 prompt。

### 3. 后台任务运行器

新增 `src/main/handlers/backgroundTasks.ts`（含少量纯函数：环形缓冲截断/时长格式化，移入 shellProbe 同目录文件 `taskUtils.ts` 不单开，直接放 backgroundTasks 并导出纯函数供测；测试文件 `backgroundTasks.test.ts` 只测纯函数，不 spawn）：

- `startBackgroundTask({command, cwd, shellProfile})`：用 shell 执行（win: `cmd.exe /V:ON /Q /c "命令"`；posix: `shell -c '命令'`），**不走队列**；
  - posix `detached: true`（独立进程组），Windows `windowsHide`；
  - 每个任务环形缓冲最近 ~200KB 输出；事件 `task:event {id, kind:'data'|'exit', ...}` 推所有窗口；
  - 同工作区目录越界保护复用 terminalServer 的 norm 前缀判断（抽到 shellProbe.ts 导出 `isWithinWorkspace`）。
- `listBackgroundTasks()` / `killBackgroundTask(id)`：
  - posix `process.kill(-pid, 'SIGTERM')` 杀进程组，1.5s 后未退 SIGKILL；
  - win32 `taskkill /pid <pid> /T /F`（项目已有 taskkill 树杀先例）。
- IPC：`task:start` / `task:list` / `task:kill` / `task:tail`（按偏移追读缓冲）。
- AI 工具（terminalServer.ts 新增 3 个）：
  - `start_background_task`（启动 dev server/监听类长任务，立即返回 id + 前 2s 预热输出）
  - `list_background_tasks`
  - `stop_background_task`

### 4. 前端

- preload + `api.d.ts`：`terminal.taskStart/taskList/taskKill/taskTail` + `onTaskEvent`。
- `TerminalPanel.vue`：
  - 头部加「后台」按钮（角标显示运行数）→ 应用内 modal（复用 `.modal-overlay`，禁原生弹窗）：任务列表（命令/状态/运行时长/终止按钮/展开追读输出/复制）；
  - 用户命令失败（run 返回 exitCode≠0）时输出区末尾出现「🔧 AI 修复」按钮，点击 `window.dispatchEvent(new CustomEvent('scholar:fix-terminal-error', {detail:{command,output,exitCode,cwd,summary}}))`。
- `ChatPanel.vue`：监听该事件，把预填诊断 prompt（命令 + 摘要 + 尾部输出）写入输入框并聚焦，**不自动发送**（用户确认后 Enter；工具执行仍受权限模式门控）。

### 5. 接线与保持不变项

- `terminal.ts` 改用 `resolveShellProfile` + `buildCommandLine` + `parseMarkerLine`；Windows cmd/GBK/启动导流/队列/超时行为逐字保持；posix 行为对 bash/zsh 等价。
- `main/index.ts` 注册 task IPC（在 registerTerminalHandlers 内一并注册，避免新增注册点）。

## 验证三件套

1. 双端 typecheck 零错误；
2. 全量 vitest：现有 425 例不减，新增预计 30+ 例（shellProbe 三平台模板/探测/fish、commandError 八类错误、任务纯函数）；
3. CDP 真窗冒烟（新端口）：普通命令回归（dir/echo 中文）、失败命令出现 AI 修复按钮并能填入 ChatPanel、后台启动 `ping -n 20 127.0.0.1` 出现在列表且可终止、AI 工具列表含 3 个新工具。临时探针用完即删。

## 不做（二期）

- PowerShell 7 探测为默认交互 shell（pwsh 退出码/编码策略不同，风险大，本期仅留 profile 扩展点）；
- 真 PTY（node-pty）/ 彩色输出 / 交互式程序支持；
- 后台任务持久化跨重启；端口占用自动检测可视化；
- macOS/Linux 真机验证（当前仅 Windows 环境，POSIX 路径靠单测保障）。
