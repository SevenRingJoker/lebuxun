// semanticValidator.ts 单元测试：包名归一化、import 提取、依赖闭环差集、
// 修复提示词构建、补丁解析容错、补丁预检（边界 + 语法）。
import { describe, expect, it } from 'vitest'
import {
  normalizePackageName,
  extractImportSpecifiers,
  checkDependencyClosure,
  buildCoderRepairPrompt,
  parseCoderPatches,
  validatePatches
} from './semanticValidator'

describe('normalizePackageName', () => {
  it('普通包原样返回', () => {
    expect(normalizePackageName('vue')).toBe('vue')
    expect(normalizePackageName('lodash')).toBe('lodash')
  })

  it('子路径截取到包根', () => {
    expect(normalizePackageName('vue/dist/vue.js')).toBe('vue')
    expect(normalizePackageName('lodash/debounce')).toBe('lodash')
  })

  it('scoped 包保留 scope', () => {
    expect(normalizePackageName('@vue/cli-service')).toBe('@vue/cli-service')
    expect(normalizePackageName('@vue/cli-service/lib/xx')).toBe('@vue/cli-service')
  })

  it('相对路径返回 null', () => {
    expect(normalizePackageName('./foo')).toBeNull()
    expect(normalizePackageName('../bar/baz')).toBeNull()
    expect(normalizePackageName('.a')).toBeNull()
  })

  it('绝对路径 / 盘符路径返回 null', () => {
    expect(normalizePackageName('/usr/lib/x')).toBeNull()
    expect(normalizePackageName('C:\\proj\\x')).toBeNull()
    expect(normalizePackageName('d:/proj/x')).toBeNull()
  })

  it('node: 前缀返回 null', () => {
    expect(normalizePackageName('node:fs')).toBeNull()
    expect(normalizePackageName('node:path')).toBeNull()
  })

  it('@/ 别名返回 null', () => {
    expect(normalizePackageName('@/components/Hello')).toBeNull()
  })

  it('空串 / 残缺 scope 返回 null', () => {
    expect(normalizePackageName('')).toBeNull()
    expect(normalizePackageName('@')).toBeNull()
    expect(normalizePackageName('@scope')).toBeNull()
    expect(normalizePackageName('@/')).toBeNull()
  })
})

describe('extractImportSpecifiers', () => {
  it('提取 import from', () => {
    const specs = extractImportSpecifiers(`import Vue from 'vue'\nimport { a, b } from "lodash"`)
    expect(specs).toContain('vue')
    expect(specs).toContain('lodash')
  })

  it('提取裸 import', () => {
    expect(extractImportSpecifiers(`import 'reflect-metadata'`)).toContain('reflect-metadata')
  })

  it('提取 export from', () => {
    expect(extractImportSpecifiers(`export { x } from './mod'\nexport * from 'pkg-x'`)).toEqual(
      expect.arrayContaining(['./mod', 'pkg-x'])
    )
  })

  it('提取 require', () => {
    expect(extractImportSpecifiers(`const a = require('fs')\nconst b = require("axios")`)).toEqual(
      expect.arrayContaining(['fs', 'axios'])
    )
  })

  it('提取动态 import', () => {
    expect(extractImportSpecifiers(`const m = await import('vue-router')`)).toContain('vue-router')
  })

  it('无导入返回空数组', () => {
    expect(extractImportSpecifiers('const x = 1')).toEqual([])
  })
})

describe('checkDependencyClosure', () => {
  const pkgJson = JSON.stringify({
    dependencies: { vue: '^2.6.14', axios: '^1.0.0' },
    devDependencies: { jest: '^29.0.0' }
  })

  it('全部命中声明时无问题', () => {
    const files = new Map([['src/main.js', `import Vue from 'vue'\nimport axios from 'axios'`]])
    expect(checkDependencyClosure(files, pkgJson)).toEqual([])
  })

  it('未声明包报缺失并按包聚合引用文件', () => {
    const files = new Map([
      ['src/a.js', `import _ from 'lodash'`],
      ['src/b.js', `import { debounce } from 'lodash/debounce'`],
      ['src/c.js', `import dayjs from 'dayjs'`]
    ])
    const issues = checkDependencyClosure(files, pkgJson)
    expect(issues).toHaveLength(2)
    const lodash = issues.find((i) => i.package === 'lodash')
    expect(lodash?.referencedBy).toEqual(['src/a.js', 'src/b.js'])
    const dayjs = issues.find((i) => i.package === 'dayjs')
    expect(dayjs?.referencedBy).toEqual(['src/c.js'])
  })

  it('相对导入与内置模块跳过', () => {
    const files = new Map([
      ['src/a.js', `import x from './x'\nimport fs from 'fs'\nimport p from 'node:path'\nimport y from '@/y'`]
    ])
    expect(checkDependencyClosure(files, pkgJson)).toEqual([])
  })

  it('scoped 包按 scope/name 匹配声明', () => {
    const files = new Map([['src/a.js', `import x from '@vue/cli-service/lib/a'`]])
    const pkg = JSON.stringify({ devDependencies: { '@vue/cli-service': '^5.0.0' } })
    expect(checkDependencyClosure(files, pkg)).toEqual([])
  })

  it('package.json 解析失败时所有外部引用报缺失', () => {
    const files = new Map([['src/a.js', `import vue from 'vue'`]])
    const issues = checkDependencyClosure(files, 'not-json')
    expect(issues).toHaveLength(1)
    expect(issues[0].package).toBe('vue')
  })

  it('接受普通对象（非 Map）作为 files', () => {
    const issues = checkDependencyClosure({ 'a.js': `import x from 'xxx'` }, pkgJson)
    expect(issues.map((i) => i.package)).toEqual(['xxx'])
  })

  it('空文件集返回空', () => {
    expect(checkDependencyClosure(new Map(), pkgJson)).toEqual([])
  })

  it('结果按包名排序', () => {
    const files = new Map([['a.js', `import b from 'bbb'\nimport a from 'aaa'\nimport c from 'ccc'`]])
    const issues = checkDependencyClosure(files, '{}')
    expect(issues.map((i) => i.package)).toEqual(['aaa', 'bbb', 'ccc'])
  })
})

describe('buildCoderRepairPrompt', () => {
  it('包含缺失清单、文件内容与输出格式要求', () => {
    const issues = [{ package: 'lodash', referencedBy: ['src/a.js'] }]
    const files = new Map([['src/a.js', `import _ from 'lodash'`]])
    const p = buildCoderRepairPrompt(issues, files)
    expect(p).toContain('lodash')
    expect(p).toContain('src/a.js')
    expect(p).toContain("import _ from 'lodash'")
    expect(p).toContain('```patch')
  })

  it('超长文件内容截断', () => {
    const issues = [{ package: 'x', referencedBy: ['a.js'] }]
    const big = 'x'.repeat(5000)
    const p = buildCoderRepairPrompt(issues, { 'a.js': big })
    expect(p).toContain('...(截断)')
    expect(p.length).toBeLessThan(big.length + 2000)
  })
})

describe('parseCoderPatches', () => {
  it('解析单个补丁', () => {
    const text = '前言\n```patch\n{"file":"src/a.js","content":"console.log(1)"}\n```\n后记'
    const r = parseCoderPatches(text)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.patches).toHaveLength(1)
      expect(r.patches[0].file).toBe('src/a.js')
      expect(r.patches[0].content).toBe('console.log(1)')
    }
  })

  it('解析多个补丁', () => {
    const text =
      '```patch\n{"file":"a.js","content":"1"}\n```\n中间说明\n```patch\n{"file":"b.js","content":"2"}\n```'
    const r = parseCoderPatches(text)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.patches.map((p) => p.file)).toEqual(['a.js', 'b.js'])
  })

  it('无 patch 块返回 error', () => {
    const r = parseCoderPatches('没有补丁')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('未找到')
  })

  it('JSON 语法错误返回 error 并带块序号', () => {
    const r = parseCoderPatches('```patch\n{"file":}\n```')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('第 1 个 patch 块')
  })

  it('缺 file 字段返回 error', () => {
    const r = parseCoderPatches('```patch\n{"content":"x"}\n```')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('file')
  })

  it('content 为空返回 error', () => {
    const r = parseCoderPatches('```patch\n{"file":"a.js","content":"  "}\n```')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('content 为空')
  })
})

describe('validatePatches', () => {
  const opts = { workspace: 'D:\\ws', targetDir: 'proj' }

  it('路径越界拒绝（上跳出 workspace）', async () => {
    const r = await validatePatches([{ file: '../../etc/x.js', content: 'const a = 1' }], opts)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('越界')
  })

  it('workspace 缺失拒绝', async () => {
    const r = await validatePatches([{ file: 'a.js', content: 'const a = 1' }], {
      workspace: '',
      targetDir: null
    })
    expect(r.ok).toBe(false)
  })

  it('语法错误拒绝', async () => {
    const r = await validatePatches([{ file: 'a.js', content: 'const = 1' }], opts)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('语法预检失败')
  })

  it('JSON 语法错误拒绝', async () => {
    const r = await validatePatches([{ file: 'package.json', content: '{ bad json' }], opts)
    expect(r.ok).toBe(false)
  })

  it('合法补丁通过', async () => {
    const r = await validatePatches([{ file: 'src/a.js', content: 'const a = 1\nexport default a' }], opts)
    expect(r.ok).toBe(true)
  })

  it('空补丁列表通过', async () => {
    const r = await validatePatches([], opts)
    expect(r.ok).toBe(true)
  })
})
