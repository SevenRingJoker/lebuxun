# P1⑬ 调试能力（DAP）实现计划

## 一、范围

为 ScholarTreaCode 增加最小可用的 Node.js 调试能力：断点、启动/附加、单步/继续、堆栈与变量查看。

- **支持运行时**：Node.js（`node --inspect` / `node --inspect-brk`）。
- **协议**：DAP（Debug Adapter Protocol）。直接以 TCP 连接 Node Inspector（9229 等端口），其内置完整 DAP 支持（VS Code 同款路径），无需引入 debugpy/js-debug 等外部适配器进程。
- **配置**：launch（启动新进程并注入 `--inspect-brk`）与 attach（连接既有 9229 端口）两类。

## 二、架构与分层

### 2.1 纯函数层（零 IO / 零 electron，可单测）— `src/main/debug/dapCore.ts`

| 函数 | 职责 |
|------|------|
| `encodeDapMessage(msg)` | 对象 → `Content-Length: N\r\n\r\n{json}` 帧（Buffer） |
| `createDapDecoder()` / `feedDapChunk(state, chunk)` | 流式分片重组：跨包半头、半 JSON、多帧粘连；产出完整消息数组与新状态 |
| `isResponse / isEvent / isRequest` | 三类消息判别 |
| `newRequestSeq(state)` | 请求序号分配 |
| `matchResponse(pending, msg)` | 按 `request_seq` 匹配应答，返回 `{pending', reply}` |
| `normalizeBreakpoint(file, line)` | 断点规范化：绝对路径、行号 ≥1 |
| `buildLaunchArgs / buildAttachArgs` | 生成 `launch` / `attach` 请求参数 |
| `parseStackFrames / parseScopes / parseVariables` | DAP 响应体 → UI 友好结构（数组、字段兜底） |

### 2.2 主进程状态层 — `src/main/debug/debugSession.ts`

- 管理唯一活跃会话：`idle → connecting → initialized → running / stopped → terminated`。
- `launch(config)`：`spawn('node', ['--inspect-brk=0', entry])`，解析 stdout `Debugger listening on ws://...` 得实际端口，随后 TCP 连接。
- `attach(port)`：直接 TCP 连接。
- DAP 握手：`initialize` → `setBreakpoints` → `configurationDone` → 等待 `initialized`/`stopped` 事件。
- 断点增删：按文件聚合并向适配器发 `setBreakpoints`。
- 控制：`continue / next / stepIn / stepOut / pause / disconnect`。
- 事件桥：收到 `stopped` 时自动拉取 `threads → stackTrace → scopes → variables` 第一层，组装快照后 `webContents.send('debug:event', ...)` 推全部窗口（先例见 `handlers/backgroundTasks.ts` 的 `task:event`）。
- 输出捕获：被调进程 stdout/stderr 透传到前端调试控制台区。

### 2.3 IPC — `src/main/handlers/debug.ts`

| 通道 | 方向 | 说明 |
|------|------|------|
| `debug:start` | invoke `{ kind:'launch'|'attach', entry?, port? }` | 启动/附加会话 |
| `debug:stop` | invoke | 终止会话并 kill 子进程 |
| `debug:setBreakpoints` | invoke `{ file, lines[] }` | 覆盖式设置某文件断点 |
| `debug:control` | invoke `{ action }` | continue/next/stepIn/stepOut/pause |
| `debug:state` | invoke | 当前会话快照 |
| `debug:event` | send | `state / stopped(stack,vars) / output / terminated` |

preload 暴露 `window.api.debug.*`，`api.d.ts` 补类型。

### 2.4 前端最小可用 UI

1. **断点槽（EditorPanel）**：Monaco `glyphMargin: true` + `onMouseDown` 命中 glyph 区 → 切换该行断点（红点 decoration）；本地维护 `Map<file, Set<line>>`，切换文件时重渲染；调试中命中行加黄色高亮 decoration。
2. **调试侧栏**：不新增第三栏，复用左栏 —— FileTree 顶部加「文件 / 调试」分段切换；调试面板含：会话状态徽标、启动配置（入口文件输入 + launch/attach 按钮 + 端口输入）、控制按钮条（继续/单步/步入/步出/暂停/停止）、调用堆栈列表（点击跳转对应文件行）、变量树（一层展开）。样式沿用现有 sidebar 变量与 `.modal-overlay` 规范。

## 三、验证三件套

1. **双端 typecheck 零错误**。
2. **全量 vitest**：纯函数层预计新增 35+ 单测（帧编解码边界、半包/粘包、请求应答匹配、断点规范化、launch/attach 参数、堆栈/变量解析兜底）。
3. **CDP 真窗冒烟**：起 Electron `--remote-debugging-port=9222`；写一个临时 `scratch/debug-target.js`（含循环打印便于断点）；通过 IPC 启动 launch 会话 → 断言 `initialized`；设断点 → 断言 `stopped` 事件且堆栈首帧文件/行正确；`continue` → `terminated`。临时探针脚本用完即删、进程即停。

## 四、二期不做（明确边界）

- 条件断点 / 日志点 / 命中次数；watch 表达式与变量多层懒加载展开；多线程/多会话并发调试；Chrome/Edge 页面调试、Python 等其它运行时；断点持久化到工作区文件；变量编辑与 REPL 求值（`evaluate`）。

## 五、涉及文件

- 新增：`src/main/debug/dapCore.ts(+test)`、`src/main/debug/debugSession.ts`、`src/main/handlers/debug.ts`、`src/renderer/src/components/DebugPanel.vue`
- 修改：`src/main/index.ts`（注册）、`src/preload/index.ts`、`src/renderer/src/api.d.ts`、`src/renderer/src/components/FileTree.vue`（顶部分段切换）、`src/renderer/src/components/EditorPanel.vue`（glyphMargin + 断点/命中行 decoration）
- 文档：`项目结构说明.md`（7.1 表标 ✅、7.2 小节、文件树、单测计数）、`日志.md`（进度总览 + 里程碑 + 下一项指向 P1⑯）
