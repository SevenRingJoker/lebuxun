// 模型管理弹窗：供应商卡片（启停/Key/连通性测试）+ 自定义端点 + 用量统计。
// Key 保存即由主进程 safeStorage 加密，界面只回显掩码；保存后通知父组件刷新模型清单。
<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { UiProviderSettingEntry, UiUsageStats } from '../api'

// embedded=true 时内嵌于统一设置页：不渲染遮罩外壳与关闭按钮
defineProps<{ embedded?: boolean }>()

const emit = defineEmits<{
  (e: 'close'): void
  /** 供应商配置有变化（启停/Key/自定义增删），父组件应刷新模型清单 */
  (e: 'changed'): void
}>()

const providers = ref<UiProviderSettingEntry[]>([])
const usage = ref<UiUsageStats | null>(null)
const loading = ref(false)
/** 每个供应商的测试连接结果：id → 成功/失败文案 */
const testResults = ref<Record<string, { ok: boolean; text: string }>>({})
/** 每个供应商正在编辑的 Key 输入值（空 = 未修改） */
const keyInputs = ref<Record<string, string>>({})
/** 每个供应商的测试中进行状态 */
const testing = ref<Record<string, boolean>>({})

// 新增自定义端点表单
const newName = ref('')
const newBaseUrl = ref('')
const formError = ref('')
const notice = ref('')

// 自定义端点删除确认（应用内非阻塞弹窗，禁原生 confirm）
const pendingRemove = ref<UiProviderSettingEntry | null>(null)

async function loadAll(): Promise<void> {
  loading.value = true
  try {
    providers.value = await window.api.ai.getProviderSettings()
    usage.value = await window.api.ai.getUsageStats()
  } finally {
    loading.value = false
  }
}

async function toggleProvider(p: UiProviderSettingEntry): Promise<void> {
  await window.api.ai.setProviderEnabled(p.id, !p.enabled)
  p.enabled = !p.enabled
  emit('changed')
}

async function saveKey(p: UiProviderSettingEntry): Promise<void> {
  const key = (keyInputs.value[p.id] ?? '').trim()
  if (!key) return
  const res = await window.api.ai.setProviderKey(p.id, key)
  if (res.ok) {
    keyInputs.value[p.id] = ''
    notice.value = `${p.name} 的 API Key 已保存`
    await loadAll()
    emit('changed')
  } else {
    formError.value = res.error || '保存失败'
  }
}

async function clearKey(p: UiProviderSettingEntry): Promise<void> {
  await window.api.ai.setProviderKey(p.id, '')
  notice.value = `${p.name} 的 API Key 已清除`
  await loadAll()
  emit('changed')
}

async function testProvider(p: UiProviderSettingEntry): Promise<void> {
  testing.value[p.id] = true
  testResults.value[p.id] = { ok: false, text: '测试中...' }
  try {
    const res = await window.api.ai.testProvider(p.id)
    testResults.value[p.id] = res.ok
      ? { ok: true, text: '连接成功' }
      : { ok: false, text: res.error || '连接失败' }
  } finally {
    testing.value[p.id] = false
  }
}

async function addCustom(): Promise<void> {
  formError.value = ''
  if (!newBaseUrl.value.trim()) {
    formError.value = '请填写 baseUrl（如 http://127.0.0.1:8080/v1）'
    return
  }
  const res = await window.api.ai.addCustomProvider({ name: newName.value, baseUrl: newBaseUrl.value })
  if (res.ok) {
    newName.value = ''
    newBaseUrl.value = ''
    notice.value = '自定义供应商已添加'
    await loadAll()
    emit('changed')
  } else {
    formError.value = res.error || '添加失败'
  }
}

function askRemove(p: UiProviderSettingEntry): void {
  pendingRemove.value = p
}

async function confirmRemove(): Promise<void> {
  const p = pendingRemove.value
  pendingRemove.value = null
  if (!p) return
  const res = await window.api.ai.removeCustomProvider(p.id)
  if (res.ok) {
    notice.value = `已删除 ${p.name}`
    await loadAll()
    emit('changed')
  } else {
    formError.value = res.error || '删除失败'
  }
}

async function resetUsage(): Promise<void> {
  await window.api.ai.resetUsageStats()
  usage.value = await window.api.ai.getUsageStats()
}

/** 千分位格式化 token 数 */
function fmtNum(n: number): string {
  return n.toLocaleString('en-US')
}

/** 成本格式化：小于 1 美分显示 4 位小数，否则 2 位 */
function fmtCost(usd: number): string {
  return usd < 0.01 && usd > 0 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
}

onMounted(loadAll)
</script>

<template>
  <div :class="embedded ? 'embed-root' : 'modal-overlay'" @click.self="!embedded && emit('close')">
    <div class="settings-modal" :class="{ embed: embedded }">
      <div v-if="!embedded" class="settings-header">
        <span class="settings-title">模型管理</span>
        <button class="close-btn" title="关闭" @click="emit('close')">×</button>
      </div>

      <div class="settings-body">
        <div v-if="notice" class="notice-bar">{{ notice }}</div>
        <div v-if="formError" class="error-bar">{{ formError }}</div>

        <!-- ===== 供应商列表 ===== -->
        <div class="section-title">供应商</div>
        <div v-for="p in providers" :key="p.id" class="provider-card">
          <div class="provider-head">
            <span
              class="health-dot"
              :class="{
                ok: testResults[p.id]?.ok === true,
                bad: testResults[p.id]?.ok === false && testResults[p.id]?.text !== '测试中...'
              }"
            ></span>
            <span class="provider-name">{{ p.name }}</span>
            <span v-if="!p.builtin" class="tag-custom">自定义</span>
            <span class="spacer"></span>
            <button class="test-btn" :disabled="testing[p.id]" @click="testProvider(p)">
              {{ testing[p.id] ? '测试中…' : '测试连接' }}
            </button>
            <label class="switch" :title="p.enabled ? '点击禁用' : '点击启用'">
              <input type="checkbox" :checked="p.enabled" @change="toggleProvider(p)" />
              <span class="slider"></span>
            </label>
          </div>

          <div v-if="p.baseUrl" class="provider-url">{{ p.baseUrl }}</div>
          <div v-if="testResults[p.id]" class="test-result" :class="{ ok: testResults[p.id].ok }">
            {{ testResults[p.id].text }}
          </div>

          <!-- Key 区：需要 Key 或已配置过 Key 的供应商显示 -->
          <div v-if="p.needsKey || p.hasKey" class="key-row">
            <input
              v-model="keyInputs[p.id]"
              class="key-input"
              type="password"
              :placeholder="p.keyMasked ? `当前：${p.keyMasked}（输入新 Key 覆盖）` : '输入 API Key'"
            />
            <button class="mini-btn" :disabled="!keyInputs[p.id]?.trim()" @click="saveKey(p)">保存</button>
            <button v-if="p.hasKey" class="mini-btn danger" @click="clearKey(p)">清除</button>
          </div>
          <div v-if="p.needsKey && !p.hasKey" class="key-hint">未配置 Key，该供应商暂不可用</div>
          <div v-if="!p.encryptionAvailable && p.hasKey" class="key-hint warn">
            当前环境不支持系统级加密，Key 以明文存储
          </div>

          <div class="provider-foot">
            <button v-if="!p.builtin" class="mini-btn danger" @click="askRemove(p)">删除</button>
          </div>
        </div>

        <!-- ===== 新增自定义供应商 ===== -->
        <div class="section-title">新增自定义供应商（OpenAI 兼容端点）</div>
        <div class="add-form">
          <input v-model="newName" class="form-input" placeholder="名称（如：我的 vLLM）" />
          <input v-model="newBaseUrl" class="form-input" placeholder="baseUrl（如 http://127.0.0.1:8080/v1）" />
          <button class="mini-btn primary" @click="addCustom">添加</button>
        </div>

        <!-- ===== 用量统计 ===== -->
        <div class="section-title">
          用量统计
          <span class="spacer"></span>
          <button class="mini-btn danger" :disabled="!usage || usage.totalCalls === 0" @click="resetUsage">
            清零
          </button>
        </div>
        <div v-if="usage && usage.totalCalls > 0" class="usage-table">
          <div class="usage-row usage-head">
            <span>模型</span><span>调用</span><span>输入 token</span><span>输出 token</span><span>估算成本</span>
          </div>
          <div v-for="(u, modelId) in usage.byModel" :key="modelId" class="usage-row">
            <span class="usage-model" :title="modelId">{{ modelId }}</span>
            <span>{{ u.calls }}<template v-if="u.estimatedCalls">（{{ u.estimatedCalls }} 估）</template></span>
            <span>{{ fmtNum(u.tokensIn) }}</span>
            <span>{{ fmtNum(u.tokensOut) }}</span>
            <span>{{ fmtCost(u.cost) }}</span>
          </div>
          <div class="usage-row usage-total">
            <span>合计</span><span>{{ usage.totalCalls }}</span><span></span><span></span>
            <span>{{ fmtCost(usage.totalCost) }}</span>
          </div>
        </div>
        <div v-else class="usage-empty">暂无用量记录</div>
      </div>
    </div>

    <!-- 删除自定义供应商确认（应用内弹窗） -->
    <div v-if="pendingRemove" class="modal-overlay inner" @click.self="pendingRemove = null">
      <div class="confirm-modal">
        <div class="modal-title">删除供应商</div>
        <div class="dlg-message">确定删除「{{ pendingRemove.name }}」吗？其 API Key 配置会一并清除。</div>
        <div class="modal-actions">
          <button class="mini-btn" @click="pendingRemove = null">取消</button>
          <button class="mini-btn danger" @click="confirmRemove">删除</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 930;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
.modal-overlay.inner {
  z-index: 940;
}

.settings-modal {
  width: 620px;
  max-width: calc(100vw - 48px);
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  border: 1px solid var(--border-light);
  background: var(--bg-secondary);
  box-shadow: 0 0 0 1px var(--border-glow), 0 12px 40px rgba(0, 0, 0, 0.5);
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.settings-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: 1px;
}
.close-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 18px;
  cursor: pointer;
  padding: 0 4px;
}
.close-btn:hover {
  color: var(--accent);
}

.settings-body {
  padding: 12px 16px 16px;
  overflow-y: auto;
}

/* 内嵌模式：填充统一设置页内容区，去掉弹窗外壳 */
.embed-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.settings-modal.embed {
  width: 100%;
  max-width: none;
  max-height: none;
  height: 100%;
  border: none;
  border-radius: 0;
  box-shadow: none;
  background: transparent;
}

.notice-bar {
  padding: 6px 10px;
  margin-bottom: 10px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--accent);
  background: var(--accent-dim);
  border: 1px solid var(--border-glow);
}
.error-bar {
  padding: 6px 10px;
  margin-bottom: 10px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--danger);
  border: 1px solid var(--danger);
}

.section-title {
  display: flex;
  align-items: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 1px;
  margin: 14px 0 8px;
}
.section-title:first-child {
  margin-top: 0;
}
.spacer {
  flex: 1;
}

/* ---------- 供应商卡片 ---------- */
.provider-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
  background: var(--bg-panel);
}
.provider-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.provider-name {
  font-weight: 600;
  color: var(--text-primary);
}
.tag-custom {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  color: var(--accent);
  border: 1px solid var(--border-glow);
  background: var(--accent-dim);
}
.provider-url {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-muted);
  word-break: break-all;
}

.health-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted);
  flex-shrink: 0;
}
.health-dot.ok {
  background: var(--success);
  box-shadow: 0 0 6px var(--success);
}
.health-dot.bad {
  background: var(--danger);
  box-shadow: 0 0 6px var(--danger);
}

.test-result {
  margin-top: 6px;
  font-size: 12px;
  color: var(--danger);
  word-break: break-all;
}
.test-result.ok {
  color: var(--success);
}

/* 开关 */
.switch {
  position: relative;
  width: 32px;
  height: 18px;
  flex-shrink: 0;
  cursor: pointer;
}
.switch input {
  display: none;
}
.slider {
  position: absolute;
  inset: 0;
  border-radius: 9px;
  background: var(--bg-hover);
  border: 1px solid var(--border-light);
  transition: background 0.15s;
}
.slider::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--text-muted);
  transition: transform 0.15s, background 0.15s;
}
.switch input:checked + .slider {
  background: var(--accent-dim);
  border-color: var(--accent);
}
.switch input:checked + .slider::before {
  transform: translateX(14px);
  background: var(--accent);
  box-shadow: 0 0 6px var(--accent);
}

/* Key 输入行 */
.key-row {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.key-input {
  flex: 1;
  padding: 6px 10px;
  background: var(--bg-primary);
  border: 1px solid var(--border-light);
  border-radius: 6px;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 12px;
  outline: none;
}
.key-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--border-glow);
}
.key-hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--warning);
}
.key-hint.warn {
  color: var(--danger);
}

.provider-foot {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}

/* ---------- 按钮 ---------- */
.mini-btn {
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid var(--border-light);
  background: var(--bg-hover);
  color: var(--text-primary);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}
.mini-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.mini-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.mini-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--btn-primary-text);
  font-weight: 600;
}
.mini-btn.primary:hover:not(:disabled) {
  background: var(--accent-hover);
  color: var(--btn-primary-text);
}
.mini-btn.danger {
  border-color: var(--danger);
  color: var(--danger);
}
.mini-btn.danger:hover:not(:disabled) {
  background: var(--danger);
  color: #fff;
}
.test-btn {
  padding: 3px 10px;
  border-radius: 5px;
  border: 1px solid var(--border-light);
  background: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
}
.test-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.test-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ---------- 新增表单 ---------- */
.add-form {
  display: flex;
  gap: 6px;
}
.form-input {
  flex: 1;
  padding: 6px 10px;
  background: var(--bg-primary);
  border: 1px solid var(--border-light);
  border-radius: 6px;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 12px;
  outline: none;
}
.form-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--border-glow);
}

/* ---------- 用量统计 ---------- */
.usage-table {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.usage-row {
  display: grid;
  grid-template-columns: 1fr 90px 110px 110px 90px;
  gap: 8px;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
}
.usage-row:last-child {
  border-bottom: none;
}
.usage-head {
  background: var(--bg-tertiary);
  color: var(--text-muted);
  font-weight: 600;
}
.usage-total {
  background: var(--bg-tertiary);
  color: var(--text-primary);
  font-weight: 600;
}
.usage-model {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.usage-empty {
  padding: 16px;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
  border: 1px dashed var(--border);
  border-radius: 8px;
}

/* 确认弹窗 */
.confirm-modal {
  width: 360px;
  padding: 16px;
  border-radius: 10px;
  border: 1px solid var(--border-light);
  background: var(--bg-secondary);
}
.modal-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 10px;
}
.dlg-message {
  margin-top: 4px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
</style>
