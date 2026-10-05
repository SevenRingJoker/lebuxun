// 显存监控层：封装 Ollama /api/ps 探测，带 500ms 缓存与失败宽容。
// 原则：探测层永远不许阻塞调度——任何异常/超时/字段缺失都按「显存充足」处理。
// 零 Electron 依赖，纯 fetch + 常量，便于单测 mock。
//
// 调用约束（阶段三收归）：
// - getFreeVram / listLoadedModels 等显存探测接口，只允许 modelRegistry 与 vramMonitor 内部调用。
// - 决策层（adaptiveScheduler）不直接调用，由治理层通过 resolveModelForTask 注入。
// - 其它模块（含 IPC handler）一律通过 modelRegistry / adaptiveScheduler 公开接口访问。

/** 单模型驻留信息（/api/ps 返回项的子集） */
export interface LoadedModelInfo {
  name: string
  /** 该模型当前占用的显存字节数 */
  sizeVram: number
}

/** 一次显存探测的结果快照 */
export interface VramSnapshot {
  /** 探测是否成功（false 时 loaded/freeVram 无意义） */
  ok: boolean
  /** 当前驻留模型清单 */
  loaded: LoadedModelInfo[]
  /** 估算空闲显存字节；探测失败为 null */
  freeVram: number | null
}

/**
 * 物理显存总量（字节）：16GB × 90% 安全水位 = 14.4GB。
 * 三模型分时复用架构的硬约束——同一时刻只允许一个模型驻留，
 * 但切换瞬间可能出现「旧模型未释放 + 新模型加载中」的叠加，故按 90% 水位预检。
 */
export const TOTAL_VRAM = 14.4 * 1024 ** 3

/** 缓存窗口：同窗口内重复探测直接返回缓存，避免切换流程中密集请求 /api/ps */
const CACHE_TTL_MS = 500

/** Ollama 服务地址（与 ollamaProvider.HOST 一致，此处独立声明避免反向依赖 provider 层） */
const OLLAMA_HOST = 'http://127.0.0.1:11434'

let cache: { at: number; snapshot: VramSnapshot } | null = null

/** 探测一次显存占用（内部缓存 500ms）。异常/超时/非 200 → ok:false, freeVram:null。 */
export async function probeVram(opts?: { signal?: AbortSignal }): Promise<VramSnapshot> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.snapshot
  let snapshot: VramSnapshot
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/ps`, {
      method: 'GET',
      signal: opts?.signal ?? AbortSignal.timeout(2000)
    })
    if (!res.ok) {
      snapshot = { ok: false, loaded: [], freeVram: null }
    } else {
      const data = (await res.json()) as {
        models?: Array<{ name?: string; size_vram?: number }>
      }
      const loaded: LoadedModelInfo[] = (data.models ?? []).map((m) => ({
        name: m.name ?? '',
        sizeVram: m.size_vram ?? 0
      }))
      const used = loaded.reduce((acc, m) => acc + m.sizeVram, 0)
      snapshot = { ok: true, loaded, freeVram: Math.max(0, TOTAL_VRAM - used) }
    }
  } catch {
    // 网络异常 / Ollama 未启动 / 超时：一律按探测失败处理
    snapshot = { ok: false, loaded: [], freeVram: null }
  }
  cache = { at: Date.now(), snapshot }
  return snapshot
}

/**
 * 是否有足够显存加载 needBytes。
 * 探测失败（ok:false / freeVram:null）按「充足」返回 true——这是明确的防抖策略：
 * 宁可尝试加载失败走降级链，也不让探测层阻塞调度。
 */
export async function hasEnoughVram(needBytes: number, snapshot?: VramSnapshot): Promise<boolean> {
  const s = snapshot ?? (await probeVram())
  if (!s.ok || s.freeVram === null) return true
  return s.freeVram >= needBytes
}

/**
 * 等待所有模型卸载完成（轮询 /api/ps，间隔 500ms）。
 * 超时后放弃并按成功处理——卸载失败最多浪费显存，由后续切换的显存预检兜底。
 */
export async function waitUntilUnloaded(opts?: {
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<void> {
  const deadline = Date.now() + (opts?.timeoutMs ?? 10_000)
  // 清缓存：卸载确认必须看到实时状态，不能用切换前的旧快照
  cache = null
  while (Date.now() < deadline) {
    const s = await probeVram({ signal: opts?.signal })
    if (opts?.signal?.aborted) return
    // 探测失败按已卸载处理（Ollama 可能正在重启，此时必然无模型驻留）
    if (!s.ok) return
    if (s.loaded.length === 0 || s.loaded.every((m) => m.sizeVram === 0)) return
    await new Promise((r) => setTimeout(r, 500))
    // 每轮探测强制绕过缓存，拿到最新状态
    cache = null
  }
  // 超时放弃：不抛错，按成功处理
}

/** 测试专用：清空内部缓存 */
export function _resetVramCacheForTest(): void {
  cache = null
}
