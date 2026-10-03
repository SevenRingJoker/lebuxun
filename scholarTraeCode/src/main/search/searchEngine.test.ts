// 搜索引擎单测：纯函数层（ripgrep.ts）+ 引擎集成层（真实 rg 进程 + tmpdir 文件）。
//
// 覆盖：
// - 参数构造 / JSON 解析（多文件分组、列定位、畸形行容错）/ glob 与正则边界；
// - tmpdir 下搜索、替换预览与落盘一致性（字面量 + 正则双模式）、BOM/EOL 保留；
// - 复核拦截（预览后文件改动）、大文件跳过、无变化不写盘。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  toUnpackedPath,
  resolveShippedRgPath,
  resolveRgPath,
  splitGlobs,
  buildRgArgs,
  parseRgEvent,
  utf8ByteOffsetToCharIndex,
  stripEol,
  RgResultAggregator,
  MAX_RESULT_MATCHES
} from './ripgrep'
import {
  runContentSearch,
  buildReplacePlan,
  applyReplace,
  buildReplaceRegExp,
  MAX_REPLACE_FILE_BYTES
} from './searchEngine'

// ---------- 测试夹具：构造 rg --json 原始事件行 ----------

/** submatch 原始结构 */
function sub(t: string, start: number, end: number): Record<string, unknown> {
  return { match: { text: t }, start, end }
}

/** rg match 事件原始 JSON 行 */
function matchLine(
  p: string,
  lineNumber: number,
  text: string,
  submatches: unknown[]
): string {
  return JSON.stringify({
    type: 'match',
    data: { path: { text: p }, lines: { text }, line_number: lineNumber, submatches }
  })
}

/** rg begin/end/context/summary 事件原始 JSON 行 */
function plainLine(type: string, p = './a.txt'): string {
  return JSON.stringify({ type, data: { path: { text: p } } })
}

// ============================================================
// toUnpackedPath
// ============================================================
describe('toUnpackedPath', () => {
  it('Windows 分隔符：app.asar\\ 改写为 app.asar.unpacked\\', () => {
    expect(toUnpackedPath('C:\\app\\resources\\app.asar\\node_modules\\rg\\rg.exe')).toBe(
      'C:\\app\\resources\\app.asar.unpacked\\node_modules\\rg\\rg.exe'
    )
  })

  it('POSIX 分隔符：app.asar/ 改写为 app.asar.unpacked/', () => {
    expect(toUnpackedPath('/opt/app.app.asar/bin/rg')).toBe('/opt/app.app.asar.unpacked/bin/rg')
  })

  it('路径中不含 app.asar 时原样返回', () => {
    expect(toUnpackedPath('D:\\dev\\node_modules\\rg\\rg.exe')).toBe(
      'D:\\dev\\node_modules\\rg\\rg.exe'
    )
  })

  it('多处命中全部改写', () => {
    expect(toUnpackedPath('app.asar/x/app.asar/y')).toBe('app.asar.unpacked/x/app.asar.unpacked/y')
  })
})

// ============================================================
// resolveShippedRgPath / resolveRgPath
// ============================================================
describe('resolveShippedRgPath', () => {
  /** 构造假 require：按 resolve 入参决定返回或抛错 */
  function fakeResolve(map: Record<string, string>, throwsFor?: string[]): NodeRequire {
    return {
      resolve: (id: string) => {
        if (throwsFor?.includes(id) || !(id in map)) {
          throw new Error(`Cannot find module '${id}'`)
        }
        return map[id]
      }
    } as unknown as NodeRequire
  }

  it('平台包可解析时返回其 rg 路径', () => {
    const pkg = `@vscode/ripgrep-${process.platform}-${process.arch}/bin/${
      process.platform === 'win32' ? 'rg.exe' : 'rg'
    }`
    const req = fakeResolve({ [pkg]: 'C:/fake/rg.exe' })
    expect(resolveShippedRgPath(req)).toBe('C:/fake/rg.exe')
  })

  it('平台包缺失时抛出含包名的中文错误', () => {
    expect(() => resolveShippedRgPath(fakeResolve({}))).toThrow(/ripgrep/)
  })

  it('resolveRgPath：路径落在 asar 内时自动改写为 unpacked', () => {
    const pkg = `@vscode/ripgrep-${process.platform}-${process.arch}/bin/${
      process.platform === 'win32' ? 'rg.exe' : 'rg'
    }`
    const req = fakeResolve({ [pkg]: '/opt/app.asar/bin/rg' })
    expect(resolveRgPath(req)).toBe('/opt/app.asar.unpacked/bin/rg')
  })
})

// ============================================================
// splitGlobs
// ============================================================
describe('splitGlobs', () => {
  it('逗号分隔并去空白', () => {
    expect(splitGlobs('*.ts, *.vue')).toEqual(['*.ts', '*.vue'])
  })
  it('空白（含换行/制表）分隔', () => {
    expect(splitGlobs('*.ts\n\t*.vue  *.js')).toEqual(['*.ts', '*.vue', '*.js'])
  })
  it('连续分隔符不产生空项', () => {
    expect(splitGlobs(' , , *.ts ,, ')).toEqual(['*.ts'])
  })
  it('null/undefined/空串返回空数组', () => {
    expect(splitGlobs(null)).toEqual([])
    expect(splitGlobs(undefined)).toEqual([])
    expect(splitGlobs('   ')).toEqual([])
  })
})

// ============================================================
// buildRgArgs
// ============================================================
describe('buildRgArgs', () => {
  const base = ['--json', '--no-require-git', '--max-columns=512', '--max-columns-preview']

  it('默认：忽略大小写 -i + 字面量 -F，pattern 以 -e 显式声明', () => {
    const args = buildRgArgs({ query: 'foo' })
    expect(args).toEqual([...base, '-i', '-F', '-e', 'foo', '.'])
  })

  it('区分大小写：不带 -i', () => {
    const args = buildRgArgs({ query: 'foo', caseSensitive: true })
    expect(args).not.toContain('-i')
    expect(args).toContain('-F')
  })

  it('全字匹配追加 -w', () => {
    expect(buildRgArgs({ query: 'foo', wholeWord: true })).toContain('-w')
  })

  it('正则模式不带 -F', () => {
    const args = buildRgArgs({ query: 'fo{2}', regexMode: true })
    expect(args).not.toContain('-F')
    expect(args).toContain('-i')
  })

  it('includes 每个映射一个 -g，excludes 映射为 -g !…', () => {
    const args = buildRgArgs({
      query: 'foo',
      includes: ['*.ts', '*.vue'],
      excludes: ['node_modules', 'dist']
    })
    expect(args).toEqual([
      ...base,
      '-i',
      '-F',
      '-g', '*.ts',
      '-g', '*.vue',
      '-g', '!node_modules',
      '-g', '!dist',
      '-e', 'foo',
      '.'
    ])
  })

  it('字面量查询以 - 开头时不会被误识别为选项', () => {
    const args = buildRgArgs({ query: '-strange' })
    const i = args.indexOf('-e')
    expect(args[i + 1]).toBe('-strange')
  })
})

// ============================================================
// parseRgEvent
// ============================================================
describe('parseRgEvent', () => {
  it('解析 match 事件：路径/行号/行文本/submatch 字节偏移', () => {
    const evt = parseRgEvent(matchLine('./a.txt', 7, 'hello world\n', [sub('hello', 0, 5)]))
    expect(evt).toEqual({
      kind: 'match',
      path: './a.txt',
      lineNumber: 7,
      lineText: 'hello world\n',
      submatches: [{ text: 'hello', byteStart: 0, byteEnd: 5 }]
    })
  })

  it('一行多个 submatch 全部解析', () => {
    const evt = parseRgEvent(
      matchLine('./a.txt', 1, 'foo foo\n', [sub('foo', 0, 3), sub('foo', 4, 7)])
    )
    expect(evt!.kind).toBe('match')
    if (evt?.kind === 'match') expect(evt.submatches).toHaveLength(2)
  })

  it('begin/end/context/summary 识别为 plain 事件', () => {
    expect(parseRgEvent(plainLine('begin'))).toEqual({ kind: 'begin' })
    expect(parseRgEvent(plainLine('end'))).toEqual({ kind: 'end' })
    expect(parseRgEvent(plainLine('context'))).toEqual({ kind: 'context' })
    expect(parseRgEvent(plainLine('summary'))).toEqual({ kind: 'summary' })
  })

  it('空行/纯空白返回 null', () => {
    expect(parseRgEvent('')).toBeNull()
    expect(parseRgEvent('   \n')).toBeNull()
  })

  it('畸形 JSON 返回 null', () => {
    expect(parseRgEvent('{not json')).toBeNull()
  })

  it('JSON 非对象 / 无 type / 未知 type 返回 null', () => {
    expect(parseRgEvent('123')).toBeNull()
    expect(parseRgEvent('{"foo":1}')).toBeNull()
    expect(parseRgEvent('{"type":"weird"}')).toBeNull()
  })

  it('match 缺 data / path / line_number / lines 返回 null', () => {
    expect(parseRgEvent(JSON.stringify({ type: 'match' }))).toBeNull()
    expect(
      parseRgEvent(JSON.stringify({ type: 'match', data: { path: { text: './a' } } }))
    ).toBeNull()
    expect(
      parseRgEvent(
        JSON.stringify({
          type: 'match',
          data: { path: { text: './a' }, line_number: 1 }
        })
      )
    ).toBeNull()
  })

  it('submatch 个别畸形项被跳过，合法项保留（容错不抛错）', () => {
    const raw = matchLine('./a.txt', 1, 'foo bar\n', [
      sub('foo', 0, 3),
      { match: { text: 'bad' } } /* 缺 start/end */,
      { start: 0, end: 1 } /* 缺 match */,
      null,
      sub('bar', 4, 7)
    ])
    const evt = parseRgEvent(raw)
    if (evt?.kind === 'match') {
      expect(evt.submatches).toHaveLength(2)
      expect(evt.submatches.map(s => s.text)).toEqual(['foo', 'bar'])
    } else {
      throw new Error('应解析为 match 事件')
    }
  })

  it('submatches 不是数组时按空数组处理', () => {
    const evt = parseRgEvent(
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: './a' },
          line_number: 1,
          lines: { text: 'x\n' },
          submatches: 'nope'
        }
      })
    )
    if (evt?.kind === 'match') expect(evt.submatches).toEqual([])
    else throw new Error('应解析为 match 事件')
  })

  it('CRLF 行尾在 lineText 中原样保留', () => {
    const evt = parseRgEvent(matchLine('./a.txt', 1, 'foo\r\n', [sub('foo', 0, 3)]))
    if (evt?.kind === 'match') expect(evt.lineText).toBe('foo\r\n')
    else throw new Error('应解析为 match 事件')
  })
})

// ============================================================
// utf8ByteOffsetToCharIndex
// ============================================================
describe('utf8ByteOffsetToCharIndex', () => {
  it('ASCII 下字节偏移即字符索引', () => {
    expect(utf8ByteOffsetToCharIndex('abcdef', 4)).toBe(4)
  })

  it('CJK：每个汉字 3 字节，正确换算', () => {
    const text = '你好abc'
    expect(utf8ByteOffsetToCharIndex(text, 0)).toBe(0)
    expect(utf8ByteOffsetToCharIndex(text, 3)).toBe(1)
    expect(utf8ByteOffsetToCharIndex(text, 6)).toBe(2)
  })

  it('emoji（4 字节 + 代理对占 2 个码元）不被拆成半字符', () => {
    const text = '😀a'
    expect(utf8ByteOffsetToCharIndex(text, 4)).toBe(2)
  })

  it('偏移超出文本返回文本长度', () => {
    expect(utf8ByteOffsetToCharIndex('ab', 999)).toBe(2)
  })
})

// ============================================================
// stripEol
// ============================================================
describe('stripEol', () => {
  it('去除 LF / CRLF 行尾', () => {
    expect(stripEol('abc\n')).toBe('abc')
    expect(stripEol('abc\r\n')).toBe('abc')
  })
  it('无行尾原样返回', () => {
    expect(stripEol('abc')).toBe('abc')
  })
})

// ============================================================
// RgResultAggregator
// ============================================================
describe('RgResultAggregator', () => {
  it('多文件分组：按首次出现顺序输出，路径解析为绝对路径', () => {
    const root = process.cwd()
    const agg = new RgResultAggregator(root)
    agg.ingest(plainLine('begin', './a.txt'))
    agg.ingest(matchLine('./a.txt', 1, 'foo\n', [sub('foo', 0, 3)]))
    agg.ingest(plainLine('end', './a.txt'))
    agg.ingest(matchLine('./sub/b.txt', 2, 'foo foo\n', [sub('foo', 0, 3), sub('foo', 4, 7)]))

    const groups = agg.getGroups()
    expect(groups).toHaveLength(2)
    expect(groups[0].path.replace(/\\/g, '/').endsWith('a.txt')).toBe(true)
    expect(groups[0].matchCount).toBe(1)
    expect(groups[0].matches).toEqual([{ lineNumber: 1, preview: 'foo', submatches: [
      { text: 'foo', byteStart: 0, byteEnd: 3 }
    ] }])
    // b.txt 同行两处 → matchCount=2
    expect(groups[1].matchCount).toBe(2)
    expect(agg.totalMatches).toBe(3)
  })

  it('submatches 为空的 match 事件按 1 处计（该行确实被命中）', () => {
    const agg = new RgResultAggregator(process.cwd())
    agg.ingest(matchLine('./a.txt', 1, 'foo\n', []))
    expect(agg.totalMatches).toBe(1)
    expect(agg.getGroups()[0].matchCount).toBe(1)
  })

  it('非 match 事件不计数', () => {
    const agg = new RgResultAggregator(process.cwd())
    agg.ingest(plainLine('begin'))
    agg.ingest(plainLine('context'))
    agg.ingest(plainLine('summary'))
    expect(agg.totalMatches).toBe(0)
    expect(agg.getGroups()).toHaveLength(0)
  })

  it('达到 limit：标记 truncated/reachedLimit，后续 ingest 不再计数', () => {
    const agg = new RgResultAggregator(process.cwd(), 3)
    agg.ingest(matchLine('./a.txt', 1, 'foo foo\n', [sub('foo', 0, 3), sub('foo', 4, 7)]))
    expect(agg.reachedLimit()).toBe(false)
    agg.ingest(matchLine('./a.txt', 2, 'foo\n', [sub('foo', 0, 3)]))
    expect(agg.reachedLimit()).toBe(true)
    expect(agg.truncated).toBe(true)
    expect(agg.totalMatches).toBe(3)
    const after = agg.totalMatches
    agg.ingest(matchLine('./b.txt', 1, 'foo\n', [sub('foo', 0, 3)]))
    expect(agg.totalMatches).toBe(after)
  })

  it('默认上限为 MAX_RESULT_MATCHES（5000）', () => {
    const agg = new RgResultAggregator(process.cwd())
    expect(agg.reachedLimit()).toBe(false)
    agg.ingest(matchLine('./a.txt', 1, 'x\n', []))
    for (let i = 0; i < MAX_RESULT_MATCHES - 1; i++) {
      agg.ingest(matchLine('./a.txt', i + 2, 'x\n', []))
    }
    expect(agg.reachedLimit()).toBe(true)
  })
})

// ============================================================
// buildReplaceRegExp
// ============================================================
describe('buildReplaceRegExp', () => {
  it('字面量模式：元字符被转义，点号不充当通配符', () => {
    const re = buildReplaceRegExp({ query: 'a.b' })
    expect('a.b'.match(re)).toHaveLength(1)
    expect('axb'.match(re)).toBeNull()
  })

  it('正则模式：查询串原样作为源码', () => {
    const re = buildReplaceRegExp({ query: 'fo{2}', regexMode: true })
    expect('foo'.match(re)).toHaveLength(1)
    expect('fo'.match(re)).toBeNull()
  })

  it('忽略大小写为默认 flags（gi + m）', () => {
    const re = buildReplaceRegExp({ query: 'foo' })
    expect('FOO'.match(re)).toHaveLength(1)
    expect(re.flags.split('').sort().join('')).toBe(['g', 'i', 'm'].sort().join(''))
  })

  it('区分大小写时不带 i', () => {
    const re = buildReplaceRegExp({ query: 'foo', caseSensitive: true })
    expect('FOO'.match(re)).toBeNull()
    expect(re.flags).not.toContain('i')
  })

  it('全字匹配：词中匹配被边界环视排除', () => {
    const re = buildReplaceRegExp({ query: 'foo', wholeWord: true })
    expect('foobar'.match(re)).toBeNull()
    expect('a foo b'.match(re)).toHaveLength(1)
  })

  it('m 行模式：锚点 ^/$ 按行生效', () => {
    const re = buildReplaceRegExp({ query: '^foo$', regexMode: true })
    expect('foo'.match(re)).toHaveLength(1)
    expect('foobar'.match(re)).toBeNull()
  })

  it('正则模式下非法正则抛出含说明的错误', () => {
    expect(() => buildReplaceRegExp({ query: '(unclosed', regexMode: true })).toThrow(/正则/)
  })
})

// ============================================================
// 集成层：runContentSearch（真实 rg + tmpdir）
// ============================================================
describe('runContentSearch（集成：真实 rg）', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'search-query-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('字面量搜索：分组/行号/预览/计数正确', async () => {
    writeFileSync(join(root, 'a.txt'), 'hello world\nxx hello\n')
    writeFileSync(join(root, 'b.txt'), 'say hello\n')

    const r = await runContentSearch(root, { query: 'hello' })
    expect(r.fileCount).toBe(2)
    expect(r.totalMatches).toBe(3)
    expect(r.truncated).toBe(false)
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0)

    const ga = r.groups.find(g => g.path.endsWith('a.txt'))!
    expect(ga.matchCount).toBe(2)
    expect(ga.matches.map(m => m.lineNumber)).toEqual([1, 2])
    expect(ga.matches[0].preview).toBe('hello world')
  })

  it('无匹配：退出码 1 正常返回空结果（不报错）', async () => {
    writeFileSync(join(root, 'a.txt'), 'nothing here\n')
    const r = await runContentSearch(root, { query: 'zzzz-not-found' })
    expect(r.groups).toEqual([])
    expect(r.fileCount).toBe(0)
    expect(r.totalMatches).toBe(0)
  })

  it('空 query reject', async () => {
    await expect(runContentSearch(root, { query: '' })).rejects.toThrow()
  })

  it('区分大小写：Foo 不匹配 foo', async () => {
    writeFileSync(join(root, 'a.txt'), 'Foo\nfoo\n')
    const r = await runContentSearch(root, { query: 'Foo', caseSensitive: true })
    expect(r.totalMatches).toBe(1)
    expect(r.groups[0].matches[0].preview).toBe('Foo')
  })

  it('全字匹配：foobar 不计，独立 foo 计', async () => {
    writeFileSync(join(root, 'a.txt'), 'foobar and foo\n')
    const r = await runContentSearch(root, { query: 'foo', wholeWord: true })
    expect(r.totalMatches).toBe(1)
  })

  it('正则模式：fo{2} 匹配 foo', async () => {
    writeFileSync(join(root, 'a.txt'), 'foo fo fooo\n')
    const r = await runContentSearch(root, { query: 'fo{2}', regexMode: true })
    // foo 与 fooo 开头的 foo 各一处（同行全局匹配：fooo 只在 0-3 一处，下一处从 oo 起不匹配）
    expect(r.totalMatches).toBe(2)
  })

  it('include glob：只搜 *.ts', async () => {
    writeFileSync(join(root, 'a.ts'), 'needle\n')
    writeFileSync(join(root, 'b.txt'), 'needle\n')
    const r = await runContentSearch(root, { query: 'needle', includes: ['*.ts'] })
    expect(r.fileCount).toBe(1)
    expect(r.groups[0].path).toBe(join(root, 'a.ts'))
  })

  it('exclude glob：排除 b.txt', async () => {
    writeFileSync(join(root, 'a.ts'), 'needle\n')
    writeFileSync(join(root, 'b.txt'), 'needle\n')
    const r = await runContentSearch(root, { query: 'needle', excludes: ['*.txt'] })
    expect(r.fileCount).toBe(1)
    expect(r.groups[0].path).toBe(join(root, 'a.ts'))
  })

  it('默认不搜隐藏文件（rg 默认行为）', async () => {
    writeFileSync(join(root, '.hidden.txt'), 'needle\n')
    writeFileSync(join(root, 'visible.txt'), 'needle\n')
    const r = await runContentSearch(root, { query: 'needle' })
    expect(r.fileCount).toBe(1)
    expect(r.groups[0].path).toBe(join(root, 'visible.txt'))
  })

  it('CJK 内容搜索与预览正常', async () => {
    writeFileSync(join(root, 'a.txt'), '前缀 中文 后缀\n另一行\n', 'utf8')
    const r = await runContentSearch(root, { query: '中文' })
    expect(r.totalMatches).toBe(1)
    expect(r.groups[0].matches[0].preview).toBe('前缀 中文 后缀')
  })
})

// ============================================================
// 集成层：buildReplacePlan（真实 rg + tmpdir）
// ============================================================
describe('buildReplacePlan（集成：真实 rg）', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'search-plan-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('字面量：逐文件计数 + 变更行 before/after', async () => {
    writeFileSync(join(root, 'a.txt'), 'foo and foo\nno change\nfoo\n')
    writeFileSync(join(root, 'b.txt'), 'FOO\n')

    const plan = await buildReplacePlan(root, { query: 'foo', replaceText: 'bar' })
    expect(plan.totalFiles).toBe(2)
    expect(plan.totalMatches).toBe(4)

    const pa = plan.files.find(f => f.path.endsWith('a.txt'))!
    expect(pa.matchCount).toBe(3)
    expect(pa.changes).toHaveLength(2)
    expect(pa.changes[0]).toEqual({ lineNumber: 1, before: 'foo and foo', after: 'bar and bar' })
    expect(pa.changes[1]).toEqual({ lineNumber: 3, before: 'foo', after: 'bar' })
  })

  it('正则 + 捕获组反向引用：$1/$2 生效', async () => {
    writeFileSync(join(root, 'a.txt'), 'foo12 bar34\n')
    const plan = await buildReplacePlan(root, {
      query: '(\\w+?)(\\d+)',
      replaceText: '$2-$1',
      regexMode: true
    })
    // foo12 -> 12-foo；bar34 -> 34-bar（同一变更行）
    expect(plan.files[0].changes[0].after).toBe('12-foo 34-bar')
  })

  it('替换文本为空串＝删除匹配', async () => {
    writeFileSync(join(root, 'a.txt'), 'a foo b\n')
    const plan = await buildReplacePlan(root, { query: 'foo ', replaceText: '' })
    expect(plan.files[0].changes[0].after).toBe('a b')
  })

  it('匹配存在但替换后文本相同：计入 matchCount 但不产生变更行', async () => {
    writeFileSync(join(root, 'a.txt'), 'foo\n')
    const plan = await buildReplacePlan(root, { query: 'foo', replaceText: 'foo' })
    expect(plan.files[0].matchCount).toBe(1)
    expect(plan.files[0].changes).toHaveLength(0)
  })

  it('onlyFiles 过滤：只为指定文件生成计划', async () => {
    writeFileSync(join(root, 'a.txt'), 'foo\n')
    writeFileSync(join(root, 'b.txt'), 'foo\n')
    const plan = await buildReplacePlan(root, { query: 'foo', replaceText: 'x' }, [
      join(root, 'b.txt')
    ])
    expect(plan.totalFiles).toBe(1)
    expect(plan.files[0].path).toBe(join(root, 'b.txt'))
  })

  it('单文件超过 5MB：标注 skipped=too-large，不读取', async () => {
    // 短行重复超过 5MB（避免超长行被 --max-columns 排除导致搜不到）
    const big = join(root, 'big.txt')
    writeFileSync(big, 'needle xx\n'.repeat(530_000))
    writeFileSync(join(root, 'small.txt'), 'needle\n')
    expect((await import('node:fs')).statSync(big).size).toBeGreaterThan(MAX_REPLACE_FILE_BYTES)

    const plan = await buildReplacePlan(root, { query: 'needle', replaceText: 'xx' })
    const pb = plan.files.find(f => f.path === big)!
    expect(pb.skipped).toBe('too-large')
    expect(pb.matchCount).toBe(0)
    expect(pb.changes).toHaveLength(0)
    // 小文件计划正常
    expect(plan.files.find(f => f.path.endsWith('small.txt'))!.matchCount).toBe(1)
  })
})

// ============================================================
// 集成层：applyReplace（真实 rg + tmpdir）
// ============================================================
describe('applyReplace（集成：真实 rg）', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'search-apply-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('字面量落盘与预览一致，LF EOL 保留', async () => {
    const f = join(root, 'a.txt')
    writeFileSync(f, 'foo and foo\nbar\n')
    const plan = await buildReplacePlan(root, { query: 'foo', replaceText: 'qux' })
    const expected = plan.files[0].matchCount

    const r = await applyReplace({
      query: 'foo',
      replaceText: 'qux',
      selections: [{ path: f, expectedCount: expected }]
    })
    expect(r.applied).toHaveLength(1)
    expect(r.applied[0].replacements).toBe(2)
    expect(r.skipped).toHaveLength(0)
    expect(readFileSync(f, 'utf8')).toBe('qux and qux\nbar\n')
  })

  it('BOM + CRLF 字节级保留', async () => {
    const f = join(root, 'a.txt')
    const BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf])
    writeFileSync(f, Buffer.concat([BOM_BYTES, Buffer.from('a foo b\r\nc foo\r\n')]))

    const plan = await buildReplacePlan(root, { query: 'foo', replaceText: 'bar' })
    await applyReplace({
      query: 'foo',
      replaceText: 'bar',
      selections: [{ path: f, expectedCount: plan.files[0].matchCount }]
    })

    const bytes = readFileSync(f)
    // BOM 仍在开头
    expect(bytes.subarray(0, 3)).toEqual(BOM_BYTES)
    // 全部 CRLF 原样
    expect(bytes).toEqual(Buffer.concat([BOM_BYTES, Buffer.from('a bar b\r\nc bar\r\n')]))
    expect(bytes.includes(Buffer.from('\n'))).toBe(true)
    expect(bytes.toString('utf8').includes('\r\n')).toBe(true)
  })

  it('复核拦截：预览后文件被改动 → skipped=changed，不写盘', async () => {
    const f = join(root, 'a.txt')
    writeFileSync(f, 'foo\nfoo\n')
    const plan = await buildReplacePlan(root, { query: 'foo', replaceText: 'x' })
    // 在 apply 前篡改文件，匹配数变化
    writeFileSync(f, 'foo\nfoo\nfoo\n')

    const r = await applyReplace({
      query: 'foo',
      replaceText: 'x',
      selections: [{ path: f, expectedCount: plan.files[0].matchCount }]
    })
    expect(r.applied).toHaveLength(0)
    expect(r.skipped).toHaveLength(1)
    expect(r.skipped[0].reason).toBe('changed')
    // 文件内容未被改动
    expect(readFileSync(f, 'utf8')).toBe('foo\nfoo\nfoo\n')
  })

  it('混合勾选：正常文件应用、改动文件跳过', async () => {
    const f1 = join(root, 'a.txt')
    const f2 = join(root, 'b.txt')
    writeFileSync(f1, 'foo\n')
    writeFileSync(f2, 'foo\n')
    const plan = await buildReplacePlan(root, { query: 'foo', replaceText: 'x' })
    const countOf = (p: string) => plan.files.find(f => f.path === p)!.matchCount

    // 篡改 f2
    writeFileSync(f2, 'foo\nfoo\n')

    const r = await applyReplace({
      query: 'foo',
      replaceText: 'x',
      selections: [
        { path: f1, expectedCount: countOf(f1) },
        { path: f2, expectedCount: countOf(f2) }
      ]
    })
    expect(r.applied.map(x => x.path)).toEqual([f1])
    expect(r.skipped.map(x => x.reason)).toEqual(['changed'])
    expect(readFileSync(f1, 'utf8')).toBe('x\n')
    expect(readFileSync(f2, 'utf8')).toBe('foo\nfoo\n')
  })

  it('大文件 → skipped=too-large', async () => {
    const f = join(root, 'big.txt')
    writeFileSync(f, 'needle xx\n'.repeat(530_000))
    const r = await applyReplace({
      query: 'needle',
      replaceText: 'xx',
      selections: [{ path: f, expectedCount: 0 }]
    })
    expect(r.applied).toHaveLength(0)
    expect(r.skipped[0].reason).toBe('too-large')
  })

  it('文件不存在/无状态 → skipped=unreadable', async () => {
    const missing = join(root, 'gone.txt')
    expect(existsSync(missing)).toBe(false)
    const r = await applyReplace({
      query: 'foo',
      replaceText: 'x',
      selections: [{ path: missing, expectedCount: 1 }]
    })
    expect(r.skipped[0].reason).toBe('unreadable')
  })

  it('替换后无内容变化：不写盘但计入 applied', async () => {
    const f = join(root, 'a.txt')
    writeFileSync(f, 'foo\n')
    const r = await applyReplace({
      query: 'foo',
      replaceText: 'foo',
      selections: [{ path: f, expectedCount: 1 }]
    })
    expect(r.applied).toHaveLength(1)
    expect(r.applied[0].replacements).toBe(1)
    expect(r.skipped).toHaveLength(0)
    expect(readFileSync(f, 'utf8')).toBe('foo\n')
  })

  it('正则模式落盘与 JS 直接替换结果一致', async () => {
    const f = join(root, 'a.txt')
    writeFileSync(f, 'abc123 def456\n', 'utf8')
    const plan = await buildReplacePlan(root, {
      query: '([a-z]+)(\\d+)',
      replaceText: '$2:$1',
      regexMode: true
    })
    const r = await applyReplace({
      query: '([a-z]+)(\\d+)',
      replaceText: '$2:$1',
      regexMode: true,
      selections: [{ path: f, expectedCount: plan.files[0].matchCount }]
    })
    expect(r.skipped).toHaveLength(0)
    // 与 JS 同源替换逐字一致
    expect(readFileSync(f, 'utf8')).toBe('abc123 def456\n'.replace(/([a-z]+)(\d+)/g, '$2:$1'))
  })
})
