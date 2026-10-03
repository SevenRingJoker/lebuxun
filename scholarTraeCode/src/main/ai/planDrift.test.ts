// 计划-执行偏差检测单测（纯函数层，零 IO 依赖）。
// 覆盖：三类偏差命中/不命中、严重度聚合、缺省边界、计划文本匹配、
// 绝对/相对/中文路径、无 manifest 时不评估范围蔓延。
import { describe, it, expect } from 'vitest'
import { detectPlanDrift, formatDriftReport, type DriftInput } from './planDrift'
import type { TodoItem } from './todoManager'
import type { ArtifactManifest } from './validation'

/** 构造 todo 的快捷工厂 */
function todo(id: number, content: string, status: TodoItem['status']): TodoItem {
  return { id, content, status, priority: 'medium' }
}

/** 构造 manifest（仅 fileExists 规则） */
function manifest(paths: string[]): ArtifactManifest {
  return {
    id: 'm',
    rules: paths.map((p) => ({
      id: 'r' + p,
      description: '产物 ' + p,
      kind: 'fileExists',
      path: p
    }))
  }
}

function baseInput(over: Partial<DriftInput> = {}): DriftInput {
  return {
    todos: [],
    createdFiles: new Set<string>(),
    manifest: null,
    plan: null,
    ...over
  }
}

describe('detectPlanDrift 边界', () => {
  it('无 todos 且无 createdFiles → 空报告', () => {
    const r = detectPlanDrift(baseInput())
    expect(r.items).toHaveLength(0)
    expect(r.hasBlock).toBe(false)
    expect(r.hasWarn).toBe(false)
  })

  it('输入缺省（undefined）不抛异常', () => {
    const r = detectPlanDrift({ todos: [] as TodoItem[], createdFiles: new Set() })
    expect(r.items).toHaveLength(0)
  })
})

describe('unfinishedTodo 未完成步骤', () => {
  it('pending 与 in_progress 均报 warn，completed 不报', () => {
    const r = detectPlanDrift(
      baseInput({
        todos: [
          todo(1, '已做', 'completed'),
          todo(2, '没做', 'pending'),
          todo(3, '做一半', 'in_progress')
        ]
      })
    )
    expect(r.items).toHaveLength(2)
    expect(r.items.every((i) => i.kind === 'unfinishedTodo')).toBe(true)
    expect(r.hasWarn).toBe(true)
    expect(r.hasBlock).toBe(false)
    expect(r.items.find((i) => i.detail.includes('没做'))).toBeTruthy()
    expect(r.items.find((i) => i.detail.includes('进行中未完成'))).toBeTruthy()
  })
})

describe('missingArtifact 产物缺失', () => {
  it('已创建文件命中后缀模式不报，缺失报 block', () => {
    const r = detectPlanDrift(
      baseInput({
        createdFiles: new Set(['D:\\proj\\my-app\\package.json']),
        manifest: manifest(['my-app/package.json', 'my-app/src/main.js'])
      })
    )
    const missing = r.items.filter((i) => i.kind === 'missingArtifact')
    expect(missing).toHaveLength(1)
    expect(missing[0].detail).toContain('main.js')
    expect(r.hasBlock).toBe(true)
  })

  it('相对路径与绝对路径跨分隔符可匹配', () => {
    const r = detectPlanDrift(
      baseInput({
        createdFiles: new Set(['/home/u/proj/a/b.ts']),
        manifest: manifest(['a/b.ts'])
      })
    )
    expect(r.items.filter((i) => i.kind === 'missingArtifact')).toHaveLength(0)
  })

  it('整体相等（无父目录）也命中', () => {
    const r = detectPlanDrift(
      baseInput({
        createdFiles: new Set(['README.md']),
        manifest: manifest(['README.md'])
      })
    )
    expect(r.items).toHaveLength(0)
  })

  it('后缀必须为独立路径段，防止 package.json 匹配 xpackage.json', () => {
    const r = detectPlanDrift(
      baseInput({
        createdFiles: new Set(['my-app/xpackage.json']),
        manifest: manifest(['package.json'])
      })
    )
    expect(r.items.filter((i) => i.kind === 'missingArtifact')).toHaveLength(1)
  })
})

describe('unexpectedFile 计划外文件', () => {
  it('无 manifest 时不评估范围蔓延（避免误报）', () => {
    const r = detectPlanDrift(
      baseInput({
        createdFiles: new Set(['anything/random.txt'])
      })
    )
    expect(r.items).toHaveLength(0)
  })

  it('manifest 覆盖不到且 plan 文本也未提及 → warn', () => {
    const r = detectPlanDrift(
      baseInput({
        createdFiles: new Set([
          'D:\\proj\\my-app\\package.json',
          'D:\\proj\\my-app\\stray-note.txt'
        ]),
        manifest: manifest(['my-app/package.json']),
        plan: '创建 my-app 项目，包含 package.json'
      })
    )
    const unexpect = r.items.filter((i) => i.kind === 'unexpectedFile')
    expect(unexpect).toHaveLength(1)
    expect(unexpect[0].detail).toContain('stray-note.txt')
  })

  it('路径末 2/3 段在 plan 文本中出现即计划内（绝对路径 vs 相对写法）', () => {
    const r = detectPlanDrift(
      baseInput({
        createdFiles: new Set(['D:\\proj\\my-app\\src\\main.js']),
        manifest: manifest([]),
        plan: '创建 src/main.js 作为入口文件'
      })
    )
    expect(r.items.filter((i) => i.kind === 'unexpectedFile')).toHaveLength(0)
  })

  it('中文路径计划内匹配', () => {
    const r = detectPlanDrift(
      baseInput({
        createdFiles: new Set(['D:\\proj\\我的应用\\入口.js']),
        manifest: manifest([]),
        plan: '在 我的应用 目录创建 入口.js'
      })
    )
    expect(r.items).toHaveLength(0)
  })
})

describe('综合场景与格式化', () => {
  it('三类偏差同时存在时聚合正确', () => {
    const r = detectPlanDrift(
      baseInput({
        todos: [todo(1, '收尾', 'pending')],
        createdFiles: new Set(['D:\\proj\\app\\package.json', 'D:\\proj\\app\\extra.log']),
        manifest: manifest(['app/package.json', 'app/missing.js']),
        plan: '创建 app 项目含 package.json'
      })
    )
    expect(r.items).toHaveLength(3)
    expect(r.hasBlock).toBe(true)
    expect(r.hasWarn).toBe(true)
    const kinds = new Set(r.items.map((i) => i.kind))
    expect(kinds).toEqual(new Set(['unfinishedTodo', 'missingArtifact', 'unexpectedFile']))
  })

  it('formatDriftReport 无偏差返回空串', () => {
    expect(formatDriftReport(detectPlanDrift(baseInput()))).toBe('')
  })

  it('formatDriftReport 分三块列出且含关键产物缺失标题', () => {
    const r = detectPlanDrift(
      baseInput({
        todos: [todo(1, '收尾', 'pending')],
        createdFiles: new Set(['D:\\proj\\app\\extra.log']),
        manifest: manifest(['app/package.json']),
        plan: '创建 app'
      })
    )
    const text = formatDriftReport(r)
    expect(text).toContain('关键产物缺失 1 项')
    expect(text).toContain('未完成步骤 1 项')
    expect(text).toContain('计划外文件 1 个')
    expect(text).toContain('package.json')
  })

  it('只缺产物时不输出空的未完成/计划外标题', () => {
    const r = detectPlanDrift(
      baseInput({
        createdFiles: new Set<string>(),
        manifest: manifest(['a.js'])
      })
    )
    const text = formatDriftReport(r)
    expect(text).toContain('关键产物缺失')
    expect(text).not.toContain('未完成步骤')
    expect(text).not.toContain('计划外文件')
  })
})
