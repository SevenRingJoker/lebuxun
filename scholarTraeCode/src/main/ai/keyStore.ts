// API Key 安全存储：用 Electron safeStorage（Windows 走 DPAPI）加密后落盘。
// 存储文件：userData/ai-keys.json，结构 { [providerId]: { cipher, plaintext? } }。
// safeStorage 不可用（如部分 Linux 无 keyring）时降级明文存储并打 plaintext 标记，UI 据此提示风险。
// Key 明文只在主进程内部流转，渲染进程只能拿到掩码（sk-***尾4位）。
import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 单个供应商的 Key 存储条目 */
interface KeyEntry {
  /** safeStorage 加密后的 base64 密文；降级模式下为明文 */
  cipher: string
  /** 降级明文标记（safeStorage 不可用时 true，UI 应提示风险） */
  plaintext?: boolean
}

/** 持久化结构：providerId → Key 条目 */
type KeyFile = Record<string, KeyEntry>

const KEYS_FILE = () => join(app.getPath('userData'), 'ai-keys.json')

function loadKeys(): KeyFile {
  try {
    if (existsSync(KEYS_FILE())) {
      const parsed = JSON.parse(readFileSync(KEYS_FILE(), 'utf-8'))
      if (parsed && typeof parsed === 'object') return parsed as KeyFile
    }
  } catch {
    // 文件损坏时按无 Key 处理，不阻塞启动
  }
  return {}
}

function saveKeys(keys: KeyFile): void {
  try {
    writeFileSync(KEYS_FILE(), JSON.stringify(keys, null, 2), 'utf-8')
  } catch {
    // 持久化失败不影响主流程，下次保存会重试
  }
}

/** 当前环境是否支持加密存储（app ready 后调用才可靠；异常一律按不可用处理） */
export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/**
 * 保存 Key：支持加密则存 safeStorage 密文，否则降级明文 + plaintext 标记。
 * 传空串视为清除该供应商的 Key。
 */
export function setKey(providerId: string, key: string): void {
  const keys = loadKeys()
  const trimmed = key.trim()
  if (!trimmed) {
    delete keys[providerId]
    saveKeys(keys)
    return
  }
  if (isEncryptionAvailable()) {
    try {
      keys[providerId] = { cipher: safeStorage.encryptString(trimmed).toString('base64') }
      saveKeys(keys)
      return
    } catch {
      // 加密意外失败：降级明文，保功能优先
    }
  }
  keys[providerId] = { cipher: trimmed, plaintext: true }
  saveKeys(keys)
}

/**
 * 读取 Key 明文（仅限主进程内部使用，绝不透传渲染进程）。
 * 密文解密失败（如换机器导致 DPAPI 域不匹配）视为 Key 失效返回 null。
 */
export function getKey(providerId: string): string | null {
  const entry = loadKeys()[providerId]
  if (!entry) return null
  if (entry.plaintext) return entry.cipher
  try {
    return safeStorage.decryptString(Buffer.from(entry.cipher, 'base64'))
  } catch {
    // 解密失败：按 Key 失效处理
    return null
  }
}

/** 删除指定供应商的 Key（不存在时静默） */
export function deleteKey(providerId: string): void {
  const keys = loadKeys()
  if (providerId in keys) {
    delete keys[providerId]
    saveKeys(keys)
  }
}

/**
 * Key 掩码：渲染进程唯一可见形态，如 `sk-***abcd`。
 * Key 过短（<8 位）时全打码，避免掩码本身泄露内容。
 */
export function getKeyMasked(providerId: string): string | null {
  const key = getKey(providerId)
  if (!key) return null
  if (key.length < 8) return 'sk-***'
  return `sk-***${key.slice(-4)}`
}

/** 是否已配置 Key（不回明文，供设置页开关状态用） */
export function hasKey(providerId: string): boolean {
  return providerId in loadKeys()
}
