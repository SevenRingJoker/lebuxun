// s47 一键打包流水线 IPC：
// - build:start  启动 electron-builder（dir=解包目录快速验证 / dist=NSIS+portable 完整产物）
// - 过程日志逐行广播 build:log；结束扫描 release/ 产物并广播 build:done（含版本号）
// - 单实例锁：同一时间只允许一个打包任务
// 注：打包对象是 IDE 自身（app.getAppPath()），非用户工作区。
import { app, ipcMain, shell, BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface BuildDone {
  ok: boolean
  code: number | null
  /** 产物相对路径清单（release/ 下） */
  artifacts: string[]
  version: string
  durationMs: number
}

let running = false

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

/** 扫描 release/ 产物（一层目录 + 安装包扩展名） */
async function scanArtifacts(root: string): Promise<string[]> {
  const dir = join(root, 'release')
  const out: string[] = []
  const EXT = /\.(exe|msi|dmg|zip|AppImage|deb|blockmap)$/i
  async function walk(rel: string, depth: number): Promise<void> {
    if (depth > 2) return
    let entries
    try {
      entries = await readdir(join(dir, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        // win-unpacked 等解包目录本身也算产物
        if (e.name.endsWith('-unpacked')) out.push(r + '/')
        else await walk(r, depth + 1)
      } else if (EXT.test(e.name)) {
        out.push(r)
      }
    }
  }
  await walk('', 0)
  return out.sort()
}

async function readVersion(root: string): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf-8'))
    return String(pkg.version ?? '0.0.0')
  } catch {
    return '0.0.0'
  }
}

export function registerBuildHandlers(): void {
  ipcMain.handle('build:start', async (_e, mode: 'dir' | 'dist') => {
    if (running) return { ok: false, error: '已有打包任务进行中' }
    const root = app.getAppPath()
    running = true
    const t0 = Date.now()
    // 后台跑，立即返回已启动；结果走 build:done 事件
    void (async () => {
      const script = mode === 'dist' ? 'dist' : 'pack'
      const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
      // Windows 需 shell:true（CVE-2024-27980 后直接 spawn .cmd 会抛 EINVAL）
      let proc
      try {
        proc = spawn(cmd, ['run', script], { cwd: root, windowsHide: true, shell: true })
      } catch (err) {
        running = false
        broadcast('build:done', {
          ok: false, code: null, artifacts: [], version: '0.0.0', durationMs: Date.now() - t0
        } satisfies BuildDone)
        broadcast('build:log', { text: `[错误] 打包进程启动失败：${(err as Error).message}` })
        return
      }
      let buf = ''
      const feed = (chunk: string) => {
        buf += chunk
        const lines = buf.split(/\r?\n/)
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim()) broadcast('build:log', { text: line })
        }
      }
      proc.stdout.on('data', (b: Buffer) => feed(b.toString('utf8')))
      proc.stderr.on('data', (b: Buffer) => feed(b.toString('utf8')))
      proc.on('close', (code) => {
        void (async () => {
          if (buf.trim()) broadcast('build:log', { text: buf })
          const done: BuildDone = {
            ok: code === 0,
            code,
            artifacts: code === 0 ? await scanArtifacts(root) : [],
            version: await readVersion(root),
            durationMs: Date.now() - t0
          }
          running = false
          broadcast('build:done', done)
        })()
      })
      proc.on('error', (err) => {
        running = false
        broadcast('build:done', {
          ok: false,
          code: null,
          artifacts: [],
          version: '0.0.0',
          durationMs: Date.now() - t0
        } satisfies BuildDone)
        broadcast('build:log', { text: `[错误] 打包进程启动失败：${err.message}` })
      })
    })()
    return { ok: true, mode, script: mode === 'dist' ? 'dist' : 'pack' }
  })

  ipcMain.handle('build:status', () => ({ running }))

  ipcMain.handle('build:openRelease', async () => {
    const dir = join(app.getAppPath(), 'release')
    try {
      await stat(dir)
      shell.openPath(dir)
      return { ok: true }
    } catch {
      return { ok: false, error: 'release 目录不存在（尚未产出）' }
    }
  })
}
