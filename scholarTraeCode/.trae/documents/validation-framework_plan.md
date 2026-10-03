# P1⑯ 验证锁通用化 · 实施计划

> 创建：2026-09-30。本计划落地路线图 P1 第 16 项「验证锁通用化」。

## 一、范围

### 1.1 现状痛点

`src/main/ai/scheduler.ts` 第 1135-1154 行的 `validateProjectCreation(ctx)` 把 Vue 脚手架的 5 个硬编码条件（package.json / src/main.js / src/App.vue / ranNpmInstall / ranServe）写死，仅服务于项目创建场景。修 bug、重构、问答类任务在收尾时没有任何验证框架——只要模型输出纯文本就放行，缺少「应存在的文件 / 应满足的断言 / 应执行的命令」这类任务无关的产物校验能力。

### 1.2 本次目标

抽出**任务无关的验证器注册表**：

- 计划阶段（或框架预置）声明「产物清单」`ArtifactManifest`：由若干 `ValidationRule`（文件存在 / 内容匹配 / 命令退出码 / 自定义回调）组成；
- scheduler 在任务收尾与 dedup stall 两个分支统一调用 `runValidation(manifest, ctx)`，未通过按现有停滞/熔断逻辑推进；
- 项目创建场景改用框架预置规则 `vueScaffoldManifest`，行为与现状逐字等价（现有单测全绿）；
- 非项目创建场景默认 `manifest = null` → 永远放行，与现状一致。

### 1.3 二期不做

- `generatePlan` 阶段自动解析计划文本/JSON 注入 manifest（需要约定 schema、解析容错、与 reasoning 模型协议联动，单独立项）；
- `TodoStore` 嵌入 manifest 与顺序锁解耦；
- 前端 UI 编辑 manifest、跨任务模板库、manifest 持久化到 `.trae/`；
- 在 IPC 暴露 validation API（纯函数层不直连 IPC）；
- 重构 `isTodoSatisfied` / `fileHintsOf`（顺序锁逻辑保留现状，与收尾验证锁语义不同：前者按 Todo 文本判单步推进、后者按 manifest 判整体收尾）。

## 二、纯函数层设计 `src/main/ai/validation.ts`

零 IO、零 electron，配单测（参考 `shellProbe.ts` / `dapCore.ts` 先例）。

### 2.1 类型定义

```ts
// 验证器种类：四类预置 + 自定义回调
export type ValidationKind = 'fileExists' | 'contentMatch' | 'commandExecuted' | 'custom'

// 严重级别：block 阻止收尾，warn 仅提示不阻止
export type Severity = 'block' | 'warn'

// 单条验证规则
export interface ValidationRule {
  id: string                  // 规则 id（去重/调试用）
  description: string         // 给模型看的人类描述
  kind: ValidationKind
  severity: Severity          // 默认 block
  // kind 对应的参数（互斥，按 kind 取用）
  path?: string               // fileExists / contentMatch：相对工作区路径或后缀匹配模式
  pattern?: string | RegExp   // contentMatch：内容正则/字符串
  command?: string | RegExp   // commandExecuted：命令文本模式
  // custom 回调签名：返回 true 视为通过，false 视为未通过；message 可覆盖 description
  check?: (ctx: ValidationContext) => boolean | { passed: boolean; message?: string }
}

// 产物清单：一组规则的容器
export interface ArtifactManifest {
  id: string                  // manifest id（如 'vue-scaffold'）
  rules: ValidationRule[]
}

// 验证执行所需上下文（scheduler 侧适配填充）
export interface ValidationContext {
  createdFiles: Set<string>               // 已创建文件（含 MCP write_file）
  executedCommands: Map<string, string>   // 已执行命令文本 → 结果文本（成功/失败/输出片段）
  workspace?: string                      // 工作区根（fileExists 后缀匹配时仅作展示）
}

// 单条验证结果
export interface ValidationResult {
  ruleId: string
  passed: boolean
  message: string                          // 失败时为给模型的提示文本
  severity: Severity
}

// 聚合结果
export interface ValidationSummary {
  allPassed: boolean
  failed: ValidationResult[]               // 仅未通过项
  message: string | null                  // 给模型的强制继续消息（allPassed 时为 null）
}
```

### 2.2 核心函数

```ts
// 四类内置验证器（按 kind 分派）
export function runRule(rule: ValidationRule, ctx: ValidationContext): ValidationResult

// 执行 manifest 全部规则
export function runValidation(
  manifest: ArtifactManifest | null,
  ctx: ValidationContext
): ValidationSummary

// 聚合为给模型的强制继续消息（沿用现状的 🚫 验证锁未通过（缺失：…） 格式以保持行为等价）
export function formatValidationMessage(summary: ValidationSummary): string | null

// 从计划文本/对象解析 manifest（二期未做自动注入，本函数仅作为占位与单测入口）
export function parseManifest(raw: unknown): ArtifactManifest | null

// 框架预置规则：Vue 脚手架 5 项（行为逐字等价旧 validateProjectCreation）
export const vueScaffoldManifest: ArtifactManifest
```

### 2.3 关键实现细节

- **fileExists 匹配**：复用现状的「路径 replace `\\` → `/` 后 endsWith」逻辑——`path: 'package.json'` 命中任何 `…/package.json`，`path: 'src/main.js'` 命中 `…/src/main.js`，向后兼容大小写不敏感（Windows 友好）。
- **commandExecuted 匹配**：在 `executedCommands` 的键集合中查找匹配 `command` 正则的命令，并校验其值不包含失败标记（`npm error|npm ERR|错误|failed|不是内部或外部命令`，与第 791-792 行现状一致）。
- **contentMatch 匹配**：在 createdFiles 中找匹配 `path` 的文件路径——**纯函数层不读磁盘**，contentMatch 仅校验「文件是否已被追踪且包含 pattern」时需调用方在 ctx 中提供文件内容快照（二期 contentMatch 不接入实际内容，仅作为 API 预留 + 单测桩验证）；本期的 `vueScaffoldManifest` 不使用 contentMatch。
- **formatValidationMessage**：消息模板与第 1151-1153 行逐字对齐——`🚫 验证锁未通过（缺失：A、B）。除非所有关键文件已创建且 npm install + npm run serve 均已执行成功，否则严禁输出"任务完成"或结束循环。请立即调用工具补齐缺失项（当前已创建 N 个文件）。` 当 manifest 为 vueScaffold 时输出该模板；其他 manifest 输出通用模板 `🚫 验证锁未通过（缺失：A、B）。请立即调用工具补齐缺失项。`

## 三、重构 `validateProjectCreation`

`src/main/ai/scheduler.ts` 保留导出 `validateProjectCreation(ctx: PromptContext): string | null` 签名不变（向后兼容现有调用点与单测），改为薄壳：

```ts
import { runValidation, vueScaffoldManifest } from './validation'

export function validateProjectCreation(ctx: PromptContext): string | null {
  const vctx: ValidationContext = {
    createdFiles: ctx.createdFiles,
    executedCommands: buildCommandSnapshot(ctx),  // 从 ctx.ranNpmInstall / ranServe / ranMkdir 适配
    workspace: ctx.workspace ?? undefined
  }
  return formatValidationMessage(runValidation(vueScaffoldManifest, vctx))
}
```

`buildCommandSnapshot(ctx)` 是 scheduler 内部的纯函数适配器：把 `ranNpmInstall / ranServe / ranMkdir` 三个布尔标志位反向翻译为 `executedCommands` Map（`npm install` → ''、`npm run serve` → ''、`mkdir` → ''），让 `commandExecuted` 验证器能命中。这样 vueScaffoldManifest 的 5 条规则全部能用同一套 `runValidation` 跑出来，且消息文本逐字等价旧实现。

> 设计权衡：是否直接让 scheduler 维护 `executedCommands` Map 替换三个布尔位？——二期再做。本期仅做最小适配，三个布尔位仍是 scheduler 内部的真实状态源，避免大范围改动工具执行段（第 789-806 行）。

## 四、scheduler 接线

仅改两处：

1. **第 663 行收尾分支**：保持 `validateProjectCreation(ctx)` 调用不变（它内部已委托给框架）。
2. **第 837 行 dedup stall 分支**：保持 `validateProjectCreation(ctx)` 调用不变。

通用化能力的体现：未来任何任务只要在 `chatWithTools` 起始处构造一个 `ArtifactManifest` 并赋给 ctx（二期不做这一步），收尾就会自动走 `runValidation`。本期为通用框架铺底，不强制接入新场景。

## 五、单测计划（目标 +28 例，507 → 535）

`src/main/ai/validation.test.ts`：

- **runRule · fileExists**（5 例）：精确路径命中、后缀匹配（package.json）、跨盘符/反斜杠归一、大小写不敏感、缺失返回未通过。
- **runRule · contentMatch**（3 例）：API 预留路径——文件不在 createdFiles 时未通过、pattern 为字符串/RegExp 各一例。
- **runRule · commandExecuted**（4 例）：命令存在且无失败标记→通过；命令存在但有 `npm ERR`→未通过；命令不存在→未通过；正则匹配 `npm install|i`。
- **runRule · custom**（3 例）：回调返 true→通过；回调返 false→未通过；回调返 `{ passed: false, message }` 覆盖描述。
- **runRule · severity**（2 例）：warn 级未通过仍记入 failed 但不阻止 allPassed（仅记录）；block 级未通过阻止 allPassed。
- **runValidation**（4 例）：空 manifest→allPassed + message null；全通过→allPassed + message null；部分未通过→allPassed false + failed 列表 + message 非空；manifest 为 null→直接 allPassed。
- **formatValidationMessage**（3 例）：vueScaffold 未通过输出含「npm install + npm run serve 均已执行成功」模板（逐字对齐旧消息）；通用 manifest 未通过输出通用模板；allPassed→null。
- **vueScaffoldManifest**（2 例）：5 条规则齐全（kind/severity/path/command 校验）；端到端跑 ctx 等价旧 validateProjectCreation 输出。
- **parseManifest**（2 例）：合法对象→manifest；非法输入→null。

`scheduler.test.ts` 旧 `validateProjectCreation` 4 例与 `isTodoSatisfied` 5 例不动，应全绿（行为等价验证）。

## 六、验证三件套

1. **typecheck**：主进程 `tsc -p tsconfig.node.json` + 渲染进程 `tsc -p tsconfig.web.json`，零错误。
2. **vitest 全量**：`node node_modules\vitest\vitest.mjs run`，507 → 535，全绿。
3. **CDP 真窗冒烟**（临时探针用完即删）：
   - 主进程新模块加载无错（窗口正常起、DevTools console 无红色异常）；
   - 项目创建请求触发校验锁（用 stub 模型只输出文字不调用工具，应被强制继续，消息含「npm install + npm run serve 均已执行成功」——回归旧文案）；
   - 修 bug 类请求（非项目创建）默认无 manifest 正常收尾（无强制继续消息）；
   - listTools 回归（确认未误删任何工具）。

## 七、同步双文档

- **《项目结构说明.md》**：7.1 路线图表 P1⑯ 标 ✅；7.2 新增「验证锁框架」小节（validation.ts 类型与函数清单、scheduler 接线点）；文件树加 `src/main/ai/validation.ts` 与 `validation.test.ts`；单测计数更新。
- **《日志.md》**：进度总览第 11 行计数 13 → 14；表格加 P1⑯ 行；里程碑段落新增一段（纯函数层 / 重构 / 接线 / 验证 / 二期不做）；下一步指向 P2 队列（P1 收口完成）。
