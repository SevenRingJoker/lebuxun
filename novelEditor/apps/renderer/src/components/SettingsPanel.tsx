/** 收尾批次 3 设置面板（SPEC §7.8 / §15 功能验收）
 *
 * 模态浮层（风格沿用 app.css）：
 * - Ollama 状态区：运行徽标 + 已安装模型列表；
 * - 路由区：6 个任务各一行（中文任务名 + 模型下拉/自由输入 + 温度 + 逐条保存）；
 * - 「恢复默认路由」→ settings:reset-routes；
 * - 「拉取模型」区：名称输入 + 按钮，进度条订阅 settings:pull-progress（按 jobId 过滤）。
 */

import { useEffect, useState } from 'react';
import type { ModelRoute } from '@novel-forge/shared';
import { useSettingsStore } from '../stores/settingsStore.js';

interface SettingsPanelProps {
  onClose: () => void;
}

/** 任务中文名（顺序即面板展示顺序） */
const TASK_LABEL: Record<ModelRoute['task'], string> = {
  'chapter-plan': '章节规划',
  'paragraph-gen': '段落生成',
  polish: '润色',
  'style-analyze': '风格分析',
  discriminator: '判别器',
  embedding: '向量嵌入',
};
const TASK_ORDER: ModelRoute['task'][] = [
  'chapter-plan', 'paragraph-gen', 'polish', 'style-analyze', 'discriminator', 'embedding',
];

function RouteRow({
  route,
  onSave,
  saving,
}: {
  route: ModelRoute;
  onSave: (task: ModelRoute['task'], patch: { model?: string; temperature?: number }) => void;
  saving: boolean;
}) {
  const [model, setModel] = useState(route.model);
  const [temp, setTemp] = useState(String(route.temperature));
  const dirty = model !== route.model || temp !== String(route.temperature);
  const invalid = model.trim() === '' || temp === '' || Number.isNaN(Number(temp));
  return (
    <div className="settings-route-row">
      <span className="settings-route-task">{TASK_LABEL[route.task]}</span>
      <input
        className="settings-route-model"
        list="settings-model-options"
        value={model}
        onChange={(e) => setModel(e.target.value)}
        placeholder="模型名"
      />
      <input
        className="settings-route-temp"
        type="number"
        step={0.1}
        min={0}
        max={2}
        value={temp}
        onChange={(e) => setTemp(e.target.value)}
      />
      <button
        type="button"
        disabled={!dirty || invalid || saving}
        onClick={() => onSave(route.task, { model: model.trim(), temperature: Number(temp) })}
      >
        保存
      </button>
    </div>
  );
}

export default function SettingsPanel({ onClose }: SettingsPanelProps) {
  const routes = useSettingsStore((s) => s.routes);
  const ollama = useSettingsStore((s) => s.ollama);
  const error = useSettingsStore((s) => s.error);
  const pulling = useSettingsStore((s) => s.pulling);
  const pullDone = useSettingsStore((s) => s.pullDone);
  const load = useSettingsStore((s) => s.load);
  const setRoute = useSettingsStore((s) => s.setRoute);
  const resetRoutes = useSettingsStore((s) => s.resetRoutes);
  const pullModel = useSettingsStore((s) => s.pullModel);

  const [pullName, setPullName] = useState('');

  useEffect(() => {
    void load();
  }, [load]);

  const installed = ollama?.models ?? [];
  const byTask = new Map(routes.map((r) => [r.task, r]));

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">设置</span>
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>

        {/* Ollama 状态区 */}
        <div className="settings-section">
          <div className="settings-section-title">Ollama 状态</div>
          <div className="settings-status">
            <span className={ollama?.running ? 'settings-badge settings-badge--ok' : 'settings-badge settings-badge--down'}>
              {ollama?.running ? '运行中' : '未运行'}
            </span>
            {ollama?.detail !== undefined && <span className="settings-detail">{ollama.detail}</span>}
          </div>
          {installed.length > 0 ? (
            <div className="settings-model-list">
              {installed.map((m) => (
                <span key={m} className="settings-model-chip">
                  {m}
                </span>
              ))}
            </div>
          ) : (
            <div className="settings-empty">暂无已安装模型</div>
          )}
        </div>

        {/* 路由区 */}
        <div className="settings-section">
          <div className="settings-section-title">模型路由</div>
          <datalist id="settings-model-options">
            {installed.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {TASK_ORDER.map((task) => {
            const route = byTask.get(task);
            if (!route) return null;
            return (
              <RouteRow
                key={`${task}:${route.model}:${route.temperature}`}
                route={route}
                onSave={(t, patch) => void setRoute(t, patch)}
                saving={false}
              />
            );
          })}
          <div className="settings-actions">
            <button type="button" onClick={() => void resetRoutes()}>
              恢复默认路由
            </button>
          </div>
        </div>

        {/* 拉取模型区 */}
        <div className="settings-section">
          <div className="settings-section-title">拉取模型</div>
          <div className="settings-pull-row">
            <input
              value={pullName}
              onChange={(e) => setPullName(e.target.value)}
              placeholder="模型名（如 qwen3:32b）"
            />
            <button
              type="button"
              disabled={pulling !== null || pullName.trim() === ''}
              onClick={() => void pullModel(pullName.trim())}
            >
              {pulling !== null ? '拉取中…' : '拉取'}
            </button>
          </div>
          {pulling !== null && (
            <div className="settings-progress">
              <span>
                {pulling.model} · {pulling.status}
                {pulling.total !== undefined && pulling.completed !== undefined
                  ? `（${Math.round((pulling.completed / pulling.total) * 100)}%）`
                  : ''}
              </span>
              <progress
                {...(pulling.total !== undefined && pulling.completed !== undefined
                  ? { value: pulling.completed, max: pulling.total }
                  : {})}
              />
            </div>
          )}
          {pullDone !== null && <div className="settings-ok">模型 {pullDone} 已就绪</div>}
        </div>

        {error !== null && <div className="settings-error">{error}</div>}
      </div>
    </div>
  );
}
