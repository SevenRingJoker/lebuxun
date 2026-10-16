/** SPEC §7.6 Ollama Lifecycle：自动检测 / 启动 / 模型拉取 / 显存查询 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { OllamaModel, PullProgress, VramInfo } from '@novel-forge/shared';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type SpawnLike = (command: string, args: string[], options: object) => ChildProcess;

export interface OllamaLifecycleConfig {
  host: string;
  autoStart: boolean;
  /** ensureRunning 等待健康检查总超时（ms），SPEC §7.6 = 30s */
  healthTimeoutMs?: number;
  /** 健康检查轮询间隔（ms），测试可缩短 */
  pollIntervalMs?: number;
}

export interface OllamaLifecycleDeps {
  fetchFn?: FetchLike;
  spawnFn?: SpawnLike;
}

export class OllamaLifecycle {
  private readonly healthTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly fetchFn: FetchLike;
  private readonly spawnFn: SpawnLike;

  constructor(
    private readonly config: OllamaLifecycleConfig,
    deps: OllamaLifecycleDeps = {},
  ) {
    this.healthTimeoutMs = config.healthTimeoutMs ?? 30_000;
    this.pollIntervalMs = config.pollIntervalMs ?? 500;
    this.fetchFn = deps.fetchFn ?? (globalThis.fetch.bind(globalThis) as FetchLike);
    this.spawnFn =
      deps.spawnFn ??
      ((command, args, options) => spawn(command, args, options as Parameters<typeof spawn>[2]));
  }

  async ensureRunning(): Promise<{ status: 'running' | 'started' | 'failed' }> {
    if (await this.isHealthy()) {
      return { status: 'running' };
    }
    if (!this.config.autoStart) {
      return { status: 'failed' };
    }
    try {
      const child = this.spawnFn('ollama', ['serve'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    } catch {
      return { status: 'failed' };
    }
    const ok = await this.waitForHealthy(this.healthTimeoutMs);
    return { status: ok ? 'started' : 'failed' };
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${this.config.host}/api/version`, {
        signal: AbortSignal.timeout(3_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async waitForHealthy(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isHealthy()) return true;
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    return this.isHealthy();
  }

  /** 列出已安装模型（GET /api/tags，5s 超时）；失败 running=false + detail */
  async listModels(): Promise<{ running: boolean; models: OllamaModel[]; detail?: string }> {
    try {
      const res = await this.fetchFn(`${this.config.host}/api/tags`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        return { running: false, models: [], detail: `查询模型失败: HTTP ${res.status}` };
      }
      const data = (await res.json()) as { models?: OllamaModel[] };
      return { running: true, models: data.models ?? [] };
    } catch (err) {
      return { running: false, models: [], detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** list 无则 pull（带进度回调），返回模型最终是否可用 */
  async ensureModel(name: string, onProgress?: (p: PullProgress) => void): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${this.config.host}/api/tags`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { models?: { name: string; model?: string }[] };
      const installed = (data.models ?? []).some((m) => m.name === name || m.model === name);
      if (installed) return true;
      await this.pullModel(name, onProgress ?? (() => {}));
      return true;
    } catch {
      return false;
    }
  }

  /** 原生 /api/pull（NDJSON 流），逐行回调进度 */
  async pullModel(name: string, onProgress: (p: PullProgress) => void): Promise<void> {
    const res = await this.fetchFn(`${this.config.host}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: true }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`拉取模型失败: HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          onProgress(JSON.parse(trimmed) as PullProgress);
        } catch {
          // 忽略半行/坏行
        }
      }
    }
    const tail = buffer.trim();
    if (tail) {
      try {
        onProgress(JSON.parse(tail) as PullProgress);
      } catch {
        // ignore
      }
    }
  }

  /** SPEC §7.6：调 /api/ps 汇总 size_vram */
  async getVramUsage(): Promise<VramInfo> {
    const res = await this.fetchFn(`${this.config.host}/api/ps`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) {
      throw new Error(`查询显存失败: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { models?: { size_vram?: number }[] };
    const usedBytes = (data.models ?? []).reduce((sum, m) => sum + (m.size_vram ?? 0), 0);
    const usedMB = Math.round(usedBytes / (1024 * 1024));
    // 真实显存总量无法从 Ollama API 获得，交由 vram-monitor 估算
    return { usedMB, totalMB: null, freeMB: null };
  }
}
