// LSP 多服务器：服务器选择 / 扩展名路由 / Vue 工作区探测 纯逻辑单测
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import {
  chooseServerKind,
  isHandledExt,
  detectVueWorkspace,
  resolveTsdk,
  TS_FAMILY_EXTS,
  VUE_SCAN_MAX_ENTRIES,
  VUE_SCAN_MAX_DEPTH
} from './lsp'

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'lsp-scan-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('chooseServerKind — 默认服务器选择', () => {
  it('工作区含 .vue → vue（Take Over）', () => {
    expect(chooseServerKind(true)).toBe('vue')
  })
  it('工作区无 .vue → ts（维持现状）', () => {
    expect(chooseServerKind(false)).toBe('ts')
  })
})

describe('isHandledExt — 扩展名路由', () => {
  it('TS 全家桶在两种模式下都被处理', () => {
    for (const ext of TS_FAMILY_EXTS) {
      expect(isHandledExt(ext, 'ts')).toBe(true)
      expect(isHandledExt(ext, 'vue')).toBe(true)
    }
  })

  it('ts 模式不处理 .vue', () => {
    expect(isHandledExt('vue', 'ts')).toBe(false)
  })

  it('vue 模式额外处理 .vue（能力合并）', () => {
    expect(isHandledExt('vue', 'vue')).toBe(true)
  })

  it('归一化大小写、前导点与无关扩展名', () => {
    expect(isHandledExt('TS', 'ts')).toBe(true)
    expect(isHandledExt('.Vue', 'vue')).toBe(true)
    expect(isHandledExt('css', 'ts')).toBe(false)
    expect(isHandledExt('css', 'vue')).toBe(false)
    expect(isHandledExt('md', 'vue')).toBe(false)
  })
})

describe('detectVueWorkspace — 受限工作区探测', () => {
  it('根目录不存在时安全回落 false', () => {
    expect(detectVueWorkspace(join(root, 'no-such-dir'))).toBe(false)
  })

  it('空工作区 → false', () => {
    const dir = join(root, 'empty')
    mkdirSync(dir)
    expect(detectVueWorkspace(dir)).toBe(false)
  })

  it('仅含 TS 文件 → false', () => {
    const dir = join(root, 'ts-only')
    mkdirSync(dir)
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1')
    writeFileSync(join(dir, 'b.js'), 'const b = 2')
    expect(detectVueWorkspace(dir)).toBe(false)
  })

  it('浅层 .vue → true', () => {
    const dir = join(root, 'shallow-vue')
    mkdirSync(dir)
    writeFileSync(join(dir, 'App.vue'), '<template></template>')
    expect(detectVueWorkspace(dir)).toBe(true)
  })

  it('深层嵌套 .vue → true（默认深度内）', () => {
    const dir = join(root, 'deep-vue')
    const nested = join(dir, 'src', 'views', 'user', 'profile')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'Card.vue'), '<template></template>')
    expect(detectVueWorkspace(dir)).toBe(true)
  })

  it('node_modules 内的 .vue 被跳过', () => {
    const dir = join(root, 'deps-vue')
    const pkg = join(dir, 'node_modules', 'some-lib', 'dist')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'bundle.vue'), '<template></template>')
    expect(detectVueWorkspace(dir)).toBe(false)
  })

  it('其他跳过目录（dist/.git/.trae）中的 .vue 不命中', () => {
    const dir = join(root, 'skip-dirs')
    for (const skip of ['dist', '.git', '.trae']) {
      mkdirSync(join(dir, skip), { recursive: true })
      writeFileSync(join(dir, skip, 'x.vue'), '<template></template>')
    }
    expect(detectVueWorkspace(dir)).toBe(false)
  })

  it('超过 maxDepth 的 .vue → false', () => {
    const dir = join(root, 'too-deep')
    const nested = join(dir, 'a', 'b', 'c', 'd', 'e')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'Deep.vue'), '<template></template>')
    expect(detectVueWorkspace(dir, { maxDepth: 3 })).toBe(false)
  })

  it('超过 maxEntries 时安全回落 false', () => {
    const dir = join(root, 'too-many')
    mkdirSync(dir)
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(dir, `f${i}.ts`), `export const f${i} = ${i}`)
    }
    // readdir 按名排序：f*.ts 先于 z.vue 被计数，4 个条目后即中止
    writeFileSync(join(dir, 'z.vue'), '<template></template>')
    expect(detectVueWorkspace(dir, { maxEntries: 4 })).toBe(false)
    // 放宽上限后可命中
    expect(detectVueWorkspace(dir)).toBe(true)
  })

  it('中文路径中的 .vue → true', () => {
    const dir = join(root, '中文-项目')
    mkdirSync(dir)
    writeFileSync(join(dir, '组件.vue'), '<template></template>')
    expect(detectVueWorkspace(dir)).toBe(true)
  })

  it('默认上限常量是正数且深度有限', () => {
    expect(VUE_SCAN_MAX_ENTRIES).toBeGreaterThan(0)
    expect(VUE_SCAN_MAX_DEPTH).toBeGreaterThan(0)
  })
})

describe('resolveTsdk — 运行时 TypeScript 位置', () => {
  it('指向 typescript/lib 且 tsserver.js 存在', () => {
    const tsdk = resolveTsdk()
    expect(tsdk.replace(/\\/g, '/').endsWith('/lib')).toBe(true)
    expect(existsSync(join(tsdk, 'tsserver.js'))).toBe(true)
    expect(existsSync(join(tsdk, 'typescript.js'))).toBe(true)
  })
})
