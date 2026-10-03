// s50 多 Agent 并行编排——角色 Agent 预设（纯函数层，零 IO）：
// 前端 / 后端 / 测试 三个预设角色，各持独立上下文与工具白名单；
// 另提供汇总 Agent 的冲突裁决 Prompt 构建（冲突文件 + 各方报告 → 裁决指令）。

/** 预设角色 id */
export type AgentRoleId = 'frontend' | 'backend' | 'test'

/** 角色预设定义 */
export interface AgentRolePreset {
  id: AgentRoleId
  /** 中文标签（看板分派/UI 展示） */
  label: string
  description: string
  /** 工具白名单（按工具精确名；最终与实际可用工具取交集） */
  toolWhitelist: string[]
  /** 系统提示后缀：角色职责边界 */
  prompt: string
}

/**
 * 只读类工具对所有角色开放；写改工具各角色都需要；
 * bash（跑服务/测试）仅后端、测试角色持有；gen_test_skeleton 仅测试角色。
 */
export const ROLE_PRESETS: Record<AgentRoleId, AgentRolePreset> = {
  frontend: {
    id: 'frontend',
    label: '前端 Agent',
    description: '负责界面与交互：.vue/.css/.html/.tsx 等前端文件',
    toolWhitelist: ['read', 'grep', 'glob', 'write', 'edit'],
    prompt:
      '你是前端 Agent，只负责界面渲染、交互与样式相关文件（.vue/.css/.html/.tsx/.jsx）。' +
      '不得修改服务端接口、数据库或测试基础设施；改动保持科技蓝青暗色风格一致。'
  },
  backend: {
    id: 'backend',
    label: '后端 Agent',
    description: '负责服务逻辑与接口：.ts 服务端、数据模型、构建配置',
    toolWhitelist: ['read', 'grep', 'glob', 'write', 'edit', 'bash'],
    prompt:
      '你是后端 Agent，只负责服务端逻辑、API、数据模型与构建配置。' +
      '可以用 bash 启动/验证服务，但不得改动 UI 组件与样式；接口变更需保持向后兼容。'
  },
  test: {
    id: 'test',
    label: '测试 Agent',
    description: '负责测试补齐与回归：测试文件 + 用 bash 跑测试',
    toolWhitelist: ['read', 'grep', 'glob', 'write', 'edit', 'bash', 'gen_test_skeleton'],
    prompt:
      '你是测试 Agent，负责补齐/修复测试并运行回归（vitest 等）。' +
      '测试文件与被测文件同目录就近放置；只在测试无法通过且确属实现缺陷时，最小改动实现代码。'
  }
}

/** 全部预设列表（编排器下拉/校验） */
export const ROLE_LIST: AgentRolePreset[] = [ROLE_PRESETS.frontend, ROLE_PRESETS.backend, ROLE_PRESETS.test]

/** 判定是否为合法角色 id */
export function isAgentRoleId(id: unknown): id is AgentRoleId {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(ROLE_PRESETS, id)
}

/**
 * 解析某角色实际可用工具：白名单 ∩ 当前可用工具名（保持可用工具原顺序，稳定）。
 * 未知角色或不可用工具一律剔除，绝不把白名单幻觉传给模型。
 */
export function resolveRoleTools(role: AgentRoleId | unknown, availableNames: string[]): string[] {
  if (!isAgentRoleId(role)) return []
  const allow = new Set(ROLE_PRESETS[role].toolWhitelist)
  return availableNames.filter((n) => allow.has(n))
}

/** 取角色系统提示（未知角色返回空串） */
export function roleSystemPrompt(role: AgentRoleId | unknown): string {
  return isAgentRoleId(role) ? ROLE_PRESETS[role].prompt : ''
}

// ===== 汇总 Agent：冲突裁决与验收合并 =====

export interface ConflictInput {
  path: string
  tasks: string[]
}

export interface SubReportInput {
  task: string
  role?: AgentRoleId | null
  report: string
}

/**
 * 构建汇总 Agent 的冲突裁决消息（user 角色单条）：
 * 列出冲突文件、涉及子任务与各方报告，要求选择保留方案或给出合并内容。
 */
export function buildConflictVerdictPrompt(conflicts: ConflictInput[], reports: SubReportInput[]): string {
  const lines: string[] = ['你是汇总 Agent，需要对多 Agent 并行执行中的文件冲突做出裁决。']
  lines.push('## 冲突文件')
  for (const c of conflicts) {
    lines.push(`- ${c.path}（涉及：${c.tasks.join('、')}）`)
  }
  lines.push('## 各方报告')
  for (const r of reports) {
    lines.push(`### ${r.task}${r.role ? `（${ROLE_PRESETS[r.role]?.label ?? r.role}）` : ''}`)
    lines.push(r.report)
  }
  lines.push(
    '## 裁决要求\n' +
      '逐文件给出：保留哪一方的版本（或合并双方哪些内容）+ 一句话理由；' +
      '无法自动合并时标记为「需人工」并说明分歧点。'
  )
  return lines.join('\n')
}

/**
 * 汇总 Agent 系统提示：冲突裁决与验收合并的角色底座。
 */
export const SUMMARIZER_PROMPT =
  '你是汇总 Agent，不直接写业务代码：负责合并各角色 Agent 的产物、裁决文件冲突、' +
  '核对验收证据。只基于各方报告与冲突清单做决定，不臆造未提供的文件内容。'

/** 验收合并：各方报告 → 汇总结论的结构化骨架（纯文本标题，供模型填充） */
export function buildAcceptanceMergePrompt(reports: SubReportInput[]): string {
  const lines = ['请合并以下各角色 Agent 的执行结果，给出验收结论：']
  for (const r of reports) {
    lines.push(`- ${r.task}${r.role ? `（${ROLE_PRESETS[r.role]?.label ?? r.role}）` : ''}：${r.report}`)
  }
  lines.push('输出：① 各文件最终归属 ② 待补验收证据 ③ 总体是否可交付（是/否 + 理由）。')
  return lines.join('\n')
}
