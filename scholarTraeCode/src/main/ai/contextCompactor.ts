// 上下文压缩（token 驱动）：对话历史超过当前模型窗口的动态预算时，
// 把中间历史交给摘要模型生成一条 assistant 摘要，保留 system + 首条 user + 最近 N 条。
// 摘要后做关键事实（路径/命令）保留度校验，覆盖率不足时带事实清单重试一次；
// 摘要失败或两次都不达标则退化截断，宁可丢历史也不撑爆窗口。
import type { AiMessage } from './types'
import {
  countMessagesTokens,
  planCompaction,
  buildHistoryText,
  extractKeyFacts,
  retentionScore
} from './tokenBudget'

/**
 * 摘要函数签名：接收待压缩的中间历史文本，返回摘要内容；
 * 返回 null 表示摘要失败，调用方走退化截断方案。
 */
export type Summarizer = (text: string) => Promise<string | null>

export interface CompactOptions {
  /** 对话历史可用 token 预算（由模型窗口×比例 − 系统提示 − 输出预留算出） */
  historyBudgetTokens: number
  /** 保留最近的消息条数（含工具调用，保证当前任务连续性） */
  keepRecent?: number
  /** 摘要保留度不足时是否带事实清单重试一次（默认 true） */
  retry?: boolean
  /** 保留度阈值：低于此值触发重试 */
  minRetention?: number
  /** 组装中间历史时单条消息的 token 上限 */
  perMsgTokens?: number
}

/** 触发重试的最小覆盖率 */
const DEFAULT_MIN_RETENTION = 0.5

/**
 * 按需压缩消息列表（token 计量）。
 *
 * @param messages  当前完整消息列表（可含 system，system 全部原样保留）
 * @param summarize 摘要函数（由调度器注入，内部调用当前模型）
 * @param opts      预算与保留策略
 */
export async function compactIfNeeded(
  messages: AiMessage[],
  summarize: Summarizer,
  opts: CompactOptions
): Promise<AiMessage[]> {
  // 预算内原样返回
  if (countMessagesTokens(messages) <= opts.historyBudgetTokens) return messages

  const keepRecent = opts.keepRecent ?? 4
  const plan = planCompaction(messages, keepRecent)
  if (!plan) return messages

  // 中间历史节选文本（工具结果代码块优先、单条预算截断）
  const historyText = buildHistoryText(plan.middle, opts.perMsgTokens ?? 600)
  const facts = extractKeyFacts(historyText)

  let summary = await summarize(historyText)

  // 保留度校验：覆盖率不足时把事实清单拼入提示重试一次
  if (summary && (opts.retry ?? true)) {
    const score = retentionScore(facts, summary)
    if (score < (opts.minRetention ?? DEFAULT_MIN_RETENTION)) {
      const factList = [
        facts.paths.length ? `路径：${facts.paths.join('、')}` : '',
        facts.commands.length ? `命令：${facts.commands.join('、')}` : ''
      ]
        .filter(Boolean)
        .join('\n')
      if (factList) {
        const retryText =
          `${historyText}\n\n【上一版摘要遗漏了关键事实，本次摘要必须原样保留以下路径与命令，不得省略】\n${factList}`
        summary = (await summarize(retryText)) ?? summary
      }
    }
  }

  if (summary) {
    const summaryMsg: AiMessage = {
      role: 'assistant',
      content: `[历史摘要] ${summary}`
    }
    return [...plan.systems, plan.first, summaryMsg, ...plan.recent]
  }

  // 退化：摘要失败时直接丢弃中间历史，避免超窗口
  return [...plan.systems, plan.first, ...plan.recent]
}
