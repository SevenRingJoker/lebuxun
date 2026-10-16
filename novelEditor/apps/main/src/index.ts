/** Main 入口：SPEC §2 启动顺序（Phase 1：失败仅 warn 并继续，不弹窗） */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { app, BrowserWindow } from 'electron';
import { OLLAMA_CONFIG } from '@novel-forge/shared';
import { openDatabase } from './db/index.js';
import { registerIpcHandlers } from './ipc/index.js';
import { LLMGateway } from './llm/gateway.js';
import { OllamaLifecycle } from './llm/ollama-lifecycle.js';
import { OllamaProvider } from './llm/providers/ollama.js';
import { getModelRouter, loadRouteOverrides } from './llm/router-instance.js';
import { SidecarManager } from './sidecar/manager.js';
import { SidecarClient } from './sidecar/client.js';
import type { EventBus } from './workflow/events.js';

const OLLAMA_HOST = process.env.NOVEL_FORGE_OLLAMA_HOST ?? 'http://localhost:11434';

/** 启动模型检查仅覆盖这两个任务（避免一次性拉多个大模型），模型名去重 */
const STARTUP_CHECK_TASKS = ['embedding', 'paragraph-gen'] as const;

/** sidecar/ 目录解析：env 覆盖 > 打包 extraResources > app 内布局 > dev workspaces 布局。
 * dev 模式 app.getAppPath() 是 apps/main，'sidecar' 相对解析会指向不存在的目录；
 * cwd 无效时 spawn 报 ENOENT（伪装成 Python 命令缺失），故必须挑真实存在的目录（实机验证发现的缺陷）。 */
function resolveSidecarDir(): string {
  const envDir = process.env.NOVEL_FORGE_SIDECAR_DIR;
  if (envDir != null && envDir !== '' && existsSync(envDir)) return envDir;
  const candidates = [
    path.join(process.resourcesPath, 'sidecar'), // 打包：extraResources
    path.resolve(app.getAppPath(), 'sidecar'), // 打包：app 内布局
    path.resolve(app.getAppPath(), '..', '..', 'sidecar'), // dev：apps/main → 仓库根
  ];
  return candidates.find((dir) => existsSync(dir)) ?? candidates[candidates.length - 1]!;
}

/**
 * 启动模型检查（收尾批次 3）：对 embedding / paragraph-gen 两个路由模型做「缺失则拉取」
 * 的准备；进度经 eventBus 推 settings:pull-progress，失败/不可用仅 warn、不阻塞启动。
 */
function prepareStartupModels(ollama: OllamaLifecycle, eventBus: EventBus): void {
  const router = getModelRouter();
  const names = [...new Set(STARTUP_CHECK_TASKS.map((task) => router.routeFor(task).model))];
  for (const name of names) {
    const jobId = randomUUID();
    void ollama
      .ensureModel(name, (p) => {
        eventBus.emit({
          type: 'settings:pull-progress',
          jobId,
          model: name,
          status: p.status,
          ...(p.completed !== undefined ? { completed: p.completed } : {}),
          ...(p.total !== undefined ? { total: p.total } : {}),
        });
      })
      .then((ok) => {
        if (!ok) {
          console.warn(`[novel-forge] 启动模型检查：${name} 不可用（Ollama 未就绪或拉取失败），继续启动`);
        }
      })
      .catch((err) => {
        console.warn(`[novel-forge] 启动模型检查异常（${name}），忽略：`, err);
      });
  }
}

let mainWindow: BrowserWindow | null = null;
let sidecar: SidecarManager | null = null;

async function bootstrap(): Promise<void> {
  await app.whenReady();

  // 1a. 初始化 SQLite（WAL）
  const db = await openDatabase(path.join(app.getPath('userData'), 'novel-forge.db'));

  // 1a-2. 加载持久化的路由覆盖（settings 表 key='model-routes'）到全局单例
  try {
    loadRouteOverrides(db);
  } catch (err) {
    console.warn('[novel-forge] 路由覆盖加载失败（回退 DEFAULT_ROUTES），继续启动：', err);
  }

  // 1b. LLM Gateway + Ollama provider（Phase 3 节点经 NodeContext.llm 消费）
  const gateway = new LLMGateway();
  gateway.registerProvider('ollama', new OllamaProvider({ host: OLLAMA_HOST, keepAlive: OLLAMA_CONFIG.keepAlive }));
  const ollama = new OllamaLifecycle({ host: OLLAMA_HOST, autoStart: true });
  try {
    const result = await ollama.ensureRunning();
    if (result.status === 'failed') {
      console.warn('[novel-forge] Ollama 未运行且自动启动失败，LLM 功能不可用（Phase 1 不弹窗）');
    }
  } catch (err) {
    console.warn('[novel-forge] Ollama 检测异常，继续启动：', err);
  }

  // 1c. 启动 Python Sidecar：失败 warn 继续（sidecarClient 缺省时 RAG/风格节点降级）
  let sidecarClient: SidecarClient | undefined;
  const sidecarDir = resolveSidecarDir();
  sidecar = new SidecarManager({ cwd: sidecarDir });
  try {
    const { port } = await sidecar.start();
    sidecarClient = new SidecarClient(`http://127.0.0.1:${port}`);
    const health = await sidecarClient.health();
    console.log(`[novel-forge] sidecar ready @${port} (${health.status} ${health.version})`);
  } catch (err) {
    console.warn('[novel-forge] sidecar 启动失败，继续启动（风格/RAG 功能不可用）：', err);
  }

  // 1d. 注册 IPC + 工作流引擎（注入 llm/sidecar/ollama；路由器单例在注册内注入）
  const runtime = registerIpcHandlers({
    db,
    llm: gateway,
    ollama,
    ...(sidecarClient !== undefined ? { sidecar: sidecarClient } : {}),
  });

  // 1e. 启动模型检查（不阻塞；进度经 eventBus 推 renderer）
  prepareStartupModels(ollama, runtime.eventBus);

  // 2. 创建 BrowserWindow
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: false,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../../renderer/dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (sidecar) void sidecar.stop();
});

void bootstrap().catch((err) => {
  console.error('[novel-forge] 启动失败：', err);
  app.quit();
});
