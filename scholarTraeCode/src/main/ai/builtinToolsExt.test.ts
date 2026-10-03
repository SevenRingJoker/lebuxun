// 扩展内置工具单测：纯函数（HTML/搜索/脚本白名单/git 白名单/registry 解析）
// + delete/move/copy 的 tmpdir 端到端 + 假 fetcher 网络工具测试。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  stripHtml,
  decodeDuckUrl,
  parseSearchResults,
  isAllowedScriptName,
  parsePackageScripts,
  validateGitArgs,
  npmRegistryUrl,
  parseNpmRegistry,
  webFetchText,
  webSearch,
  EXTRA_TOOLS,
  type FetchLike
} from './builtinToolsExt'

// 从注册表取工具执行体
function toolOf(name: string) {
  const t = EXTRA_TOOLS.find((x) => x.name === name)
  if (!t) throw new Error(`工具未注册: ${name}`)
  return t
}

describe('stripHtml', () => {
  it('去除 script/style/注释与标签', () => {
    const html = '<style>body{color:red}</style><p>你好 <b>世界</b></p><script>alert(1)</script>'
    expect(stripHtml(html)).toBe('你好 世界')
  })

  it('块级标签转换为换行并压缩空白', () => {
    // </div> 与 <br> 连续出现会保留一个空行（段落感），三个以上换行才压缩
    const html = '<div>第一行</div><div>第二行</div><br><span>尾</span>'
    expect(stripHtml(html)).toBe('第一行\n第二行\n\n尾')
    expect(stripHtml('<p>a</p>\n\n\n\n<p>b</p>')).toBe('a\n\nb')
  })

  it('解码常用 HTML 实体', () => {
    expect(stripHtml('&lt;a&gt; &amp; &quot;b&quot; &#39;c&#39;&nbsp;d')).toBe('<a> & "b" \'c\' d')
  })
})

describe('decodeDuckUrl / parseSearchResults', () => {
  const page = `
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">示例 <b>A</b></a>
    <a class="result__snippet" href="#">摘要 A 内容</a>
    <a class="result__a" href="https://direct.example.com/b">直链 B</a>
    <a class="result__snippet" href="#">摘要 B 内容</a>
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fc">C</a>
    <a class="result__snippet" href="#">摘要 C</a>
  `

  it('解码 DDG 跳转链接', () => {
    expect(decodeDuckUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa')).toBe('https://example.com/a')
    expect(decodeDuckUrl('https://direct.example.com/b')).toBe('https://direct.example.com/b')
    expect(decodeDuckUrl('/relative/path')).toBe('')
  })

  it('解析结果：标题/链接/摘要按序配对', () => {
    const rs = parseSearchResults(page)
    expect(rs).toHaveLength(3)
    expect(rs[0]).toEqual({ title: '示例 A', url: 'https://example.com/a', snippet: '摘要 A 内容' })
    expect(rs[1].url).toBe('https://direct.example.com/b')
  })

  it('遵守 limit 上限', () => {
    expect(parseSearchResults(page, 2)).toHaveLength(2)
  })
})

describe('isAllowedScriptName / parsePackageScripts', () => {
  it('白名单脚本名通过', () => {
    for (const n of ['test', 'lint', 'build', 'typecheck', 'check', 'compile', 'build:web', 'test:unit']) {
      expect(isAllowedScriptName(n)).toBe(true)
    }
  })

  it('白名单外脚本名拒绝', () => {
    for (const n of ['dev', 'publish', 'watch', 'start', 'preinstall', 'test;', 'rm -rf']) {
      expect(isAllowedScriptName(n)).toBe(false)
    }
  })

  it('解析 package.json scripts', () => {
    expect(parsePackageScripts('{"scripts":{"test":"vitest run"}}')).toEqual({ test: 'vitest run' })
    expect(parsePackageScripts('{"name":"x"}')).toEqual({})
    expect(parsePackageScripts('not json')).toBeNull()
  })
})

describe('validateGitArgs', () => {
  it('白名单子命令通过', () => {
    expect(validateGitArgs(['status', '--short']).ok).toBe(true)
    expect(validateGitArgs(['diff', 'HEAD~1']).ok).toBe(true)
    expect(validateGitArgs(['commit', '-m', 'msg']).ok).toBe(true)
    expect(validateGitArgs(['stash', 'list']).ok).toBe(true)
  })

  it('破坏性子命令拒绝', () => {
    for (const sub of ['push', 'reset', 'rebase', 'merge', 'clean', 'submodule']) {
      const r = validateGitArgs([sub])
      expect(r.ok).toBe(false)
      expect(r.reason).toContain(sub)
    }
  })

  it('破坏性旗标拒绝', () => {
    expect(validateGitArgs(['restore', '--hard']).ok).toBe(false)
    expect(validateGitArgs(['branch', '-D', 'x']).ok).toBe(false)
    expect(validateGitArgs(['add', '-f', 'a']).ok).toBe(false)
  })

  it('裸 stash 拒绝（会修改工作区）', () => {
    expect(validateGitArgs(['stash']).ok).toBe(false)
    expect(validateGitArgs(['stash', 'pop']).ok).toBe(false)
  })

  it('空参数拒绝', () => {
    expect(validateGitArgs([]).ok).toBe(false)
  })
})

describe('npmRegistryUrl / parseNpmRegistry', () => {
  it('构造 registry URL（scope 编码）', () => {
    expect(npmRegistryUrl('vue')).toBe('https://registry.npmjs.org/vue/latest')
    expect(npmRegistryUrl('@types/node')).toBe('https://registry.npmjs.org/@types%2fnode/latest')
  })

  it('非法包名返回 null', () => {
    expect(npmRegistryUrl('bad name')).toBeNull()
    expect(npmRegistryUrl('../../etc')).toBeNull()
    expect(npmRegistryUrl('')).toBeNull()
  })

  it('解析 registry 响应', () => {
    const j = JSON.stringify({ version: '3.5.0', description: '框架', license: 'MIT' })
    expect(parseNpmRegistry(j)).toEqual({ version: '3.5.0', description: '框架', license: 'MIT' })
  })

  it('license 为对象时取 type 字段', () => {
    const j = JSON.stringify({ version: '1.0.0', license: { type: 'Apache-2.0' } })
    expect(parseNpmRegistry(j)?.license).toBe('Apache-2.0')
  })

  it('损坏 JSON 返回 null', () => {
    expect(parseNpmRegistry('xx')).toBeNull()
    expect(parseNpmRegistry('{}')).toBeNull()
  })
})

// ---------------- 假 fetcher ----------------

/** 构造假响应对象 */
function fakeRes(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: async () => body
  }
}

describe('webFetchText（假 fetcher）', () => {
  it('HTML 内容剥离标签', async () => {
    const fetcher: FetchLike = async () =>
      fakeRes(200, '<html><body><h1>标题</h1><p>正文</p></body></html>', { 'content-type': 'text/html' })
    const out = await webFetchText('https://example.com', fetcher)
    expect(out).toBe('标题\n正文')
  })

  it('非 HTML 内容原样返回', async () => {
    const fetcher: FetchLike = async () =>
      fakeRes(200, '{"a":1}', { 'content-type': 'application/json' })
    expect(await webFetchText('https://api.example.com', fetcher)).toBe('{"a":1}')
  })

  it('HTTP 错误返回错误描述', async () => {
    const fetcher: FetchLike = async () => fakeRes(404, 'not found')
    expect(await webFetchText('https://example.com/x', fetcher)).toContain('HTTP 404')
  })

  it('跟随重定向并解析相对 Location', async () => {
    const seen: string[] = []
    const fetcher: FetchLike = async (url) => {
      seen.push(url)
      if (seen.length === 1) return fakeRes(302, '', { location: '/next' })
      return fakeRes(200, '最终内容', { 'content-type': 'text/plain' })
    }
    const out = await webFetchText('https://example.com/start', fetcher)
    expect(out).toBe('最终内容')
    expect(seen[1]).toBe('https://example.com/next')
  })

  it('重定向超限报错', async () => {
    const fetcher: FetchLike = async () => fakeRes(302, '', { location: 'https://example.com/loop' })
    expect(await webFetchText('https://example.com', fetcher)).toContain('重定向次数过多')
  })

  it('请求异常返回错误描述', async () => {
    const fetcher: FetchLike = async () => {
      throw new Error('ECONNREFUSED')
    }
    expect(await webFetchText('https://down.example.com', fetcher)).toContain('ECONNREFUSED')
  })

  it('非 http/https URL 拒绝', async () => {
    expect(await webFetchText('file:///etc/passwd', async () => fakeRes(200, ''))).toContain('仅支持')
  })
})

describe('webSearch（假 fetcher）', () => {
  it('格式化编号结果列表', async () => {
    const page = `
      <a class="result__a" href="https://a.example.com">结果一</a>
      <a class="result__snippet" href="#">摘要一</a>
    `
    const fetcher: FetchLike = async () => fakeRes(200, page, { 'content-type': 'text/html' })
    const out = await webSearch('测试关键词', fetcher)
    expect(out).toContain('1. 结果一')
    expect(out).toContain('https://a.example.com')
    expect(out).toContain('摘要一')
  })

  it('无结果时明确提示', async () => {
    const fetcher: FetchLike = async () => fakeRes(200, '<html></html>')
    expect(await webSearch('xyz', fetcher)).toBe('未找到结果')
  })
})

// ---------------- delete/move/copy tmpdir 端到端 ----------------

describe('delete/move/copy（临时目录）', () => {
  let ws = ''

  beforeEach(async () => {
    ws = await fsp.mkdtemp(join(tmpdir(), 'tools-ext-'))
    await fsp.mkdir(join(ws, 'src', 'sub'), { recursive: true })
    await fsp.writeFile(join(ws, 'src', 'a.txt'), '内容A', 'utf-8')
    await fsp.writeFile(join(ws, 'src', 'sub', 'b.txt'), '内容B', 'utf-8')
  })

  afterEach(async () => {
    await fsp.rm(ws, { recursive: true, force: true })
  })

  it('delete 移入 .trae/trash 且原路径消失', async () => {
    const target = join(ws, 'src', 'a.txt')
    const out = await toolOf('delete').run({ path: target }, ws)
    expect(out).toContain('已删除')
    expect(out).toContain('.trae/trash')
    await expect(fsp.stat(target)).rejects.toThrow()
    const trash = await fsp.readdir(join(ws, '.trae', 'trash'))
    expect(trash.some((f) => f.endsWith('a.txt'))).toBe(true)
  })

  it('delete 目录递归移入回收站', async () => {
    const target = join(ws, 'src', 'sub')
    const out = await toolOf('delete').run({ path: target }, ws)
    expect(out).toContain('已删除')
    await expect(fsp.stat(target)).rejects.toThrow()
    const trash = await fsp.readdir(join(ws, '.trae', 'trash'))
    const moved = trash.find((f) => f.includes('sub'))
    expect(moved).toBeTruthy()
    expect(await fsp.readFile(join(ws, '.trae', 'trash', moved!, 'b.txt'), 'utf-8')).toBe('内容B')
  })

  it('delete 不存在的目标返回错误', async () => {
    expect(await toolOf('delete').run({ path: join(ws, 'nope.txt') }, ws)).toContain('不存在')
  })

  it('move 移动文件并自动建父目录', async () => {
    const out = await toolOf('move').run(
      { source: join(ws, 'src', 'a.txt'), destination: join(ws, 'new', 'deep', 'moved.txt') },
      ws
    )
    expect(out).toContain('已移动')
    expect(await fsp.readFile(join(ws, 'new', 'deep', 'moved.txt'), 'utf-8')).toBe('内容A')
    await expect(fsp.stat(join(ws, 'src', 'a.txt'))).rejects.toThrow()
  })

  it('move 目标已存在则拒绝', async () => {
    const out = await toolOf('move').run(
      { source: join(ws, 'src', 'a.txt'), destination: join(ws, 'src', 'sub', 'b.txt') },
      ws
    )
    expect(out).toContain('已存在')
  })

  it('copy 递归复制目录且源保留', async () => {
    const out = await toolOf('copy').run(
      { source: join(ws, 'src'), destination: join(ws, 'backup') },
      ws
    )
    expect(out).toContain('已复制')
    expect(await fsp.readFile(join(ws, 'backup', 'sub', 'b.txt'), 'utf-8')).toBe('内容B')
    expect(await fsp.readFile(join(ws, 'src', 'a.txt'), 'utf-8')).toBe('内容A')
  })

  it('copy 目标已存在则拒绝', async () => {
    await fsp.mkdir(join(ws, 'exists'), { recursive: true })
    const out = await toolOf('copy').run(
      { source: join(ws, 'src', 'a.txt'), destination: join(ws, 'exists') },
      ws
    )
    expect(out).toContain('已存在')
  })
})

// ---------------- run_script / git / npm_info 工具层 ----------------

describe('run_script 工具', () => {
  let ws = ''
  beforeEach(async () => {
    ws = await fsp.mkdtemp(join(tmpdir(), 'tools-script-'))
  })
  afterEach(async () => {
    await fsp.rm(ws, { recursive: true, force: true })
  })

  it('白名单外脚本名直接拒绝（不读盘）', async () => {
    const out = await toolOf('run_script').run({ name: 'dev' }, ws)
    expect(out).toContain('不在白名单')
  })

  it('package.json 不存在时报错', async () => {
    const out = await toolOf('run_script').run({ name: 'test' }, ws)
    expect(out).toContain('未找到')
  })

  it('脚本不存在时列出已有脚本', async () => {
    await fsp.writeFile(join(ws, 'package.json'), '{"scripts":{"build":"tsc"}}', 'utf-8')
    const out = await toolOf('run_script').run({ name: 'test' }, ws)
    expect(out).toContain('不存在脚本 test')
    expect(out).toContain('build')
  })
})

describe('git 工具', () => {
  it('白名单校验失败时不执行', async () => {
    const out = await toolOf('git').run({ args: ['push', 'origin', 'main'] }, '/tmp')
    expect(out).toContain('不允许的 git 子命令')
  })

  it('args 缺失时报错', async () => {
    const out = await toolOf('git').run({}, '/tmp')
    expect(out).toContain('缺少 args')
  })

  it('非仓库目录执行 status 返回非零退出码', async () => {
    const ws = await fsp.mkdtemp(join(tmpdir(), 'tools-git-'))
    try {
      const out = await toolOf('git').run({ args: ['status'] }, ws)
      expect(out).toContain('退出码')
    } finally {
      await fsp.rm(ws, { recursive: true, force: true })
    }
  })
})

describe('npm_info 工具', () => {
  it('非法包名拒绝', async () => {
    expect(await toolOf('npm_info').run({ name: 'bad name' })).toContain('非法包名')
  })
})
