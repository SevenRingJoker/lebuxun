/** 节点单测共用工具：mock LLM/Sidecar + NodeContext 构造 + 最小表播种
 *
 * LLM 一律 mock（禁止连真实 Ollama）；sidecar 同理。
 * candidates 表有 run_id 外键，落库类节点测试需 seedRun() 先播种。
 */

import type { ChatChunk, ChatRequest, StreamEvent, WorkflowNode } from '@novel-forge/shared';
import type { AppDatabase } from '../../db/index.js';
import type { ChatStream, LLMGateway } from '../../llm/gateway.js';
import type { SidecarClient } from '../../sidecar/client.js';
import type { NodeContext } from '../types.js';

/** mock LLMGateway：handler 按调用次序返回文本（数组）或恒返回同一文本。
 *  chat 以逐字符 delta 的 ChatStream 形式返回（模拟 token 级流式，§15）；
 *  collect 直接收全文。 */
export function mockLlm(handler: ((req: ChatRequest) => string) | string[]): LLMGateway {
  let call = 0;
  const impl = typeof handler === 'function' ? handler : (() => handler[Math.min(call, handler.length - 1)]!);
  const llm = {
    collect: (req: ChatRequest & { provider?: string }) => {
      const text = impl(req);
      call += 1;
      return Promise.resolve(text);
    },
    chat: (req: ChatRequest & { provider?: string }): ChatStream => {
      const text = impl(req);
      call += 1;
      const gen = (async function* (): AsyncGenerator<ChatChunk> {
        for (const ch of text) {
          yield { delta: ch };
        }
      })() as ChatStream;
      gen.collect = async () => {
        let acc = '';
        for await (const chunk of gen) {
          acc += chunk.delta;
        }
        return acc;
      };
      return gen;
    },
  };
  return llm as unknown as LLMGateway;
}

/** 驱动节点 execute：兼容 Promise / AsyncGenerator 两种返回。
 *  generator 形态收集全部 string yield 为 tokens，return 值为 output（对齐 executor 语义）。 */
export async function runNode<T>(
  result: Promise<T> | AsyncGenerator<unknown, T, unknown>,
): Promise<{ output: T; tokens: string[] }> {
  if (
    typeof result === 'object' &&
    result !== null &&
    Symbol.asyncIterator in result &&
    typeof (result as { next?: unknown }).next === 'function'
  ) {
    const tokens: string[] = [];
    const iterator = (result as AsyncGenerator<unknown, T, unknown>)[Symbol.asyncIterator]();
    for (;;) {
      const { done, value } = await iterator.next();
      if (done) return { output: value, tokens };
      if (typeof value === 'string') tokens.push(value);
    }
  }
  return { output: await (result as Promise<T>), tokens: [] };
}

/** mock SidecarClient：只实现测试用到的方法，其余抛错 */
export function mockSidecar(overrides: Partial<SidecarClient> = {}): SidecarClient {
  return {
    ragQuery: () => Promise.resolve({ results: [] }),
    ragIndex: () => Promise.resolve({ ok: true, count: 1 }),
    ...overrides,
  } as unknown as SidecarClient;
}

export interface MockCtx {
  ctx: NodeContext;
  events: StreamEvent[];
  logs: string[];
}

export function makeCtx(
  db: AppDatabase,
  opts: {
    llm?: LLMGateway;
    sidecar?: SidecarClient;
    params?: Record<string, unknown>;
    runId?: string;
    nodeId?: string;
    projectId?: string;
    nodeType?: WorkflowNode['type'];
  } = {},
): MockCtx {
  const events: StreamEvent[] = [];
  const logs: string[] = [];
  const nodeId = opts.nodeId ?? 'node-1';
  const ctx: NodeContext = {
    runId: opts.runId ?? 'run-1',
    nodeId,
    projectId: opts.projectId ?? 'p1',
    node: { id: nodeId, type: opts.nodeType ?? 'input.context', position: { x: 0, y: 0 }, params: opts.params ?? {} },
    db,
    ...(opts.llm !== undefined ? { llm: opts.llm } : {}),
    ...(opts.sidecar !== undefined ? { sidecar: opts.sidecar } : {}),
    emit: (e) => events.push(e),
    log: (msg) => logs.push(msg),
  };
  return { ctx, events, logs };
}

export function seedProject(db: AppDatabase, id = 'p1'): void {
  db.prepare('INSERT INTO projects (id, name, genre, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    '测试项目',
    '仙侠',
    Date.now(),
    Date.now(),
  );
}

/** 播种 workflow + run（candidates.run_id 外键需要） */
export function seedRun(db: AppDatabase, runId = 'run-1', projectId = 'p1'): void {
  db.prepare(
    "INSERT INTO workflows (id, project_id, name, graph, version, updated_at) VALUES (?, ?, ?, '{}', 1, ?)",
  ).run(`wf-${runId}`, projectId, `wf-${runId}`, Date.now());
  db.prepare(
    "INSERT INTO runs (id, workflow_id, status, created_at, updated_at) VALUES (?, ?, 'running', ?, ?)",
  ).run(runId, `wf-${runId}`, Date.now(), Date.now());
}
