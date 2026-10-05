// 运行时验证器（L4 层）：npm run serve 执行后探测 dev server 是否真正可访问。
// 分层验证链最末端：L1 语法（syntaxGuard）→ L2 结构（validation 验证锁）→ L3 语义（semanticValidator）→ L4 运行时（本模块）。
// 纯函数层：端口推断、诊断文本打包；探测用全局 fetch（测试可 mock），编排在 scheduler。

/** dev server 探测结果 */
export interface ProbeResult {
  /** 是否探测成功（收到 2xx 响应） */
  ok: boolean
  /** 实际探测的端口 */
  port: number
  /** 尝试次数 */
  attempts: number
  /** 最后一次获得的 HTTP 状态码（从未连通为 null） */
  lastStatus: number | null
  /** 失败原因（ok=false 时填写） */
  error?: string
}

/** 探测默认超时（30s：dev server 冷启动编译可能较慢） */
export const DEFAULT_PROBE_TIMEOUT_MS = 30_000
/** 默认轮询间隔 */
export const DEFAULT_PROBE_INTERVAL_MS = 1_000

/**
 * 端口推断：
 * 1. 启动命令显式 --port / --port=NNN → 最高优先
 * 2. vue.config.js devServer.port → vue-cli 自定义端口
 * 3. 命令含 vite → 5173（vite 缺省）
 * 4. 否则 → 8080（vue-cli devServer 缺省）
 */
export function inferPort(cmd: string, vueConfigContent?: string | null): number {
  // 1. 命令行显式端口（--port 3000 / --port=3000）
  const cliPort = cmd.match(/--port[=\s]+(\d{2,5})\b/)
  if (cliPort) {
    const p = Number(cliPort[1])
    if (p > 0 && p < 65536) return p
  }
  // 2. vue.config.js devServer.port
  if (vueConfigContent) {
    const m = vueConfigContent.match(/devServer\s*:\s*\{[\s\S]*?port\s*:\s*(\d{2,5})/)
    if (m) {
      const p = Number(m[1])
      if (p > 0 && p < 65536) return p
    }
  }
  // 3. vite 项目缺省 5173
  if (/\bvite\b/i.test(cmd)) return 5173
  // 4. vue-cli devServer 缺省 8080
  return 8080
}

/**
 * 轮询探测 http://127.0.0.1:port/ 直到收到 2xx 响应或超时。
 * - 任一 2xx 状态即视为成功（dev server 就绪）
 * - 连接拒绝/5xx 继续重试，直到 timeoutMs 耗尽
 * - signal 中止立即返回失败
 */
export async function probeDevServer(opts: {
  port: number
  timeoutMs?: number
  intervalMs?: number
  signal?: AbortSignal
  /** 测试注入：自定义 fetch（缺省用全局 fetch） */
  fetchImpl?: typeof fetch
}): Promise<ProbeResult> {
  const { port } = opts
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const intervalMs = opts.intervalMs ?? DEFAULT_PROBE_INTERVAL_MS
  const doFetch = opts.fetchImpl ?? fetch
  const url = `http://127.0.0.1:${port}/`
  const deadline = Date.now() + timeoutMs
  let attempts = 0
  let lastStatus: number | null = null
  let lastError = ''

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      return { ok: false, port, attempts, lastStatus, error: '探测被中止' }
    }
    attempts += 1
    try {
      const res = await doFetch(url, {
        signal: opts.signal ?? AbortSignal.timeout(Math.min(intervalMs, Math.max(500, deadline - Date.now()))),
        // dev server 根路径可能重定向，手动跟踪避免 fetch 抛错
        redirect: 'follow'
      })
      lastStatus = res.status
      if (res.ok) {
        return { ok: true, port, attempts, lastStatus }
      }
      lastError = `HTTP ${res.status}`
    } catch (err) {
      if (opts.signal?.aborted) {
        return { ok: false, port, attempts, lastStatus, error: '探测被中止' }
      }
      // 连接拒绝（ECONNREFUSED）：服务尚未就绪，继续等
      lastError = err instanceof Error ? err.message : String(err)
      lastStatus = null
    }
    // 距截止时间不足一个间隔：直接按超时退出，不再 sleep
    const remain = deadline - Date.now()
    if (remain <= 0) break
    await sleep(Math.min(intervalMs, remain))
  }
  return {
    ok: false,
    port,
    attempts,
    lastStatus,
    error: `探测超时（${timeoutMs}ms 内 ${attempts} 次尝试均未获得 2xx）：${lastError || '无响应'}`
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 打包运行时验证失败信息，供 Planner(14B) 观察者在用户通道诊断。
 * @param probe 探测结果
 * @param serveCommand 实际执行的启动命令
 * @param serveOutput 启动命令的输出尾部（截断）
 * @param files 已创建文件清单（相对路径，截断）
 */
export function buildRuntimeDiagnosis(
  probe: ProbeResult,
  serveCommand: string,
  serveOutput: string,
  files: string[]
): string {
  const outputTail = serveOutput.length > 2000 ? `...(前略)\n${serveOutput.slice(-2000)}` : serveOutput
  const fileList = files.length > 0 ? files.slice(0, 30).join('、') : '(无)'
  return [
    '【L4 运行时验证】dev server 启动后无法访问，请协助诊断。',
    '',
    `启动命令：${serveCommand}`,
    `探测端口：${probe.port}（尝试 ${probe.attempts} 次，最后状态：${probe.lastStatus ?? '未连通'}）`,
    `失败原因：${probe.error ?? '未知'}`,
    '',
    '启动输出（尾部）：',
    '```',
    outputTail.trim() || '(无输出)',
    '```',
    '',
    `已创建文件：${fileList}`,
    '',
    '请输出 JSON 格式诊断结论（只输出 JSON，不要其他文字）：',
    '{',
    '  "kind": "strategy" | "codefix",',
    '  "instruction": "给执行器的具体修复指令（中文，一句话说明该做什么）",',
    '  "targetFiles": ["相对路径1"]  // 仅 codefix 时必填',
    '}',
    '',
    '判定规则：',
    '- strategy：启动命令/端口/目录认知错误，只需告诉执行器正确动作（如改用 npm run dev、换端口探测）',
    '- codefix：源码/配置错误导致 dev server 崩溃，需要修复指定文件'
  ].join('\n')
}
