// contextCompactor 集成单测：预算判定、摘要结构、退化截断、保留度不足重试
import { describe, it, expect } from 'vitest'
import { compactIfNeeded, type Summarizer } from './contextCompactor'
import type { AiMessage } from './types'

function msg(role: AiMessage['role'], content: string, extra?: Partial<AiMessage>): AiMessage {
  return { role, content, ...extra }
}

/** 构造超预算长会话：1 条 system + 首条 user + 3 条中间 + 4 条最近 */
function makeLongConversation(): AiMessage[] {
  return [
    msg('system', 'system prompt'),
    msg('user', '请完成脚手架任务'),
    msg('assistant', '中间工作一：创建了 src/main.ts 等文件'.repeat(20)),
    msg('tool', '中间工具结果：npm run typecheck 通过'.repeat(20), { name: 'bash' }),
    msg('assistant', '中间工作二：修复 app.json'.repeat(20)),
    msg('user', '最近问题 1'),
    msg('assistant', '最近回复 1'),
    msg('tool', '最近工具结果'),
    msg('assistant', '最近回复 2')
  ]
}

describe('compactIfNeeded', () => {
  it('预算内原样返回（同一引用）', async () => {
    const messages = [msg('user', '短对话'), msg('assistant', '好的')]
    let called = 0
    const summarizer: Summarizer = async () => { called++; return '摘要' }
    const out = await compactIfNeeded(messages, summarizer, { historyBudgetTokens: 100000 })
    expect(out).toBe(messages)
    expect(called).toBe(0)
  })

  it('超预算且摘要成功：保留 system/首条/最近4条，插入摘要消息', async () => {
    const messages = makeLongConversation()
    const summarizer: Summarizer = async () => '这是摘要内容'
    const out = await compactIfNeeded(messages, summarizer, { historyBudgetTokens: 10 })

    expect(out[0].role).toBe('system')
    expect(out[1].content).toBe('请完成脚手架任务')
    const summaryMsg = out.find((m) => m.content.startsWith('[历史摘要]'))
    expect(summaryMsg).toBeTruthy()
    expect(summaryMsg!.content).toContain('这是摘要内容')
    // 最近 4 条原样在尾部
    expect(out.slice(-4).map((m) => m.content)).toEqual([
      '最近问题 1',
      '最近回复 1',
      '最近工具结果',
      '最近回复 2'
    ])
    // 中间三条不再出现
    expect(out.some((m) => m.content.includes('中间工作一'))).toBe(false)
  })

  it('摘要返回 null 时退化截断（无摘要消息）', async () => {
    const messages = makeLongConversation()
    const summarizer: Summarizer = async () => null
    const out = await compactIfNeeded(messages, summarizer, { historyBudgetTokens: 10 })
    expect(out.some((m) => m.content.startsWith('[历史摘要]'))).toBe(false)
    expect(out[0].role).toBe('system')
    expect(out[1].content).toBe('请完成脚手架任务')
    expect(out).toHaveLength(6) // system + first + recent4
  })

  it('摘要保留度不足 50% 时带事实清单重试一次', async () => {
    const messages = makeLongConversation()
    const calls: string[] = []
    const summarizer: Summarizer = async (text) => {
      calls.push(text)
      // 第一次返回不含任何路径/命令的空泛摘要；第二次返回保留事实的摘要
      if (calls.length === 1) return '做了一些修改'
      return '创建了 src/main.ts，执行 npm run typecheck 通过'
    }
    const out = await compactIfNeeded(messages, summarizer, { historyBudgetTokens: 10 })
    expect(calls).toHaveLength(2)
    // 重试请求文本带事实清单提示
    expect(calls[1]).toContain('关键事实')
    expect(calls[1]).toContain('src/main.ts')
    expect(calls[1]).toContain('npm run typecheck')
    // 最终采用第二次摘要
    expect(out.find((m) => m.content.startsWith('[历史摘要]'))?.content).toContain('npm run typecheck')
  })

  it('重试摘要仍不达标时采用第二次结果（不无限重试）', async () => {
    const messages = makeLongConversation()
    const calls: string[] = []
    const summarizer: Summarizer = async (text) => {
      calls.push(text)
      return calls.length === 1 ? '做了修改' : '还是没有事实'
    }
    await compactIfNeeded(messages, summarizer, { historyBudgetTokens: 10 })
    expect(calls).toHaveLength(2)
  })

  it('retry=false 时不重试', async () => {
    const messages = makeLongConversation()
    const calls: string[] = []
    const summarizer: Summarizer = async (text) => { calls.push(text); return '泛泛而谈无路径' }
    await compactIfNeeded(messages, summarizer, { historyBudgetTokens: 10, retry: false })
    expect(calls).toHaveLength(1)
  })

  it('对话太短即使超预算也原样返回', async () => {
    const messages = [msg('user', '短'), msg('assistant', '答')]
    const summarizer: Summarizer = async () => '摘要'
    const out = await compactIfNeeded(messages, summarizer, { historyBudgetTokens: 0 })
    expect(out).toBe(messages)
  })
})
