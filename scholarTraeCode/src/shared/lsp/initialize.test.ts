// initialize.ts 单测：服务器种类守卫、initialize 参数构建、Volar 初始化选项分支
import { describe, it, expect } from 'vitest'
import {
  isLspServerKind,
  LSP_CLIENT_CAPABILITIES,
  buildVueInitializationOptions,
  buildInitializeParams
} from './initialize'

describe('isLspServerKind — 种类守卫', () => {
  it('ts / vue 命中', () => {
    expect(isLspServerKind('ts')).toBe(true)
    expect(isLspServerKind('vue')).toBe(true)
  })
  it('其他值不命中', () => {
    expect(isLspServerKind('eslint')).toBe(false)
    expect(isLspServerKind(null)).toBe(false)
    expect(isLspServerKind(undefined)).toBe(false)
    expect(isLspServerKind(123)).toBe(false)
  })
})

describe('LSP_CLIENT_CAPABILITIES — 共享能力声明', () => {
  it('覆盖现有 7 类能力', () => {
    const td = LSP_CLIENT_CAPABILITIES.textDocument
    expect(td.completion).toBeDefined()
    expect(td.hover).toBeDefined()
    expect(td.definition).toBeDefined()
    expect(td.references).toBeDefined()
    expect(td.rename).toBeDefined()
    expect(td.documentFormatting).toBeDefined()
    expect(td.codeAction).toBeDefined()
  })
  it('声明 workspace.applyEdit', () => {
    expect(LSP_CLIENT_CAPABILITIES.workspace.applyEdit).toBe(true)
  })
})

describe('buildVueInitializationOptions', () => {
  it('携带 tsdk 且显式关闭 hybridMode（Take Over）', () => {
    const opts = buildVueInitializationOptions('d:/proj/node_modules/typescript/lib')
    expect(opts.typescript.tsdk).toBe('d:/proj/node_modules/typescript/lib')
    expect(opts.typescript.disableAutoImportCache).toBe(false)
    expect(opts.vue.hybridMode).toBe(false)
  })
})

describe('buildInitializeParams — initialize 参数分支', () => {
  it('公共字段：processId/rootUri/capabilities/clientInfo', () => {
    const p = buildInitializeParams('ts', 'd:\\proj')
    expect(p.processId).toBeNull()
    expect(p.rootUri).toBe('file:///d:/proj')
    expect(p.capabilities).toBe(LSP_CLIENT_CAPABILITIES)
    expect(p.clientInfo).toEqual({ name: 'ScholarTreaCode', version: '0.1.0' })
  })

  it('ts 模式不带 initializationOptions', () => {
    const p = buildInitializeParams('ts', 'd:\\proj')
    expect(p.initializationOptions).toBeUndefined()
  })

  it('vue 模式带 initializationOptions（tsdk 透传）', () => {
    const p = buildInitializeParams('vue', 'd:\\proj', 'd:/proj/node_modules/typescript/lib')
    expect(p.initializationOptions).toBeDefined()
    expect(p.initializationOptions?.typescript.tsdk).toBe('d:/proj/node_modules/typescript/lib')
    expect(p.initializationOptions?.vue.hybridMode).toBe(false)
  })

  it('vue 模式未提供 tsdk 时回落空串（不崩溃）', () => {
    const p = buildInitializeParams('vue', null)
    expect(p.rootUri).toBeNull()
    expect(p.initializationOptions?.typescript.tsdk).toBe('')
  })
})
