// s46 测试自动生成与受影响回归圈定（纯函数层，零 IO）。
//
// 两个职责：
//   1) buildTestSkeleton：按源码导出符号生成 vitest 用例骨架（describe + it.todo），
//      AI 填断言、人审入库（骨架经暂存区落盘）。
//   2) affectedTests：变更落盘后，用 s42 索引的 imports 反查「受影响测试子集」——
//      变更文件的同名测试 + 直接引用者 + 引用者的同名测试。
import type { CodeSymbol } from './codeParse'
import type { CodeIndex } from './indexer'

/** 测试文件判定：xxx.test.ts / xxx.spec.ts / __tests__ 目录 */
export function isTestFile(rel: string): boolean {
  return /(?:\.(?:test|spec)\.[a-z]+$)|(?:^|\/)(?:__tests__|tests?)\//i.test(rel)
}

/** 源码文件 → 期望的同名测试文件路径（src/foo.ts → src/foo.test.ts） */
export function testFileFor(rel: string): string {
  return rel.replace(/\.([a-z]+)$/i, '.test.$1')
}

/** 测试文件 → 被测源码路径（src/foo.test.ts → src/foo.ts） */
export function sourceFileFor(rel: string): string {
  return rel.replace(/\.(?:test|spec)\.([a-z]+)$/i, '.$1')
}

/** 骨架只覆盖纯函数与方法（类/接口/类型跳过——骨架无断言价值低） */
const SKEL_KINDS = new Set(['function', 'method'])

/**
 * 生成 vitest 用例骨架。
 * @param sourceRel 源码相对路径（正斜杠）
 * @param symbols   源码导出符号
 * @returns 骨架文本；无可测符号返回 null
 */
export function buildTestSkeleton(sourceRel: string, symbols: CodeSymbol[]): string | null {
  const fns = [...new Set(symbols.filter((s) => SKEL_KINDS.has(s.kind)).map((s) => s.name))]
  if (fns.length === 0) return null
  const testRel = testFileFor(sourceRel)
  // import 路径：测试与源码同目录（foo.test.ts 引 ./foo），去扩展名
  const importPath = './' + sourceRel.split('/').pop()!.replace(/\.[a-z]+$/i, '')
  const its = fns
    .map((n) => `  describe('${n}', () => {\n    it.todo('基本行为') // TODO: AI 填充断言\n  })`)
    .join('\n\n')
  return (
    `// 由「为改动补测试」生成的骨架：AI 填充断言后人审入库\n` +
    `import { describe, expect, it } from 'vitest'\n` +
    `import { ${fns.join(', ')} } from '${importPath}'\n\n` +
    `describe('${sourceRel.split('/').pop()}', () => {\n${its}\n})\n` +
    `// 防误删：expect 引入占位\nvoid expect\n`
  )
}

/**
 * 解析 import 说明符到索引内的 relPath。
 * 仅处理相对说明符（./ ../）；包说明符（裸名）返回 null。
 * 尝试扩展名补齐与 /index 解析，与 index.files 键（正斜杠相对路径）对齐。
 */
export function resolveImport(index: CodeIndex, importerRel: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const dir = importerRel.includes('/') ? importerRel.slice(0, importerRel.lastIndexOf('/')) : ''
  const parts = (dir ? dir + '/' + spec : spec).split('/')
  const stack: string[] = []
  for (const p of parts) {
    if (p === '' || p === '.') continue
    if (p === '..') stack.pop()
    else stack.push(p)
  }
  const base = stack.join('/')
  const candidates = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.vue`, `${base}.py`,
    `${base}/index.ts`, `${base}/index.js`, `${base}/index.vue`, `${base}/index.py`
  ]
  for (const c of candidates) {
    if (index.files[c]) return c
  }
  return null
}

/**
 * 受影响测试圈定：
 * - 变更本身是测试 → 含自身；
 * - 变更是源码 → 同名测试（索引内存在）+ 直接 import 它的文件（一跳）+ 这些文件的同名测试；
 * - 结果去重、只含索引内真实存在的测试文件，按路径排序（输出稳定）。
 */
export function affectedTests(index: CodeIndex, changedRels: string[]): string[] {
  const out = new Set<string>()
  // 反查表：被引用文件 → 引用者清单
  const importersOf = new Map<string, string[]>()
  for (const [rel, f] of Object.entries(index.files)) {
    for (const spec of f.imports) {
      const target = resolveImport(index, rel, spec)
      if (!target) continue
      const arr = importersOf.get(target) ?? []
      arr.push(rel)
      importersOf.set(target, arr)
    }
  }

  const seeds = new Set<string>(changedRels)
  for (const rel of changedRels) {
    if (isTestFile(rel)) {
      out.add(rel)
      // 测试文件变更也视同其源码变更（源码的引用者测试一并回归）
      seeds.add(sourceFileFor(rel))
      continue
    }
    const own = testFileFor(rel)
    if (index.files[own]) out.add(own)
  }
  // 一跳引用者 + 其同名测试
  for (const seed of seeds) {
    for (const importer of importersOf.get(seed) ?? []) {
      if (isTestFile(importer)) {
        out.add(importer)
      } else {
        const t = testFileFor(importer)
        if (index.files[t]) out.add(t)
      }
    }
  }
  return [...out].sort()
}
