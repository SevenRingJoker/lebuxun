/** ① 顶部栏：项目 / 章节 / 模式 / 成长指数 / 全局操作
 *
 * Phase 6（任务 6.2）：右侧加「编辑器 / 仪表盘」视图切换按钮。
 * 收尾：已打开项目时提供「项目」按钮（清空 projectId 回入口页）与
 * 「运行」入口（workflowStore.run()，runStatus 驱动禁用态与状态文案）。
 */

import type { AppView } from '../App.js';
import { useWorkflowStore } from '../stores/workflowStore.js';
import { useProjectOverviewStore } from '../stores/projectOverviewStore.js';

interface TopBarProps {
  view: AppView;
  onViewChange: (view: AppView) => void;
  /** 收尾批次 3：打开设置面板 */
  onOpenSettings: () => void;
}

const RUN_STATUS_LABEL: Record<string, string> = {
  idle: '空闲',
  running: '运行中',
  paused: '已暂停',
  done: '已完成',
  error: '出错',
};

export default function TopBar({ view, onViewChange, onOpenSettings }: TopBarProps) {
  const projectId = useWorkflowStore((s) => s.projectId);
  const workflow = useWorkflowStore((s) => s.workflow);
  const runStatus = useWorkflowStore((s) => s.runStatus);
  const run = useWorkflowStore((s) => s.run);
  const close = useWorkflowStore((s) => s.close);
  const chapterCount = useProjectOverviewStore((s) => s.chapters.length);
  const growthIndex = useProjectOverviewStore((s) => s.growthIndex);

  return (
    <header className="app-topbar">
      <span className="brand">NovelForge</span>
      {projectId === null ? (
        <span className="placeholder">项目：未打开</span>
      ) : (
        <>
          <button type="button" className="topbar-tab" onClick={() => close()}>
            项目
          </button>
          <span className="placeholder">工作流：{workflow?.name ?? '—'}</span>
          {view === 'editor' && (
            <>
              <button
                type="button"
                className="topbar-tab"
                disabled={runStatus === 'running'}
                onClick={() => void run()}
              >
                运行
              </button>
              <span className="placeholder">状态：{RUN_STATUS_LABEL[runStatus] ?? runStatus}</span>
            </>
          )}
        </>
      )}
      <span className="placeholder" title="项目章节总数（定稿后自动刷新）">
        章节：{projectId === null ? '—' : chapterCount}
      </span>
      <span className="placeholder" title="成长指数（偏好学习成熟度，growth:stats）">
        成长指数：{projectId === null || growthIndex === null ? '—' : Math.round(growthIndex * 100)}
      </span>
      <span style={{ flex: 1 }} />
      <button type="button" className="topbar-tab" onClick={onOpenSettings}>
        设置
      </button>
      <button
        type="button"
        className={view === 'editor' ? 'topbar-tab topbar-tab--active' : 'topbar-tab'}
        onClick={() => onViewChange('editor')}
      >
        编辑器
      </button>
      <button
        type="button"
        className={view === 'dashboard' ? 'topbar-tab topbar-tab--active' : 'topbar-tab'}
        onClick={() => onViewChange('dashboard')}
      >
        仪表盘
      </button>
    </header>
  );
}
