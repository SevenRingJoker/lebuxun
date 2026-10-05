// 模型角色注册表：分时复用调度器的核心切换通道（自适应版）。
// 核心原则：不硬编码任何模型名，所有模型由 adaptiveScheduler 按画像+显存动态选择。
// 实际的 provider.chat 调用由调用方（scheduler）执行；本模块只管理「当前驻留的是谁」。

import { selectModelForRoleWithDiagnostics, getFreeVram, type ModelRole, type ModelChoice } from './adaptiveScheduler'
import { listLoadedModels } from './modelDiscovery'
import { waitUntilUnloaded } from './vramMonitor'

/** Ollama 服务地址（可被 OLLAMA_HOST 环境变量覆盖） */
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'

/** 当前驻留的模型选择；null 表示无模型驻留 */
let current: ModelChoice | null = null

/** 当前驻留角色（供外部查询） */
let currentRole_: ModelRole | null = null

/** 切换互斥锁：所有切换请求串行排队，避免并发切换导致显存叠加 */
let switchQueue: Promise<void> = Promise.resolve()

/** 获取当前驻留角色 */
export function currentRole(): ModelRole | null {
  return currentRole_
}

/** 获取当前驻留选择 */
export function currentChoice(): ModelChoice | null {
  return current
}

/**
 * 治理层唯一对外查询：返回当前驻留模型的快照（拉模式）。
 * 执行层（OllamaProvider）每次发请求前必须调用此方法获取真实模型名与上下文，
 * 不再持有任何模型状态字段——单一数据源，杜绝双写。
 * 返回 null 表示当前无模型驻留（chat 应返回明确错误而非用 'auto'）。
 */
export function getActiveModel(): {
  modelName: string
  numCtx: number
  role: ModelRole
} | null {
  if (!current || !currentRole_) return null
  return {
    modelName: current.profile.name,
    numCtx: current.numCtx,
    role: currentRole_
  }
}

export interface SwitchResult {
  ok: true
  choice: ModelChoice
  degraded: boolean
}

export interface SwitchError {
  ok: false
  error: string
}

/**
 * 切换驻留模型（互斥串行）：
 * 1. 已在驻留且同模型同上下文 → 直接返回
 * 2. 由 adaptiveScheduler 按画像+显存动态选择目标模型
 * 3. unload → warmup → 切换成功
 * 4. 无可用模型 → 返回 error
 */
export async function switchModel(
  role: ModelRole,
  opts?: {
    force?: boolean
    signal?: AbortSignal
    onSwitch?: (from: ModelRole | null, to: ModelRole, degraded: boolean) => void
  }
): Promise<SwitchResult | SwitchError> {
  // 已在驻留且同角色：直接放行（force 可强制重载）
  if (!opts?.force && current && currentRole_ === role) {
    return { ok: true, choice: current, degraded: false }
  }

  // 串行排队
  const prev = switchQueue
  let release: () => void = () => {}
  switchQueue = new Promise<void>((r) => {
    release = r
  })
  await prev

  try {
    // ✅ 关键修复：先卸载旧模型再计算可用显存。
    // 否则 getFreeVram 读到的是旧模型占用后的剩余显存，选模型时会低估可用空间
    // （典型表现：8B 驻留时切 14B，按剩余显存判定为放不下，实际卸载后完全够）。
    // 为避免「同模型跨角色」时无意义的卸载-加载循环，先用当前显存快速预测目标模型；
    // 命中同模型同上下文则直接复用，否则先卸载再做正式的显存探测与选型。
    if (current) {
      const probeFree = await getFreeVram({ signal: opts?.signal })
      const probe = await selectModelForRoleWithDiagnostics(role, probeFree, { signal: opts?.signal })
      if (
        !opts?.force &&
        probe.choice &&
        current.profile.name === probe.choice.profile.name &&
        current.numCtx === probe.choice.numCtx
      ) {
        // 同模型同上下文复用：不卸载、不 warmup，仅更新角色
        currentRole_ = role
        opts?.onSwitch?.(currentRole_, role, false)
        return { ok: true, choice: current, degraded: false }
      }
      console.log(`[TraeCode] 切换前先卸载 ${current.profile.name}，释放显存`)
      await unloadCurrentModel({ signal: opts?.signal })
    }

    // 旧模型已卸载，getFreeVram 才是真实可用值
    const freeVram = await getFreeVram({ signal: opts?.signal })
    const diag = await selectModelForRoleWithDiagnostics(role, freeVram, { signal: opts?.signal })
    console.log(
      `[TraeCode] 角色=${role} 卸载后可用显存=${freeVram.toFixed(1)}GB ` +
      `候选=${diag.totalAvailable}个 [${diag.availableNames.join(', ') || '(空)'}] ` +
      `→ ${diag.choice?.profile.name ?? '(无)'} ctx=${diag.choice?.numCtx ?? '-'}`
    )
    if (!diag.choice) {
      console.warn(`[TraeCode] 角色=${role} 无可用模型，拒绝日志:`, diag.rejectionLog)
      return {
        ok: false,
        error:
          `角色 ${role} 无可用模型（卸载后可用显存 ${freeVram.toFixed(1)}GB）。` +
          `可用: ${diag.availableNames.join(', ') || '(空)'}。` +
          `拒绝原因: ${diag.rejectionLog.join('; ') || '无'}`
      }
    }
    const choice = diag.choice

    // doSwitch 里不再卸载（已在前面卸载）
    await doSwitch(choice, role, { ...opts, skipUnload: true })
    currentRole_ = role
    opts?.onSwitch?.(currentRole_, role, false)
    return { ok: true, choice, degraded: false }
  } finally {
    release()
  }
}

/** 内部切换流程：unload → warmup → 置 current（调用方已持有互斥锁）。
 * 不再主动同步 provider —— provider 每次请求时通过 getActiveModel() 拉取，
 * 状态单源化，杜绝双写不一致。
 * skipUnload=true 时跳过卸载步骤（switchModel 在调用前已卸载旧模型）。 */
async function doSwitch(
  target: ModelChoice,
  role: ModelRole,
  opts?: { signal?: AbortSignal; skipUnload?: boolean }
): Promise<void> {
  // 1. 卸载当前（若有且调用方未提前卸载）
  if (!opts?.skipUnload && current) {
    await unloadCurrentModel({ signal: opts?.signal })
  }
  // 2. warmup 目标模型（权重真正入 GPU）
  const warm = await warmupModel(target, { signal: opts?.signal })
  if (!warm.ok) {
    throw new Error(`warmup ${target.profile.name} 失败：${warm.error}`)
  }
  // 3. 置当前驻留（唯一状态写入点）
  current = target
  currentRole_ = role
}

/**
 * 安全切换：先尝试目标角色；失败时尝试用 executor 兜底（最小模型，仍标记 degraded）。
 * 返回结果永不为异常——失败通过 { ok:false, error } 显式返回。
 */
export async function safeSwitch(
  role: ModelRole,
  opts?: {
    signal?: AbortSignal
    onSwitch?: (from: ModelRole | null, to: ModelRole, degraded: boolean) => void
  }
): Promise<SwitchResult | SwitchError> {
  try {
    const r = await switchModel(role, opts)
    if (r.ok) return r

    // 目标角色失败 → 兜底到 executor（如果原角色本来就是 executor，不重复兜底）
    if (role !== 'executor') {
      console.warn(`[TraeCode] 角色=${role} 切换失败，尝试 executor 兜底:`, r.error)
      const fb = await switchModel('executor', opts)
      if (fb.ok) {
        // 用 executor 的模型顶替原角色，标记 degraded，调用方据此决定是否继续
        return { ok: true, choice: fb.choice, degraded: true }
      }
      return { ok: false, error: `${r.error}；executor 兜底也失败：${fb.error}` }
    }
    return r
  } catch (err) {
    // 捕获 warmup 等异常，避免异常穿透到调用层
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `角色 ${role} 切换异常：${msg}` }
  }
}

/** 卸载当前驻留模型：POST /api/generate keep_alive:0；确认卸载后 current 置 null */
export async function unloadCurrentModel(opts?: { signal?: AbortSignal }): Promise<void> {
  if (!current) return
  try {
    await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: opts?.signal ?? AbortSignal.timeout(5000),
      body: JSON.stringify({
        model: current.profile.name,
        prompt: '',
        stream: false,
        keep_alive: 0
      })
    })
  } catch {
    // 卸载失败不阻塞：Ollama 可能正在重启或模型已被其他进程卸载
  }
  current = null
  currentRole_ = null
  // 确认卸载完成（轮询 /api/ps，超时 10s 后放弃）
  await waitUntilUnloaded({ signal: opts?.signal })
}

/**
 * Warmup：发 1-token ping 请求，确保权重真正入 GPU。
 * 避免首轮推理因冷启动超时（调度器误判为网络故障回退）。
 */
export async function warmupModel(
  choice: ModelChoice,
  opts?: { signal?: AbortSignal }
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: opts?.signal ?? AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model: choice.profile.name,
        messages: [{ role: 'user', content: '1' }],
        stream: false,
        keep_alive: '5m',
        options: { num_ctx: choice.numCtx, num_predict: 1 }
      })
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, error: `warmup HTTP ${res.status} ${text.slice(0, 200)}` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `warmup 异常：${err instanceof Error ? err.message : String(err)}` }
  }
}

/** 查询当前已加载模型（代理 modelDiscovery） */
export async function listLoaded(): Promise<{ name: string; sizeVramGB: number }[]> {
  return listLoadedModels()
}

// ============== 测试专用 ==============

/** 测试专用：重置内部状态 */
export function _resetRegistryForTest(): void {
  current = null
  currentRole_ = null
  switchQueue = Promise.resolve()
}

/** 测试专用：直接设置 current（模拟已驻留） */
export function _setCurrentForTest(choice: ModelChoice | null, role?: ModelRole): void {
  current = choice
  currentRole_ = role ?? null
}
