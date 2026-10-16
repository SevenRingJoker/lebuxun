/** 默认工作流播种（SPEC §3 resources/default-workflows/、§9.1 主循环）
 *
 * main-loop.json 是项目无关的图模板；project:create 时深拷贝绑定到新项目
 * （workflows.project_id 外键约束，见 ipc/project.ts）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkflowEdge, WorkflowNode } from '@novel-forge/shared';

export interface DefaultWorkflowGraph {
  name: string;
  version: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

const FILE_NAME = 'main-loop.json';

/** 兼容 vitest（ESM）与 esbuild CJS 产物两种运行形态（同 db/index.ts 的 moduleDir） */
function moduleDir(): string {
  if (typeof __dirname !== 'undefined') return __dirname;
  return path.dirname(fileURLToPath(import.meta.url));
}

function candidateDirs(): string[] {
  const here = moduleDir();
  return [
    // 环境变量覆盖（打包后可用 extraResources 指到此处）
    ...(process.env.NOVEL_FORGE_DEFAULT_WORKFLOWS_DIR !== undefined
      ? [process.env.NOVEL_FORGE_DEFAULT_WORKFLOWS_DIR]
      : []),
    // cwd = 仓库根（npm run dev -w apps/main 的上层）或 apps/main
    path.join(process.cwd(), 'resources', 'default-workflows'),
    path.join(process.cwd(), '..', '..', 'resources', 'default-workflows'),
    // 源码形态 src/workflow → 上 4 级到仓库根；产物形态 dist → 上 3 级到仓库根
    path.join(here, '..', '..', '..', '..', 'resources', 'default-workflows'),
    path.join(here, '..', '..', '..', 'resources', 'default-workflows'),
  ];
}

/** 加载默认工作流图模板；找不到/解析失败抛错（调用方决定 warn 或失败） */
export function loadDefaultWorkflow(dir?: string): DefaultWorkflowGraph {
  const dirs = dir !== undefined ? [dir] : candidateDirs();
  for (const d of dirs) {
    const file = path.join(d, FILE_NAME);
    if (!fs.existsSync(file)) continue;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as DefaultWorkflowGraph;
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      throw new Error(`默认工作流 ${file} 结构非法：缺 nodes/edges 数组`);
    }
    return parsed;
  }
  throw new Error(`默认工作流 ${FILE_NAME} 未找到（搜索：${dirs.join(', ')}）`);
}
