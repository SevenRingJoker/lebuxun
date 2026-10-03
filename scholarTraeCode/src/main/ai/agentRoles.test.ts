// s50 角色预设单测：白名单交集/角色判定/提示/冲突裁决 Prompt
import { describe, expect, it } from 'vitest'
import {
  ROLE_LIST,
  ROLE_PRESETS,
  SUMMARIZER_PROMPT,
  buildAcceptanceMergePrompt,
  buildConflictVerdictPrompt,
  isAgentRoleId,
  resolveRoleTools,
  roleSystemPrompt
} from './agentRoles'

const AVAILABLE = ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'gen_test_skeleton', 'mcp_xxx']

describe('s50 角色 Agent 预设', () => {
  it('三个预设角色齐全', () => {
    expect(ROLE_LIST.map((r) => r.id)).toEqual(['frontend', 'backend', 'test'])
    for (const r of ROLE_LIST) {
      expect(r.label).toContain('Agent')
      expect(r.toolWhitelist.length).toBeGreaterThan(0)
    }
  })

  it('isAgentRoleId', () => {
    expect(isAgentRoleId('frontend')).toBe(true)
    expect(isAgentRoleId('test')).toBe(true)
    expect(isAgentRoleId('hacker')).toBe(false)
    expect(isAgentRoleId(null)).toBe(false)
  })

  it('前端角色：无 bash，可写改前端文件', () => {
    const tools = resolveRoleTools('frontend', AVAILABLE)
    expect(tools).toContain('write')
    expect(tools).not.toContain('bash')
    expect(tools).not.toContain('gen_test_skeleton')
    expect(tools).not.toContain('mcp_xxx')
  })

  it('后端角色：持 bash 但无测试骨架工具', () => {
    const tools = resolveRoleTools('backend', AVAILABLE)
    expect(tools).toContain('bash')
    expect(tools).not.toContain('gen_test_skeleton')
  })

  it('测试角色：bash + gen_test_skeleton', () => {
    const tools = resolveRoleTools('test', AVAILABLE)
    expect(tools).toContain('bash')
    expect(tools).toContain('gen_test_skeleton')
  })

  it('白名单中不存在的工具被剔除（不产生幻觉工具）', () => {
    const tools = resolveRoleTools('test', ['read', 'grep'])
    expect(tools).toEqual(['read', 'grep'])
  })

  it('未知角色返回空工具集与空提示', () => {
    expect(resolveRoleTools('ceo', AVAILABLE)).toEqual([])
    expect(roleSystemPrompt('ceo')).toBe('')
  })

  it('解析结果保持可用工具原顺序（稳定）', () => {
    const reversed = [...AVAILABLE].reverse()
    const tools = resolveRoleTools('backend', reversed)
    expect(tools).toEqual(reversed.filter((n) => ROLE_PRESETS.backend.toolWhitelist.includes(n)))
  })

  it('角色提示非空且含角色边界', () => {
    expect(roleSystemPrompt('frontend')).toContain('前端')
    expect(roleSystemPrompt('test')).toContain('测试')
  })

  it('冲突裁决 Prompt 含冲突文件与各方报告', () => {
    const p = buildConflictVerdictPrompt(
      [{ path: 'src/a.ts', tasks: ['t1', 't2'] }],
      [
        { task: 't1', role: 'frontend', report: '我加了按钮' },
        { task: 't2', role: 'backend', report: '我加了接口字段' }
      ]
    )
    expect(p).toContain('src/a.ts')
    expect(p).toContain('t1')
    expect(p).toContain('t2')
    expect(p).toContain('按钮')
    expect(p).toContain('裁决')
  })

  it('无冲突时 Prompt 仍给出裁决框架', () => {
    const p = buildConflictVerdictPrompt([], [{ task: 't1', report: 'ok' }])
    expect(p).toContain('汇总 Agent')
  })

  it('验收合并 Prompt 含可交付结论要求', () => {
    const p = buildAcceptanceMergePrompt([{ task: 't1', role: 'test', report: '测试全过' }])
    expect(p).toContain('验收')
    expect(p).toContain('测试全过')
    expect(p).toContain('可交付')
  })

  it('汇总 Agent 系统提示存在', () => {
    expect(SUMMARIZER_PROMPT).toContain('汇总 Agent')
  })
})
