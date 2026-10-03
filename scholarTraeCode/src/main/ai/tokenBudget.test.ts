// tokenBudget 纯函数单测：token 估算/消息计数/动态预算/压缩分段/关键事实/保留度/工具输出节选
import { describe, it, expect } from 'vitest'
import {
  estimateTokensText,
  countMessagesTokens,
  computeHistoryBudget,
  planCompaction,
  extractKeyFacts,
  retentionScore,
  truncateToolOutput,
  buildHistoryText
} from './tokenBudget'
import type { AiMessage } from './types'

/** 关键事实类型本地别名（用例构造用） */
type KeyFacts = { paths: string[]; commands: string[] }

function msg(role: AiMessage['role'], content: string, extra?: Partial<AiMessage>): AiMessage {
  return { role, content, ...extra }
}

describe('estimateTokensText', () => {
  it('空串为 0', () => {
    expect(estimateTokensText('')).toBe(0)
  })

  it('纯 ASCII 按 4 字符/token 向上取整', () => {
    expect(estimateTokensText('abcd')).toBe(1)
    expect(estimateTokensText('abcdefgh')).toBe(2)
    expect(estimateTokensText('a')).toBe(1)
  })

  it('纯中文每字约 1 token', () => {
    expect(estimateTokensText('上下文压缩策略')).toBe(7)
  })

  it('中英混合：中文密度越高 token 越多', () => {
    const cjk = estimateTokensText('读取文件并修改配置')
    const ascii = estimateTokensText('read file and edit config')
    expect(cjk).toBeGreaterThan(ascii)
  })
})

describe('countMessagesTokens', () => {
  it('content 合计', () => {
    const messages = [msg('user', 'abcd'), msg('assistant', 'efgh')]
    expect(countMessagesTokens(messages)).toBe(2)
  })

  it('toolCalls JSON 计入', () => {
    const without = countMessagesTokens([msg('assistant', 'ok')])
    const withCalls = countMessagesTokens([
      msg('assistant', 'ok', { toolCalls: [{ name: 'read', arguments: { path: 'src/main.ts' } }] })
    ])
    expect(withCalls).toBeGreaterThan(without)
  })

  it('空 toolCalls 数组不膨胀', () => {
    expect(countMessagesTokens([msg('assistant', 'ok', { toolCalls: [] })])).toBe(1)
  })
})

describe('computeHistoryBudget', () => {
  it('32k 窗口常规计算', () => {
    // 32768*0.75 - 2000(系统) - 1024(输出) = 21552
    expect(computeHistoryBudget(32768, 2000)).toBe(21552)
  })

  it('128k 窗口历史预算显著放大', () => {
    expect(computeHistoryBudget(128000, 2000)).toBeGreaterThan(80000)
  })

  it('系统提示超大时命中 2048 下限', () => {
    expect(computeHistoryBudget(8192, 8000)).toBe(2048)
  })

  it('ratio/outputReserve/floor 可覆盖', () => {
    // 10000*0.5 - 0 - 0 = 5000
    expect(computeHistoryBudget(10000, 0, { ratio: 0.5, outputReserve: 0, floor: 100 })).toBe(5000)
    expect(computeHistoryBudget(10000, 9900, { ratio: 0.5, floor: 500 })).toBe(500)
  })
})

describe('planCompaction', () => {
  it('system 全分离且首条/最近/中间分段正确', () => {
    const messages = [
      msg('system', 'sys1'),
      msg('user', 'first'),
      msg('assistant', 'mid1'),
      msg('tool', 'mid2'),
      msg('assistant', 'mid3'),
      msg('user', 'recent1'),
      msg('assistant', 'recent2')
    ]
    const plan = planCompaction(messages, 2)
    expect(plan).not.toBeNull()
    expect(plan!.systems.map((m) => m.content)).toEqual(['sys1'])
    expect(plan!.first.content).toBe('first')
    expect(plan!.recent.map((m) => m.content)).toEqual(['recent1', 'recent2'])
    expect(plan!.middle.map((m) => m.content)).toEqual(['mid1', 'mid2', 'mid3'])
  })

  it('对话条数不足返回 null', () => {
    const short = [msg('system', 's'), msg('user', 'u'), msg('assistant', 'a')]
    expect(planCompaction(short, 4)).toBeNull()
  })

  it('keepRecent 可配', () => {
    const messages = [msg('user', 'f'), msg('assistant', 'm'), msg('user', 'r')]
    // keepRecent=1：共 3 条非 system，3 > 2 可压缩
    expect(planCompaction(messages, 1)?.middle.map((m) => m.content)).toEqual(['m'])
  })
})

describe('extractKeyFacts', () => {
  it('提取相对/绝对路径并去重', () => {
    const facts = extractKeyFacts('读取 src/main.ts 后再读 src/main.ts，配置在 D:\\code\\app.json')
    expect(facts.paths).toContain('src/main.ts')
    expect(facts.paths).toContain('D:\\code\\app.json')
    // 去重：src/main.ts 只出现一次
    expect(facts.paths.filter((p) => p === 'src/main.ts')).toHaveLength(1)
  })

  it('提取 npm/git 命令', () => {
    const facts = extractKeyFacts('执行 npm run typecheck 后运行 git status 检查')
    expect(facts.commands.some((c) => c.startsWith('npm run typecheck'))).toBe(true)
    expect(facts.commands.some((c) => c.startsWith('git status'))).toBe(true)
  })

  it('提取 $ / > 引导命令', () => {
    const facts = extractKeyFacts('$ pnpm install\n> node scripts/check.js')
    expect(facts.commands).toContain('pnpm install')
    expect(facts.commands).toContain('node scripts/check.js')
  })

  it('无事实文本返回空数组', () => {
    const facts = extractKeyFacts('这是一段没有路径和命令的普通对话')
    expect(facts.paths).toEqual([])
    expect(facts.commands).toEqual([])
  })

  it('空串安全', () => {
    expect(extractKeyFacts('')).toEqual({ paths: [], commands: [] })
  })
})

describe('retentionScore', () => {
  it('全覆盖为 1', () => {
    const facts: KeyFacts = { paths: ['src/main.ts'], commands: ['npm test'] }
    expect(retentionScore(facts, '修改了 src/main.ts 并执行 npm test 验证')).toBe(1)
  })

  it('部分覆盖在 0~1 之间', () => {
    const facts: KeyFacts = { paths: ['src/main.ts', 'src/app.ts'], commands: [] }
    const score = retentionScore(facts, '修改了 src/main.ts')
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThan(1)
  })

  it('零覆盖为 0', () => {
    const facts: KeyFacts = { paths: ['src/main.ts'], commands: ['npm test'] }
    expect(retentionScore(facts, '完成了界面调整')).toBe(0)
  })

  it('无事实时视为 1（不触发重试）', () => {
    expect(retentionScore({ paths: [], commands: [] }, '任意摘要')).toBe(1)
  })

  it('路径允许 basename 命中', () => {
    const facts: KeyFacts = { paths: ['D:\\long\\dir\\to\\main.ts'], commands: [] }
    expect(retentionScore(facts, '编辑了 main.ts 文件')).toBe(1)
  })
})

describe('truncateToolOutput', () => {
  it('短文本原样返回', () => {
    expect(truncateToolOutput('ok', 100)).toBe('ok')
  })

  it('空串安全', () => {
    expect(truncateToolOutput('', 100)).toBe('')
  })

  it('超长文本带截断标记', () => {
    const long = 'a'.repeat(4000)
    const out = truncateToolOutput(long, 50)
    expect(out).toContain('已截断')
    expect(estimateTokensText(out)).toBeLessThanOrEqual(50 + 40) // 标记自身留余量
  })

  it('代码围栏优先保留', () => {
    const code = '```ts\nconst x = calculateImportantValue()\nconsole.log(x)\n```'
    const filler = '普通日志行 '.repeat(400)
    const out = truncateToolOutput(`${filler}\n${code}\n${filler}`, 60)
    expect(out).toContain('calculateImportantValue')
  })

  it('错误结论行优先于普通行保留', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `普通输出行 ${i}`).join('\n')
    const out = truncateToolOutput(`${lines}\n错误：编译失败 at line 9`, 40)
    expect(out).toContain('编译失败')
  })
})

describe('buildHistoryText', () => {
  it('带角色标签（tool 消息含工具名）', () => {
    const text = buildHistoryText([msg('tool', 'result', { name: 'read' })])
    expect(text).toContain('[tool(read)]')
  })

  it('tool 消息超预算时出现截断标记', () => {
    const huge = 'x'.repeat(4000)
    const text = buildHistoryText([msg('tool', huge, { name: 'bash' })], 50)
    expect(text).toContain('已截断')
  })

  it('普通长消息保留含结论词的行', () => {
    const body = Array.from({ length: 80 }, (_, i) => `无关内容行 ${i}`).join('\n') + '\n任务成功完成'
    const text = buildHistoryText([msg('assistant', body)], 80)
    expect(text).toContain('任务成功完成')
  })
})
