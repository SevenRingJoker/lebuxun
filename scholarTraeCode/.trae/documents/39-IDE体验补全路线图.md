# IDE 基础体验补全路线图（M1–M5）

> 来源：2026-10-02 用户提出的体验补全规划。本文件是后续推进的总纲，每项完成时回写状态与交付证据。
> 状态图例：⬜ 待办 ｜ 🟡 进行中 ｜ ✅ 完成

---

## M1 · IDE 基础体验补全（1.5–2.5 周）

### 1.1 真 PTY 终端（P0，3–5 天）✅

**为什么**：当前 bashGate 直接拦 vue create、npm init、Python REPL、watch 模式，AI 不能替你跑交互命令，是最大日常短板。

**技术选型**：node-pty（Windows 走 ConPTY），新增 `src/main/terminal/ptySession.ts`。

**主进程**：
- `handlers/terminal.ts` 从"持久 shell 管道 + 哨兵"改为"PTY 会话管理"，保留旧 shellProbe 作为非 PTY 回退
- 多终端实例：`terminal:create`、`terminal:write`、`terminal:resize`、`terminal:kill`、`terminal:list`
- Windows 默认 shell：PowerShell 7（pwsh.exe）优先，回退 powershell.exe、cmd.exe
- 进程树杀：Windows 用 taskkill /T /F，POSIX 用进程组；保留现有 backgroundTasks.ts 树杀逻辑
- 编码：PTY 输出统一 UTF-8；旧 GBK 兼容只保留给非 PTY 回退

**渲染端**：
- `TerminalPanel.vue` 接入 xterm.js（@xterm/xterm + @xterm/addon-fit + @xterm/addon-web-links）
- 支持彩色、光标、Ctrl+C、Tab 补全、窗口缩放、多 Tab

**AI 工具**：
- `terminalServer.ts` 的 run_terminal_command 改为可走 PTY；交互式命令不再被 bashGate 一刀切，标记"需用户确认"
- `bashGate.ts` 保留破坏命令永久拒绝；交互式脚手架从"硬拒"改为"弹审批 + 建议用 PTY"

**验收**：
- 内置终端能跑 npm init、vue create、python REPL、npm run dev watch
- 彩色输出正常，Ctrl+C 能中断，窗口缩放不花屏
- AI 能通过工具启动一个交互命令，用户可在终端里继续输入
- 双端 typecheck + 单测 + CDP 冒烟

**交付证据（2026-10-02）**：
- 双端 typecheck 零错误；单测 1042 通过（基线 1025，只增不减）；生产构建通过
- CDP 真窗冒烟 7/7：ptyCreate×2 → ptyWrite 回显 → onPtyData → ptyResize → ptyKill/onPtyExit → ptyList 状态正确
- 实际交付通道：`terminal:ptyCreate/ptyWrite/ptyResize/ptyKill/ptyList` + `terminal:ptyData/ptyExit`（旧哨兵通道原样保留）
- 本机无 pwsh 7，正确回退 PowerShell 5.1；i18n 中英双语已接入（terminal 命名空间）
- 待人工过一遍：npm init、node REPL、npm run dev watch 及 Ctrl+C/拖拽实际手感

### 1.2 全局搜索/替换（P0，2–3 天）✅ 已完成（2026-10-02）

**为什么**：全局搜索替换比很多 AI 功能更常用。

**主进程**：
- 新增 `handlers/search.ts`，用 @vscode/ripgrep 或直接调 rg.exe（随包放 resources/bin/rg.exe）
- IPC：`search:query`、`search:replacePreview`、`search:replaceApply`
- 支持：大小写、全词、正则、包含/排除 glob、结果上限 5000

**渲染端**：
- 左栏加"搜索"Tab（与文件/调试/验证并列）
- `SearchPanel.vue`：输入框、选项、结果树（文件 → 行）、点击跳转
- 替换区：替换预览 diff，逐文件/全部替换，应用内确认

**与 AI 联动**：AI 的 grep 工具优先走同一 ripgrep 封装，结果格式统一。

**验收**：
- 1 万文件项目搜索 < 2s，结果可跳转
- 替换预览正确，全部替换走应用内确认，不弹原生 confirm
- 单测覆盖 glob/正则/编码边界

**完成情况**：按 [41-全局搜索替换-计划.md](file:///d:/47.104.20.186/aiProject/scholarTraeCode/.trae/documents/41-全局搜索替换-计划.md) 全部交付。ripgrep 15.0（@vscode/ripgrep@1.18，rg.exe asarUnpack）；SearchPanel + ReplacePreviewModal（勾选/before-after 红绿/二次确认）；grepTool 已委托同一引擎并保留 walk 回退。双端 typecheck 零错误、单测 1111 全过（新增 69）、CDP 落盘冒烟通过。

### 1.3 SCM 源代码管理面板（P0，3–4 天）✅

**为什么**：现在只有 diff/checkpoint，没有 VS Code 式 SCM 侧栏。

**完成情况**：按 [42-SCM源代码管理-计划.md](file:///d:/47.104.20.186/aiProject/scholarTraeCode/.trae/documents/42-SCM源代码管理-计划.md) 全部交付（2026-10-02）。主进程 `statusGrouped` 三分组（保留 porcelain XY 双字母，支持「暂存后再改」双组同现）、stage/unstage（restore --staged + reset 回退，工作区边界校验）、commitStaged（仅提交暂存区）、for-each-ref 分支列表/切换/新建（isValidBranchName 白名单）；渲染端 ScmPanel（分支头+提交框 Ctrl+Enter+三折叠分组+应用内 discard 确认）、DiffViewer 支持 viewerInitialPath 预选；中英 i18n 各 26 键。双端 typecheck 零错误、单测 **1173** 全过（新增 62）、CDP 真窗冒烟通过（暂存/双组/提交落盘/分支/discard/DiffViewer 预选）。
> 已知后续项：应用自身的 `.trae/` 目录（code-index.json 等）会出现在用户 git 未跟踪列表，尚无自动 .gitignore 处理，见 42 文档「八、已知问题」。

**主进程扩展 `handlers/git.ts`**：
- `git:statusGrouped`：staged / unstaged / untracked 分组
- `git:stage`、`git:unstage`、`git:discard`、`git:commit`、`git:branchList`、`git:checkoutBranch`、`git:createBranch`
- 提交信息模板、中文路径、大文件保护

**渲染端**：
- 左栏加"源代码管理"Tab，`ScmPanel.vue`
- 分组列表、逐文件 diff、暂存/取消暂存、提交框、分支切换
- 与现有 `DiffViewer.vue` 复用

**与 AI 联动**：AI 任务前自动检查点保留；任务后可在 SCM 面板看改动。

**验收**：
- 能完成日常：改文件 → 看 diff → 暂存 → 提交 → 切分支 ✅
- 与现有 checkpoint/回滚不冲突 ✅
- 单测覆盖 porcelain 解析、分组、暂存/取消暂存 ✅

### 1.4 Vue / Volar LSP（P0，2–4 天）✅（2026-10-02 完成，详见 [43-VueVolarLSP-计划](file:///d:/47.104.20.186/aiProject/scholarTraeCode/.trae/documents/43-VueVolarLSP-计划.md)）

**为什么**：当前 LSP 只覆盖 TS/JS/TSX/JSX，.vue 没智能提示。

**依赖**：@vue/language-server（Volar），随包放 node_modules 或 resources。

**主进程 `handlers/lsp.ts`**：
- 支持多 language server 注册：typescript-language-server + vue-language-server
- 按文件扩展名路由：.vue → Volar，.ts/.js → TS server

**渲染端 `monacoLsp.ts`**：
- 注册 vue 语言，Monaco 配置 Vue 语法高亮
- 复用现有 7 类 provider：补全、悬停、定义、引用、重命名、格式化、代码操作
- 诊断：Volar 的 template/script 诊断写入 ProblemsPanel

可选：ESLint/Prettier LSP 先不做。

**验收**：
- .vue 文件补全、跳转、诊断、重命名可用 ✅
- 与 TS server 不冲突，切换文件正常 ✅（采用 Take Over 二选一：含 .vue 工作区仅 Volar，无 .vue 仅 tls）
- 单测覆盖扩展名路由、能力合并 ✅

**完成情况**：`@vue/language-server@2.1.10` + typescript 5.9（移至 dependencies、asarUnpack 全链解包）；主进程多服务器 IPC + vue 工作区探测；渲染端 kind 切换、URI 归一化；Monaco vue 语言（Monarch）+ provider 复用。单测 1173 → 1205；CDP 真窗冒烟 14/14。已知行为：从导入使用方 rename 走本地别名，跨文件 rename 需从声明处发起（上游 TS 行为，详见 43 文档）。

---

## M2 · AI 审阅与中断体验（1.5–2 周）

### 2.1 逐 hunk 暂存/审阅（P0，4–6 天）✅ 2026-10-02 完成（s24–s27，详见 44）

**为什么**：当前 ㊝ 只到文件级，AI 改大文件时只能全收/全拒。

**纯函数层 `ai/changeStage.hunk.ts`（s24 新建，Myers O(ND) 零依赖）**：
- ✅ `splitHunks(base, current)`：行 diff + 3 行上下文分组，输出 hunk 列表
- ✅ `parseUnifiedDiff` / `formatUnifiedDiff`：unified 文本解析生成
- ✅ `applyHunksToBase`：只重放选中 hunk；未知 id/区间重叠/基线漂移均拒绝
- ✅ 冲突检测：hunk 之间重叠、上下文与基线不符

**`handlers/staging.ts`（s25）**：✅ accept/reject 支持 hunkIds；部分接受后基线前进、完整内容留 pending（diff 只显剩余块）；整批冲突不落盘。

**`StagingPanel.vue`（s26）**：✅ diff 区上方 hunk chips（勾选、点编号定位、增删行计数），逐 hunk 接受/拒绝；与文件级选择互斥联动。

**与 Git SCM 联动**：暂存 hunk 与 git index 同步先不做，保持独立。

**验收**：
- ✅ AI 改 200 行文件，能只接受其中指定 hunk（CDP 冒烟 200 行 4 hunk 选 2 块磁盘核验）
- ✅ 拒绝的 hunk 不落盘，接受的落盘
- ✅ 单测覆盖 hunk 拆分、重叠、冲突（20 个新单测）
- 完成情况：1225 单测全绿（48 文件），CDP 冒烟 11/11（含中文路径、冲突阻断、pending.json 清理）

### 2.2 Ollama/HTTP abort + 工具内部打断（P0，3–4 天）✅

**为什么**：Ollama abort() 是 no-op，停止后底层还在跑。

**完成情况（s28–s30，2026-10-02）**：

**s28 Provider 真 abort**：
- `ollamaProvider.ts` 弃 ollama 库改原生 fetch 直连 `/api/chat`（NDJSON 手写解析），inflight AbortController 池 + `AbortSignal.any` 合并外部 signal；chat/chatStream abort 返回「已中止」不触发回退
- `openaiCompatibleProvider.ts`/`anthropicProvider.ts`：mergeSignal 统一内部 abortRef 与外部 signal；非流式 chat 补上 signal；catch 统一「已中止」语义
- `scheduler.ts` 四处接线（scheduleChatStream 第 3 参 / generatePlan / summarize / 主循环 chat + finishByAbort）；`aiScheduling.ts` 增 chatStreamAbort / inlineStreamAbort 模块级中止器

**s29 工具内部打断**：
- `builtinTools.ts` bash：`detached`（POSIX 进程组）+ killTree（Windows `taskkill /T /F`，POSIX `kill(-pid)`），signal abort 杀进程树回填「⚠ 已被用户中止」
- `builtinToolsExt.ts` spawnCollect 同款 signal（run_script / git 透传）
- `mcpToolBridge.ts` callMcpTool 第 5 参 signal：内置透传；MCP 走 SDK `callTool(..., undefined, { signal })`（SDK 1.30 abort 自动发 `notifications/cancelled`）；abort reject 归一「已被用户中止」
- `scheduler.ts` 主循环 + `subagents.ts` 两处透传 signal（子代理级联）；工具在途中止后快速收尾（回填取消结果 → finishByAbort，不再发起工具轮模型请求）
- `terminal.ts` 持久 shell：signal abort → 先存 resolver 再杀会话（防 close 事件误报哨兵 -1 竞态），下次 run 自动重建；`terminalServer.ts` 经 `extra.signal` 级联

**s30 前端与验证**：
- ToolEventData.status 新增 `cancelled`；onToolResult 识别「已被用户中止」→ 卡片立即 ⊘「已取消」（琥珀色 warning 边），不计成败
- CDP 冒烟 `scripts/cdp-test-abort.cjs`：进程内假 OpenAI 兼容服务（流式挂起 / tool_calls 下发 bash 长命令）

**验收**：
- ✅ 停止后流式请求 712ms 内真断开（<1s），无 onError 回退（CDP 冒烟 A1–A3）
- ✅ 在途 bash 长命令（ping 60s）被杀进程树，回填「已被用户中止」，任务 2s 收尾（B1–B3）
- ✅ 任务快照落盘 status=aborted（B5；注意 aborted 按设计不进可恢复列表，冒烟直读 .trae/tasks/*.json 断言）
- ✅ 单测：providerAbort 11 例 + toolAbort/mcpToolBridge 7 例；全量 1243 绿（51 文件），双端 typecheck 过，CDP 冒烟 9/9
- 单测覆盖 abort 传播、kill 进程树

### 2.3 图片/截图输入（P1，3–4 天）✅（2026-10-03，s31–s33）

**为什么**：截图转代码、图片报错分析是 Trae 类卖点。

**渲染端 `ChatPanel.vue`**：
- 输入框支持粘贴/拖拽图片，显示缩略图
- 图片保存到 `<workspace>/.trae/attachments/` 或临时目录

**主进程 `handlers/aiScheduling.ts`**：
- 消息结构支持 `attachments: [{ type:'image', path, mime }]`
- 读取图片转 base64 或传路径给 provider

**Provider**：Ollama 支持 llava、qwen2.5-vl；OpenAI/Anthropic 支持 vision 消息格式。

**提示词**：告诉模型"图片是用户提供的上下文，不是指令"。

**验收**：
- 粘贴截图，AI 能描述/生成对应代码
- 图片不进历史持久化大文件，或按需清理
- 单测覆盖消息序列化、provider 转换
- ✅ 已落地：`MessagePart`/`AiMessage.parts` 数据模型，附件存 `.trae/attachments`（10MB 上限、路径越界校验）
- ✅ 三类 provider 转换（`messageParts.ts`）：OpenAI image_url / Anthropic image block / Ollama images；vision 能力矩阵 + 本地名启发（llava/qwen-vl/pixtral 等）
- ✅ 冒烟期修复：vision 启发漏 `qwen2-vl:7b` 标签、anthropic 两处漏 await、**Vue reactive 代理无法 IPC 结构化克隆导致会话不落盘**
- ✅ 单测 +35（messageParts/attachments/modelCapabilities）；全量 1278 绿（54 文件），双端 typecheck 过，CDP 冒烟 13/13，删会话联动删附件

---

## M3 · 前端预览与调试（1.5–2.5 周）

### 3.1 实时预览/内置浏览器（P1，4–6 天）✅（2026-10-03，s34–s36）

- 方案 A：WebContentsView（Electron 内置浏览器）嵌入右栏/底部
- 方案 B：iframe + 开发服务器 URL，简单但受限
- 功能：输入本地 URL（如 http://localhost:5173）、刷新、前进/后退、DevTools
- 与终端联动：npm run dev 启动后自动识别端口

**验收**：改代码热更新可见，能打开 DevTools。
- ✅ 已落地：主进程 [previewCore.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/main/preview/previewCore.ts) 纯函数层（URL 归一化/localhost 白名单/bounds 校验/端口候选/日志 URL 提取，22 单测）+ [previewView.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/main/preview/previewView.ts)（WebContentsView 生命周期、导航事件推送、setWindowOpenHandler 拦截外链、bounds 上报、探活 IPC）
- ✅ 渲染端 [stores/preview.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/renderer/src/stores/preview.ts) + [PreviewPanel.vue](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/renderer/src/components/PreviewPanel.vue)（地址栏/导航三键/DevTools/探活/关闭）+ EditorPanel 中栏互斥切换（编辑器↔预览）
- ✅ 仅允许 localhost/127.0.0.1，外链一律系统浏览器；WebContentsView 不注入 preload（用户项目无需 window.api）
- ✅ 冒烟 `scripts/cdp-test-preview.cjs`：进程内假 HTTP 服务两页互跳，验证打开/前进后退/reload/setBounds/close 全链路 8/8 通过
- ✅ 单测 1278 → **1300**（+22）；双端 typecheck 零错误；CDP 冒烟 8/8

### 3.2 元素选择发送 AI（P1，3–4 天）✅（2026-10-03，s37–s38）

- 注入脚本到预览页面：鼠标悬停高亮、点击获取选择器、DOM 片段、截图
- 通过 IPC 把选择器/HTML/截图发送到 ChatPanel，预填 prompt
- AI 可据此改对应组件

**验收**：点击页面元素，ChatPanel 出现"修改这个元素"上下文。
- ✅ 已落地：主进程 [elementPicker.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/main/preview/elementPicker.ts)（选择器优先级 data-id/data-testid/id→CSS path、outerHTML 8K 截断、console 桥 `__SCHOLAR_PICKED__` 回传）+ [previewView.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/main/preview/previewView.ts) 增加 enterPickMode/exitPickMode/captureElement IPC（元素截图独立校验，不复用整视图最小宽高）
- ✅ ChatPanel `onPicked` 预填「修改这个元素：<选择器>（摘要）」
- ✅ 冒烟期修复：picker 脚本内残留插值导致注入语法错误（单测只覆盖纯函数未覆盖整脚本执行，CDP 冒烟暴露后删除）；captureElement 复用整视图 MIN 宽高校验误拒小元素
- ✅ 单测 1300 → **1307**（+7）；双端 typecheck 零错误；CDP 冒烟 `scripts/cdp-test-picker.cjs` **11/11**（打开→注入 overlay→点击采集三要素→截图 PNG→预填→退出）

### 3.3 多语言 DAP + AI 调试集成（P1，4–7 天）✅（2026-10-03，s39–s41）

- 扩展运行时：Python（debugpy，走 DAP）、Go（dlv dap）
- `debug/dapCore.ts` 已有帧编解码，补 `debugSession.ts` 支持通用 DAP adapter
- 前端 DebugPanel：条件断点、日志点、watch、变量多层展开、REPL evaluate
- AI 集成：AI 可读堆栈/变量，自动建议断点，解释异常

**验收**：Python/Go 能下断点、单步、看变量；AI 能基于堆栈给修复建议。
- ✅ 已落地：[genericDapSession.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/main/debug/genericDapSession.ts) spawn adapter 走 stdio DAP（`python -m debugpy.adapter` / `dlv dap`），与 Node CDP [debugSession.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/main/debug/debugSession.ts) 对外统一接口；握手按 debugpy 时序（initialize→launch 不 await→等 initialized→setBreakpoints→configurationDone→收 launch 响应）；进程退出 `rejectAllPending` 防挂起；`resolvePythonCommand` py→python3→python 探测 + 安装引导
- ✅ DebugPanel：runtime 下拉（Node/Python/Go）、launch/attach、args/cwd/env、REPL evaluate（停驻时可用）；store 双后端路由 IPC
- ✅ AI 调试工具 [builtinToolsDebug.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/main/ai/builtinToolsDebug.ts)：`debug_get_context`（堆栈/作用域/变量/异常快照，[debugContextFormat.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/main/debug/debugContextFormat.ts) 截断格式化）、`debug_apply_breakpoint`（按活跃后端路由）、`debug_evaluate`（DAP，传停驻首帧 frameId）
- ✅ 单测 1307 → **1328**（+21）；双端 typecheck 零错误；CDP 冒烟 `scripts/cdp-test-dap.cjs` **11/11**（launch→断点停驻第 2 行→变量 x=1→evaluate x+1=2→终止→三工具注册）
- ✅ 真机冒烟（vitest `genericDapSession.smoke.test.ts`）：Python debugpy 1.8.22 全链路 2/2 通过；**Go/dlv 本机未安装，按计划记录跳过（环境探测 `describe.skipIf`）**

---

## M4 · 性能与稳定性（持续，1 周+）⬜

- 索引性能：大项目（>5000 文件）增量索引耗时、内存
- Monaco：多 Tab 模型复用、大文件打开速度、语法高亮卡顿
- 启动速度：主进程懒加载、MCP 延迟连接、LSP 按需启动
- 长会话：上下文压缩后内存、chat store 消息上限
- 崩溃/卡死：crashReporter 日志、主进程 CPU/内存监控
- 真实项目跑一周，记录并修 top 10 卡顿

**验收**：10 万行项目打开 < 5s，编辑不卡，连续用 8h 不崩。

---

## M5 · 可选增强（按需）⬜

- MCP HTTP/SSE、OAuth
- 插件安装 UI、插件市场（个人用可跳过）
- 渲染端轨迹查看 UI、日志等级运行时可调
- 命令参数化、chord 快捷键、keymap 导入导出
- manifest 持久化到 .trae/、contentMatch 真磁盘读取
- 子代理中途续跑、历史快照清理

---

## 进度回写记录

| 事项 | 状态 | 完成日期 | 证据/备注 |
|------|------|---------|----------|
| 1.1 真 PTY 终端 | ✅ 完成 | 2026-10-02 | typecheck/1042 单测/build/CDP 冒烟 7-7 通过；人工验收待过手感 |
| 1.2 全局搜索/替换 | ✅ | 2026-10-02 | 41 |
| 1.3 SCM 面板 | ✅ | 2026-10-02 | 42；1173 单测/CDP 冒烟全过；`.trae/` 未 ignore 为已知后续项 |
| 1.4 Vue/Volar LSP | ✅ | 2026-10-02 | 43；1205 单测/CDP 冒烟 14-14；使用方 rename 本地别名为上游已知行为 |
| 2.1 逐 hunk 暂存 | ✅ | 2026-10-02 | 44；1225 单测/CDP 冒烟 11-11；与 git index 保持独立 |
| 2.2 abort 打断 | ✅ | 2026-10-02 | 44；1243 单测/CDP 冒烟 9-9；流式断连 712ms、bash 进程树杀、卡片「已取消」、快照 aborted |
| 2.3 图片输入 | ✅ | 2026-10-03 | 44；1278 单测/CDP 冒烟 13-13；三类 provider 多模态、附件只存路径、删会话联动清理 |
| 3.1 内置浏览器 | ✅ | 2026-10-03 | 44；1300 单测/CDP 冒烟 8-8；WebContentsView 嵌入、localhost 白名单、bounds 上报、导航事件、DevTools |
| 3.2 元素选择 | ✅ | 2026-10-03 | 44；1307 单测/CDP 冒烟 11-11；picker 注入脚本语法错误与截图小元素误拒经冒烟修复 |
| 3.3 多语言 DAP | ✅ | 2026-10-03 | 44；1328 单测/CDP 冒烟 11-11/真机冒烟 2-2；debugpy stdio 握手时序、py 启动器探测、rejectAllPending 防挂起；dlv 未装记录跳过 |
| M4 性能稳定性 | ⬜ | — | — |
| M5 可选增强 | ⬜ | — | — |
