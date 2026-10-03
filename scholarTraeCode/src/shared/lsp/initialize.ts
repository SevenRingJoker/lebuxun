// LSP initialize 请求参数构建：按语言服务器种类分支，纯函数、零 Electron 依赖。
// ts 模式：typescript-language-server，无需初始化选项；
// vue 模式：@vue/language-server（Volar），必须显式 tsdk 与 hybridMode:false（Take Over）。
import { pathToUri } from './converter'

/** 语言服务器种类（ts / vue；同时只会运行一种） */
export type LspServerKind = 'ts' | 'vue'

/** 判断值是否为合法服务器种类 */
export function isLspServerKind(value: unknown): value is LspServerKind {
  return value === 'ts' || value === 'vue'
}

/**
 * 完整的客户端能力声明（textDocument 块）。
 * 两种服务器共用：Volar capabilities 是其超集，未声明的能力不请求即可。
 */
export const LSP_CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: { didSave: true, willSave: false },
    completion: {
      completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'] }
    },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    definition: { linkSupport: false },
    references: {},
    rename: { prepareSupport: true },
    documentFormatting: {},
    codeAction: {
      codeActionLiteralSupport: {
        codeActionKind: { valueSet: ['quickfix', 'refactor', 'refactor.extract', 'source'] }
      }
    }
  },
  workspace: { applyEdit: true }
}

/**
 * 构建 Volar 初始化选项。
 * @param tsdk 运行时 typescript/lib 目录绝对路径（含 tsserver.js）
 */
export function buildVueInitializationOptions(tsdk: string): {
  typescript: { tsdk: string; disableAutoImportCache: boolean }
  vue: { hybridMode: boolean }
} {
  return {
    typescript: { tsdk, disableAutoImportCache: false },
    // 默认 hybridMode=true 依赖外部 TS 插件 named pipe（VS Code 场景），
    // 本应用不具备；false 走全功能模式，单服务器 Take Over .vue + TS 全家桶
    vue: { hybridMode: false }
  }
}

/** 构建 initialize 请求参数（按服务器种类分支） */
export function buildInitializeParams(
  kind: LspServerKind,
  rootPath: string | null,
  tsdk?: string
): {
  processId: null
  rootUri: string | null
  capabilities: typeof LSP_CLIENT_CAPABILITIES
  clientInfo: { name: string; version: string }
  initializationOptions?: ReturnType<typeof buildVueInitializationOptions>
} {
  return {
    processId: null,
    rootUri: rootPath ? pathToUri(rootPath) : null,
    capabilities: LSP_CLIENT_CAPABILITIES,
    clientInfo: { name: 'ScholarTreaCode', version: '0.1.0' },
    // 仅 Volar 需要 initializationOptions
    ...(kind === 'vue' ? { initializationOptions: buildVueInitializationOptions(tsdk ?? '') } : {})
  }
}
