# P1⑭ 设置 / 命令面板 / 快捷键 实施计划

> 日期：2026-09-30
> 前置：P1⑪ 子代理增强已完成（基线 359 例单测全绿、双端 typecheck 零错）

## 一、现状痛点（已调研确认）

| 现状 | 位置 | 问题 |
|------|------|------|
| 配置入口分散 | ChatPanel 头部 3 个图标按钮分别开 ModelSettings / McpSettings / RulesSkillsSettings 弹窗；主题切换在 App.vue 顶栏；权限模式/检查点开关在 ChatPanel 头部 | 没有统一设置页，新用户找不到入口 |
| 无命令面板 | — | 所有功能只能靠鼠标点按钮 |
| 快捷键硬编码 | EditorPanel.vue L347 window keydown 硬编码 Ctrl+S | 无按键解析层、不可配置、无冲突检测 |

好底子：三个管理弹窗（ModelSettings / McpSettings / RulesSkillsSettings）功能完整，只需加 `embedded` 属性即可内嵌复用；主题/权限模式/检查点均已在 Pinia store 中有现成 action（`theme.setTheme`、`chat.setPermissionMode`、`chat.toggleAutoCheckpoint`）。

## 二、目标

1. **命令注册表纯函数层**（零 electron/DOM，可单测）：命令定义、按键串解析/格式化、KeyboardEvent 匹配、模糊搜索打分、按键冲突检测、默认+用户覆盖 keymap 合并。
2. **命令面板**：`Ctrl+Shift+P` 唤起，模糊搜索 + ↑↓/Enter/Esc 键盘操作，执行注册命令。
3. **统一设置页**：Tab 聚合——通用（主题/权限模式/自动检查点）、模型、MCP、规则技能、快捷键；已有三个管理组件加 `embedded` 属性内嵌复用，不重复造管理 UI。
4. **可配置快捷键**：命令→按键映射持久化，设置页可录制改键、冲突提示、恢复默认。

## 三、文件改动

### 1. 新增 `src/shared/keymap.ts`（零依赖纯函数层）

新建 `src/shared/` 目录（main/renderer/vitest 三方共用，渲染端经相对路径 import，electron-vite 可正常打包）：

- 类型：`CommandDef { id, title, group, defaultKey? }`、`KeyStroke { ctrl, shift, alt, meta, key }`
- `parseAccelerator('Ctrl+Shift+P')` → `KeyStroke | null`（修饰词大小写不敏感、非法键返回 null；Mac 的 Cmd 归一到 meta）
- `formatAccelerator(KeyStroke)` → 规范化显示串（与 parse 往返一致）
- `matchKeyEvent(e: { ctrlKey, shiftKey, altKey, metaKey, key }, KeyStroke)`：修饰键严格相等 + 主键大小写不敏感（接口结构化，不依赖 DOM 类型）
- `fuzzyScore(query, text)` → `number | null`：子序列匹配，连续命中/词首命中加权，非子序列返回 null
- `searchCommands(query, commands)` → 按打分降序、同分按标题稳定排序
- `detectConflict(keymap: Record<string,string>)` → 同一按键绑到多个命令时返回冲突对
- `mergeKeymap(defaults, userOverrides)` → 用户覆盖优先，空串表示显式解绑

### 2. 新增 `src/shared/keymap.test.ts`（约 25 例）

parse/format 往返与非法输入、matchKeyEvent 修饰键严格性、fuzzyScore 子序列/连续加权/大小写、searchCommands 排序稳定性、detectConflict、mergeKeymap 覆盖与解绑。

`vitest.config.ts` include 增加 `src/shared/**/*.test.ts`。

### 3. 渲染端命令注册表 `src/renderer/src/commands/registry.ts`

- `useCommands()`：集中定义命令清单（约 14 条），执行体对接现有 store/弹窗开关：
  - 打开设置（默认 `Ctrl+,`）、设置-模型 / 设置-MCP / 设置-规则技能（直达对应 Tab）
  - 新建会话、会话历史、聚焦输入框、切换工具调用模式、停止当前任务（发送中时可用）
  - 切换主题（白→黑→蓝循环）、权限模式：只读/询问/自动、切换自动检查点
  - 切换 AI 面板显隐
- keymap 状态：localStorage `scholar-keymap` 持久化（与主题 localStorage 模式一致）；`rebind(id, key)` / `resetKeymap()`
- 初版不含「保存文件」：Ctrl+S 保留 EditorPanel 现有硬编码（涉及另存为弹窗内部状态，迁移成本大于收益，列入二期）

### 4. 新增 `CommandPalette.vue`（挂 App.vue 根级）

- `Ctrl+Shift+P` 全局唤起（window capture 阶段监听，确保 Monaco 内也能触发）；Esc/点击遮罩关闭
- 输入即搜（searchCommands），↑↓ 移动、Enter 执行并关闭；每条右侧显示当前生效按键（mergeKeymap 后）
- 复用 `.modal-overlay` / `cp-glass` 既有样式

### 5. 新增 `SettingsPanel.vue` 统一设置页

- 左侧 Tab 导航：通用 / 模型 / MCP / 规则技能 / 快捷键
- 通用：主题三选一（复用 theme store）、权限模式三段开关、自动检查点开关
- 模型/MCP/规则技能：给三个既有组件加 `embedded?: boolean` 属性——embedded 时渲染内容区、不渲染 overlay 外壳与关闭按钮（每个组件模板改动约 10 行）
- 快捷键 Tab：命令列表（分组/标题/当前按键），点击「改键」进入录制态（下一次按键组合落盘，Esc 取消）；冲突红字提示；「全部恢复默认」按钮
- ChatPanel 头部 3 个设置图标改为打开 SettingsPanel 对应 Tab（入口保留，弹窗统一）

### 6. 全局快捷键分发

- App.vue 挂 window keydown（capture 阶段）：遍历 keymap 匹配 `matchKeyEvent`，命中即 preventDefault + 执行对应命令；输入框/textarea 焦点下仅响应带修饰键的组合（避免误触）
- 命令面板自身的 Ctrl+Shift+P 也走同一分发器（注册表内置）

## 四、验证

1. 双端 `typecheck` 零错误（`src/shared` 被 tsconfig.web 经 import 拉入检查）
2. 全量 `vitest run`：359 → 约 384 例，只增不减
3. CDP 真窗冒烟（新端口 9380，临时探针用完即删）：
   - Ctrl+Shift+P 唤起面板、输入「模型」过滤、Enter 打开设置页模型 Tab
   - 快捷键 Tab 改键（绑定→localStorage 落盘→新键生效→恢复默认）
   - 冲突检测（两命令绑同键出提示）
   - 设置页五个 Tab 渲染、通用 Tab 主题切换生效
   - 回归：Ctrl+S 保存、ChatPanel 各入口按钮

## 五、二期不做

- 「保存文件」命令迁移（EditorPanel 另存为流程解耦后迁入注册表）
- 多键序列（chord，如 Ctrl+K Ctrl+S）、命令参数化（带输入框的命令）
- keymap 导出/导入、按工作区覆盖
