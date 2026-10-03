// 上下文工程兼容层。
// 原 buildIndex/selectContext 的实现已按职责拆分为：
// - codeParse.ts：单文件 import/符号/预览解析（纯函数）
// - indexer.ts：持久化增量索引（.trae/code-index.json）
// - retrieval.ts：BM25 + CJK 二元组 + 依赖邻接检索、@mention 解析、上下文拼装
// - embeddings.ts：可选 Ollama 语义向量与混合检索
// 本文件仅保留 re-export，避免既有 import 路径失效。
export { buildIndex } from './indexer'
export type { IndexedFile, CodeIndex, IndexDelta } from './indexer'
export { selectContext, searchIndex, parseMentions, buildContext, tokenize } from './retrieval'
export type { SearchHit, ParsedMentions } from './retrieval'
