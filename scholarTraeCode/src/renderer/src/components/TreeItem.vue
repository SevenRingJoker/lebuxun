<script setup lang="ts">
// 递归树节点：目录可折叠，文件点击后通知 workspace store
// 支持右键菜单冒泡与内部拖拽移动（文件/文件夹可拖到目录上）
import { ref, watch, computed } from 'vue'
import { useWorkspaceStore, type FsNode } from '../stores/workspace'

const props = defineProps<{
  node: FsNode
  // 外部要求展开的路径列表（新建文件/文件夹、拖放时由 FileTree 维护）
  expandedPaths?: string[]
  // 当前正在拖拽的源路径（用于源节点置灰）
  draggingPath?: string | null
  // 当前合法拖放目标路径（用于目标目录高亮）
  dropTargetPath?: string | null
}>()

// 向父级冒泡各类事件，最终由 FileTree 统一处理
const emit = defineEmits<{
  (e: 'node-contextmenu', payload: { node: FsNode; x: number; y: number }): void
  (e: 'node-dragstart', payload: { node: FsNode; event: DragEvent }): void
  (e: 'node-dragover', payload: { node: FsNode; event: DragEvent }): void
  (e: 'node-dragleave', payload: { node: FsNode }): void
  (e: 'node-drop', payload: { node: FsNode; event: DragEvent }): void
  (e: 'node-dragend'): void
  (e: 'node-select', payload: { node: FsNode; shiftKey: boolean; ctrlKey: boolean }): void
  (e: 'node-activate', payload: { node: FsNode }): void
}>()

const ws = useWorkspaceStore()
const expanded = ref<boolean>(props.expandedPaths?.includes(props.node.path) ?? false)
// 当前节点是否在多选集合中（Shift/Ctrl 选择）
const isSelected = computed(() => ws.selectedPaths.has(props.node.path))

// 文件扩展名 → 图标颜色映射（无图标库依赖，用 inline SVG 文件轮廓 + 着色）
const EXT_COLORS: Record<string, string> = {
  vue: '#42B883',
  js: '#F7DF1E',
  ts: '#3178C6',
  jsx: '#61DAFB',
  tsx: '#61DAFB',
  json: '#CBCB41',
  log: '#8B8B94',
  md: '#52525B',
  html: '#E34F26',
  css: '#1572B6',
  scss: '#CC6699',
  py: '#3776AB',
  sh: '#89E051',
  yml: '#CB171E',
  yaml: '#CB171E',
  png: '#A074C4',
  jpg: '#A074C4',
  svg: '#FFB13B',
  zip: '#6E7681',
}
const fileColor = computed(() => {
  if (props.node.type !== 'file') return ''
  const m = props.node.name.match(/\.([^.]+)$/)
  const ext = m ? m[1].toLowerCase() : ''
  return EXT_COLORS[ext] || 'var(--text-muted)'
})

// 外部展开列表变化时同步本地折叠态
watch(
  () => props.expandedPaths,
  (list) => {
    if (list?.includes(props.node.path)) expanded.value = true
  },
  { deep: true }
)

function onClick(node: FsNode, e: MouseEvent): void {
  // Shift/Ctrl+click：交给 FileTree 处理多选，不打开/折叠
  if (e.shiftKey || e.ctrlKey) {
    e.preventDefault()
    emit('node-select', { node, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey })
    return
  }
  // 普通点击：折叠/展开目录或打开文件，并通知 FileTree 清空多选
  if (node.type === 'directory') {
    expanded.value = !expanded.value
  } else {
    ws.openFile(node.path)
  }
  emit('node-activate', { node })
}

// 右键节点：阻止默认菜单，把节点与坐标交给 FileTree 弹出自定义菜单
function onContextMenu(node: FsNode, e: MouseEvent): void {
  e.preventDefault()
  e.stopPropagation()
  emit('node-contextmenu', { node, x: e.clientX, y: e.clientY })
}

// ---------- 拖拽 ----------
function onDragStart(node: FsNode, e: DragEvent): void {
  // 只允许工作区内的节点作为拖拽源
  e.stopPropagation()
  if (e.dataTransfer) {
    // 使用自定义 MIME，避免被识别成 OS 文件拖拽
    e.dataTransfer.setData('application/x-scholar-node', node.path)
    e.dataTransfer.effectAllowed = 'move'
  }
  emit('node-dragstart', { node, event: e })
}

function onDragOver(node: FsNode, e: DragEvent): void {
  // 只有目录才是合法放置目标；合法性的最终判断在 FileTree
  if (node.type !== 'directory') return
  e.preventDefault()
  e.stopPropagation()
  e.dataTransfer && (e.dataTransfer.dropEffect = 'move')
  emit('node-dragover', { node, event: e })
}

function onDragLeave(node: FsNode, e: DragEvent): void {
  e.stopPropagation()
  emit('node-dragleave', { node })
}

function onDrop(node: FsNode, e: DragEvent): void {
  if (node.type !== 'directory') return
  e.preventDefault()
  e.stopPropagation()
  emit('node-drop', { node, event: e })
}

function onDragEnd(e: DragEvent): void {
  e.stopPropagation()
  emit('node-dragend')
}
</script>

<template>
  <div class="tree-node">
    <div
      class="node-row"
      :class="{
        dir: node.type === 'directory',
        active: ws.currentFile === node.path,
        selected: isSelected,
        dragging: draggingPath === node.path,
        'drop-target': dropTargetPath === node.path
      }"
      :draggable="true"
      @click="onClick(node, $event)"
      @contextmenu="onContextMenu(node, $event)"
      @dragstart="onDragStart(node, $event)"
      @dragover="onDragOver(node, $event)"
      @dragleave="onDragLeave(node, $event)"
      @drop="onDrop(node, $event)"
      @dragend="onDragEnd($event)"
    >
      <span class="icon">
        <template v-if="node.type === 'directory'">{{ expanded ? '▾' : '▸' }}</template>
        <svg v-else class="file-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path fill="currentColor" :style="{ color: fileColor }" d="M3 1.5a.5.5 0 0 0-.5.5v12a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5V5.2c0-.13-.05-.26-.15-.35l-3.2-3.2A.5.5 0 0 0 9.8 1.5H3Zm.5 1h5.8v2.7a.5.5 0 0 0 .5.5H12.5V14H3.5V2.5Z"/>
        </svg>
      </span>
      <span class="name">{{ node.name }}</span>
    </div>
    <div v-if="node.type === 'directory' && expanded" class="children">
      <TreeItem
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        :expanded-paths="expandedPaths"
        :dragging-path="draggingPath"
        :drop-target-path="dropTargetPath"
        @node-contextmenu="(p) => emit('node-contextmenu', p)"
        @node-dragstart="(p) => emit('node-dragstart', p)"
        @node-dragover="(p) => emit('node-dragover', p)"
        @node-dragleave="(p) => emit('node-dragleave', p)"
        @node-drop="(p) => emit('node-drop', p)"
        @node-dragend="emit('node-dragend')"
        @node-select="(p) => emit('node-select', p)"
        @node-activate="(p) => emit('node-activate', p)"
      />
    </div>
  </div>
</template>

<style scoped>
.node-row {
  display: flex;
  align-items: center;
  padding: 2px 8px;
  cursor: pointer;
  color: var(--text-secondary);
  user-select: none;
  white-space: nowrap;
  border-left: 2px solid transparent;
}
.node-row:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}
.node-row.dir {
  color: var(--text-primary);
}
.node-row.active {
  background: var(--bg-hover);
  color: var(--text-primary);
  border-left: 2px solid var(--primary);
}

/* Shift/Ctrl 多选选中态 */
.node-row.selected {
  background: var(--bg-hover);
  border-left: 2px solid var(--primary);
}

/* 正在拖拽的源节点：降低不透明度 */
.node-row.dragging {
  opacity: 0.4;
}

/* 合法放置目标：靛蓝描边 + 悬浮底色 */
.node-row.drop-target {
  background: var(--bg-hover);
  border-left: 2px solid var(--primary);
  color: var(--primary);
  box-shadow: inset 0 0 0 1px var(--primary);
}

.icon {
  width: 16px;
  text-align: center;
  margin-right: 4px;
  flex-shrink: 0;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.children {
  padding-left: 16px;
}
</style>
