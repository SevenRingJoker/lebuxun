/** 项目入口页（收尾新增）：workflowStore.projectId 为空时替代三栏编辑区渲染
 *
 * - 项目列表卡片：名称 / 类型 / 更新时间，点击打开（workflowStore.load(projectId, defaultWorkflowId)）
 * - 新建项目表单：名称 / 类型 / 描述，project:create 成功后直接打开
 * load 失败时 projectId 留空、本页保持渲染，错误经 workflowStore.error 展示（可重试）
 */

import { useCallback, useEffect, useState } from 'react';
import type { ProjectListItem } from '@novel-forge/shared';
import { projectApi } from '../ipc/index.js';
import { useWorkflowStore } from '../stores/workflowStore.js';

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN');
}

export default function ProjectGate() {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [name, setName] = useState('');
  const [genre, setGenre] = useState('');
  const [description, setDescription] = useState('');
  const load = useWorkflowStore((s) => s.load);
  const storeError = useWorkflowStore((s) => s.error);

  const refresh = useCallback(async (): Promise<ProjectListItem[]> => {
    try {
      const res = await projectApi.list();
      if (res.ok && res.projects !== undefined) {
        setProjects(res.projects);
        setError(null);
        return res.projects;
      }
      setError(res.error ?? '项目列表加载失败');
    } catch (err) {
      // 非 Electron 环境（纯 vite 预览）下降级为错误提示
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
    return [];
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openProject = async (p: ProjectListItem): Promise<void> => {
    if (p.defaultWorkflowId === undefined) {
      setError(`项目「${p.name}」未绑定默认工作流，无法打开`);
      return;
    }
    setOpening(true);
    try {
      await load(p.id, p.defaultWorkflowId);
    } finally {
      setOpening(false);
    }
  };

  const createProject = async (): Promise<void> => {
    if (name.trim() === '' || genre.trim() === '') {
      setError('请填写项目名称与类型');
      return;
    }
    setOpening(true);
    try {
      const res = await projectApi.create({
        name: name.trim(),
        genre: genre.trim(),
        ...(description.trim() !== '' ? { description: description.trim() } : {}),
      });
      if (!res.ok || res.project === undefined) {
        setError(res.error ?? '创建项目失败');
        return;
      }
      // 重拉列表拿 defaultWorkflowId 后直接打开
      const list = await refresh();
      const created = list.find((p) => p.id === res.project?.id);
      if (created?.defaultWorkflowId !== undefined) {
        await load(created.id, created.defaultWorkflowId);
      } else {
        setError('项目已创建，但未找到默认工作流，请从列表打开');
      }
    } finally {
      setOpening(false);
    }
  };

  const shownError = error ?? storeError;

  return (
    <div className="project-gate">
      <h2 className="gate-title">项目入口</h2>
      {shownError !== null && <div className="gate-error">{shownError}</div>}

      <div className="gate-create">
        <h3>新建项目</h3>
        <label>
          名称
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：长安夜话" />
        </label>
        <label>
          类型
          <input value={genre} onChange={(e) => setGenre(e.target.value)} placeholder="如：玄幻 / 科幻 / 武侠" />
        </label>
        <label>
          描述（可选）
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="一句话简介"
          />
        </label>
        <div className="gate-actions">
          <button type="button" disabled={opening} onClick={() => void createProject()}>
            创建并打开
          </button>
        </div>
      </div>

      <div className="gate-list">
        <h3>打开项目</h3>
        {loading ? (
          <div className="gate-empty">加载中…</div>
        ) : projects.length === 0 ? (
          <div className="gate-empty">暂无项目，请先新建</div>
        ) : (
          projects.map((p) => (
            <button
              key={p.id}
              type="button"
              className="gate-card"
              disabled={opening}
              onClick={() => void openProject(p)}
            >
              <span className="gate-card-title">{p.name}</span>
              <span className="gate-card-meta">
                {p.genre} · 更新于 {formatTime(p.updatedAt)}
              </span>
              {p.description !== undefined && <span className="gate-card-desc">{p.description}</span>}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
