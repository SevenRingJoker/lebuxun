# P1⑧ MCP 管理 UI 实施计划（初版：stdio 全生命周期管理）

## 一、现状研究（代码事实）

- `src/main/handlers/mcp.ts`（单文件 ~235 行）：
  - `loadConfig()` 只读：依次尝试 `process.cwd()/mcp-servers.json`、`app.getAppPath()`、`resourcesPath`，取第一个存在的；无写入能力。
  - `ServerConfig = { package?, command?, args?, description? }`：package（本地 node_modules 包，ELECTRON_RUN_AS_NODE 离线启动）/ command 两种 stdio 模式；args 中 `"."` 解析为 baseDir；**无 enabled 开关、无 env 透传**。
  - 启动时在 `registerMcpHandlers()` 内一次性连接全部配置，失败仅 console.error；运行期只有 `_clients: Map<string, Client>`——**无 connecting/error/disabled 状态记录**，UI 无从展示。
  - 内置虚拟服务器 `terminal`（`createTerminalClient()` 进程内）直接塞进 `_clients`，不在配置文件中。
  - 现有 IPC：`mcp:setWorkspaceRoot`（filesystem 追加工作区目录重启，观察到重复追加不去重）、`mcp:listTools`、`mcp:callTool`。
- `mcp-servers.json`：当前仅 filesystem 一个服务器。
- preload `window.api.mcp`：listTools/callTool/setWorkspaceRoot 三个方法。
- UI 先例：`ModelSettings.vue`（供应商卡片+开关+测试连接+删除确认）、`SessionHistory.vue`（modal 弹窗模式）、ChatPanel 头部按钮区；全程应用内弹窗，禁原生 confirm。
- `mcpToolBridge.ts` 按 `_clients` 合并工具；新增服务器连接后工具自动被 AI 侧收集（每次调用时遍历）。

## 二、目标（初版范围）

1. 配置免手编 JSON：UI 增/改/删/启停 stdio MCP 服务器，保存即尝试连接并反馈结果
2. 服务器状态可见：connected / connecting / error / disabled + 错误文案 + 工具清单（名称/描述）
3. 内置 `terminal` 虚拟服务器只读展示（不可编辑/删除/启停）
4. 配置持久化到 **userData/mcp-servers.json**（可写位置），首启从随包/仓库默认配置**播种一次**，之后以 userData 为唯一真相源
5. ServerConfig 增加 `enabled?: boolean` 与 `env?: Record<string,string>`（KEY=VALUE）
6. 纯函数抽离 + 单测 ≥12 例

**二期不做**：streamable-HTTP / SSE transport、OAuth、工具级细粒度授权（本期仅工具清单只读展示）、自动重连退避（保留手动「重启」按钮）。

## 三、文件与改动

### 新增

| 文件 | 职责 |
|---|---|
| `src/main/ai/mcpConfig.ts` | **零 electron 依赖纯函数层**：`validateServerConfig(input)`（名称 `^[a-zA-Z0-9_-]{1,40}$` 且非保留字 `terminal`；package/command 二选一必填；args 字符串数组；env 行解析 `K=V`）、`parseArgsLines(text)`、`parseEnvLines(text)`、`mergeDefaultConfig(bundled, user)`（按服务器名合并，user 优先）、`dedupeDirs(args)`（filesystem 允许目录去重，修重复追加）、`isReservedName`；返回结构化错误（`{ok:false,error}` 模式） |
| `src/main/ai/mcpConfig.test.ts` | ≥12 例：名称合法/非法/保留字；package 与 command 互斥；args 规范化；env 行解析（合法/缺等号/空行/#注释/前后空格）；merge 覆盖；dedupeDirs 保序去重；配置播种边界 |
| `src/renderer/src/components/McpSettings.vue` | MCP 管理弹窗：服务器卡片列表（状态灯/名称/描述/transport 徽标/工具数/启停 switch/编辑/重启/删除）；工具清单折叠行；新增/编辑表单子弹窗（名称、模式 radio、package 或 command、args 每行一个、env 每行 KEY=VALUE、描述）；保存后内联显示连接成功/失败；删除应用内二次确认；terminal 卡片置灰只读 |

### 修改

- `src/main/handlers/mcp.ts`（重构，不改对外已有通道行为）：
  - 配置路径：`userConfigPath() = app.getPath('userData')/mcp-servers.json`；`bundledConfigPath()` 保持现有三候选；**读取顺序 userData → bundled**；首启 userData 不存在时把 bundled 原样播种到 userData（无 bundled 则播种空骨架 `{mcpServers:{}}`）。
  - `readUserConfig()/writeUserConfig(cfg)`：JSON 解析失败抛带路径的错误；写用 tmp+rename 原子写。
  - `ServerConfig` 增 `enabled?`、`env?`；`resolveSpawn` 合并 `cfg.env`（值为 string）。
  - 模块级 `serverStates: Map<string, ServerRuntime>`（status/error/connectedAt/tools）；抽出统一 `connectServer(name, cfg)`（启动时与增改/重启共用），状态迁移 connecting→connected/error；`disconnectServer(name)`；enabled=false → 不连接记 disabled。
  - terminal 注册后 state 标 `builtin`。
  - 新 IPC（均在 registerMcpHandlers 内）：
    - `mcp:listServers()` → `UiMcpServerInfo[]`：配置全量（含 disabled/未连接）+ 运行时状态 + 工具清单（listTools 结果缓存进 state，失败返回空+错误标记）
    - `mcp:addServer(name, cfg)`：名称查重 → 校验 → 写配置 → 尝试连接（返回连接结果，失败保留 error 状态，配置仍落盘）
    - `mcp:updateServer(name, cfg)`（不允许改名；改名=删旧增新，UI 编辑时名称只读）
    - `mcp:removeServer(name)`：拒绝 terminal；断开 → 删配置 → 状态清除
    - `mcp:toggleServer(name, enabled)`：写配置；开则连接、关则断开记 disabled
    - `mcp:restartServer(name)`：按当前配置重新连接，返回最新状态/错误
  - `setWorkspaceRoot` 重启 filesystem 时用 `dedupeDirs` 合并目录，顺带刷新 state。
- `src/preload/index.ts`：mcp 段补 6 个方法（入参用宽松 unknown/结构化类型）。
- `src/renderer/src/api.d.ts`：`UiMcpServerInfo`（name/description/mode: 'package'|'command'|'builtin'/package?/command?/args?/env?/enabled/status/error?/tools:{name,description?}[]）、`UiMcpServerConfigInput`、`UiMcpSaveResult`；mcp 段补签名。
- `src/renderer/src/components/ChatPanel.vue`：头部齿轮按钮前加 MCP 入口按钮（插头/积木图标，title「MCP 服务器管理」），挂载 `<McpSettings v-if="showMcp">`。
- 《项目结构说明.md》：7.1 第 8 行标 ✅（准确写「stdio 全生命周期 UI；HTTP/SSE/OAuth 未做」）、目录树、7.2 ⑧小节重写、单测计数 213→实际值。
- 日志.md：里程碑追加 P1⑧，下一步改为 ⑨。

## 四、关键状态与类型

```ts
type ServerStatus = 'connected' | 'connecting' | 'error' | 'disabled' | 'builtin'
interface ServerRuntime { status: ServerStatus; error: string | null; connectedAt: number | null }
// UI 聚合
interface UiMcpServerInfo {
  name: string; description: string
  mode: 'package' | 'command' | 'builtin'
  package?: string; command?: string; args: string[]; env: Record<string,string>
  enabled: boolean
  status: ServerStatus; error: string | null
  tools: { name: string; description?: string }[]
}
```

## 五、实施步骤（依赖序）

1. `mcpConfig.ts` 纯函数 + `mcpConfig.test.ts`（先红后绿，独立于 electron）
2. `mcp.ts` 重构：配置路径/播种/原子写、state 表、connect/disconnect 统一化、6 个新 IPC、dedupeDirs、env 合并
3. preload + api.d.ts
4. `McpSettings.vue`（卡片+表单+确认）+ ChatPanel 入口
5. 验证：双端 typecheck、全量 vitest（213 → ≥225）、重启 dev（带 9341）+ CDP 冒烟（探针用完即删）
6. 更新《项目结构说明.md》与日志.md，汇报

## 六、CDP 冒烟清单

1. `mcp:listServers`：filesystem=connected 且工具数 >0；terminal=builtin；含描述与参数
2. 新增坏服务器（command 指向不存在的 exe）→ 返回 ok 但 status=error 且 error 有文案；userData/mcp-servers.json 已写入
3. `mcp:restartServer` 坏服务器仍 error；toggle 关闭后 status=disabled 且 _clients 中移除
4. 修正为有效配置（update 成 package 模式不可行则改为 toggle 再开验证 disabled→connected 路径用 filesystem 自身 restart 验证）
5. 删除坏服务器 → list 中消失、配置文件同步
6. 弹窗 UI 渲染截图：状态灯/工具折叠/表单校验（空名称、package+command 同填的内联报错）
7. 工作区切换 setWorkspaceRoot 后 filesystem 目录不重复（dedupeDirs 验证）

## 七、风险与应对

- **userData 播种后与仓库 mcp-servers.json 脱节**：本期接受（userData 成为唯一真相源，符合「用户配置」语义）；dev 下若想回到默认，删除 userData 文件即重新播种。日志中记录该行为。
- **连接耗时（npx 类最长 120s）卡 UI**：connectServer 不阻塞保存响应——add/toggle 先写配置并立即返回 `status:'connecting'`，连接在后台进行，UI 用 restart/轮询 listServers 拿终态（卡片提供刷新；本期 listServers 时不重复发起连接）。
- **filesystem 被删除导致 AI 无文件工具**：删除确认文案明确提示；内置工具 read/write 等不依赖 MCP，影响仅限 MCP 通道。
- **env 注入密钥泄漏**：env 在 UI 以密码掩码展示（input type=password 可切换显示），不进入日志。
- **terminal 保留名冲突**：validate 拒绝名称 `terminal`。
- **vitest 安全**：mcpConfig 零 import electron；mcp.ts 的 electron 部分不纳入单测。
