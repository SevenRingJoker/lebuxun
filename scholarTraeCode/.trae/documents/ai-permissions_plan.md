# ① 权限与安全审批 实施计划

对照《项目结构说明.md》7.2 节第①项（P0）：为 AI 工具调用增加统一权限层——只读/询问/自动三模式、危险命令确认、工作区边界、敏感文件排除、路径逃逸防护、审计日志、前端审批条。

## 一、代码研究结论（接入点已核实）

- 工具执行唯一入口：[scheduler.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/main/ai/scheduler.ts) 的 runWithTools 工具循环，第 683-700 行附近顺序为：跨轮去重 → `preflightBash`（项目创建专用门控）→ `callMcpTool` 执行。**权限关卡插入在 preflightBash 之后、callMcpTool 之前**。
- 运行时协调工具（todo_write/dispatch_subagents/list_skills/use_skill，第 649 行）不碰文件系统/进程，**跳过权限关卡**。
- 子代理 [subagents.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/main/ai/subagents.ts) 的 runOne 直接调用 callMcpTool，**必须透传同一个关卡函数**，否则子代理成为越权通道。
- IPC 事件模式已成熟：[aiScheduling.ts](file:///d:/47.104.20.186/aiProject/scholarTraeCode/src/main/handlers/aiScheduling.ts) 用 `win.webContents.send` 推送事件（todo/subagent 同款）；审批需要反向通道，用 pending Promise Map + `ai:permissionResponse` handle 实现。
- 配置持久化范式：providerRegistry.ts 用 `app.getPath('userData')/ai-providers.json`，权限模式照搬，存 `ai-permissions.json`。
- bash 工具（builtinTools.ts 第 124 行）的 cwd 来自 args.cwd || workspace；read/grep/glob 的 path/root 同理——逃逸检查有明确字段可抓。
- 前端订阅范式：chat.ts onMounted 订阅 onTodoUpdate/onSubagentUpdate；审批条放 ChatPanel 输入器上方（subagent-bar 同级位置）。

## 二、文件与模块

**新增：**

- `src/main/ai/permissions.ts`：纯决策引擎（可单测）+ 模式持久化
  - 类型：`PermissionMode = 'readonly' | 'ask' | 'auto'`；`Decision = 'allow' | 'deny' | 'ask'`
  - `evaluate(name, args, ctx: { workspace?: string|null }, mode)` → `{ decision, reason, danger?: boolean }`
  - 工具分类：只读类（read/grep/glob/list_skills）、写入类（write/write_file/edit/edit_file/create_directory/move_file/delete_file/copy 等）、命令类（bash/run_terminal_command）
  - 危险命令正则集：`rm -rf`/`del /s|/q`/`format`/`reg add|delete`/`netsh`/`shutdown`/`taskkill`/`mklink`/`icacls`/`curl|wget ... | iex|sh`/`npm publish` 等
  - 敏感文件匹配：`.env*`、`id_rsa`、`*.pem/*.key/*.p12`、`credentials`、`.trae/audit.log`、`.git/config`
  - 模式矩阵：
    - readonly：写/命令一律 deny（只读工具放行）
    - ask（默认）：写/命令一律询问；危险命令 danger 高亮
    - auto：常规写/命令放行；危险命令仍询问
    - 所有模式下：工作区外写入 → deny；工作区外读取/命令 cwd 逃逸 → ask；敏感文件 → deny
    - 无工作区时：所有写/命令降级为 ask
  - 会话级"始终允许"规则表（name+归一化签名），随 Agent 运行实例生效
- `src/main/handlers/security.ts`：副作用层
  - `isInside(root, target)`：path.resolve 后带分隔符前缀比较，防 `../` 逃逸与盘符穿越
  - `appendAudit(workspace, entry)`：追加 `<workspace>/.trae/audit.log`（无工作区写 userData/logs），含时间/工具/参数摘要/模式/决策/用户应答；失败静默不阻塞
- `src/main/ai/permissions.test.ts`：决策矩阵单测（模式×工具类型、逃逸、敏感文件、危险命令、无工作区、会话规则命中）

**修改：**

- `scheduler.ts`：ToolsEvents 增加 `onPermissionRequest?: (req) => Promise<{decision:'allow_once'|'allow_always'|'deny', reason?}>`；工具循环插入 `permissionGate`（纯决策 → allow 直接执行 / deny 回填错误不执行 / ask 走事件等前端应答 / always 写会话规则）；审计落盘；gate 实例传入 subagents
- `subagents.ts`：RunSubagentsParams 增加可选 `gate`，runOne 执行工具前同样过闸
- `aiScheduling.ts`：pending Map（requestId → resolve）+ `ai:permissionRequest` 推送 + `ai:permissionResponse` handle 释放；窗口销毁/5 分钟超时按 deny 处理；新增 get/setPermissionMode 两个 IPC
- `preload/index.ts`：ai 对象补 `getPermissionMode/setPermissionMode/onPermissionRequest/respondPermission`
- `renderer/src/api.d.ts`：UiPermissionRequest（id/tool/摘要/target/danger）等类型
- `stores/chat.ts`：permission 单条状态（后端串行请求，前端展示最新一条）、订阅与应答、mode 状态与切换
- `components/ChatPanel.vue`：输入器上方审批条（工具图标+名称、路径或命令全文、danger 红色警示；按钮：允许一次 / 本次会话始终允许 / 拒绝）；chat-header 加三模式分段切换（只读/询问/自动）

## 三、实施步骤（依赖顺序）

1. permissions.ts 纯决策引擎 + 模式持久化
2. security.ts 路径逃逸检查 + 审计日志
3. permissions.test.ts 并跑 vitest（纯逻辑先绿）
4. scheduler.ts 接入 gate（ToolsEvents、循环插桩、审计）
5. subagents.ts 透传 gate
6. aiScheduling.ts 审批桥 + 模式 IPC
7. preload + api.d.ts 通道与类型
8. chat.ts + ChatPanel.vue 审批条与模式切换
9. typecheck（node + web）+ 全量 vitest
10. 沙箱外重启 dev，CDP/人工冒烟：auto 模式直接写、ask 模式弹审批、readonly 拒绝、危险命令高亮、`..\` 逃逸被拒

## 四、依赖与注意事项

- 不改动 preflightBash：它是项目创建专用业务门控，权限层是通用安全闸，二者串联（业务门控先拦，安全闸后审）。
- 审批等待期间模型循环自然 await，不占轮次；deny 以工具错误形式回填 convo，Agent 会看到拒绝原因并可换方案，不算停滞。
- 审批条与现有 TODO/子代理状态条同区域，样式复用 cp-glass/CSS 变量，遵循蓝青科技风。
- 审计日志加入敏感文件排除，防止 AI 读取审批记录后进行提示注入。
- 模式默认 ask：升级后首次行为安全；auto 模式下危险命令仍必须询问（自动模式不等于免审批）。

## 五、验证

- `npm test`：新增用例 + 现有 84 例全绿
- tsc 双配置通过（web 仅保留历史遗留 App.vue 报错）
- dev 实机冒烟四种路径：自动放行、询问-允许、询问-拒绝（Agent 收到拒绝并改道）、逃逸/敏感硬拒

## 六、风险与处理

- **用户不响应导致 Agent 长挂**：5 分钟超时自动 deny 并回填超时原因；窗口销毁同样 deny。
- **审批打扰过多**：auto 模式 + 会话级"始终允许"（按工具+目标签名）降低频率；只读操作永不询问。
- **子代理并发弹多条**：后端 await 串行化审批（每扇区同一把锁），前端始终只有一条待决。
- **路径检查平台差异**：统一 path.resolve/sep 比较，单测覆盖 Windows 反斜杠与 `..` 穿越用例。
- **审计日志写入失败**：静默吞掉，安全功能不得阻断主流程。
