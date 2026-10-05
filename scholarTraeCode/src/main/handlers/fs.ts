// 文件系统 IPC：为渲染进程提供目录树读取、文件读写、新建/重命名/删除等本地文件能力
import { ipcMain, dialog, BrowserWindow, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { join, dirname, sep, isAbsolute } from 'node:path'

// 目录树节点结构（渲染进程 FileTree 直接消费）
export interface FsNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FsNode[]
}

// 统一的 IPC 成功/失败返回结构
type OpResult<T = string> = { ok: boolean; path?: T; error?: string }

// 递归读取目录，跳过常见噪音目录，返回层级树
async function readDirTree(root: string, depth = 6): Promise<FsNode[]> {
  if (depth <= 0) return []
  const ignore = new Set(['.git', 'dist', 'out', 'release'])
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const nodes: FsNode[] = []
  for (const entry of entries) {
    if (ignore.has(entry.name)) continue
    const fullPath = join(root, entry.name)
    if (entry.isDirectory()) {
      // node_modules 与其他目录同等对待，完全递归展开
      const children = await readDirTree(fullPath, depth - 1)
      nodes.push({
        name: entry.name,
        path: fullPath,
        type: 'directory',
        children
      })
    } else if (entry.isFile()) {
      nodes.push({ name: entry.name, path: fullPath, type: 'file' })
    }
  }
  // 目录在前、文件在后，各自按名称排序
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return nodes
}

// 校验新建/重命名字段。
// 允许相对子路径（如 "src/a.ts" 会自动建父目录），拒绝：
// 空名、Windows 非法字符、绝对路径、".." 越界
function validateRelativeName(rawName: string): string[] {
  const name = rawName.trim().replace(/[\\/]+$/, '')
  if (!name) {
    throw new Error('名称不能为空')
  }
  if (/[<>:"|?*]/.test(name)) {
    throw new Error('名称包含非法字符 < > : " | ? *')
  }
  // 去掉末尾分隔符后按 / 或 \ 拆段；前导分隔符会产生空段，一并拒绝
  const parts = name.split(/[\\/]+/)
  if (parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new Error('名称不能包含 "."、".." 或以分隔符开头')
  }
  return parts
}

// 注册 fs 相关 IPC
export function registerFsHandlers(): void {
  // 选择工作区目录
  ipcMain.handle('fs:selectWorkspace', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择工作区目录',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // 校验路径是否仍存在且为目录（启动时恢复上次工作区前使用）
  ipcMain.handle('fs:isDirectory', async (_e, targetPath: string): Promise<boolean> => {
    try {
      const stat = await fs.stat(targetPath)
      return stat.isDirectory()
    } catch {
      return false
    }
  })

  // 系统「另存为」对话框：未选择工作区时，草稿可保存到电脑任意位置
  ipcMain.handle('fs:saveDialog', async (event, defaultName?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { ok: false as const, canceled: true }
    const result = await dialog.showSaveDialog(win, {
      title: '保存文件',
      defaultPath: defaultName || 'untitled.txt',
      filters: [
        { name: '所有文件', extensions: ['*'] },
        { name: '文本文件', extensions: ['txt', 'md'] },
        { name: '代码文件', extensions: ['ts', 'js', 'json', 'vue', 'html', 'css', 'scss', 'py'] }
      ]
    })
    if (result.canceled || !result.filePath) return { ok: false as const, canceled: true }
    return { ok: true as const, path: result.filePath }
  })

  // 读取目录树
  ipcMain.handle('fs:readDirTree', async (_e, root: string) => {
    return await readDirTree(root)
  })

  // 读取文件内容（utf-8）
  ipcMain.handle('fs:readFile', async (_e, path: string) => {
    return await fs.readFile(path, 'utf-8')
  })

  // 写入文件内容（自动创建父目录由调用方保证，这里直接写）
  ipcMain.handle('fs:writeFile', async (_e, path: string, content: string) => {
    await fs.writeFile(path, content, 'utf-8')
    return true
  })

  // 新建文件：在 parentDir 下按 relName 创建（支持相对子路径），已存在则报错不覆盖
  ipcMain.handle(
    'fs:createFile',
    async (_e, parentDir: string, relName: string): Promise<OpResult> => {
      try {
        const parts = validateRelativeName(relName)
        const target = join(parentDir, ...parts)
        await fs.mkdir(dirname(target), { recursive: true })
        // wx：路径已存在时失败，避免静默覆盖已有文件
        await fs.writeFile(target, '', { encoding: 'utf-8', flag: 'wx' })
        return { ok: true, path: target }
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) }
      }
    }
  )

  // 新建文件夹：递归创建，已存在则报错
  ipcMain.handle(
    'fs:createDirectory',
    async (_e, parentDir: string, relName: string): Promise<OpResult> => {
      try {
        const parts = validateRelativeName(relName)
        const target = join(parentDir, ...parts)
        await fs.mkdir(target, { recursive: false })
        return { ok: true, path: target }
      } catch (err: any) {
        // 目录已存在时 Node 抛 EEXIST，给出友好提示
        if (err?.code === 'EEXIST') return { ok: false, error: '同名文件夹已存在' }
        return { ok: false, error: err?.message || String(err) }
      }
    }
  )

  // 重命名：只改最后一段名称，目标已存在则报错
  ipcMain.handle(
    'fs:rename',
    async (_e, oldPath: string, newName: string): Promise<OpResult> => {
      try {
        // 重命名只允许单段名称，不允许带子路径
        const parts = validateRelativeName(newName)
        if (parts.length !== 1) {
          return { ok: false, error: '重命名不能包含路径分隔符' }
        }
        const target = join(dirname(oldPath), parts[0])
        if (target === oldPath) return { ok: true, path: oldPath }
        await fs.rename(oldPath, target)
        return { ok: true, path: target }
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) }
      }
    }
  )

  // 删除：移入系统回收站（可恢复），失败时回退提示
  ipcMain.handle('fs:trash', async (_e, targetPath: string): Promise<OpResult<null>> => {
    try {
      await shell.trashItem(targetPath)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  // 在系统资源管理器中定位并选中目标
  ipcMain.handle('fs:showItem', (_e, targetPath: string) => {
    shell.showItemInFolder(targetPath)
    return true
  })

  // 拖拽移动：把 srcPath 移动到目标目录 destDir 下（保持原名）。
  // root 为工作区根，用于越界校验：源/目标都必须在工作区内；
  // 拒绝拖入自身、拖入自己的子目录、目标同名冲突。
  ipcMain.handle(
    'fs:move',
    async (
      _e,
      root: string,
      srcPath: string,
      destDir: string
    ): Promise<OpResult> => {
      try {
        // 统一为绝对路径，并确保都在工作区内（防止 .. 越界）
        const norm = (p: string): string => {
          const abs = isAbsolute(p) ? p : join(root, p)
          // 归一化分隔符后比较前缀
          return abs.endsWith(sep) ? abs.slice(0, -1) : abs
        }
        const rootN = norm(root)
        const srcN = norm(srcPath)
        const destN = norm(destDir)

        const inWorkspace = (p: string): boolean =>
          p === rootN || p.startsWith(rootN + sep)
        if (!inWorkspace(srcN) || !inWorkspace(destN)) {
          return { ok: false, error: '只能在当前工作区内移动文件' }
        }

        const srcName = srcN.slice(srcN.lastIndexOf(sep) + 1)
        const target = join(destN, srcName)

        // 源与目标相同（拖回原目录）：无操作
        if (target === srcN) return { ok: true, path: srcN }
        // 禁止把目录拖入其自身或自己的子目录（会造成循环/路径消失）
        if (destN === srcN || destN.startsWith(srcN + sep)) {
          return { ok: false, error: '不能将文件夹移动到其自身或子目录中' }
        }

        // 目标已存在同名项时拒绝，避免静默覆盖/合并
        try {
          await fs.access(target)
          return { ok: false, error: `目标目录已存在同名项：${srcName}` }
        } catch {
          // 不存在才继续（access 抛错即路径可用）
        }

        await fs.rename(srcN, target)
        return { ok: true, path: target }
      } catch (err: any) {
        // 跨盘移动时 rename 会抛 EXDEV，给出明确提示（后续可扩展为复制+删除）
        if (err?.code === 'EXDEV') {
          return { ok: false, error: '不支持跨磁盘分区移动' }
        }
        return { ok: false, error: err?.message || String(err) }
      }
    }
  )
}
