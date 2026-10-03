<script setup lang="ts">
// MCP 服务器管理弹窗：stdio 服务器的增删改/启停/重连，状态灯、错误文案、工具清单只读展示。
// 内置 terminal 服务器只读。配置落 userData/mcp-servers.json（主进程首启自动播种）。
import { ref, onMounted } from 'vue'
import type { UiMcpServerInfo, UiMcpServerStatus, UiMcpServerConfigInput } from '../api'

// embedded=true 时内嵌于统一设置页：不渲染遮罩外壳与关闭按钮
defineProps<{ embedded?: boolean }>()

const emit = defineEmits<{ (e: 'close'): void }>()

const servers = ref<UiMcpServerInfo[]>([])
const loading = ref(false)
const notice = ref('')
// 展开工具清单的服务器 id 集合
const expanded = ref<Set<string>>(new Set())
// 删除二次确认
const confirmDelete = ref<UiMcpServerInfo | null>(null)

// 表单状态
const editing = ref<null | { isNew: boolean; name: string; initial: UiMcpServerInfo | null }>(null)
const fName = ref('')
const fMode = ref<'package' | 'command'>('package')
const fPackage = ref('')
const fCommand = ref('')
const fArgs = ref('')
const fEnv = ref('')
const fDesc = ref('')
const fError = ref('')
const fSaving = ref(false)
const showEnv = ref(false)

const STATUS_META: Record<UiMcpServerStatus, { label: string; cls: string }> = {
  connected: { label: '已连接', cls: 'ok' },
  connecting: { label: '连接中', cls: 'warn' },
  error: { label: '连接失败', cls: 'err' },
  disabled: { label: '已停用', cls: 'off' },
  builtin: { label: '内置', cls: 'builtin' }
}
const MODE_LABEL: Record<UiMcpServerInfo['mode'], string> = {
  package: '本地包',
  command: '命令',
  builtin: '内置'
}

function flash(text: string): void {
  notice.value = text
  setTimeout(() => {
    if (notice.value === text) notice.value = ''
  }, 2500)
}

async function reload(): Promise<void> {
  loading.value = true
  try {
    servers.value = await window.api.mcp.listServers()
  } catch {
    // 主进程未就绪时静默保留旧列表
  } finally {
    loading.value = false
  }
}

function toggleTools(s: UiMcpServerInfo): void {
  const next = new Set(expanded.value)
  if (next.has(s.name)) next.delete(s.name)
  else next.add(s.name)
  expanded.value = next
}

// 连接中状态下延迟刷新一次拿终态（本地包/坏命令通常 1~2 秒内出结果）
function refreshSoon(delay = 1800): void {
  setTimeout(() => {
    if (!editing.value) void reload()
  }, delay)
}

// ---------- 表单 ----------

function openAdd(): void {
  editing.value = { isNew: true, name: '', initial: null }
  fName.value = ''
  fMode.value = 'package'
  fPackage.value = ''
  fCommand.value = ''
  fArgs.value = ''
  fEnv.value = ''
  fDesc.value = ''
  fError.value = ''
  showEnv.value = false
}

function openEdit(s: UiMcpServerInfo): void {
  editing.value = { isNew: false, name: s.name, initial: s }
  fName.value = s.name
  fMode.value = s.mode === 'command' ? 'command' : 'package'
  fPackage.value = s.package ?? ''
  fCommand.value = s.command ?? ''
  fArgs.value = (s.args ?? []).join('\n')
  fEnv.value = Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n')
  fDesc.value = s.description ?? ''
  fError.value = ''
  showEnv.value = Object.keys(s.env ?? {}).length > 0
}

function closeForm(): void {
  editing.value = null
}

// 前端轻校验（主进程校验为准）；返回 env 解析结果
function validateForm(): UiMcpServerConfigInput | null {
  const name = fName.value.trim()
  if (!editing.value?.isNew) {
    // 编辑模式名称不可改，跳过名称校验
  } else if (!name) {
    fError.value = '请填写服务器名称'
  } else if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) {
    fError.value = '名称仅支持字母、数字、下划线、连字符，且不超过 40 个字符'
    return null
  } else if (name === 'terminal') {
    fError.value = '"terminal" 是内置保留名称'
    return null
  }
  const pkg = fPackage.value.trim()
  const cmd = fCommand.value.trim()
  if (fMode.value === 'package' ? !pkg : !cmd) {
    fError.value = fMode.value === 'package' ? '请填写本地包名' : '请填写启动命令'
    return null
  }
  const args = fArgs.value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  const envLines: string[] = []
  const env: Record<string, string> = {}
  for (const raw of fEnv.value.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) {
      fError.value = `环境变量行格式错误（应为 KEY=VALUE）：${line}`
      return null
    }
    const key = line.slice(0, eq).trim()
    env[key] = line.slice(eq + 1).trim()
    envLines.push(line)
  }
  const payload: UiMcpServerConfigInput = {
    args,
    ...(Object.keys(env).length ? { env } : {}),
    ...(fDesc.value.trim() ? { description: fDesc.value.trim() } : {})
  }
  if (fMode.value === 'package') payload.package = pkg
  else payload.command = cmd
  return payload
}

async function saveForm(): Promise<void> {
  if (!editing.value || fSaving.value) return
  const payload = validateForm()
  if (!payload) return
  fError.value = ''
  fSaving.value = true
  try {
    const e = editing.value
    const res = e.isNew
      ? await window.api.mcp.addServer(fName.value.trim(), payload)
      : await window.api.mcp.updateServer(e.name, payload)
    if (!res.ok) {
      fError.value = res.error || '保存失败'
      return
    }
    editing.value = null
    await reload()
    flash(res.status === 'connected' ? '服务器已连接' : res.status === 'connecting' ? '已保存，正在后台连接…' : '已保存（已停用）')
    refreshSoon()
  } finally {
    fSaving.value = false
  }
}

async function onToggle(s: UiMcpServerInfo, enabled: boolean): Promise<void> {
  const res = await window.api.mcp.toggleServer(s.name, enabled)
  if (!res.ok) {
    flash(res.error || '操作失败')
    return
  }
  await reload()
  flash(enabled ? '正在启动服务器…' : '服务器已停用')
  if (enabled) refreshSoon()
}

async function onRestart(s: UiMcpServerInfo): Promise<void> {
  flash(`正在重连 ${s.name}…`)
  const res = await window.api.mcp.restartServer(s.name)
  await reload()
  flash(res.ok ? `${s.name} 重连成功` : `${s.name} 重连失败：${res.error || '未知错误'}`)
}

async function onDelete(): Promise<void> {
  const s = confirmDelete.value
  if (!s) return
  const res = await window.api.mcp.removeServer(s.name)
  confirmDelete.value = null
  if (!res.ok) {
    flash(res.error || '删除失败')
    return
  }
  await reload()
  flash(`已删除服务器 ${s.name}`)
}

onMounted(reload)
</script>

<template>
  <div :class="embedded ? 'embed-root' : 'modal-overlay'" @click.self="!embedded && emit('close')">
    <div class="mcp-modal" :class="{ embed: embedded }">
      <div class="mcp-header">
        <span class="mcp-title">MCP 服务器</span>
        <div class="header-actions">
          <button class="btn-ghost" title="刷新状态" @click="reload">
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path fill="currentColor" d="M13.2 2.8A6 6 0 1 0 14 7.5a.75.75 0 0 0-1.5.1 4.5 4.5 0 1 1-.88-3.4H10.2a.75.75 0 0 0 0 1.5h3.4a.75.75 0 0 0 .75-.75V1.6a.75.75 0 0 0-1.5 0v1.2Z"/>
            </svg>
          </button>
          <button class="btn-new" @click="openAdd">
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path fill="currentColor" d="M8 2a.8.8 0 0 1 .8.8v4.4h4.4a.8.8 0 0 1 0 1.6H8.8v4.4a.8.8 0 0 1-1.6 0V8.8H2.8a.8.8 0 0 1 0-1.6h4.4V2.8A.8.8 0 0 1 8 2Z"/>
            </svg>
            添加服务器
          </button>
          <button v-if="!embedded" class="btn-close" title="关闭" @click="emit('close')">✕</button>
        </div>
      </div>

      <div class="mcp-list">
        <div v-if="!loading && servers.length === 0" class="empty-hint">
          暂无 MCP 服务器，点击「添加服务器」配置一个 stdio MCP
        </div>
        <div v-for="s in servers" :key="s.name" class="server-card" :class="{ builtin: s.mode === 'builtin' }">
          <div class="card-main">
            <span class="status-dot" :class="STATUS_META[s.status].cls" :title="STATUS_META[s.status].label"></span>
            <div class="card-body" @click="s.tools.length && toggleTools(s)">
              <div class="card-title-row">
                <span class="server-name">{{ s.name }}</span>
                <span class="mode-badge" :class="s.mode">{{ MODE_LABEL[s.mode] }}</span>
                <span class="status-label" :class="STATUS_META[s.status].cls">{{ STATUS_META[s.status].label }}</span>
                <button
                  v-if="s.tools.length"
                  class="tools-badge"
                  :title="expanded.has(s.name) ? '收起工具清单' : '展开工具清单'"
                  @click.stop="toggleTools(s)"
                >{{ s.tools.length }} 个工具</button>
              </div>
              <div class="server-desc">{{ s.description || (s.mode === 'package' ? s.package : s.command) }}</div>
              <div v-if="s.error" class="server-error" :title="s.error">{{ s.error }}</div>
            </div>
            <div class="card-ops">
              <!-- 启停开关（内置禁用） -->
              <label v-if="s.mode !== 'builtin'" class="switch" :title="s.enabled ? '点击停用' : '点击启用'">
                <input type="checkbox" :checked="s.enabled" @change="onToggle(s, ($event.target as HTMLInputElement).checked)" />
                <span class="slider"></span>
              </label>
              <button v-if="s.mode !== 'builtin'" class="op-btn" title="重连" @click="onRestart(s)">
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                  <path fill="currentColor" d="M13.2 2.8A6 6 0 1 0 14 7.5a.75.75 0 0 0-1.5.1 4.5 4.5 0 1 1-.88-3.4H10.2a.75.75 0 0 0 0 1.5h3.4a.75.75 0 0 0 .75-.75V1.6a.75.75 0 0 0-1.5 0v1.2Z"/>
                </svg>
              </button>
              <button v-if="s.mode !== 'builtin'" class="op-btn" title="编辑" @click="openEdit(s)">
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                  <path fill="currentColor" d="M11.3 1.7a1.7 1.7 0 0 1 2.4 0l.6.6a1.7 1.7 0 0 1 0 2.4L6 13l-3.6 1L3.4 10l7.9-8.3Zm1 .9L12 2.3a.5.5 0 0 0-.7 0L10.5 3.1l2.4 2.4.8-.8a.5.5 0 0 0 0-.7l-1.4-1.4ZM9.7 4.3 4.9 9.1l-.5 1.9 1.9-.5 4.8-4.8-1.4-1.4Z"/>
                </svg>
              </button>
              <button v-if="s.mode !== 'builtin'" class="op-btn danger" title="删除" @click="confirmDelete = s">
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                  <path fill="currentColor" d="M6.5 1a.5.5 0 0 0-.5.5V2H3.2a.7.7 0 0 0 0 1.4h.4l.6 10.3A1.5 1.5 0 0 0 5.7 15h4.6a1.5 1.5 0 0 0 1.5-1.3l.6-10.3h.4a.7.7 0 0 0 0-1.4H10v-.5a.5.5 0 0 0-.5-.5h-3ZM5.5 3h5l-.6 10.5h-3.8L5.5 3Z"/>
                </svg>
              </button>
            </div>
          </div>
          <!-- 工具清单 -->
          <div v-if="expanded.has(s.name) && s.tools.length" class="tools-panel">
            <div v-for="t in s.tools" :key="t.name" class="tool-row">
              <span class="tool-name">{{ t.name }}</span>
              <span v-if="t.description" class="tool-desc">{{ t.description }}</span>
            </div>
          </div>
          <!-- 删除二次确认（应用内，禁原生 confirm） -->
          <div v-if="confirmDelete?.name === s.name" class="confirm-row">
            <span>确认删除服务器「{{ s.name }}」？AI 将无法再调用其工具</span>
            <button class="btn-danger" @click="onDelete">删除</button>
            <button class="btn-cancel" @click="confirmDelete = null">取消</button>
          </div>
        </div>
      </div>

      <div v-if="notice" class="mcp-notice">{{ notice }}</div>

      <!-- 添加 / 编辑表单 -->
      <div v-if="editing" class="modal-overlay inner" @click.self="closeForm">
        <div class="form-modal">
          <div class="form-title">{{ editing.isNew ? '添加 MCP 服务器' : `编辑 · ${editing.name}` }}</div>

          <label class="field">
            <span class="field-label">名称</span>
            <input v-model="fName" type="text" placeholder="如 github、my-mcp" :disabled="!editing.isNew" />
          </label>

          <div class="field">
            <span class="field-label">启动方式</span>
            <div class="mode-switch">
              <button type="button" :class="{ active: fMode === 'package' }" @click="fMode = 'package'">本地包（node_modules，推荐）</button>
              <button type="button" :class="{ active: fMode === 'command' }" @click="fMode = 'command'">可执行命令</button>
            </div>
          </div>

          <label v-if="fMode === 'package'" class="field">
            <span class="field-label">npm 包名</span>
            <input v-model="fPackage" type="text" placeholder="如 @modelcontextprotocol/server-filesystem" />
          </label>
          <label v-else class="field">
            <span class="field-label">启动命令</span>
            <input v-model="fCommand" type="text" placeholder="如 uvx、python、/path/to/server（Windows 避免 npx.cmd）" />
          </label>

          <label class="field">
            <span class="field-label">启动参数（每行一个；“.” 代表项目根目录）</span>
            <textarea v-model="fArgs" rows="3" placeholder=".&#10;--option&#10;value"></textarea>
          </label>

          <div class="field">
            <button type="button" class="env-toggle" @click="showEnv = !showEnv">
              {{ showEnv ? '▾' : '▸' }} 环境变量（KEY=VALUE，每行一个，# 开头为注释）
            </button>
            <textarea v-if="showEnv" v-model="fEnv" rows="3" class="mono" placeholder="API_KEY=xxx&#10;# 注释行"></textarea>
          </div>

          <label class="field">
            <span class="field-label">描述（可选）</span>
            <input v-model="fDesc" type="text" placeholder="该服务器的用途说明" />
          </label>

          <div v-if="fError" class="form-error">{{ fError }}</div>

          <div class="form-actions">
            <button class="btn-cancel" @click="closeForm">取消</button>
            <button class="btn-save" :disabled="fSaving" @click="saveForm">{{ fSaving ? '保存中…' : '保存并连接' }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
.modal-overlay.inner { z-index: 2100; }

/* 内嵌模式：填充统一设置页内容区，去掉弹窗外壳 */
.embed-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.mcp-modal.embed {
  width: 100%;
  max-width: none;
  max-height: none;
  height: 100%;
  border: none;
  border-radius: 0;
  box-shadow: none;
  background: transparent;
}
.mcp-modal {
  width: 620px;
  max-width: calc(100vw - 48px);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  border-radius: 10px;
  border: 1px solid var(--border-light);
  background: var(--bg-secondary);
  box-shadow: 0 0 0 1px var(--border-glow), 0 12px 40px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}
.mcp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}
.mcp-title { font-size: 14px; font-weight: 600; color: var(--text-primary); }
.header-actions { display: flex; align-items: center; gap: 8px; }
.btn-new {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 10px; font-size: 12px; border-radius: 6px;
  color: var(--accent); background: var(--accent-dim);
  border: 1px solid var(--border-glow); cursor: pointer;
}
.btn-ghost {
  display: inline-flex; padding: 4px; border: 1px solid var(--border);
  border-radius: 6px; background: transparent; color: var(--text-muted); cursor: pointer;
}
.btn-ghost:hover { color: var(--accent); border-color: var(--border-glow); }
.btn-close {
  border: none; background: none; color: var(--text-muted);
  font-size: 13px; cursor: pointer; padding: 2px 6px;
}
.btn-close:hover { color: var(--text-primary); }

.mcp-list { flex: 1; overflow-y: auto; padding: 10px 12px; }
.empty-hint { padding: 40px 16px; text-align: center; color: var(--text-muted); font-size: 13px; }

.server-card {
  margin-bottom: 8px;
  border: 1px solid var(--border-light);
  border-radius: 8px;
  background: var(--bg-panel);
  overflow: hidden;
}
.server-card.builtin { border-style: dashed; opacity: 0.92; }
.card-main { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; }
.status-dot {
  flex: none;
  width: 9px; height: 9px; margin-top: 5px;
  border-radius: 50%;
}
.status-dot.ok { background: var(--success); box-shadow: 0 0 6px var(--success); }
.status-dot.warn { background: #f0b429; box-shadow: 0 0 6px #f0b429; }
.status-dot.err { background: var(--danger); box-shadow: 0 0 6px var(--danger); }
.status-dot.off { background: var(--text-muted); }
.status-dot.builtin { background: var(--accent); box-shadow: 0 0 6px var(--accent); }

.card-body { flex: 1; min-width: 0; cursor: default; }
.card-body:deep(.tools-badge) { cursor: pointer; }
.card-title-row { display: flex; align-items: center; gap: 8px; }
.server-name { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.mode-badge {
  font-size: 10px; padding: 1px 6px; border-radius: 8px;
  border: 1px solid var(--border); color: var(--text-muted);
}
.mode-badge.command { color: #b58cff; border-color: rgba(181, 140, 255, 0.5); }
.mode-badge.builtin { color: var(--accent); border-color: var(--border-glow); }
.status-label { font-size: 11px; color: var(--text-muted); }
.status-label.ok { color: var(--success); }
.status-label.warn { color: #f0b429; }
.status-label.err { color: var(--danger); }
.status-label.builtin { color: var(--accent); }
.tools-badge {
  margin-left: auto;
  font-size: 10px; padding: 1px 8px; border-radius: 8px;
  color: var(--accent); background: var(--accent-dim);
  border: 1px solid var(--border-glow); cursor: pointer;
}
.server-desc {
  margin-top: 3px; font-size: 12px; color: var(--text-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.server-error {
  margin-top: 4px; font-size: 11px; color: var(--danger);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.card-ops { display: flex; align-items: center; gap: 6px; flex: none; }
.op-btn {
  display: inline-flex; padding: 3px; border: none; border-radius: 4px;
  background: transparent; color: var(--text-muted); cursor: pointer;
}
.op-btn:hover { color: var(--accent); background: var(--bg-hover); }
.op-btn.danger:hover { color: var(--danger); }

/* 开关 */
.switch { position: relative; display: inline-block; width: 32px; height: 18px; margin-right: 2px; }
.switch input { opacity: 0; width: 0; height: 0; }
.slider {
  position: absolute; inset: 0; cursor: pointer;
  border-radius: 10px; background: var(--border);
  border: 1px solid var(--border-light);
  transition: 0.15s;
}
.slider::before {
  content: ''; position: absolute; width: 12px; height: 12px; left: 2px; top: 2px;
  border-radius: 50%; background: var(--text-muted); transition: 0.15s;
}
.switch input:checked + .slider { background: var(--accent-dim); border-color: var(--accent); }
.switch input:checked + .slider::before { transform: translateX(14px); background: var(--accent); }

.tools-panel {
  border-top: 1px dashed var(--border);
  padding: 6px 12px 8px 31px;
  max-height: 160px; overflow-y: auto;
}
.tool-row { padding: 3px 0; font-size: 12px; display: flex; gap: 10px; align-items: baseline; }
.tool-name { color: var(--accent); font-family: monospace; flex: none; }
.tool-desc { color: var(--text-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.confirm-row {
  display: flex; align-items: center; gap: 8px;
  margin: 0 12px 10px 31px; padding: 7px 10px;
  border-radius: 6px; font-size: 12px; color: var(--danger);
  background: var(--bg-secondary); border: 1px solid var(--danger);
}
.btn-danger {
  margin-left: auto; padding: 3px 10px; font-size: 12px; border-radius: 5px;
  color: #fff; background: var(--danger); border: none; cursor: pointer;
}
.btn-cancel {
  padding: 3px 10px; font-size: 12px; border-radius: 5px;
  color: var(--text-secondary); background: transparent;
  border: 1px solid var(--border); cursor: pointer;
}

.mcp-notice {
  position: absolute; bottom: 18px; left: 50%; transform: translateX(-50%);
  padding: 6px 14px; border-radius: 16px; font-size: 12px;
  color: var(--text-primary); background: var(--bg-panel);
  border: 1px solid var(--border-glow);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}

/* 表单子弹窗 */
.form-modal {
  width: 480px; max-width: calc(100vw - 60px);
  max-height: 84vh; overflow-y: auto;
  border-radius: 10px; padding: 16px 18px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  box-shadow: 0 0 0 1px var(--border-glow), 0 12px 40px rgba(0, 0, 0, 0.5);
}
.form-title { font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 12px; }
.field { display: block; margin-bottom: 12px; }
.field-label { display: block; font-size: 11px; color: var(--text-muted); margin-bottom: 4px; }
.field input[type='text'], .field textarea {
  width: 100%; box-sizing: border-box;
  padding: 6px 9px; font-size: 12px;
  border-radius: 6px; border: 1px solid var(--border);
  background: var(--bg-panel); color: var(--text-primary); outline: none;
  resize: vertical;
}
.field input[type='text']:focus, .field textarea:focus { border-color: var(--accent); }
.field input:disabled { color: var(--text-muted); opacity: 0.7; }
.field textarea.mono { font-family: monospace; }
.mode-switch { display: flex; gap: 8px; }
.mode-switch button {
  flex: 1; padding: 6px; font-size: 12px; border-radius: 6px;
  border: 1px solid var(--border); background: var(--bg-panel);
  color: var(--text-muted); cursor: pointer;
}
.mode-switch button.active { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.env-toggle {
  border: none; background: none; padding: 0; cursor: pointer;
  font-size: 11px; color: var(--text-muted);
}
.env-toggle:hover { color: var(--accent); }
.form-error {
  margin-bottom: 10px; padding: 7px 10px; font-size: 12px;
  border-radius: 6px; color: var(--danger);
  border: 1px solid var(--danger); background: var(--bg-panel);
}
.form-actions { display: flex; justify-content: flex-end; gap: 8px; }
.btn-save {
  padding: 5px 14px; font-size: 12px; border-radius: 6px;
  color: var(--accent); background: var(--accent-dim);
  border: 1px solid var(--border-glow); cursor: pointer;
}
.btn-save:disabled { opacity: 0.5; cursor: wait; }
</style>
