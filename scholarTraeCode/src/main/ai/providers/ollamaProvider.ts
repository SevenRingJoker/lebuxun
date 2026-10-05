// Ollama 供应商实现：把现有 ollama / electron-ollama 逻辑封装到统一 AiProvider 接口下。
// 新增供应商（OpenAI/Anthropic 等）只需照此实现 AiProvider，业务层零改动。
import { app } from 'electron'
// 注意：不要用默认导出（import ollama from 'ollama'），
// 打包为 CJS 后默认导出的互操作会丢失 .list/.chat 方法；改用 Ollama 类显式实例化
import { Ollama } from 'ollama'
import { ElectronOllama } from 'electron-ollama'
import { exec } from 'node:child_process'
import type { AiProvider, ModelEntry, AiMessage, AiStreamCallbacks } from '../types'
import { isAbortError } from '../types'
import { resolveCapabilities } from '../modelCapabilities'
// 2.3 多模态：parts 消息转 Ollama images 协议
import { toOllamaMessages } from '../messageParts'
import { selectModelForRole, type ModelRole } from '../adaptiveScheduler'

// 模块级共享客户端（仅用于 list/health 探测；chat/chatStream 走原生 fetch 以支持真 abort）
const client = new Ollama()
/** Ollama 服务地址：与 client 配置一致（默认 http://127.0.0.1:11434） */
const HOST: string = ((client as any).config?.host as string | undefined) ?? 'http://127.0.0.1:11434'

/**
 * 模型驻留时长：请求结束后模型在 GPU 中保留的时间。
 * 工具调用循环中，MCP 工具执行（write_file / npm install 等）可能耗时数分钟，
 * 30s 太短——模型在工具执行间隙被卸载，下一轮要重新加载，拖慢整体进度。
 * 5m 覆盖绝大多数工具循环周期（含 npm install），空闲 5 分钟后自动释放显存。
 */
const KEEP_ALIVE = '5m'

// 能力推断逻辑已迁移至 modelCapabilities.resolveCapabilities（预设表优先，启发式兜底），
// 本地模型走启发式分支；此处保留函数名以兼容既有调用。
function inferCapabilities(name: string): ModelEntry['capabilities'] {
  return resolveCapabilities(name)
}

export class OllamaProvider implements AiProvider {
  readonly id = 'ollama'
  readonly displayName = 'Ollama（本地）'

  private electronOllama: ElectronOllama | null = null
  /** 健康状态缓存，避免每次 listModels 都重新探测 */
  private healthy = false
  /** 在途请求的 AbortController 集合：abort() 统一触发，请求完成自动移除 */
  private inflight = new Set<AbortController>()
  /** 当前角色绑定的模型名（由 switchToRole 动态选择） */
  private currentModelName: string | null = null
  /** 当前角色建议的上下文长度（由 switchToRole 动态计算） */
  private currentNumCtx = 8192
  /** 当前绑定的角色（供 UI 查询） */
  private currentRole_: 'planner' | 'executor' | 'coder' | 'observer' | null = null
  /** 切换串行化锁：避免并发切换导致显存叠加 */
  private switchingLock: Promise<unknown> = Promise.resolve()

  /** 登记一个在途请求；signal 合并外部信号（调度层停止/超时）与内部 abort() */
  private beginRequest(external?: AbortSignal): { controller: AbortController; signal: AbortSignal } {
    const controller = new AbortController()
    this.inflight.add(controller)
    return {
      controller,
      signal: external ? AbortSignal.any([controller.signal, external]) : controller.signal
    }
  }

  private async ensure(): Promise<void> {
    if (this.healthy) return
    if (!this.electronOllama) {
      this.electronOllama = new ElectronOllama({
        basePath: app.getPath('userData')
      })
    }
    if (await this.electronOllama.isRunning()) {
      this.healthy = true
      return
    }
    // 启动新服务前，先回收历史残留（上次 dev 重启/异常退出没走 will-quit 时孤儿 runner 会霸占显存）
    this.cleanupOrphanRunners()
    const meta = await this.electronOllama.getMetadata('latest')
    await this.electronOllama.serve(meta.version, {
      serverLog: (msg) => console.log('[ollama server]', msg),
      downloadLog: (p, m) => console.log(`[ollama download] ${p}% ${m}`)
    })
    this.healthy = true
    this.registerShutdownHook()
  }

  /** 清理本应用目录下残留的 llama-server 孤儿进程（仅 Windows，异步尽力而为） */
  private cleanupOrphanRunners(): void {
    if (process.platform !== 'win32') return
    const ps =
      "Get-CimInstance Win32_Process -Filter \\\"Name='llama-server.exe'\\\" | " +
      "Where-Object { $_.ExecutablePath -like '*electron-ollama*' } | " +
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
    exec(`powershell -NoProfile -Command "${ps}"`, () => {})
  }

  /**
   * 应用退出时回收内嵌 Ollama 进程树。
   * ElectronOllamaServer.stop() 只 kill `ollama serve` 主进程，
   * 其子进程 llama-server（真正占用 GPU 显存的模型 runner）不会被级联终止，
   * 会成为孤儿进程长期霸占显存。这里用 taskkill /T 强制树杀。
   */
  private shutdownRegistered = false
  private registerShutdownHook(): void {
    if (this.shutdownRegistered) return
    this.shutdownRegistered = true
    app.on('will-quit', () => {
      const server = this.electronOllama?.getServer()
      const pid = (server as any)?.process?.pid
      if (pid) {
        // /T 终止整个进程树（含 llama-server），/F 强制
        exec(`taskkill /pid ${pid} /T /F`, () => {})
      } else {
        server?.stop().catch(() => {})
      }
    })
  }

  async health(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      await this.ensure()
      // 真正请求一次 Ollama，确认服务端响应正常
      await client.list()
      return { ok: true }
    } catch (err: any) {
      this.healthy = false
      return { ok: false, error: err?.message || String(err) }
    }
  }

  async listModels(): Promise<ModelEntry[]> {
    try {
      await this.ensure()
      const res = await client.list()
      return res.models.map((m) => ({
        id: `${this.id}:${m.name}`,
        providerId: this.id,
        name: m.name,
        displayName: m.name,
        capabilities: inferCapabilities(m.name),
        available: true
      }))
    } catch (err: any) {
      console.error('[OllamaProvider] listModels 失败:', err)
      return []
    }
  }

  async chat(params: {
    model: string
    messages: AiMessage[]
    tools?: unknown[]
    signal?: AbortSignal
  }): Promise<{
    ok: boolean
    content?: string
    toolCalls?: unknown[]
    usage?: { tokensIn?: number; tokensOut?: number }
    error?: string
  }> {
    const { controller, signal } = this.beginRequest(params.signal)
    try {
      await this.ensure()
      // 关键修复：使用 switchToRole 动态选择的当前模型，而非外部传入的硬编码 model
      const activeModel = this.currentModelName
      if (!activeModel) {
        return { ok: false, error: '[TraeCode] 尚未选择模型，请先调用 switchToRole' }
      }
      // 2.3 parts 消息转 Ollama 线协议（无 parts 原样透传）
      const wireMessages = await toOllamaMessages(params.messages)
      // 原生 fetch 直连 /api/chat：ollama 库不暴露 per-request signal，无法真中断
      const res = await fetch(`${HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          model: activeModel,
          messages: wireMessages,
          tools: params.tools,
          stream: false,
          keep_alive: KEEP_ALIVE, // 控制 GPU 驻留时长，空闲自动卸载
          options: { num_ctx: this.currentNumCtx }
        })
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 200)}`.trim() }
      }
      const data: any = await res.json()
      return {
        ok: true,
        content: data?.message?.content || '',
        toolCalls: data?.message?.tool_calls,
        // Ollama 响应自带 token 统计，上报给用量记账
        usage: {
          tokensIn: data?.prompt_eval_count,
          tokensOut: data?.eval_count
        }
      }
    } catch (err: any) {
      // 用户主动中止：不触发回退，统一返回「已中止」
      if (signal.aborted || isAbortError(err)) return { ok: false, error: '已中止' }
      return { ok: false, error: err?.message || String(err) }
    } finally {
      this.inflight.delete(controller)
    }
  }

  async chatStream(
    params: { model: string; messages: AiMessage[]; signal?: AbortSignal },
    callbacks: AiStreamCallbacks
  ): Promise<{ ok: boolean; error?: string }> {
    const { controller, signal } = this.beginRequest(params.signal)
    try {
      await this.ensure()
      // 关键修复：使用 switchToRole 动态选择的当前模型，而非外部传入的硬编码 model
      const activeModel = this.currentModelName
      if (!activeModel) {
        callbacks.onError('[TraeCode] 尚未选择模型，请先调用 switchToRole')
        return { ok: false, error: '[TraeCode] 尚未选择模型，请先调用 switchToRole' }
      }
      // 2.3 parts 消息转 Ollama 线协议
      const wireMessages = await toOllamaMessages(params.messages)
      const res = await fetch(`${HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          model: activeModel,
          messages: wireMessages,
          stream: true,
          keep_alive: KEEP_ALIVE // 控制 GPU 驻留时长，空闲自动卸载
        })
      })
      if (!res.ok || !res.body) {
        const msg = res.ok
          ? '响应无 body'
          : `HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`.trim()
        callbacks.onError(msg)
        return { ok: false, error: msg }
      }
      // Ollama 流式协议：每行一个完整 JSON（NDJSON）
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const t = line.trim()
          if (!t) continue
          let chunk: any
          try {
            chunk = JSON.parse(t)
          } catch {
            continue // 半截 JSON 留待行缓冲拼好
          }
          const delta = chunk?.message?.content || ''
          if (delta) callbacks.onChunk(delta)
          // 末 chunk（done=true）携带 prompt_eval_count/eval_count，上报用量统计
          if (chunk?.done) {
            callbacks.onUsage?.({
              tokensIn: chunk.prompt_eval_count,
              tokensOut: chunk.eval_count
            })
          }
        }
      }
      callbacks.onDone({ model: `${this.id}:${params.model}` })
      return { ok: true }
    } catch (err: any) {
      // 用户主动中止：UI 已取消，不再向上抛错触发回退提示
      if (signal.aborted || isAbortError(err)) return { ok: false, error: '已中止' }
      const msg = err?.message || String(err)
      callbacks.onError(msg)
      return { ok: false, error: msg }
    } finally {
      this.inflight.delete(controller)
    }
  }

  abort(): void {
    // 中止全部在途请求（fetch signal 真实断开底层 HTTP 连接）
    for (const c of this.inflight) c.abort()
  }

  /**
   * 自适应角色切换：从可用模型中按角色画像动态选择最优模型，
   * 通过 switchingLock 串行化，避免并发切换导致显存叠加。
   * 卸载其他已加载模型，预热目标模型，绑定 num_ctx。
   * 返回实际使用的模型名 + num_ctx；无可用模型返回 null。
   */
  async switchToRole(
    role: ModelRole,
    events?: { onModelSwitching?: (e: { phase: string; model: string; reason?: string }) => void },
    signal?: AbortSignal
  ): Promise<{ model: string; numCtx: number } | null> {
    // 串行化：同一时刻只允许一个切换操作
    this.switchingLock = this.switchingLock.then(() => this._doSwitchToRole(role, events, signal))
    return this.switchingLock as Promise<{ model: string; numCtx: number } | null>
  }

  /** 暴露当前使用的模型（供 UI 显示） */
  getActiveModel(): { name: string; role: ModelRole | null; numCtx: number } {
    return {
      name: this.currentModelName || '(未加载)',
      role: this.currentRole_,
      numCtx: this.currentNumCtx
    }
  }

  private async _doSwitchToRole(
    role: ModelRole,
    events?: { onModelSwitching?: (e: { phase: string; model: string; reason?: string }) => void },
    signal?: AbortSignal
  ): Promise<{ model: string; numCtx: number } | null> {
    // 探测显存（简化：默认 16GB 总量，实际可调 nvidia-smi）
    let freeVramGB = 16
    try {
      const psRes = await fetch(`${HOST}/api/ps`, { signal: signal ?? AbortSignal.timeout(2000) })
      if (psRes.ok) {
        const data = (await psRes.json()) as { models?: Array<{ size_vram?: number }> }
        const used = (data.models ?? []).reduce((sum, m) => sum + (m.size_vram ?? 0), 0) / 1e9
        freeVramGB = Math.max(0, 16 - used)
      }
    } catch { /* 探测失败按充足处理 */ }

    const choice = await selectModelForRole(role, freeVramGB, { signal })
    if (!choice) {
      events?.onModelSwitching?.({ phase: 'error', model: '', reason: `角色 ${role} 无可用模型` })
      return null
    }

    const targetName = choice.profile.name

    // 1. 卸载除目标外的其他已加载模型
    try {
      const currentPs = await fetch(`${HOST}/api/ps`, { signal: signal ?? AbortSignal.timeout(2000) })
      if (currentPs.ok) {
        const data = (await currentPs.json()) as { models?: Array<{ name?: string }> }
        for (const loaded of data.models ?? []) {
          if (loaded.name && loaded.name !== targetName) {
            events?.onModelSwitching?.({ phase: 'unloading', model: loaded.name })
            await this.unloadModelByName(loaded.name, signal)
          }
        }
      }
    } catch { /* 卸载失败不阻塞 */ }

    // 2. 预热目标模型
    events?.onModelSwitching?.({ phase: 'loading', model: targetName, reason: choice.reason })
    await this.warmupModelByName(targetName, choice.numCtx, signal)

    events?.onModelSwitching?.({ phase: 'ready', model: targetName, reason: choice.reason })
    this.currentModelName = targetName
    this.currentNumCtx = choice.numCtx
    this.currentRole_ = role
    return { model: targetName, numCtx: choice.numCtx }
  }

  /** 强制卸载指定模型（keep_alive: 0） */
  private async unloadModelByName(name: string, signal?: AbortSignal): Promise<void> {
    try {
      await fetch(`${HOST}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: signal ?? AbortSignal.timeout(5000),
        body: JSON.stringify({ model: name, keep_alive: 0 })
      })
    } catch { /* 卸载失败不阻塞 */ }
  }

  /** 预热模型：1-token ping 触发权重加载，同时设置 num_ctx */
  private async warmupModelByName(name: string, numCtx: number, signal?: AbortSignal): Promise<void> {
    try {
      await fetch(`${HOST}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: signal ?? AbortSignal.timeout(30_000),
        body: JSON.stringify({
          model: name,
          prompt: 'ping',
          stream: false,
          keep_alive: KEEP_ALIVE,
          options: { num_ctx: numCtx, num_predict: 1 }
        })
      })
    } catch { /* 预热失败不阻塞：首次请求会再尝试 */ }
  }
}
