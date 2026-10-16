/** ⑤ 状态栏：队列 / 模型 / Token / 显存 / 保存 / 版本
 *
 * 数据来源（无独立轮询，随 store 更新重渲染）：
 * - 队列：workflowStore.runStatus 中文标签
 * - 模型：settingsStore 段落生成路由（paragraph-gen）的 model
 * - 显存：Ollama 无 VRAM 查询 API，显示已检测模型数；未启动时提示
 * - Token：workflowStore.tokenCount（本次 run 累计流式 token）
 * - 保存：所有写操作即时落 SQLite，恒定「自动保存」
 */

import { useSettingsStore } from '../stores/settingsStore.js';
import { useWorkflowStore } from '../stores/workflowStore.js';

const RUN_STATUS_LABEL: Record<string, string> = {
  idle: '空闲',
  running: '运行中',
  paused: '等待人工',
  done: '已完成',
  error: '出错',
};

export default function StatusBar() {
  const runStatus = useWorkflowStore((s) => s.runStatus);
  const tokenCount = useWorkflowStore((s) => s.tokenCount);
  const ollama = useSettingsStore((s) => s.ollama);
  const routes = useSettingsStore((s) => s.routes);

  const paragraphModel = routes.find((r) => r.task === 'paragraph-gen')?.model ?? '—';
  const ollamaLabel = ollama
    ? ollama.running
      ? `${ollama.models.length} 模型`
      : '未启动'
    : '—';

  return (
    <footer className="app-statusbar">
      <span>队列：{RUN_STATUS_LABEL[runStatus] ?? runStatus}</span>
      <span title="段落生成任务当前路由模型（设置面板可改）">模型：{paragraphModel}</span>
      <span>Token：{tokenCount}</span>
      <span title={ollama?.running ? ollama.models.join('、') : ollama?.detail ?? 'Ollama 状态未知'}>
        Ollama：{ollamaLabel}
      </span>
      <span>保存：自动保存</span>
      <span>版本：0.1.0</span>
    </footer>
  );
}
