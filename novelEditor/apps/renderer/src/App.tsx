/** SPEC §12.1 布局：顶部栏 / 左节点库 / 中画布 / 右侧栏 / 状态栏
 *
 * Phase 6（任务 6.2）：顶层加「编辑器 / 仪表盘」视图切换。
 * 收尾：workflowStore.projectId 为空时渲染 ProjectGate 项目入口页替代主区；
 * 顶层订阅 Main 流事件（§4.1）驱动 run 状态与候选面板，卸载时清理。
 */

import { useEffect, useState } from 'react';
import TopBar from './components/TopBar.js';
import NodeLibrary from './components/NodeLibrary.js';
import CanvasArea from './components/CanvasArea.js';
import SidePanel from './components/SidePanel.js';
import StatusBar from './components/StatusBar.js';
import GrowthDashboard from './components/GrowthDashboard.js';
import ProjectGate from './components/ProjectGate.js';
import SettingsPanel from './components/SettingsPanel.js';
import { onStreamEvent } from './ipc/index.js';
import { useWorkflowStore } from './stores/workflowStore.js';
import { useSettingsStore } from './stores/settingsStore.js';
import { useProjectOverviewStore } from './stores/projectOverviewStore.js';

export type AppView = 'editor' | 'dashboard';

export default function App() {
  const [view, setView] = useState<AppView>('editor');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const projectId = useWorkflowStore((s) => s.projectId);

  // 启动拉一次设置（Ollama 状态 + 路由，供状态栏/设置面板共用，失败由面板自身重试）
  useEffect(() => {
    void useSettingsStore.getState().load();
  }, []);

  // 项目切换：拉取章节概要 + 成长指数；关闭项目时复位
  useEffect(() => {
    if (projectId === null) {
      useProjectOverviewStore.getState().clear();
    } else {
      void useProjectOverviewStore.getState().load(projectId);
    }
  }, [projectId]);

  // 流事件 → workflowStore（run 状态机 + 候选面板触发）/ settingsStore（拉取进度）
  // / projectOverviewStore（成长指数、章节定稿刷新）；非 Electron 环境降级不订阅
  useEffect(() => {
    try {
      return onStreamEvent((event) => {
        useWorkflowStore.getState().onStreamEvent(event);
        useSettingsStore.getState().onStreamEvent(event);
        useProjectOverviewStore.getState().onStreamEvent(event);
      });
    } catch {
      return undefined;
    }
  }, []);

  return (
    <div className="app-shell">
      <TopBar view={view} onViewChange={setView} onOpenSettings={() => setSettingsOpen(true)} />
      {projectId === null ? (
        <main className="app-gate">
          <ProjectGate />
        </main>
      ) : view === 'dashboard' ? (
        <main className="app-dashboard">
          <GrowthDashboard />
        </main>
      ) : (
        <>
          <NodeLibrary />
          <CanvasArea />
          <SidePanel />
        </>
      )}
      <StatusBar />
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
