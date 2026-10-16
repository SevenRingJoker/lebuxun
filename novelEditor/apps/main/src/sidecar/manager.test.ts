import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { SidecarManager } from './manager.js';

/**
 * fake sidecar：node -e 脚本，stdout 首行打印端口 JSON 后驻留。
 * 用真实 spawn 验证启动/解析/重启链路（不依赖 Python）。
 */
function fakeSidecarSpawn(script: string) {
  const children: ChildProcess[] = [];
  const spawnFn = (_command: string, _args: string[], _options: object): ChildProcess => {
    const child = spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    children.push(child);
    return child;
  };
  return { spawnFn, children };
}

const READY_SCRIPT = (port: number) =>
  `console.log(JSON.stringify({port:${port},status:'ready'}));setInterval(()=>{},1000);`;

describe('SidecarManager', () => {
  it('启动并解析 stdout 首行端口 JSON', async () => {
    const { spawnFn } = fakeSidecarSpawn(READY_SCRIPT(8931));
    const manager = new SidecarManager({ cwd: process.cwd(), spawnFn });
    const { port } = await manager.start();
    expect(port).toBe(8931);
    expect(manager.getPort()).toBe(8931);
    await manager.stop();
    expect(manager.getPort()).toBeUndefined();
  });

  it('首行非 JSON → 启动失败', async () => {
    const { spawnFn } = fakeSidecarSpawn(`console.log('not json');setInterval(()=>{},1000);`);
    const manager = new SidecarManager({ cwd: process.cwd(), spawnFn });
    await expect(manager.start()).rejects.toThrow('端口协议解析失败');
  });

  it('子进程崩溃后自动重启（重解析新端口），stop 后不再重启', async () => {
    let seq = 0;
    const ports = [8941, 8942];
    const children: ChildProcess[] = [];
    const spawnFn = (_c: string, _a: string[], _o: object): ChildProcess => {
      const port = ports[Math.min(seq++, ports.length - 1)]!;
      const child = spawn(process.execPath, ['-e', READY_SCRIPT(port)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      children.push(child);
      return child;
    };

    const manager = new SidecarManager({ cwd: process.cwd(), spawnFn, maxRestarts: 3 });
    const restartEvents: number[] = [];
    manager.on('restart', (n: number) => restartEvents.push(n));

    const { port } = await manager.start();
    expect(port).toBe(8941);

    // 模拟崩溃：外部杀掉第一个子进程
    const restarted = new Promise<number>((resolve) => {
      manager.on('exit', () => {
        const check = setInterval(() => {
          const p = manager.getPort();
          if (p != null) {
            clearInterval(check);
            resolve(p);
          }
        }, 20);
      });
    });
    children[0]!.kill('SIGTERM');
    expect(await restarted).toBe(8942);
    expect(manager.getRestartCount()).toBe(1);
    expect(restartEvents).toEqual([1]);

    // stop 后杀进程不再触发重启
    await manager.stop();
    expect(manager.getRestartCount()).toBe(1);
  }, 15_000);

  it('启动即退出 → 失败', async () => {
    const { spawnFn } = fakeSidecarSpawn(`process.exit(1);`);
    const manager = new SidecarManager({ cwd: process.cwd(), spawnFn });
    await expect(manager.start()).rejects.toThrow('启动即退出');
  });
});
