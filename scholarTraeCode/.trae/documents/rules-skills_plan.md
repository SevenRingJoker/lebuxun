# P1⑨ 规则 / 技能 / 记忆管理实施计划（初版：统一管理 UI + 多级规则分层）

## 一、现状研究（代码事实）

- `src/main/ai/skills.ts`（~89 行）：
  - 读 `<workspace>/.trae/skills/*.md`，文件名白名单校验（`^[\w\u4e00-\u9fa5-]+$`）。
  - `listSkills()` 提取首段描述（跳过 `#` 标题与空行，120 字符截断），`renderSkillList()` 注入 S8 层。
  - `loadSkill()` 按需读全文（12000 字符截断），**无启停开关、无管理 UI**。
  - 实际目录 `.trae/skills/` 当前为空（无技能文件）。
- `src/main/ai/promptBuilder.ts`：
  - `buildAgentsMd()` 只读 `<workspace>/AGENTS.md`（单层，无用户级/目录级），S6 层注入。
  - `renderNotes()` 把 `AgentNote` 渲染为附注层文本。
- `src/main/ai/agentNotes.ts`（~123 行）：
  - 持久化 `.trae/agent-notes.json`（`projectStructure` / `commonErrors` / `userPreferences` / `lastTask` / `lastTaskResult` / `updatedAt`）。
  - `appendError()` 按 error 字段去重、count+1、保留前 20 条；`updateAfterTask()` 任务结束后写回。
  - **无管理 UI**，仅 `ai:loadNotes` IPC（无查看/清理入口）。
- `src/main/ai/scheduler.ts`（~850 行）：
  - 每轮循环调 `buildAgentPrompt(ctx)`，ctx 含 `agentsMd`（调度器一次性读盘）、`notesText`（每轮加载）、`skillsText`（每轮加载）。
  - 技能工具 `list_skills` / `use_skill` 已注册（`scheduler.ts:435-479`），但技能清单是**只读注入**，无启停。
- 无 `rules` 目录概念、无多级规则分层、无目录级规则文件（如 `.trae/rules/`、`AGENTS.md` 子目录）。

## 二、目标（初版范围）

1. **技能管理 UI**：列表（名称/描述/来源/启停）、在线编辑（Markdown 内容）、新建、删除、启停开关（disabled 时不注入 S8）。
2. **规则管理 UI**：列表（名称/作用域/内容预览）、在线编辑、新建、删除；支持**用户级 → 项目级 → 目录级**三层规则，就近优先合并（目录级 > 项目级 > 用户级）。
3. **笔记只读查看**：展示 `.trae/agent-notes.json` 结构化内容（常见错误列表、上次任务、用户偏好），提供「清空笔记」按钮（应用内确认）。
4. **敏感忽略复用 `.gitignore` 语义**：技能/规则/笔记变更提示纳入 Git 状态展示（不自动提交）。
5. 纯函数/存储层抽离 + 单测 ≥15 例。

**二期不做**：规则/技能热重载（改配置后需重启 Agent 会话生效）、技能包导入导出（zip）、规则冲突可视化、笔记自动总结编辑。

## 三、文件与改动

### 新增

| 文件 | 职责 |
|---|---|
| `src/main/ai/rulesConfig.ts` | **零 electron 依赖纯函数层**：`discoverRules(workspace, userRulesDir)` 遍历三层规则文件（用户级 `~/.trae/rules/*.md`、项目级 `<workspace>/.trae/rules/*.md`、目录级 `<dir>/.trae/rules/*.md` 沿路径向上）；`mergeRules(rules)` 按就近优先（目录级覆盖项目级覆盖用户级，同名后者覆盖前者）；`validateRuleName(name)` 同技能白名单；`RuleMeta`（name/scope/path/contentPreview） |
| `src/main/ai/rulesConfig.test.ts` | ≥8 例：三层发现顺序、就近合并、同名覆盖、非法名拒绝、空目录边界、用户级路径不存在 |
| `src/main/ai/skillConfig.ts` | **零 electron 依赖纯函数层**：`validateSkillName(name)`、`parseSkillMarkdown(raw)`（提取 name/description/content，支持 frontmatter `---\nname: xxx\ndescription: yyy\n---`）、`renderSkillMarkdown(meta, content)`（生成带 frontmatter 的标准格式）、`SkillMeta` 扩展（enabled?: boolean，frontmatter 存储） |
| `src/main/ai/skillConfig.test.ts` | ≥7 例：frontmatter 解析/生成、描述截断、非法名、启用/禁用标记持久化、空文件、超长描述 |
| `src/main/handlers/rulesSkills.ts` | IPC 处理器：`rules:list` / `rules:read` / `rules:write` / `rules:delete` / `rules:toggle`（启用/禁用，项目级规则启停状态存 `.trae/rules/.state.json`）；`skills:list` / `skills:read` / `skills:write` / `skills:delete` / `skills:toggle`；`notes:load` / `notes:clear`（清空 agent-notes.json） |
| `src/renderer/src/components/RulesSkillsSettings.vue` | 管理弹窗：三栏 Tab（技能 / 规则 / 笔记）；技能栏=卡片列表（名称/描述/启停开关/编辑/删除）+ Markdown 编辑器（textarea + 预览模式切换）；规则栏=按作用域分组（用户级/项目级/目录级），卡片显示名称/作用域/内容预览/编辑/删除，项目级可启停；笔记栏=只读展示 + 清空按钮（应用内确认）；全程应用内 modal，复用 `.modal-overlay` 样式 |

### 修改

- `src/main/ai/skills.ts`：扩展 `SkillMeta` 加 `enabled?: boolean`（从 frontmatter 读）；`listSkills()` 过滤 disabled；`renderSkillList()` 跳过 disabled。
- `src/main/ai/promptBuilder.ts`：
  - `buildAgentsMd()` 扩展为 `buildRulesMd(workspace, userRulesDir?)`：合并三层规则（调用 `rulesConfig.mergeRules()`），生成 `[S6 项目规则]` 层文本（原 AGENTS.md 作为项目级规则之一纳入）。
  - `PromptContext` 增 `rulesText?: string`（S6 层数据源）。
- `src/main/ai/scheduler.ts`：每轮循环调 `buildRulesMd()` 替代 `buildAgentsMd()`；`skillsText` 生成时过滤 disabled。
- `src/preload/index.ts`：rules/skills/notes 段补方法。
- `src/renderer/src/api.d.ts`：`UiSkillMeta`（name/description/enabled/sourcePath）、`UiRuleMeta`（name/scope: 'user'|'project'|'directory'/path/enabled/contentPreview）、`UiAgentNote`（结构化笔记）。
- `src/renderer/src/components/ChatPanel.vue`：头部按钮区加「规则与技能」入口（书本/齿轮图标，title「规则与技能管理」），挂载 `<RulesSkillsSettings v-if="showRulesSkills">`。
- 《项目结构说明.md》：7.1 第 9 行标 ✅、7.2 ⑨小节重写、单测计数 238→实际值。
- 日志.md：里程碑追加 P1⑨，下一步改为 ⑩。

## 四、关键状态与类型

```ts
// 技能元信息（扩展）
interface SkillMeta {
  name: string
  description: string
  enabled?: boolean  // frontmatter 存储，默认 true
  sourcePath: string // 绝对路径，用于编辑/删除
}

// 规则元信息
interface RuleMeta {
  name: string
  scope: 'user' | 'project' | 'directory'
  path: string       // 绝对路径
  enabled: boolean   // 仅项目级规则支持启停（.state.json）
  contentPreview: string // 前 200 字符
}

// 规则启停状态（项目级）
// .trae/rules/.state.json
interface RuleState {
  [ruleName: string]: boolean // true=启用，false=禁用
}

// UI 聚合
interface UiSkillMeta extends SkillMeta {}
interface UiRuleMeta extends RuleMeta {}
interface UiAgentNote {
  projectStructure?: string
  commonErrors?: { error: string; fix: string; count: number; lastSeen?: string }[]
  userPreferences?: string
  lastTask?: string
  lastTaskResult?: string
  updatedAt?: string
}
```

## 五、实施步骤（依赖序）

1. `rulesConfig.ts` + `skillConfig.ts` 纯函数 + 单测（先红后绿，独立于 electron）。
2. `rulesSkills.ts` IPC 处理器：三层规则发现/合并、技能 CRUD、笔记只读/清空。
3. preload + api.d.ts。
4. `RulesSkillsSettings.vue`（三栏 Tab + 编辑器 + 确认弹窗）+ ChatPanel 入口。
5. 验证：双端 typecheck、全量 vitest（238 → ≥253）、重启 dev（带 9341）+ CDP 冒烟（探针用完即删）。
6. 更新《项目结构说明.md》与日志.md，汇报。

## 六、CDP 冒烟清单

1. `rules:list`：三层规则按 scope 分组返回，目录级规则 path 正确。
2. 新建项目级规则 → 写入 `.trae/rules/test-rule.md`，list 中出现，enabled=true。
3. 编辑规则内容 → 文件同步更新，contentPreview 刷新。
4. 删除规则 → 文件移除，list 中消失。
5. 技能列表：创建技能 → frontmatter 生成正确，list 中出现；toggle 禁用后 list 中 enabled=false。
6. 技能编辑：修改内容 → 文件同步，frontmatter 中 enabled 保留。
7. 笔记查看：构造 agent-notes.json → UI 展示结构化内容；清空按钮二次确认后文件重置为空对象。
8. 弹窗 UI 渲染截图：三栏 Tab 切换、技能编辑器、规则作用域分组、笔记只读区。

## 七、风险与应对

- **规则分层冲突**：同名规则就近覆盖（目录级 > 项目级 > 用户级），UI 按 scope 分组展示避免混淆；合并逻辑纯函数单测覆盖。
- **技能 frontmatter 兼容性**：现有技能文件无 frontmatter，解析时容错（无 frontmatter 则从首段提取描述，enabled 默认 true）；写入时统一生成 frontmatter。
- **笔记清空误操作**：应用内二次确认弹窗，文案明确「清空后不可恢复」；清空前自动备份到 `.trae/agent-notes.backup.json`。
- **用户级规则路径跨平台**：用户级目录 `~/.trae/rules/`（Windows 下 `%USERPROFILE%\.trae\rules\`），路径不存在时返回空数组不报错。
- **目录级规则发现性能**：沿当前文件路径向上最多遍历 5 层目录，每层检查 `.trae/rules/*.md`，单测用 tmpdir 模拟。
- **vitest 安全**：rulesConfig/skillConfig 零 import electron；rulesSkills.ts 的 electron 部分不纳入单测。
