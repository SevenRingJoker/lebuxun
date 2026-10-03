// 语法预检单测：js/ts/vue/json 各类型通过与拒绝路径 + 宽松策略（空内容/未知扩展/超大内容放行）
import { describe, it, expect } from 'vitest'
import {
  validateSyntaxBeforeWrite,
  checkJson,
  lineColOf
} from './syntaxGuard'

describe('lineColOf', () => {
  it('偏移换算行/列（1 起）', () => {
    expect(lineColOf('ab\ncd', 0)).toEqual({ line: 1, column: 1 })
    expect(lineColOf('ab\ncd', 3)).toEqual({ line: 2, column: 1 })
    // 越界收敛到文末
    expect(lineColOf('ab', 99)).toEqual({ line: 1, column: 3 })
  })
})

describe('checkJson', () => {
  it('合法 JSON 通过', () => {
    expect(checkJson('{"name":"app","deps":{}}')).toEqual([])
  })
  it('非法 JSON 报错（Node20+ 报错信息不含 position，行号兜底为 1）', () => {
    const issues = checkJson('{\n  "name": "app",\n  "deps": ,\n}')
    expect(issues.length).toBe(1)
    expect(issues[0].message).toBeTruthy()
  })
})

describe('validateSyntaxBeforeWrite：JS/TS', () => {
  it('合法 js 通过', async () => {
    expect(await validateSyntaxBeforeWrite('/p/src/main.js', "import Vue from 'vue'\nconst app = new Vue()\n")).toBeNull()
  })
  it('合法 ts（含类型标注）通过', async () => {
    expect(await validateSyntaxBeforeWrite('/p/a.ts', 'const x: number = 1\nexport default x\n')).toBeNull()
  })
  it('括号未闭合被拒并带行号', async () => {
    const r = await validateSyntaxBeforeWrite('/p/router.js', 'const routes = [\n  { path: "/" }\n')
    expect(r).toContain('错误：语法预检未通过')
    expect(r).toContain('/p/router.js')
    expect(r).toMatch(/第 \d+ 行/)
  })
  it('缺逗号的对象字面量被拒', async () => {
    const r = await validateSyntaxBeforeWrite('/p/b.js', 'const a = {\n  x: 1\n  y: 2\n}\n')
    expect(r).toContain('错误：')
  })
  it('jsx 文件合法语法通过', async () => {
    const ok = await validateSyntaxBeforeWrite('/p/C.jsx', 'export function C() { return <div>hi</div> }\n')
    expect(ok).toBeNull()
  })
})

describe('validateSyntaxBeforeWrite：Vue SFC', () => {
  it('合法 SFC（template + script）通过', async () => {
    const vue = `<template>\n  <div id="app">{{ msg }}</div>\n</template>\n\n<script>\nexport default {\n  data() {\n    return { msg: 'hi' }\n  }\n}\n</script>\n`
    expect(await validateSyntaxBeforeWrite('/p/App.vue', vue)).toBeNull()
  })
  it('template 标签未闭合被拒', async () => {
    const vue = '<template>\n  <div>unclosed\n</template>\n'
    const r = await validateSyntaxBeforeWrite('/p/Bad.vue', vue)
    expect(r).toContain('错误：')
  })
  it('script 块语法错误被拒且行号回偏到 SFC 全文', async () => {
    const vue = `<template>\n  <div>x</div>\n</template>\n<script>\nconst a = {\n  x: 1\n  y: 2\n}\n</script>\n`
    const r = await validateSyntaxBeforeWrite('/p/C.vue', vue)
    expect(r).toContain('错误：')
    // script 内容首行在全文第 5 行，子问题至少落在第 5 行之后
    const m = r!.match(/第 (\d+) 行/)
    expect(m).toBeTruthy()
    expect(Number(m![1])).toBeGreaterThanOrEqual(5)
  })
})

describe('validateSyntaxBeforeWrite：宽松策略', () => {
  it('空内容放行', async () => {
    expect(await validateSyntaxBeforeWrite('/p/empty.js', '')).toBeNull()
    expect(await validateSyntaxBeforeWrite('/p/blank.ts', '   \n')).toBeNull()
  })
  it('未知扩展名放行（md/txt/py 等不检查）', async () => {
    expect(await validateSyntaxBeforeWrite('/p/README.md', '# { 不是代码')).toBeNull()
    expect(await validateSyntaxBeforeWrite('/p/main.py', 'def x(:\n  pass')).toBeNull()
  })
  it('超大内容放行（>200KB 跳过检查）', async () => {
    const big = 'const a = 1\n' + '// '.repeat(120_000)
    expect(big.length).toBeGreaterThan(200_000)
    expect(await validateSyntaxBeforeWrite('/p/big.js', big)).toBeNull()
  })
})
