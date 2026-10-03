---
name: p-item-delivery
description: Deliver a numbered roadmap capability item (P-item, such as P4 ㉙-㊲) in ScholarTreaCode, covering plan doc, pure-function layer with unit tests, thin scheduler wiring, three-part verification and doc updates. Use when the user asks to execute or continue a numbered capability item. Do not use for one-off bug fixes, generic Q&A, or unplanned refactors.
---

# P 项能力交付流程（ScholarTreaCode 专用）

执行路线图中编号能力项（㉙/㉛/㉚ 这类 P 项）时严格按本流程，不得跳步、不得扩大范围。

## 1. 调研与计划（先确认，后写码）

1. 用 Grep/Read 精读相关模块，确定：数据从哪来、现有设施能否复用、统一边界/接线点在哪。
2. 在 `.trae/documents/` 写计划文档，命名 `<编号简写>-<中文名称>-计划.md`，包含六节：
   - 现状与缺口（现有机制覆盖不到什么）
   - 目标
   - 纯函数设计（类型签名、规则表、边界行为）
   - 接线点（具体文件与位置）
   - 不做什么（显式冻结范围）
   - 验证方式
3. 用 NotifyUser 或简短汇报请用户确认；**用户明确批准前不写任何实现代码**。

## 2. 实现分层

- **纯函数层**：核心逻辑放 `src/main/ai/<name>.ts`，零 IO / 零 Electron 依赖；规则采用数据驱动模式表（参考 `terminal/commandError.ts`、`ai/bashGate.ts`）。
- **薄壳接线**：在 `scheduler.ts`（或对应 handler）调用纯函数，不把规则逻辑堆进主循环；能用单点出口覆盖（如 `callMcpTool`）就不分散接线。
- TS 文件一律写**中文注释**，注释说明「为什么」，接口导出 JSDoc 说明契约。
- 不创建计划外文件，不重构无关代码。

## 3. 单测（计数只增不减）

- 与纯函数同目录建 `<name>.test.ts`，纳入 vitest 既有 include，无需改配置。
- 必盖：命中 / 不命中、缺省与空输入边界、严重度或结果聚合、误报控制（独立路径段、短值、普通变量名等）、绝对/相对/中文路径。
- 用工厂函数构造输入，保持用例可读。

## 4. 验证三件套（缺一不可）

PowerShell 环境不支持 `&&`，用 `;` 或分多次执行：

1. `npm run typecheck` —— 主进程 + 渲染进程双端零错误；
2. `npx vitest run` —— **全量**套件全绿，核对总用例数较基线只增不减；
3. `npx electron-vite build` —— 构建成功。

CDP 真窗冒烟：UI/交互变更或场景可稳定复现时执行（`npm run dev -- --remote-debugging-port=<port>` + CDP 脚本驱动，临时脚本用完即删）。
若逻辑全在纯函数层且真机场景不可控、不可重复，可用确定性单测 + 三件套替代，但必须在汇报与《日志.md》中说明理由。
注意：Pinia store 变更在 dev 下可能不被 HMR 热替换，冒烟异常时先重启 dev 再判断。

## 5. 更新文档（交付的一部分）

- **《项目结构说明.md》**：7.1 能力路线图表格新增一行（编号/名称/落地内容摘要/后续可选项/所属 P 段）；7.2 新增该条目详细设计小节（设计要点 + 单测数 + 验证结论）。
- **《日志.md》**：更新开头最近更新日期与进度总览（已交付项范围、测试基线数字）；对应 P 段新增实施记录（含文件绝对链接）与状态表。
- 测试基线数字、新增用例数必须与实际 vitest 输出一致，禁止虚报。

## 6. 汇报风格

- 简短中文摘要：改动了什么、验证结果（基线 → 新数字）、下一步建议；
- 不贴工具原始输出，不暴露工具调用细节；
- 文件引用使用可点击绝对链接（file:/// 格式）。
