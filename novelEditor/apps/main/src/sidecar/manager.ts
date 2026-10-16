/**
 * SPEC §2 Python Sidecar 生命周期：
 * spawn 启动 → 读 stdout 首行 JSON 拿端口 → 崩溃自动重启（最多 3 次）→ stop 杀进程树。
 *
 * 端口协议：sidecar 启动后在 stdout 第一行打印 {"port": <port>, "status": "ready"}。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

export type SpawnFn = (command: string, args: string[], options: object) => ChildProcess;

export interface SidecarManagerOptions {
  /** sidecar/ 目录（uvicorn 的 cwd） */
  cwd: string;
  /** Python 启动命令，Windows 默认 py -3 */
  command?: string;
  argsPrefix?: string[];
  /** 端口解析超时（ms），默认 15s */
  parseTimeoutMs?: number;
  /** 崩溃自动重启上限，SPEC §2 = 3 */
  maxRestarts?: number;
  spawnFn?: SpawnFn;
}

const READY_PREFIX_ARGS = [
  // 必须走 -m novel_forge_sidecar.main（run() 入口）：stdout 首行打印 {"port","status":"ready"}；
  // uvicorn xxx:app 直起不打印端口 JSON，会导致端口协议解析超时（实机验证发现的缺陷）
  '-m', 'novel_forge_sidecar.main',
];

/** Windows 启动器回退：'py' 不在 PATH（或进程环境被裁剪）时退回 'python'（实机验证发现的缺陷） */
const DEFAULT_COMMANDS = ['py', 'python'];

export class SidecarManager extends EventEmitter {
  private child: ChildProcess | undefined;
  private port: number | undefined;
  private restarts = 0;
  private stopping = false;
  private startPromise: Promise<number> | undefined;

  constructor(private readonly options: SidecarManagerOptions) {
    super();
  }

  getPort(): number | undefined {
    return this.port;
  }

  getRestartCount(): number {
    return this.restarts;
  }

  async start(): Promise<{ port: number }> {
    if (this.startPromise) {
      return { port: await this.startPromise };
    }
    this.startPromise = this.spawnAndParse();
    try {
      const port = await this.startPromise;
      return { port };
    } finally {
      this.startPromise = undefined;
    }
  }

  private spawnAndParse(): Promise<number> {
    const {
      cwd,
      command,
      argsPrefix = ['-3'],
      parseTimeoutMs = 15_000,
      spawnFn = ((cmd, args, opts) =>
        spawn(cmd, args, opts as Parameters<typeof spawn>[2])) as SpawnFn,
    } = this.options;

    // 启动器候选：显式指定用之；未指定时按回退序尝试（ENOENT 换下一个）
    const commands = command !== undefined ? [command] : DEFAULT_COMMANDS;

    const attempt = (index: number): Promise<number> =>
      new Promise<number>((resolve, reject) => {
        const cmd = commands[index]!;
        const child = spawnFn(cmd, [...argsPrefix, ...READY_PREFIX_ARGS], {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        this.child = child;

        let buffer = '';
        let settled = false;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          this.killChild(child);
          reject(new Error(`sidecar 端口解析超时（${parseTimeoutMs}ms）`));
        }, parseTimeoutMs);

        const onData = (chunk: Buffer) => {
          if (settled) return;
          buffer += chunk.toString('utf8');
          const newlineIdx = buffer.indexOf('\n');
          if (newlineIdx === -1) return;
          const firstLine = buffer.slice(0, newlineIdx).trim();
          settled = true;
          clearTimeout(timer);
          child.stdout?.off('data', onData);
          try {
            const msg = JSON.parse(firstLine) as { port?: unknown; status?: unknown };
            if (typeof msg.port !== 'number' || !Number.isInteger(msg.port) || msg.port <= 0) {
              throw new Error(`非法端口: ${firstLine}`);
            }
            this.port = msg.port;
            resolve(msg.port);
          } catch (err) {
            this.killChild(child);
            reject(new Error(`sidecar 端口协议解析失败: ${firstLine}（${String(err)}）`));
          }
        };

        child.stdout?.on('data', onData);

        child.once('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // 启动器 ENOENT：还有候选则回退重试（如 py 不在 PATH → python）
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' && index + 1 < commands.length) {
            void attempt(index + 1).then(resolve, reject);
            return;
          }
          reject(err);
        });

        child.on('exit', (code, signal) => {
          this.emit('exit', { code, signal });
          if (this.child === child) {
            this.child = undefined;
            this.port = undefined;
          }
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error(`sidecar 启动即退出: code=${code} signal=${signal}`));
            return;
          }
          if (!this.stopping) {
            this.maybeRestart();
          }
        });
      });

    return attempt(0);
  }

  private maybeRestart(): void {
    const max = this.options.maxRestarts ?? 3;
    if (this.restarts >= max) {
      this.emit('restart-exhausted');
      return;
    }
    this.restarts += 1;
    this.emit('restart', this.restarts);
    void this.start().catch((err) => {
      this.emit('restart-failed', err);
    });
  }

  /** kill 子进程树（Windows 用 taskkill /T，其它平台直接 kill 进程组） */
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    this.port = undefined;
    await this.killChild(child);
  }

  private killChild(child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
      const pid = child.pid;
      if (pid == null || child.killed) {
        resolve();
        return;
      }
      const done = () => resolve();
      child.once('exit', done);
      setTimeout(done, 3_000).unref();
      try {
        if (process.platform === 'win32') {
          // /T 杀整棵进程树（uvicorn 可能再 fork/reload 子进程）
          spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        // 已退出则忽略
      }
    });
  }
}
