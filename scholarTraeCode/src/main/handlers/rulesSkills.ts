// 规则 / 技能 / 笔记管理 IPC：三层规则发现与 CRUD、技能 CRUD 与启停、笔记只读查看与清空。
// 纯函数逻辑在 ai/rulesConfig.ts 与 ai/skillConfig.ts（含单测）；本层只做 electron 接线与路径安全校验。
import { ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import { join, dirname, relative, isAbsolute, sep } from 'node:path'
import { homedir } from 'node:os'
import {
  discoverRules,
  loadRuleState,
  saveRuleState,
  validateRuleName,
  type RuleMeta
} from '../ai/rulesConfig'
import { validateSkillName, parseSkillMarkdown, renderSkillMarkdown } from '../ai/skillConfig'
import { listSkills, type SkillMeta } from '../ai/skills'
import { loadNotes, saveNotes } from '../ai/agentNotes'

type Ok<T> = { ok: true; data: T }
type Err = { ok: false; error: string }
type Result<T> = Ok<T> | Err

function ok<T>(data: T): Ok<T> {
  return { ok: true, data }
}
function err(error: string): Err {
  return { ok: false, error }
}

/** 用户级规则目录（~/.trae/rules/） */
function userRulesDir(): string {
  return join(homedir(), '.trae', 'rules')
}

/** 路径是否位于 parent 内（不含相等） */
function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 校验规则文件路径合法：必须位于用户级目录、或工作区内某级 `.trae/rules/` 目录中。
 * 防目录穿越与任意文件读写。
 */
function isRulePathAllowed(path: string, workspace: string | null | undefined): boolean {
  if (!path.toLowerCase().endsWith('.md')) return false
  if (isPathInside(path, userRulesDir())) return true
  if (!workspace || !isPathInside(path, workspace)) return false
  // 工作区内：路径段必须包含连续的 .trae/rules
  const parts = relative(workspace, path).split(sep)
  for (let i = 0; i + 1 < parts.length; i++) {
    if (parts[i] === '.trae' && parts[i + 1] === 'rules') return true
  }
  return false
}

/** 原子写：tmp + rename */
async function atomicWrite(path: string, content: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  await fs.writeFile(tmp, content, 'utf-8')
  await fs.rename(tmp, path)
}

export function registerRulesSkillsHandlers(): void {
  // ============ 规则 ============

  // 列出三层规则（用户级 / 项目级 / 目录级，currentDir 为目录级上溯起点）
  ipcMain.handle(
    'rules:list',
    async (_e, workspace?: string | null, currentDir?: string | null): Promise<RuleMeta[]> =>
      discoverRules({ workspace, userRulesDir: userRulesDir(), currentDir })
  )

  // 读取规则全文
  ipcMain.handle(
    'rules:read',
    async (_e, workspace: string | null, path: string): Promise<Result<string>> => {
      if (!isRulePathAllowed(path, workspace)) return err('非法规则路径')
      try {
        return ok(await fs.readFile(path, 'utf-8'))
      } catch {
        return err('规则文件读取失败')
      }
    }
  )

  // 新建/覆盖规则：scope=user 写用户级目录；scope=project 写 <workspace>/.trae/rules；
  // scope=directory 需带 dirPath（写 <dirPath>/.trae/rules）
  ipcMain.handle(
    'rules:write',
    async (
      _e,
      workspace: string | null,
      scope: 'user' | 'project' | 'directory',
      name: string,
      content: string,
      dirPath?: string | null
    ): Promise<Result<string>> => {
      const v = validateRuleName(name)
      if (!v.ok) return err(v.error)
      let dir: string
      if (scope === 'user') {
        dir = userRulesDir()
      } else if (scope === 'project') {
        if (!workspace) return err('无工作区，无法写项目级规则')
        dir = join(workspace, '.trae', 'rules')
      } else {
        if (!workspace || !dirPath || !isPathInside(join(dirPath, 'x'), workspace)) {
          return err('目录级规则的目标目录必须位于工作区内')
        }
        dir = join(dirPath, '.trae', 'rules')
      }
      const path = join(dir, `${name}.md`)
      try {
        await atomicWrite(path, content)
        return ok(path)
      } catch {
        return err('规则写入失败')
      }
    }
  )

  // 删除规则
  ipcMain.handle(
    'rules:delete',
    async (_e, workspace: string | null, path: string): Promise<Result<null>> => {
      if (!isRulePathAllowed(path, workspace)) return err('非法规则路径')
      try {
        await fs.rm(path, { force: true })
        return ok(null)
      } catch {
        return err('规则删除失败')
      }
    }
  )

  // 项目级规则启停（状态存 <workspace>/.trae/rules/.state.json）
  ipcMain.handle(
    'rules:toggle',
    async (_e, workspace: string | null, name: string, enabled: boolean): Promise<Result<null>> => {
      if (!workspace) return err('无工作区')
      const v = validateRuleName(name)
      if (!v.ok) return err(v.error)
      try {
        const state = await loadRuleState(workspace)
        state[name] = !!enabled
        await saveRuleState(workspace, state)
        return ok(null)
      } catch {
        return err('启停状态保存失败')
      }
    }
  )

  // ============ 技能 ============

  // 列出全部技能（含禁用；注入 Prompt 时由 renderSkillList 过滤）
  ipcMain.handle('skills:list', async (_e, workspace?: string | null): Promise<SkillMeta[]> =>
    listSkills(workspace)
  )

  // 读取技能原始 Markdown（编辑用）
  ipcMain.handle(
    'skills:read',
    async (_e, workspace: string | null, name: string): Promise<Result<string>> => {
      if (!workspace) return err('无工作区')
      const v = validateSkillName(name)
      if (!v.ok) return err(v.error)
      try {
        return ok(await fs.readFile(join(workspace, '.trae', 'skills', `${name}.md`), 'utf-8'))
      } catch {
        return err(`未找到技能 ${name}`)
      }
    }
  )

  // 新建/覆盖技能：统一生成带 frontmatter 的标准格式
  ipcMain.handle(
    'skills:write',
    async (
      _e,
      workspace: string | null,
      name: string,
      description: string,
      enabled: boolean,
      content: string
    ): Promise<Result<null>> => {
      if (!workspace) return err('无工作区，技能不可用')
      const v = validateSkillName(name)
      if (!v.ok) return err(v.error)
      try {
        const md = renderSkillMarkdown({ name, description, enabled }, content)
        await atomicWrite(join(workspace, '.trae', 'skills', `${name}.md`), md)
        return ok(null)
      } catch {
        return err('技能写入失败')
      }
    }
  )

  // 删除技能
  ipcMain.handle(
    'skills:delete',
    async (_e, workspace: string | null, name: string): Promise<Result<null>> => {
      if (!workspace) return err('无工作区')
      const v = validateSkillName(name)
      if (!v.ok) return err(v.error)
      try {
        await fs.rm(join(workspace, '.trae', 'skills', `${name}.md`), { force: true })
        return ok(null)
      } catch {
        return err('技能删除失败')
      }
    }
  )

  // 技能启停：解析原文 → 翻转 frontmatter enabled → 重写（保留正文与描述）
  ipcMain.handle(
    'skills:toggle',
    async (_e, workspace: string | null, name: string, enabled: boolean): Promise<Result<null>> => {
      if (!workspace) return err('无工作区')
      const v = validateSkillName(name)
      if (!v.ok) return err(v.error)
      const path = join(workspace, '.trae', 'skills', `${name}.md`)
      try {
        const raw = await fs.readFile(path, 'utf-8')
        const parsed = parseSkillMarkdown(raw)
        const md = renderSkillMarkdown(
          { name, description: parsed.description, enabled: !!enabled },
          parsed.content
        )
        await atomicWrite(path, md)
        return ok(null)
      } catch {
        return err('启停状态保存失败')
      }
    }
  )

  // ============ 笔记 ============

  // 只读加载笔记
  ipcMain.handle('notes:load', async (_e, workspace?: string | null) => loadNotes(workspace))

  // 清空笔记：先备份到 agent-notes.backup.json，再重置为空对象
  ipcMain.handle('notes:clear', async (_e, workspace: string | null): Promise<Result<null>> => {
    if (!workspace) return err('无工作区')
    try {
      const notesPath = join(workspace, '.trae', 'agent-notes.json')
      const backupPath = join(workspace, '.trae', 'agent-notes.backup.json')
      try {
        await fs.copyFile(notesPath, backupPath)
      } catch {
        // 原文件不存在时无需备份
      }
      await saveNotes(workspace, {})
      return ok(null)
    } catch {
      return err('笔记清空失败')
    }
  })
}
