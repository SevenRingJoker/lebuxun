/** SPEC §4.2 Channel B：Main ↔ Python Sidecar HTTP + SSE 客户端 */

import type {
  DiscriminatorScoreRequest,
  DiscriminatorScoreResponse,
  EmbedRequest,
  EmbedResponse,
  RagIndexRequest,
  RagIndexResponse,
  RagQueryRequest,
  RagQueryResponse,
  RewardScoreRequest,
  RewardScoreResponse,
  RewardStatusResponse,
  SceneClassifyRequest,
  SceneClassifyResponse,
  SidecarHealth,
  StyleAnalyzeEvent,
  StyleAnalyzeRequest,
  StyleGetResponse,
} from '@novel-forge/shared';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** /reward/status 专用小超时：仪表盘/校准页轮询，挂死不能拖慢 IPC（2 秒） */
export const REWARD_STATUS_TIMEOUT_MS = 2000;

/** sidecar HTTP 错误：带状态码与可选 detail（sidecar 400 业务失败时返回 {detail}），
 * 供 IPC 层区分「样本不足等 400 业务失败」与「连接失败」。 */
export class SidecarHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'SidecarHttpError';
  }
}

// ---------------------------------------------------------------------------
// §10.4/§10.5 evolution 与 §10.2 reward/train 契约（sidecar 端点已冻结，shared 冻结 → main 侧本地定义）
// ---------------------------------------------------------------------------

/** 偏好样本（extract-templates / reward/train 共用形状） */
export interface SidecarPreferenceSample {
  projectId: string;
  context: string;
  chosen: string;
  rejected: string;
  reasons: string[];
  createdAt?: number;
}

/** POST /evolution/extract-templates */
export interface EvolutionExtractRequest {
  samples: SidecarPreferenceSample[];
}
export interface EvolutionExtractResponse {
  templates: unknown[];
  message?: string;
}

/** POST /evolution/prompt-templates（CamelModel 自动转 camelCase） */
export interface PromptTemplateCreateRequest {
  nodeType: string;
  baseTemplate: string;
  projectId?: string;
}
export interface PromptTemplate {
  id: string;
  nodeType: string;
  projectId: string | null;
  version: number;
  parentVersion: number | null;
  content: string;
  basedOn: string | null;
}
/** GET /evolution/prompt-templates?nodeType= */
export interface PromptTemplateListResponse {
  templates: PromptTemplate[];
}

/** POST /reward/train（SSE 流式训练） */
export interface RewardTrainRequest {
  samples: SidecarPreferenceSample[];
}

/** 逐层（含 cause 链）提取 Node 错误码；fetch 连接失败是 TypeError、code 在 cause 里 */
function errCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 3 && cur !== null && cur !== undefined; i += 1) {
    const code = (cur as NodeJS.ErrnoException).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export class SidecarClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: FetchLike = globalThis.fetch.bind(globalThis) as FetchLike,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchFn(this.url(path));
    if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  private async post<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
    const res = await this.fetchFn(this.url(path), {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /** /health：带连接期重试——sidecar 打印 ready JSON（bind 后）与 uvicorn listen 之间存在
   * 竞态窗口，过早连接会 ECONNREFUSED（实机验证发现的缺陷）；最多重试 10 次 × 300ms */
  async health(): Promise<SidecarHealth> {
    let lastErr: unknown;
    for (let i = 0; i < 10; i += 1) {
      try {
        return await this.get<SidecarHealth>('/health');
      } catch (err) {
        lastErr = err;
        // fetch 的连接失败是 TypeError（code 在 cause 里），需逐层提取
        const code = errCode(err);
        if (code !== 'ECONNREFUSED' && code !== 'ECONNRESET') throw err;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    throw lastErr;
  }

  /** /style/analyze SSE 流式进度 */
  async *styleAnalyze(req: StyleAnalyzeRequest): AsyncGenerator<StyleAnalyzeEvent> {
    const res = await this.fetchFn(this.url('/style/analyze'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(req),
    });
    if (!res.ok || !res.body) {
      throw new Error(`POST /style/analyze → HTTP ${res.status}`);
    }
    yield* parseSse<StyleAnalyzeEvent>(res.body);
  }

  getStyle(styleId: string): Promise<StyleGetResponse> {
    return this.get(`/style/${encodeURIComponent(styleId)}`);
  }

  deleteStyle(styleId: string): Promise<{ ok: boolean }> {
    return this.post(`/style/${encodeURIComponent(styleId)}`, undefined, 'DELETE');
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await this.post<EmbedResponse>('/embed', { texts } satisfies EmbedRequest);
    return res.vectors;
  }

  ragIndex(req: RagIndexRequest): Promise<RagIndexResponse> {
    return this.post('/rag/index', req);
  }

  ragQuery(req: RagQueryRequest): Promise<RagQueryResponse> {
    return this.post('/rag/query', req);
  }

  discriminatorScore(req: DiscriminatorScoreRequest): Promise<DiscriminatorScoreResponse> {
    return this.post('/discriminator/score', req);
  }

  rewardScore(req: RewardScoreRequest): Promise<RewardScoreResponse> {
    return this.post('/reward/score', req);
  }

  /** Phase 6：GET /reward/status（2 秒超时；失败抛错由调用方降级缓存） */
  async rewardStatus(): Promise<RewardStatusResponse> {
    const res = await this.fetchFn(this.url('/reward/status'), {
      signal: AbortSignal.timeout(REWARD_STATUS_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GET /reward/status → HTTP ${res.status}`);
    return (await res.json()) as RewardStatusResponse;
  }

  sceneClassify(req: SceneClassifyRequest): Promise<SceneClassifyResponse> {
    return this.post('/scene/classify', req);
  }

  /** §10.4：从偏好样本提取演化模板（样本 < 30 时 sidecar 返回空列表 + 提示） */
  extractTemplates(req: EvolutionExtractRequest): Promise<EvolutionExtractResponse> {
    return this.post('/evolution/extract-templates', req);
  }

  /** §10.5：基于演化模板生成新版 improve 提示词 */
  createPromptTemplate(req: PromptTemplateCreateRequest): Promise<PromptTemplate> {
    return this.post('/evolution/prompt-templates', req);
  }

  listPromptTemplates(nodeType: string): Promise<PromptTemplateListResponse> {
    return this.get(`/evolution/prompt-templates?nodeType=${encodeURIComponent(nodeType)}`);
  }

  /** §10.2：POST /reward/train SSE 流式训练
   *
   * 中间进度帧结构宽松处理：只等流结束（done/error），不解析进度内容；
   * 400（如样本不足）读 {detail} 抛 SidecarHttpError；训练指标由调用方再查 /reward/status。
   */
  async trainReward(req: RewardTrainRequest): Promise<void> {
    const res = await this.fetchFn(this.url('/reward/train'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      let detail: string | undefined;
      try {
        detail = ((await res.json()) as { detail?: string }).detail;
      } catch {
        // 非 JSON 错误体则无 detail
      }
      // detail 同时并入 message：日志/告警单看 message 也能拿到业务失败原因
      const message =
        detail != null
          ? `POST /reward/train → HTTP ${res.status}：${detail}`
          : `POST /reward/train → HTTP ${res.status}`;
      throw new SidecarHttpError(message, res.status, detail);
    }
    if (!res.body) throw new SidecarHttpError('POST /reward/train → 响应无流', res.status);
    for await (const frame of parseSse<Record<string, unknown>>(res.body)) {
      const errText = frame['error'] ?? (frame['type'] === 'error' ? frame['detail'] : undefined);
      if (typeof errText === 'string' && errText !== '') {
        throw new SidecarHttpError(`训练失败：${errText}`, res.status);
      }
    }
  }
}

/** 逐行解析 SSE（`data: {...}\n\n`），fetch + ReadableStream */
export async function* parseSse<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      // SSE 事件以空行分隔；逐行取 data: 前缀
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trimEnd();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        yield JSON.parse(payload) as T;
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trim();
      if (payload && payload !== '[DONE]') {
        yield JSON.parse(payload) as T;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
