/** VRAM 监控：/api/ps 汇总占用 + 总量估算 */

import os from 'node:os';
import type { VramInfo } from '@novel-forge/shared';
import type { FetchLike } from './ollama-lifecycle.js';

export interface VramSnapshot extends VramInfo {
  /** total 的来源说明：真实显存不可获得时为估算值 */
  source: 'api-ps + system-memory-estimate' | 'api-ps only';
}

/**
 * 查询 VRAM 快照。
 * - used：/api/ps 各模型 size_vram 之和（真实值）。
 * - total：Windows 下没有可靠的纯 JS 方式读真实显存（wmic 已在 Win11 弃用），
 *   按任务约定用 os.totalmem()（系统内存）做粗略估算并标注来源；
 *   连系统内存都读不到时返回 null（unknown）。
 */
export async function queryVram(
  host: string,
  fetchFn?: FetchLike,
): Promise<VramSnapshot> {
  const doFetch: FetchLike = fetchFn ?? (globalThis.fetch.bind(globalThis) as FetchLike);
  const res = await doFetch(`${host}/api/ps`, { signal: AbortSignal.timeout(3_000) });
  if (!res.ok) {
    throw new Error(`查询显存失败: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { models?: { size_vram?: number }[] };
  const usedBytes = (data.models ?? []).reduce((sum, m) => sum + (m.size_vram ?? 0), 0);
  const usedMB = Math.round(usedBytes / (1024 * 1024));

  let totalMB: number | null = null;
  let source: VramSnapshot['source'] = 'api-ps only';
  try {
    // 注意：这是系统内存而非真实显存，仅作 UI 展示的粗略参考
    totalMB = Math.round(os.totalmem() / (1024 * 1024));
    source = 'api-ps + system-memory-estimate';
  } catch {
    totalMB = null;
  }

  return {
    usedMB,
    totalMB,
    freeMB: totalMB != null ? Math.max(totalMB - usedMB, 0) : null,
    source,
  };
}
