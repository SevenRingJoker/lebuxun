<script setup lang="ts">
// 规则与技能管理弹窗：三栏 Tab（技能 / 规则 / 笔记）。
// 技能支持 CRUD + 启停；规则支持三层发现 + 项目级启停；笔记只读查看 + 清空二次确认。
// 全程应用内 modal，禁原生 confirm/alert。
import { ref, computed, watch, nextTick } from 'vue'
import { useWorkspaceStore } from '../stores/workspace'
import type { UiSkillMeta, UiRuleMeta, UiAgentNote, UiRsResult } from '../api'

// embedded=true 时内嵌于统一设置页：不渲染遮罩外壳与关闭按钮
defineProps<{ embedded?: boolean }>()

const emit = defineEmits<{ (e: 'close'): void }>()
const ws = useWorkspaceStore()

// 当前目录：取当前打开文件所在目录；无则回退到工作区根（目录级规则上溯起点）
const currentDir = computed<string | null>(() => {
  const f = ws.currentFile
  if (!f || !ws.rootPath) return ws.rootPath
  const idx = Math.max(f.lastIndexOf('/'), f.lastIndexOf('\\'))
  return idx > 0 ? f.slice(0, idx) : ws.rootPath
})

// ---------- Tab 切换 ----------
type TabKey = 'skills' | 'rules' | 'notes'
const activeTab = ref<TabKey>('skills')

// ---------- 技能 ----------
const skills = ref<UiSkillMeta[]>([])
const skillLoading = ref(false)
const skillNotice = ref('')

// 编辑态
const skillEditing = ref(false)
const skillForm = ref({ name: '', description: '', enabled: true, content: '' })
const skillPreview = ref(false)
const skillNameInput = ref<HTMLInputElement | null>(null)

// 删除二次确认
const skillConfirmDelete = ref('')

async function loadSkills(): Promise<void> {
  skillLoading.value = true
  try {
    skills.value = await window.api.skills.list(ws.rootPath)
  } catch {
    skills.value = []
  } finally {
    skillLoading.value = false
  }
}

function startNewSkill(): void {
  skillEditing.value = true
  skillPreview.value = false
  skillForm.value = { name: '', description: '', enabled: true, content: '' }
  skillConfirmDelete.value = ''
  nextTick(() => skillNameInput.value?.focus())
}

function editSkill(s: UiSkillMeta): void {
  skillEditing.value = true
  skillPreview.value = false
  skillConfirmDelete.value = ''
  // 拉取全文
  window.api.skills.read(ws.rootPath, s.name).then((res: UiRsResult & { data?: string }) => {
    if (res.ok && res.data != null) {
      skillForm.value = { name: s.name, description: s.description, enabled: s.enabled !== false, content: res.data }
    } else {
      skillForm.value = { name: s.name, description: s.description, enabled: s.enabled !== false, content: '' }
    }
  })
}

async function saveSkill(): Promise<void> {
  const { name, description, enabled, content } = skillForm.value
  const n = name.trim()
  if (!n) {
    skillNotice.value = '技能名不能为空'
    setTimeout(() => (skillNotice.value = ''), 2000)
    return
  }
  const res: UiRsResult = await window.api.skills.write(ws.rootPath, n, description.trim(), enabled, content)
  if (res.ok) {
    skillNotice.value = '已保存'
    skillEditing.value = false
    await loadSkills()
  } else {
    skillNotice.value = res.error || '保存失败'
  }
  setTimeout(() => (skillNotice.value = ''), 2500)
}

async function toggleSkill(name: string, enabled: boolean): Promise<void> {
  const res: UiRsResult = await window.api.skills.toggle(ws.rootPath, name, enabled)
  if (!res.ok) {
    skillNotice.value = res.error || '启停失败'
    setTimeout(() => (skillNotice.value = ''), 2000)
  }
  await loadSkills()
}

async function deleteSkill(name: string): Promise<void> {
  const res: UiRsResult = await window.api.skills.delete(ws.rootPath, name)
  skillConfirmDelete.value = ''
  if (res.ok) {
    skillNotice.value = '已删除'
    await loadSkills()
  } else {
    skillNotice.value = res.error || '删除失败'
  }
  setTimeout(() => (skillNotice.value = ''), 2000)
}

// ---------- 规则 ----------
const rules = ref<UiRuleMeta[]>([])
const ruleLoading = ref(false)
const ruleNotice = ref('')

const ruleEditing = ref(false)
const ruleForm = ref({ name: '', scope: 'project' as UiRuleMeta['scope'], content: '', dirPath: '' })
const rulePreview = ref(false)
const ruleConfirmDelete = ref('')

const rulesByScope = computed(() => {
  const groups: Record<string, UiRuleMeta[]> = { user: [], project: [], directory: [] }
  for (const r of rules.value) groups[r.scope].push(r)
  return groups
})

async function loadRules(): Promise<void> {
  ruleLoading.value = true
  try {
    rules.value = await window.api.rules.list(ws.rootPath, currentDir.value)
  } catch {
    rules.value = []
  } finally {
    ruleLoading.value = false
  }
}

function startNewRule(): void {
  ruleEditing.value = true
  rulePreview.value = false
  ruleForm.value = { name: '', scope: 'project', content: '', dirPath: currentDir.value || '' }
  ruleConfirmDelete.value = ''
  nextTick(() => {
    const el = document.getElementById('rule-name-input') as HTMLInputElement | null
    el?.focus()
  })
}

function editRule(r: UiRuleMeta): void {
  ruleEditing.value = true
  rulePreview.value = false
  ruleConfirmDelete.value = ''
  window.api.rules.read(ws.rootPath, r.path).then((res: UiRsResult & { data?: string }) => {
    if (res.ok && res.data != null) {
      ruleForm.value = { name: r.name, scope: r.scope, content: res.data, dirPath: currentDir.value || '' }
    } else {
      ruleForm.value = { name: r.name, scope: r.scope, content: '', dirPath: currentDir.value || '' }
    }
  })
}

async function saveRule(): Promise<void> {
  const { name, scope, content, dirPath } = ruleForm.value
  const n = name.trim()
  if (!n) {
    ruleNotice.value = '规则名不能为空'
    setTimeout(() => (ruleNotice.value = ''), 2000)
    return
  }
  const res = await window.api.rules.write(ws.rootPath, scope as UiRuleMeta['scope'], n, content, scope === 'directory' ? dirPath : null)
  if (res.ok) {
    ruleNotice.value = '已保存'
    ruleEditing.value = false
    await loadRules()
  } else {
    ruleNotice.value = res.error || '保存失败'
  }
  setTimeout(() => (ruleNotice.value = ''), 2500)
}

async function toggleRule(name: string, enabled: boolean): Promise<void> {
  const res: UiRsResult = await window.api.rules.toggle(ws.rootPath, name, enabled)
  if (!res.ok) {
    ruleNotice.value = res.error || '启停失败'
    setTimeout(() => (ruleNotice.value = ''), 2000)
  }
  await loadRules()
}

async function deleteRule(path: string): Promise<void> {
  const res: UiRsResult = await window.api.rules.delete(ws.rootPath, path)
  ruleConfirmDelete.value = ''
  if (res.ok) {
    ruleNotice.value = '已删除'
    await loadRules()
  } else {
    ruleNotice.value = res.error || '删除失败'
  }
  setTimeout(() => (ruleNotice.value = ''), 2000)
}

// ---------- 笔记 ----------
const noteData = ref<UiAgentNote | null>(null)
const noteLoading = ref(false)
const noteNotice = ref('')
const noteConfirmClear = ref(false)

async function loadNotes(): Promise<void> {
  noteLoading.value = true
  try {
    noteData.value = await window.api.notes.load(ws.rootPath)
  } catch {
    noteData.value = null
  } finally {
    noteLoading.value = false
  }
}

async function doClearNotes(): Promise<void> {
  noteConfirmClear.value = false
  const res: UiRsResult = await window.api.notes.clear(ws.rootPath)
  if (res.ok) {
    noteNotice.value = '笔记已清空（已自动备份）'
    await loadNotes()
  } else {
    noteNotice.value = res.error || '清空失败'
  }
  setTimeout(() => (noteNotice.value = ''), 2500)
}

// ---------- Tab 切换时加载 ----------
watch(activeTab, (tab) => {
  if (tab === 'skills') loadSkills()
  if (tab === 'rules') loadRules()
  if (tab === 'notes') loadNotes()
}, { immediate: true })
</script>

<template>
  <div :class="embedded ? 'embed-root' : 'modal-overlay'" @click.self="!embedded && emit('close')">
    <div class="rs-modal" :class="{ embed: embedded }">
      <div class="rs-header">
        <div class="rs-tabs">
          <button
            v-for="t in [
              { key: 'skills' as TabKey, label: '技能' },
              { key: 'rules' as TabKey, label: '规则' },
              { key: 'notes' as TabKey, label: '笔记' }
            ]"
            :key="t.key"
            class="rs-tab"
            :class="{ active: activeTab === t.key }"
            @click="activeTab = t.key"
          >{{ t.label }}</button>
        </div>
        <button v-if="!embedded" class="btn-close" title="关闭" @click="emit('close')">✕</button>
      </div>

      <!-- 技能栏 -->
      <div v-if="activeTab === 'skills'" class="rs-body">
        <div v-if="!skillEditing" class="list-pane">
          <div class="toolbar">
            <button class="btn-new" @click="startNewSkill">
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <path fill="currentColor" d="M8 2a.8.8 0 0 1 .8.8v4.4h4.4a.8.8 0 0 1 0 1.6H8.8v4.4a.8.8 0 0 1-1.6 0V8.8H2.8a.8.8 0 0 1 0-1.6h4.4V2.8A.8.8 0 0 1 8 2Z"/>
              </svg>
              新建技能
            </button>
          </div>
          <div class="item-list">
            <div v-if="skillLoading" class="empty-hint">加载中…</div>
            <div v-else-if="skills.length === 0" class="empty-hint">暂无技能，点击上方按钮新建</div>
            <div
              v-for="s in skills"
              :key="s.name"
              class="item-card"
            >
              <div class="card-top">
                <span class="card-name">{{ s.name }}</span>
                <label class="switch" title="启用/禁用">
                  <input type="checkbox" :checked="s.enabled !== false" @change="toggleSkill(s.name, ($event.target as HTMLInputElement).checked)">
                  <span class="slider"></span>
                </label>
              </div>
              <div class="card-desc">{{ s.description || '（无描述）' }}</div>
              <div class="card-ops">
                <button class="op-btn" title="编辑" @click="editSkill(s)">
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                    <path fill="currentColor" d="M11.3 1.7a1.7 1.7 0 0 1 2.4 0l.6.6a1.7 1.7 0 0 1 0 2.4L6 13l-3.6 1L3.4 10l7.9-8.3Zm1 .9L12 2.3a.5.5 0 0 0-.7 0L10.5 3.1l2.4 2.4.8-.8a.5.5 0 0 0 0-.7l-1.4-1.4ZM9.7 4.3 4.9 9.1l-.5 1.9 1.9-.5 4.8-4.8-1.4-1.4Z"/>
                  </svg>
                </button>
                <button class="op-btn danger" title="删除" @click="skillConfirmDelete = s.name">
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                    <path fill="currentColor" d="M6.5 1a.5.5 0 0 0-.5.5V2H3.2a.7.7 0 0 0 0 1.4h.4l.6 10.3A1.5 1.5 0 0 0 5.7 15h4.6a1.5 1.5 0 0 0 1.5-1.3l.6-10.3h.4a.7.7 0 0 0 0-1.4H10v-.5a.5.5 0 0 0-.5-.5h-3ZM5.5 3h5l-.6 10.5h-3.8L5.5 3Zm1 1.7a.5.5 0 0 1 .5.5v6.5a.5.5 0 0 1-1 0V5.2a.5.5 0 0 1 .5-.5Zm3 0a.5.5 0 0 1 .5.5v6.5a.5.5 0 0 1-1 0V5.2a.5.5 0 0 1 .5-.5Z"/>
                  </svg>
                </button>
              </div>
              <!-- 删除二次确认 -->
              <div v-if="skillConfirmDelete === s.name" class="confirm-row">
                <span>确认删除「{{ s.name }}」？不可恢复</span>
                <button class="btn-confirm-danger" @click="deleteSkill(s.name)">删除</button>
                <button class="btn-confirm-cancel" @click="skillConfirmDelete = ''">取消</button>
              </div>
            </div>
          </div>
        </div>
        <div v-else class="editor-pane">
          <div class="editor-toolbar">
            <input ref="skillNameInput" v-model="skillForm.name" class="editor-title" placeholder="技能名称" maxlength="60">
            <button class="btn-secondary" :class="{ active: skillPreview }" @click="skillPreview = !skillPreview">
              {{ skillPreview ? '编辑' : '预览' }}
            </button>
            <button class="btn-primary" @click="saveSkill">保存</button>
            <button class="btn-ghost" @click="skillEditing = false">取消</button>
          </div>
          <div class="editor-fields">
            <input v-model="skillForm.description" class="editor-desc" placeholder="一句话描述（可选）" maxlength="120">
            <label class="editor-check">
              <input v-model="skillForm.enabled" type="checkbox">
              <span>启用</span>
            </label>
          </div>
          <textarea v-if="!skillPreview" v-model="skillForm.content" class="editor-area" placeholder="Markdown 正文…"></textarea>
          <div v-else class="editor-preview md-body" v-html="skillForm.content ? skillForm.content.replace(/\n/g, '<br>') : '（空）'"></div>
        </div>
      </div>

      <!-- 规则栏 -->
      <div v-if="activeTab === 'rules'" class="rs-body">
        <div v-if="!ruleEditing" class="list-pane">
          <div class="toolbar">
            <button class="btn-new" @click="startNewRule">
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <path fill="currentColor" d="M8 2a.8.8 0 0 1 .8.8v4.4h4.4a.8.8 0 0 1 0 1.6H8.8v4.4a.8.8 0 0 1-1.6 0V8.8H2.8a.8.8 0 0 1 0-1.6h4.4V2.8A.8.8 0 0 1 8 2Z"/>
              </svg>
              新建规则
            </button>
          </div>
          <div class="item-list">
            <div v-if="ruleLoading" class="empty-hint">加载中…</div>
            <template v-else>
              <div v-if="rules.length === 0" class="empty-hint">暂无规则</div>
              <!-- 用户级 -->
              <div v-if="rulesByScope.user.length" class="scope-group">
                <div class="scope-label">用户级（~/.trae/rules/）</div>
                <div v-for="r in rulesByScope.user" :key="r.path" class="item-card">
                  <div class="card-top">
                    <span class="card-name">{{ r.name }}</span>
                    <span class="scope-tag user">用户</span>
                  </div>
                  <div class="card-desc">{{ r.contentPreview }}</div>
                  <div class="card-ops">
                    <button class="op-btn" title="编辑" @click="editRule(r)">
                      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                        <path fill="currentColor" d="M11.3 1.7a1.7 1.7 0 0 1 2.4 0l.6.6a1.7 1.7 0 0 1 0 2.4L6 13l-3.6 1L3.4 10l7.9-8.3Zm1 .9L12 2.3a.5.5 0 0 0-.7 0L10.5 3.1l2.4 2.4.8-.8a.5.5 0 0 0 0-.7l-1.4-1.4ZM9.7 4.3 4.9 9.1l-.5 1.9 1.9-.5 4.8-4.8-1.4-1.4Z"/>
                      </svg>
                    </button>
                    <button class="op-btn danger" title="删除" @click="ruleConfirmDelete = r.path">
                      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                        <path fill="currentColor" d="M6.5 1a.5.5 0 0 0-.5.5V2H3.2a.7.7 0 0 0 0 1.4h.4l.6 10.3A1.5 1.5 0 0 0 5.7 15h4.6a1.5 1.5 0 0 0 1.5-1.3l.6-10.3h.4a.7.7 0 0 0 0-1.4H10v-.5a.5.5 0 0 0-.5-.5h-3ZM5.5 3h5l-.6 10.5h-3.8L5.5 3Zm1 1.7a.5.5 0 0 1 .5.5v6.5a.5.5 0 0 1-1 0V5.2a.5.5 0 0 1 .5-.5Zm3 0a.5.5 0 0 1 .5.5v6.5a.5.5 0 0 1-1 0V5.2a.5.5 0 0 1 .5-.5Z"/>
                      </svg>
                    </button>
                  </div>
                  <div v-if="ruleConfirmDelete === r.path" class="confirm-row">
                    <span>确认删除「{{ r.name }}」？不可恢复</span>
                    <button class="btn-confirm-danger" @click="deleteRule(r.path)">删除</button>
                    <button class="btn-confirm-cancel" @click="ruleConfirmDelete = ''">取消</button>
                  </div>
                </div>
              </div>
              <!-- 项目级 -->
              <div v-if="rulesByScope.project.length" class="scope-group">
                <div class="scope-label">项目级（.trae/rules/）</div>
                <div v-for="r in rulesByScope.project" :key="r.path" class="item-card">
                  <div class="card-top">
                    <span class="card-name">{{ r.name }}</span>
                    <label class="switch" title="启用/禁用">
                      <input type="checkbox" :checked="r.enabled" @change="toggleRule(r.name, ($event.target as HTMLInputElement).checked)">
                      <span class="slider"></span>
                    </label>
                  </div>
                  <div class="card-desc">{{ r.contentPreview }}</div>
                  <div class="card-ops">
                    <button class="op-btn" title="编辑" @click="editRule(r)">
                      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                        <path fill="currentColor" d="M11.3 1.7a1.7 1.7 0 0 1 2.4 0l.6.6a1.7 1.7 0 0 1 0 2.4L6 13l-3.6 1L3.4 10l7.9-8.3Zm1 .9L12 2.3a.5.5 0 0 0-.7 0L10.5 3.1l2.4 2.4.8-.8a.5.5 0 0 0 0-.7l-1.4-1.4ZM9.7 4.3 4.9 9.1l-.5 1.9 1.9-.5 4.8-4.8-1.4-1.4Z"/>
                      </svg>
                    </button>
                    <button class="op-btn danger" title="删除" @click="ruleConfirmDelete = r.path">
                      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                        <path fill="currentColor" d="M6.5 1a.5.5 0 0 0-.5.5V2H3.2a.7.7 0 0 0 0 1.4h.4l.6 10.3A1.5 1.5 0 0 0 5.7 15h4.6a1.5 1.5 0 0 0 1.5-1.3l.6-10.3h.4a.7.7 0 0 0 0-1.4H10v-.5a.5.5 0 0 0-.5-.5h-3ZM5.5 3h5l-.6 10.5h-3.8L5.5 3Zm1 1.7a.5.5 0 0 1 .5.5v6.5a.5.5 0 0 1-1 0V5.2a.5.5 0 0 1 .5-.5Zm3 0a.5.5 0 0 1 .5.5v6.5a.5.5 0 0 1-1 0V5.2a.5.5 0 0 1 .5-.5Z"/>
                      </svg>
                    </button>
                  </div>
                  <div v-if="ruleConfirmDelete === r.path" class="confirm-row">
                    <span>确认删除「{{ r.name }}」？不可恢复</span>
                    <button class="btn-confirm-danger" @click="deleteRule(r.path)">删除</button>
                    <button class="btn-confirm-cancel" @click="ruleConfirmDelete = ''">取消</button>
                  </div>
                </div>
              </div>
              <!-- 目录级 -->
              <div v-if="rulesByScope.directory.length" class="scope-group">
                <div class="scope-label">目录级（就近优先）</div>
                <div v-for="r in rulesByScope.directory" :key="r.path" class="item-card">
                  <div class="card-top">
                    <span class="card-name">{{ r.name }}</span>
                    <span class="scope-tag directory">目录</span>
                  </div>
                  <div class="card-desc">{{ r.contentPreview }}</div>
                  <div class="card-ops">
                    <button class="op-btn" title="编辑" @click="editRule(r)">
                      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                        <path fill="currentColor" d="M11.3 1.7a1.7 1.7 0 0 1 2.4 0l.6.6a1.7 1.7 0 0 1 0 2.4L6 13l-3.6 1L3.4 10l7.9-8.3Zm1 .9L12 2.3a.5.5 0 0 0-.7 0L10.5 3.1l2.4 2.4.8-.8a.5.5 0 0 0 0-.7l-1.4-1.4ZM9.7 4.3 4.9 9.1l-.5 1.9 1.9-.5 4.8-4.8-1.4-1.4Z"/>
                      </svg>
                    </button>
                    <button class="op-btn danger" title="删除" @click="ruleConfirmDelete = r.path">
                      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                        <path fill="currentColor" d="M6.5 1a.5.5 0 0 0-.5.5V2H3.2a.7.7 0 0 0 0 1.4h.4l.6 10.3A1.5 1.5 0 0 0 5.7 15h4.6a1.5 1.5 0 0 0 1.5-1.3l.6-10.3h.4a.7.7 0 0 0 0-1.4H10v-.5a.5.5 0 0 0-.5-.5h-3ZM5.5 3h5l-.6 10.5h-3.8L5.5 3Zm1 1.7a.5.5 0 0 1 .5.5v6.5a.5.5 0 0 1-1 0V5.2a.5.5 0 0 1 .5-.5Zm3 0a.5.5 0 0 1 .5.5v6.5a.5.5 0 0 1-1 0V5.2a.5.5 0 0 1 .5-.5Z"/>
                      </svg>
                    </button>
                  </div>
                  <div v-if="ruleConfirmDelete === r.path" class="confirm-row">
                    <span>确认删除「{{ r.name }}」？不可恢复</span>
                    <button class="btn-confirm-danger" @click="deleteRule(r.path)">删除</button>
                    <button class="btn-confirm-cancel" @click="ruleConfirmDelete = ''">取消</button>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </div>
        <div v-else class="editor-pane">
          <div class="editor-toolbar">
            <input id="rule-name-input" v-model="ruleForm.name" class="editor-title" placeholder="规则名称" maxlength="60">
            <select v-model="ruleForm.scope" class="editor-select">
              <option value="project">项目级</option>
              <option value="directory">目录级</option>
              <option value="user">用户级</option>
            </select>
            <button class="btn-secondary" :class="{ active: rulePreview }" @click="rulePreview = !rulePreview">
              {{ rulePreview ? '编辑' : '预览' }}
            </button>
            <button class="btn-primary" @click="saveRule">保存</button>
            <button class="btn-ghost" @click="ruleEditing = false">取消</button>
          </div>
          <div v-if="ruleForm.scope === 'directory'" class="editor-fields">
            <input v-model="ruleForm.dirPath" class="editor-desc" placeholder="目录绝对路径（留空使用当前目录）">
          </div>
          <textarea v-if="!rulePreview" v-model="ruleForm.content" class="editor-area" placeholder="Markdown 正文…"></textarea>
          <div v-else class="editor-preview md-body" v-html="ruleForm.content ? ruleForm.content.replace(/\n/g, '<br>') : '（空）'"></div>
        </div>
      </div>

      <!-- 笔记栏 -->
      <div v-if="activeTab === 'notes'" class="rs-body">
        <div class="list-pane">
          <div class="toolbar">
            <button class="btn-new" @click="loadNotes">
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <path fill="currentColor" d="M2.5 8a5.5 5.5 0 1 1 9.5 3.85L14 14l-2.15-2A5.5 5.5 0 0 1 2.5 8Zm1 0a4.5 4.5 0 1 0 9 0 4.5 4.5 0 0 0-9 0Z"/>
              </svg>
              刷新
            </button>
            <button class="btn-danger" @click="noteConfirmClear = true">
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <path fill="currentColor" d="M5 1h6v1h3v1H2V2h3V1Zm1 3h4v9H6V4ZM4 4h1v9H4V4Zm7 0h1v9h-1V4Z"/>
              </svg>
              清空笔记
            </button>
          </div>
          <div class="item-list">
            <div v-if="noteLoading" class="empty-hint">加载中…</div>
            <div v-else-if="!noteData || Object.keys(noteData).length === 0" class="empty-hint">暂无笔记</div>
            <div v-else class="note-view">
              <div v-if="noteData.projectStructure" class="note-block">
                <div class="note-label">项目结构</div>
                <pre class="note-pre">{{ noteData.projectStructure }}</pre>
              </div>
              <div v-if="noteData.userPreferences" class="note-block">
                <div class="note-label">用户偏好</div>
                <pre class="note-pre">{{ noteData.userPreferences }}</pre>
              </div>
              <div v-if="noteData.lastTask" class="note-block">
                <div class="note-label">上次任务</div>
                <pre class="note-pre">{{ noteData.lastTask }}</pre>
              </div>
              <div v-if="noteData.lastTaskResult" class="note-block">
                <div class="note-label">上次任务结果</div>
                <pre class="note-pre">{{ noteData.lastTaskResult }}</pre>
              </div>
              <div v-if="noteData.commonErrors?.length" class="note-block">
                <div class="note-label">常见错误（{{ noteData.commonErrors.length }} 条）</div>
                <div v-for="(e, i) in noteData.commonErrors" :key="i" class="note-error">
                  <div class="err-title">{{ e.error }}（出现 {{ e.count }} 次）</div>
                  <div class="err-fix">修复：{{ e.fix }}</div>
                </div>
              </div>
              <div v-if="noteData.updatedAt" class="note-meta">更新时间：{{ noteData.updatedAt }}</div>
            </div>
          </div>
          <!-- 清空二次确认 -->
          <div v-if="noteConfirmClear" class="confirm-row">
            <span>确定清空笔记？操作前已自动备份，清空后不可恢复</span>
            <button class="btn-confirm-danger" @click="doClearNotes">确认清空</button>
            <button class="btn-confirm-cancel" @click="noteConfirmClear = false">取消</button>
          </div>
        </div>
      </div>

      <!-- 全局通知 -->
      <Transition name="fade">
        <div v-if="skillNotice || ruleNotice || noteNotice" class="rs-notice">
          {{ skillNotice || ruleNotice || noteNotice }}
        </div>
      </Transition>
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
.rs-modal {
  width: 620px;
  max-width: calc(100vw - 48px);
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  border-radius: 10px;
  border: 1px solid var(--border-light);
  background: var(--bg-secondary);
  box-shadow: 0 0 0 1px var(--border-glow), 0 12px 40px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

/* 内嵌模式：填充统一设置页内容区，去掉弹窗外壳 */
.embed-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.rs-modal.embed {
  width: 100%;
  max-width: none;
  max-height: none;
  height: 100%;
  border: none;
  border-radius: 0;
  box-shadow: none;
  background: transparent;
}
.rs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.rs-tabs {
  display: flex;
  gap: 4px;
}
.rs-tab {
  padding: 5px 12px;
  font-size: 13px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.12s;
}
.rs-tab:hover { color: var(--text-primary); background: var(--bg-hover); }
.rs-tab.active { color: var(--accent); background: var(--accent-dim); border-color: var(--border-glow); }

.btn-close {
  border: none;
  background: none;
  color: var(--text-muted);
  font-size: 13px;
  cursor: pointer;
  padding: 2px 6px;
}
.btn-close:hover { color: var(--text-primary); }

/* 内容区 */
.rs-body { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
.list-pane { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.btn-new {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  font-size: 12px;
  border-radius: 6px;
  color: var(--accent);
  background: var(--accent-dim);
  border: 1px solid var(--border-glow);
  cursor: pointer;
}
.btn-danger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  font-size: 12px;
  border-radius: 6px;
  color: var(--danger);
  background: rgba(255, 60, 60, 0.08);
  border: 1px solid rgba(255, 60, 60, 0.25);
  cursor: pointer;
}
.item-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 10px 12px;
}
.empty-hint {
  padding: 36px 16px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

/* 卡片 */
.item-card {
  margin: 6px 4px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  transition: border-color 0.12s;
}
.item-card:hover { border-color: var(--border-light); }
.card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.card-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.card-desc {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-all;
}
.card-ops {
  margin-top: 8px;
  display: flex;
  gap: 4px;
}
.op-btn {
  display: inline-flex;
  padding: 3px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.op-btn:hover { color: var(--accent); background: var(--bg-hover); }
.op-btn.danger:hover { color: var(--danger); }

/* 作用域标签 */
.scope-group { margin-bottom: 6px; }
.scope-label {
  padding: 6px 8px 4px;
  font-size: 11px;
  color: var(--text-muted);
  opacity: 0.8;
}
.scope-tag {
  font-size: 10px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 8px;
  border: 1px solid var(--border);
  color: var(--text-muted);
}
.scope-tag.user { border-color: var(--accent); color: var(--accent); }
.scope-tag.directory { border-color: #8bc34a; color: #8bc34a; }

/* 编辑器 */
.editor-pane { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
.editor-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.editor-title {
  flex: 1;
  padding: 6px 8px;
  font-size: 13px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text-primary);
  outline: none;
}
.editor-select {
  padding: 5px 8px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text-primary);
  outline: none;
}
.editor-fields {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.editor-desc {
  flex: 1;
  padding: 5px 8px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text-primary);
  outline: none;
}
.editor-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
}
.editor-area {
  flex: 1;
  resize: none;
  padding: 10px 14px;
  font-size: 13px;
  line-height: 1.5;
  border: none;
  outline: none;
  background: var(--bg-panel);
  color: var(--text-primary);
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
}
.editor-preview {
  flex: 1;
  padding: 10px 14px;
  overflow-y: auto;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
  background: var(--bg-panel);
}

/* 按钮 */
.btn-primary {
  padding: 5px 12px;
  font-size: 12px;
  border-radius: 6px;
  color: #fff;
  background: var(--accent);
  border: none;
  cursor: pointer;
}
.btn-secondary {
  padding: 5px 10px;
  font-size: 12px;
  border-radius: 6px;
  color: var(--text-secondary);
  background: var(--bg-hover);
  border: 1px solid var(--border);
  cursor: pointer;
}
.btn-secondary.active { color: var(--accent); border-color: var(--border-glow); }
.btn-ghost {
  padding: 5px 10px;
  font-size: 12px;
  border-radius: 6px;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border);
  cursor: pointer;
}

/* 删除确认 */
.confirm-row {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--danger);
  background: var(--bg-panel);
  border: 1px solid var(--danger);
}
.btn-confirm-danger {
  margin-left: auto;
  padding: 3px 10px;
  font-size: 12px;
  border-radius: 5px;
  color: #fff;
  background: var(--danger);
  border: none;
  cursor: pointer;
}
.btn-confirm-cancel {
  padding: 3px 10px;
  font-size: 12px;
  border-radius: 5px;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid var(--border);
  cursor: pointer;
}

/* 笔记只读区 */
.note-view { padding: 4px 6px; }
.note-block { margin-bottom: 14px; }
.note-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
  margin-bottom: 4px;
}
.note-pre {
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}
.note-error {
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  margin-bottom: 6px;
}
.err-title { font-size: 12px; color: var(--danger); }
.err-fix { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
.note-meta { font-size: 11px; color: var(--text-muted); text-align: right; margin-top: 4px; }

/* 通知 */
.rs-notice {
  position: absolute;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 14px;
  border-radius: 16px;
  font-size: 12px;
  color: var(--text-primary);
  background: var(--bg-panel);
  border: 1px solid var(--border-glow);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}
.fade-enter-active, .fade-leave-active { transition: opacity 0.2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

/* 开关 */
.switch {
  position: relative;
  display: inline-block;
  width: 34px;
  height: 18px;
  flex-shrink: 0;
}
.switch input { opacity: 0; width: 0; height: 0; }
.slider {
  position: absolute;
  cursor: pointer;
  inset: 0;
  background: var(--border);
  border-radius: 18px;
  transition: background 0.2s;
}
.slider::before {
  position: absolute;
  content: '';
  height: 14px;
  width: 14px;
  left: 2px;
  bottom: 2px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.2s;
}
.switch input:checked + .slider { background: var(--accent); }
.switch input:checked + .slider::before { transform: translateX(16px); }
</style>
