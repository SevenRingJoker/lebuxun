// virtualFs 单测：路径劫持矩阵 + 角色提示词 + 三模型开关。
import { describe, it, expect } from 'vitest'
import { resolveVfsPath, roleEnvironmentHint, isThreeModelMode } from './virtualFs'
import { resolve, normalize, sep } from 'node:path'

const WS = normalize('D:/workspace')

describe('resolveVfsPath', () => {
  it('相对路径 + targetDir → 解析到 targetDir 下', () => {
    const r = resolveVfsPath('package.json', WS, 'vue2-project')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.absPath).toBe(normalize(resolve(WS, 'vue2-project/package.json')))
  })

  it('相对路径无 targetDir → 解析到 workspace 根', () => {
    const r = resolveVfsPath('package.json', WS, null)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.absPath).toBe(normalize(resolve(WS, 'package.json')))
  })

  it('嵌套相对路径 + targetDir', () => {
    const r = resolveVfsPath('src/main.js', WS, 'vue2-project')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.absPath).toBe(normalize(resolve(WS, 'vue2-project/src/main.js')))
  })

  it('绝对路径在 workspace 内 → 原样返回', () => {
    const r = resolveVfsPath(`${WS}${sep}vue2-project${sep}package.json`, WS, 'vue2-project')
    expect(r.ok).toBe(true)
  })

  it('绝对路径越出 workspace → 拒绝', () => {
    const r = resolveVfsPath('C:/Windows/System32/evil.dll', WS, 'vue2-project')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('越出工作区')
  })

  it('.. 上跳越出 workspace → 拒绝', () => {
    const r = resolveVfsPath('../../evil.js', WS, 'vue2-project')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('上跳')
  })

  it('.. 上跳但不越界 → 放行', () => {
    const r = resolveVfsPath('src/../package.json', WS, 'vue2-project')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.absPath).toBe(normalize(resolve(WS, 'vue2-project/package.json')))
  })

  it('空路径 → 拒绝', () => {
    expect(resolveVfsPath('', WS, 'x').ok).toBe(false)
    expect(resolveVfsPath('   ', WS, 'x').ok).toBe(false)
  })

  it('workspace 未指定 → 拒绝', () => {
    expect(resolveVfsPath('a.js', '', 'x').ok).toBe(false)
  })

  it('targetDir 为 . 时解析到 workspace 根', () => {
    const r = resolveVfsPath('package.json', WS, '.')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.absPath).toBe(normalize(resolve(WS, 'package.json')))
  })
})

describe('roleEnvironmentHint', () => {
  it('planner 提示词含 DAG 要求', () => {
    const h = roleEnvironmentHint('planner', 'vue2-project')
    expect(h).toContain('规划器')
    expect(h).toContain('vue2-project')
    expect(h).toContain('dag')
  })

  it('executor 提示词禁止绝对路径', () => {
    const h = roleEnvironmentHint('executor', 'vue2-project')
    expect(h).toContain('执行器')
    expect(h).toContain('禁止输出绝对路径')
    expect(h).toContain('vue2-project/')
  })

  it('coder 提示词要求完整内容非 diff', () => {
    const h = roleEnvironmentHint('coder', null)
    expect(h).toContain('代码修复器')
    expect(h).toContain('完整内容')
    expect(h).toContain('patch')
  })
})

describe('isThreeModelMode', () => {
  it('三个角色模型齐备 → true', () => {
    expect(
      isThreeModelMode(['ollama:qwen3:14b', 'ollama:qwen3:8b', 'ollama:deepseek-coder-v2:lite'])
    ).toBe(true)
  })

  it('自适应模式：任意可用模型 ≥1 → true（由 adaptiveScheduler 按画像选择）', () => {
    expect(isThreeModelMode(['ollama:qwen3:14b', 'ollama:qwen3:8b'])).toBe(true)
    expect(isThreeModelMode(['ollama:qwen3:8b'])).toBe(true)
    expect(isThreeModelMode(['ollama:llama3:8b'])).toBe(true)
  })

  it('空清单 → false', () => {
    expect(isThreeModelMode([])).toBe(false)
  })

  it('含额外模型 → true（只检查必需项）', () => {
    expect(
      isThreeModelMode([
        'ollama:qwen3:14b',
        'ollama:qwen3:8b',
        'ollama:deepseek-coder-v2:lite',
        'openai:gpt-4'
      ])
    ).toBe(true)
  })
})
