<script setup lang="ts">
// 调试面板：会话控制、断点列表、堆栈与变量查看
// 3.3 支持三类运行时：Node.js（CDP）/ Python（debugpy）/ Go（dlv dap）
import { ref, computed, watch, onMounted } from 'vue'
import { useDebugStore } from '../stores/debug'
import { useWorkspaceStore } from '../stores/workspace'
import type { UiDebugEvent } from '../api'
import type { DebugStartConfig } from '../stores/debug'

const debug = useDebugStore()
const ws = useWorkspaceStore()

// ---------- 启动配置表单 ----------
const runtime = ref<'node' | 'debugpy' | 'dlv'>('node')
const mode = ref<'launch' | 'attach'>('launch')
const entry = ref('')
const port = ref(9229)
const host = ref('127.0.0.1')
// DAP launch 扩展字段
const argsText = ref('') // 空格分隔的程序参数
const cwd = ref('')
const envText = ref('') // 每行 KEY=VALUE
const busy = ref(false)
const errorMsg = ref('')

// REPL（仅 DAP 后端 stopped 时可用）
const replInput = ref('')
const replHistory = ref<{ expr: string; result: string; error?: boolean }[]>([])

// 各运行时默认端口
const defaultPorts: Record<string, number> = { node: 9229, debugpy: 5678, dlv: 2345 }
watch(runtime, (r) => { port.value = defaultPorts[r] ?? 9229 })

const stateLabel = computed(() => {
  const m: Record<string, string> = {
    idle: '空闲', connecting: '连接中', initialized: '已初始化',
    running: '运行中', stopped: '已暂停', terminated: '已结束'
  }
  return m[debug.state] ?? debug.state
})

const stateClass = computed(() => ({
  idle: debug.state === 'idle',
  connecting: debug.state === 'connecting',
  running: debug.state === 'running',
  stopped: debug.state === 'stopped',
  terminated: debug.state === 'terminated'
}))

/** 解析 env 文本（每行 KEY=VALUE）为 Record */
function parseEnv(text: string): Record<string, string> | undefined {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    env[t.slice(0, eq).trim()] = t.slice(eq + 1)
  }
  return Object.keys(env).length ? env : undefined
}

/** 解析 args 文本（按空白拆分，支持双引号包裹含空格的单个参数） */
function parseArgs(text: string): string[] | undefined {
  const t = text.trim()
  if (!t) return undefined
  const out: string[] = []
  const re = /"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(t)) !== null) out.push(m[1] ?? m[2])
  return out.length ? out : undefined
}

async function start(): Promise<void> {
  if (busy.value) return
  busy.value = true
  errorMsg.value = ''
  try {
    let cfg: DebugStartConfig
    if (runtime.value === 'node') {
      cfg = mode.value === 'launch'
        ? { backend: 'node', kind: 'launch', entry: entry.value.trim(), port: port.value }
        : { backend: 'node', kind: 'attach', port: port.value }
      if (mode.value === 'launch' && !(cfg as { entry?: string }).entry) {
        errorMsg.value = '请填写入口文件路径'
        return
      }
    } else {
      cfg = mode.value === 'launch'
        ? {
            backend: 'dap',
            runtime: runtime.value,
            request: 'launch',
            program: entry.value.trim(),
            args: parseArgs(argsText.value),
            cwd: cwd.value.trim() || undefined,
            env: parseEnv(envText.value),
            port: port.value
          }
        : {
            backend: 'dap',
            runtime: runtime.value,
            request: 'attach',
            port: port.value,
            host: host.value.trim() || '127.0.0.1'
          }
      if (mode.value === 'launch' && !entry.value.trim()) {
        errorMsg.value = runtime.value === 'debugpy' ? '请填写 Python 脚本路径' : '请填写 Go 程序目录或 main.go 路径'
        return
      }
    }
    const r = await debug.start(cfg)
    if (!r.ok) errorMsg.value = r.error || '启动失败'
  } finally {
    busy.value = false
  }
}

async function stop(): Promise<void> {
  replHistory.value = []
  await debug.stop()
}

async function control(action: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause'): Promise<void> {
  await debug.control(action)
}

/** REPL 求值：表达式历史倒序追加（最新在上） */
async function runRepl(): Promise<void> {
  const expr = replInput.value.trim()
  if (!expr) return
  replInput.value = ''
  const r = await debug.evaluate(expr)
  replHistory.value.unshift(
    r.ok
      ? { expr, result: r.result || '(无返回值)' }
      : { expr, result: r.error || '求值失败', error: true }
  )
}

function onDebugEvent(ev: UiDebugEvent): void {
  debug.handleEvent(ev)
}

onMounted(() => {
  window.api.debug.onEvent(onDebugEvent)
  // 默认入口设为当前文件
  if (ws.currentFile) entry.value = ws.currentFile
})
</script>

<template>
  <div class="debug-panel">
    <div class="debug-header">
      <span class="debug-title">调试</span>
      <span class="debug-state" :class="stateClass">{{ stateLabel }}</span>
    </div>

    <!-- 启动配置 -->
    <div v-if="!debug.isActive" class="debug-config">
      <div class="debug-row">
        <select v-model="runtime" class="debug-input debug-select">
          <option value="node">Node.js</option>
          <option value="debugpy">Python（debugpy）</option>
          <option value="dlv">Go（dlv）</option>
        </select>
      </div>
      <div class="debug-row">
        <label class="debug-label">
          <input type="radio" v-model="mode" value="launch" /> 启动
        </label>
        <label class="debug-label">
          <input type="radio" v-model="mode" value="attach" /> 附加
        </label>
      </div>
      <div v-if="mode === 'launch'" class="debug-row">
        <input
          v-model="entry"
          class="debug-input"
          :placeholder="runtime === 'node' ? '入口文件路径（绝对）' : runtime === 'debugpy' ? 'Python 脚本路径（.py）' : 'Go 程序目录或 main.go 路径'"
        />
      </div>
      <template v-if="mode === 'attach' && runtime !== 'node'">
        <div class="debug-row">
          <input v-model="host" class="debug-input" placeholder="主机（默认 127.0.0.1）" />
        </div>
      </template>
      <div class="debug-row">
        <input v-model.number="port" type="number" class="debug-input" placeholder="端口" />
      </div>
      <!-- DAP launch 扩展参数 -->
      <template v-if="runtime !== 'node' && mode === 'launch'">
        <div class="debug-row">
          <input v-model="argsText" class="debug-input" placeholder='程序参数（空格分隔，含空格用 "双引号"）' />
        </div>
        <div class="debug-row">
          <input v-model="cwd" class="debug-input" placeholder="工作目录（可选）" />
        </div>
        <div class="debug-row">
          <textarea
            v-model="envText"
            class="debug-input debug-env"
            rows="2"
            placeholder="环境变量（可选，每行 KEY=VALUE）"
          ></textarea>
        </div>
      </template>
      <button class="debug-btn primary" :disabled="busy" @click="start">启动调试</button>
      <div v-if="errorMsg" class="debug-error">{{ errorMsg }}</div>
    </div>

    <!-- 控制条 -->
    <div v-else class="debug-controls">
      <button class="debug-btn" @click="control('continue')" :disabled="!debug.isStopped">继续</button>
      <button class="debug-btn" @click="control('next')" :disabled="!debug.isStopped">单步</button>
      <button class="debug-btn" @click="control('stepIn')" :disabled="!debug.isStopped">步入</button>
      <button class="debug-btn" @click="control('stepOut')" :disabled="!debug.isStopped">步出</button>
      <button class="debug-btn" @click="control('pause')" :disabled="debug.state !== 'running'">暂停</button>
      <button class="debug-btn danger" @click="stop">停止</button>
    </div>

    <!-- 堆栈 -->
    <div v-if="debug.stack.length" class="debug-section">
      <div class="debug-section-title">调用堆栈</div>
      <div class="debug-stack">
        <div v-for="(f, i) in debug.stack" :key="f.id" class="debug-stack-frame">
          <span class="frame-index">{{ i }}</span>
          <span class="frame-name">{{ f.name }}</span>
          <span class="frame-loc">{{ f.file.split('/').pop() }}:{{ f.line }}</span>
        </div>
      </div>
    </div>

    <!-- 变量 -->
    <div v-if="debug.variables.length" class="debug-section">
      <div class="debug-section-title">变量</div>
      <div class="debug-vars">
        <div v-for="v in debug.variables" :key="v.name" class="debug-var">
          <span class="var-name">{{ v.name }}</span>
          <span class="var-value">{{ v.value }}</span>
        </div>
      </div>
    </div>

    <!-- REPL 表达式求值（仅 DAP 后端暂停时） -->
    <div v-if="debug.activeBackend === 'dap' && debug.isStopped" class="debug-section">
      <div class="debug-section-title">表达式求值</div>
      <div class="debug-row">
        <input
          v-model="replInput"
          class="debug-input"
          placeholder="输入表达式，Enter 求值"
          @keydown.enter="runRepl"
        />
        <button class="debug-btn" @click="runRepl">求值</button>
      </div>
      <div v-for="(h, i) in replHistory" :key="i" class="debug-repl-item">
        <div class="repl-expr">› {{ h.expr }}</div>
        <div class="repl-result" :class="{ error: h.error }">{{ h.result }}</div>
      </div>
    </div>

    <!-- 输出 -->
    <div v-if="debug.output" class="debug-section">
      <div class="debug-section-title">输出</div>
      <pre class="debug-output">{{ debug.output }}</pre>
    </div>

    <!-- 断点列表 -->
    <div v-if="debug.breakpoints.size" class="debug-section">
      <div class="debug-section-title">断点</div>
      <div v-for="[file, lines] in debug.breakpoints" :key="file" class="debug-bp-group">
        <div class="debug-bp-file">{{ file.split('/').pop() }}</div>
        <div v-for="line in lines" :key="line" class="debug-bp-line">
          行 {{ line }}
          <button class="debug-bp-remove" @click="debug.toggleBreakpoint(file, line)">×</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.debug-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  font-size: 12px;
  color: var(--fg-primary);
}
.debug-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}
.debug-title { font-weight: 600; }
.debug-state {
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
}
.debug-state.idle { background: var(--bg-secondary); color: var(--fg-muted); }
.debug-state.connecting { background: #f59e0b22; color: #f59e0b; }
.debug-state.running { background: #22c55e22; color: #22c55e; }
.debug-state.stopped { background: #eab30822; color: #eab308; }
.debug-state.terminated { background: #ef444422; color: #ef4444; }
.debug-config { display: flex; flex-direction: column; gap: 6px; }
.debug-row { display: flex; gap: 8px; align-items: center; }
.debug-label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
.debug-input {
  flex: 1;
  padding: 4px 6px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--fg-primary);
  font-size: 12px;
}
.debug-btn {
  padding: 4px 8px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--fg-primary);
  cursor: pointer;
  font-size: 11px;
}
.debug-btn:hover:not(:disabled) { background: var(--bg-hover); }
.debug-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.debug-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.debug-btn.danger { background: #ef444422; border-color: #ef4444; color: #ef4444; }
.debug-controls { display: flex; flex-wrap: wrap; gap: 4px; }
.debug-select { cursor: pointer; }
.debug-env { resize: vertical; font-family: monospace; min-height: 40px; }
.debug-repl-item {
  padding: 3px 4px;
  background: var(--bg-secondary);
  border-radius: 3px;
  font-family: monospace;
}
.repl-expr { color: var(--accent); }
.repl-result { color: var(--fg-muted); white-space: pre-wrap; word-break: break-all; }
.repl-result.error { color: #ef4444; }
.debug-section { display: flex; flex-direction: column; gap: 4px; }
.debug-section-title { font-weight: 600; color: var(--fg-muted); font-size: 11px; }
.debug-stack { display: flex; flex-direction: column; gap: 2px; }
.debug-stack-frame {
  display: flex;
  gap: 6px;
  padding: 3px 4px;
  background: var(--bg-secondary);
  border-radius: 3px;
  font-family: monospace;
}
.frame-index { color: var(--fg-muted); min-width: 16px; }
.frame-name { flex: 1; }
.frame-loc { color: var(--fg-muted); }
.debug-vars { display: flex; flex-direction: column; gap: 2px; }
.debug-var {
  display: flex;
  gap: 6px;
  padding: 2px 4px;
  font-family: monospace;
}
.var-name { color: var(--accent); }
.var-value { color: var(--fg-muted); word-break: break-all; }
.debug-output {
  max-height: 120px;
  overflow: auto;
  padding: 4px;
  background: var(--bg-secondary);
  border-radius: 3px;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
}
.debug-bp-group { margin-bottom: 4px; }
.debug-bp-file { font-weight: 600; margin-bottom: 2px; }
.debug-bp-line {
  display: flex;
  justify-content: space-between;
  padding: 2px 4px;
  padding-left: 12px;
}
.debug-bp-remove {
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  padding: 0 4px;
}
.debug-bp-remove:hover { color: #ef4444; }
.debug-error {
  padding: 4px 6px;
  background: #ef444422;
  border: 1px solid #ef4444;
  border-radius: 4px;
  color: #ef4444;
  font-size: 11px;
}
</style>
