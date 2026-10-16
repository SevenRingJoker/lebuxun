/** 结构化输出辅助：LLM chat(format=json) → Zod 解析，失败带错误回显重试 1 次，再失败抛错 */

import { toOllamaFormat } from '@novel-forge/shared';
import type { ChatMessage } from '@novel-forge/shared';
import type { z } from 'zod';
import type { LLMGateway } from '../../llm/gateway.js';
import type { ModelRouter, RouteTask } from '../../llm/model-router.js';

export interface JsonCallOptions {
  llm: LLMGateway;
  router: ModelRouter;
  task: RouteTask;
  messages: ChatMessage[];
  schema: z.ZodType;
  /** 错误回显重试次数（默认 1，即最多调用 2 次） */
  retries?: number;
  log?: (msg: string) => void;
}

export async function chatJson<T>(opts: JsonCallOptions): Promise<T> {
  const { llm, router, task, messages, schema, log } = opts;
  const route = router.routeFor(task);
  const retries = opts.retries ?? 1;

  const thread: ChatMessage[] = [...messages];
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const raw = await llm.collect({
      model: route.model,
      messages: thread,
      temperature: route.temperature,
      format: toOllamaFormat(schema),
    });
    try {
      // 宽容解析：模型偶发在 JSON 外包裹说明文字 / 代码块
      return schema.parse(JSON.parse(extractJson(raw))) as T;
    } catch (err) {
      lastError = err;
      log?.(`结构化输出解析失败（第 ${attempt + 1} 次）：${err instanceof Error ? err.message : String(err)}`);
      // 错误回显：把上次响应与解析错误反馈给模型重试
      thread.push({ role: 'assistant', content: raw });
      thread.push({
        role: 'user',
        content: `上次响应不是合法 JSON 或字段不符合 schema（${err instanceof Error ? err.message : String(err)}）。请只输出修正后的 JSON，不要输出其他内容。`,
      });
    }
  }
  throw new Error(
    `结构化输出重试 ${retries + 1} 次均失败：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/** 从模型响应中截取第一个 JSON 对象/数组（容忍 ```json 代码块与前后说明文字） */
export function extractJson(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const text = fenced?.[1] ?? raw;
  const start = text.search(/[{[]/);
  if (start === -1) return text.trim();
  const open = text[start]!;
  const close = open === '{' ? '}' : ']';
  const end = text.lastIndexOf(close);
  if (end === -1 || end < start) return text.trim();
  return text.slice(start, end + 1);
}
