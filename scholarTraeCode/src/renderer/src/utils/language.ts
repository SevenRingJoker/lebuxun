// 代码语言识别工具：
// 1) 按文件「名」识别：Monaco 注册的特殊文件名/扩展名 + 项目补充规则
//    （Dockerfile.*、Containerfile、Makefile、.env.*、dotfile shell 配置等）
// 2) 按「内容」识别：shebang + 多语言特征打分（无后缀文件、未命名草稿、.txt 内代码）
// 3) 提供常用语言列表供手动选择（id 均为 Monaco 0.52 已注册语言，保证有真实高亮）
import * as monaco from 'monaco-editor'

// ============================ 路径/文件名识别 ============================

// Monaco 无独立语法、借用高亮相近语言的扩展名（小写、不带点）
const EXT_BORROW: Record<string, string> = {
  // .vue 已有独立 'vue' 语言（lsp/vueLanguage.ts），不在此借用
  // Shell 家族（Monaco 仅注册 .sh/.bash）
  zsh: 'shell',
  fish: 'shell',
  ksh: 'shell',
  // Makefile（Monaco 无 makefile 语法，命令行部分借 shell 高亮优于纯文本）
  mk: 'shell',
  mak: 'shell',
  // TOML 与 INI 同为「节 + 键值」结构，借 INI 高亮
  toml: 'ini',
  cfg: 'ini',
  conf: 'ini',
  env: 'ini',
  // C/C++ 家族补充（Monaco cpp 语言已承接 .c/.h）
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  ino: 'cpp',
  // XML 家族补充
  plist: 'xml',
  svg: 'xml',
  // RST 文档 Monaco 有独立语言（restructuredtext），让其原生 extensions 生效，不在此列
}

// 特殊文件名规则：按顺序匹配，命中即定语言（优先于扩展名判断）
// 用于 Monaco filenames 精确匹配覆盖不到的「带变体后缀」的约定文件名
const FILENAME_RULES: { re: RegExp; lang: string }[] = [
  // Dockerfile / Dockerfile.prod / Containerfile.dev
  { re: /^(dockerfile|containerfile)(\..+)?$/i, lang: 'dockerfile' },
  // Makefile / makefile / GNUmakefile（无 makefile 语法，借 shell）
  { re: /^(gnu)?makefile$/i, lang: 'shell' },
  // shell 系列 dotfile：.bashrc / .zshrc / .profile / .bash_profile ...
  {
    re: /^\.(bashrc|bash_profile|bash_logout|bash_history|zshrc|zprofile|zshenv|zsh_history|profile|kshrc)$/i,
    lang: 'shell'
  },
  // .env / .env.local / .env.production ...
  { re: /^\.env(\..+)?$/i, lang: 'ini' }
]

// 取路径中的文件名部分（兼容 Windows 反斜杠与 POSIX 斜杠）
function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || ''
}

// 按文件路径识别语言：特殊文件名 → Monaco filenames → 扩展名 → 借用映射。
// 返回 null 表示路径完全无法判断（交由内容识别兜底）。
export function detectLanguageByPath(filePath: string): string | null {
  const name = baseName(filePath).toLowerCase()
  if (!name) return null

  // 1) 项目补充的约定文件名规则
  for (const rule of FILENAME_RULES) {
    if (rule.re.test(name)) return rule.lang
  }

  // 2) Monaco 注册的特殊文件名（Dockerfile、.gitignore、jakefile 等）
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some((f) => f.toLowerCase() === name)) return lang.id
  }

  // 3) 扩展名（支持多段后缀：.d.ts / .test.tsx / Dockerfile 已在上面处理）
  const dot = name.lastIndexOf('.')
  // dot === 0 是 .env 这类 dotfile，已由规则/Monaco filenames 覆盖
  const ext = dot > 0 ? name.slice(dot + 1) : ''
  if (!ext) return null

  const dotted = `.${ext}`
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.extensions?.includes(dotted)) return lang.id
  }

  // 4) 借用映射
  return EXT_BORROW[ext] || null
}

// ============================ 内容启发式识别 ============================

// 参与内容分析的最大字节数：语言特征看文件开头即可，限制规模保证每次输入都实时
const CONTENT_SAMPLE = 8192

// shebang 解释器映射（覆盖 #!/usr/bin/env xxx、#!/bin/xxx、env -S 等形式）
const SHEBANG_MAP: { re: RegExp; lang: string }[] = [
  { re: /python|pypy/, lang: 'python' },
  { re: /\bnode\b|deno|bun/, lang: 'javascript' },
  { re: /bash|zsh|fish|ksh|\bsh\b/, lang: 'shell' },
  { re: /perl/, lang: 'perl' },
  { re: /ruby/, lang: 'ruby' },
  { re: /\bphp\b/, lang: 'php' },
  { re: /powershell|pwsh/, lang: 'powershell' },
  { re: /\blua\b/, lang: 'lua' },
  { re: /rscript/, lang: 'r' }
]

// 统计正则在样本中的命中次数
function countMatches(re: RegExp, text: string): number {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  let n = 0
  while (g.exec(text)) {
    if (++n > 50) break
  }
  return n
}

// 内容特征打分：返回 { lang, score } 列表，分数越高把握越大
function scoreContent(text: string): { lang: string; score: number }[] {
  // 仅看非空行，降低空行/空白对比例判断的干扰
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  const scores: { lang: string; score: number }[] = []
  const add = (lang: string, score: number): void => {
    if (score > 0) scores.push({ lang, score })
  }

  // ---------- 结构化数据 ----------
  // JSON：以 { 或 [ 开头且可严格解析 —— 最强信号
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  if (/^[[{]/.test(trimmed)) {
    try {
      JSON.parse(trimmed)
      add('json', 10)
    } catch {
      // 容忍尾逗号/单引号的「类 JSON」
      if (countMatches(/^\s*"[\w$-]+"\s*:/m, text) >= 2 && /[}\]]\s*$/.test(trimmed)) {
        add('json', 2)
      }
    }
  }

  // XML：<?xml 声明 / <svg / <!DOCTYPE ... rss|svg|xml
  if (/^\s*<\?xml/.test(text) || /^\s*<!DOCTYPE\s+(svg|rss|html|xml)/i.test(text)) {
    add(/<!DOCTYPE\s+html/i.test(text) ? 'html' : 'xml', 9)
  }
  if (/^\s*<svg[\s>]/i.test(text) || /^\s*<(rss|feed|project|configuration|plist)[\s>]/i.test(text)) {
    add('xml', 5)
  }

  // HTML：典型文档标签
  let htmlHits = 0
  if (/<!doctype\s+html/i.test(text)) htmlHits += 5
  if (/<html[\s>]/i.test(text)) htmlHits += 3
  if (/<(head|body|div|span|script|link|meta|table|ul|button)[\s>]/i.test(text)) htmlHits += 1
  if (countMatches(/<\/[a-z][\w-]*>/i, text) >= 2) htmlHits += 2
  if (htmlHits >= 4) add('html', htmlHits)

  // ---------- 文档类 ----------
  // Markdown：标题、围栏代码块、链接/列表（围栏优先度高，避免把 md 里的代码误判成编程语言）
  let md = 0
  if (countMatches(/^#{1,6}\s+\S/m, text) >= 1) md += 2
  if (/^```[\w-]*\s*$/m.test(text)) md += 5
  if (countMatches(/^\s*[-*+]\s+\S/m, text) >= 2) md += 1
  if (countMatches(/\[[^\]]+\]\([^)]+\)/, text) >= 1) md += 1
  if (md >= 3) add('markdown', md)

  // YAML：键值行 + 缩进/列表，且不能以 { [ 开头（那是 JSON）
  if (!/^[[{]/.test(trimmed)) {
    const kvLines = countMatches(/^[a-zA-Z_][\w.-]*\s*:(?:\s|$)/m, text)
    const listLines = countMatches(/^\s*-\s+\S/m, text)
    const docMark = countMatches(/^---\s*$/m, text)
    if (kvLines >= 2 && (listLines >= 1 || docMark >= 1 || kvLines >= 3)) {
      add('yaml', kvLines + listLines + docMark)
    }
  }

  // INI / TOML 风格：[section] + key = value
  const sections = countMatches(/^\[[^\[\]]+\]\s*$/m, text)
  const kvEq = countMatches(/^[a-zA-Z_][\w.-]*\s*=\s*\S?/m, text)
  if (sections >= 1 && kvEq >= 2) add('ini', sections + kvEq)

  // ---------- 查询/样式 ----------
  // SQL：弱关键字（select/from/where 在英文文章里也常见）必须配合
  // 强关键字、分号结尾，或「select 字段列表 from」结构才判定，避免误伤普通英文
  const sqlWeak = countMatches(/\b(select|from|where)\b/gi, text)
  const sqlStrong = countMatches(
    /\b(insert\s+into|update\s+[\w".]+\s+set|delete\s+from|create\s+table|alter\s+table|drop\s+table|group\s+by|order\s+by|inner\s+join|left\s+join|right\s+join)\b/gi,
    text
  )
  const sqlSemicolon = countMatches(/;\s*$/m, text)
  const selectFields =
    /select\s+(?:(?!the\b|a\b|an\b|this\b|that\b|these\b|those\b|best\b|all\b|some\b|any\b|one\b|two\b|please\b)[\w*.]+(?:\s*,\s*[\w*.]+)*)\s+from\b/i.test(
      text
    )
  const sqlKw = sqlWeak + sqlStrong
  if ((sqlWeak >= 2 || sqlStrong >= 1) && (sqlSemicolon >= 1 || sqlStrong >= 1 || selectFields)) {
    // 出现 INSERT INTO / CREATE TABLE 等强结构即可信，分数补到阈值以上
    add('sql', Math.max(3, sqlKw + (selectFields ? 1 : 0)))
  }

  // CSS：选择器 { 属性: 值; } 结构（至少 2 个规则块，或带 @media/@keyframes，避免误报）
  const cssRules = countMatches(/[^{}]\{[^{}]*:[^{}]*;[^{}]*\}/, text)
  const cssAt = countMatches(/@(media|keyframes|import|font-face)/, text)
  if (cssRules >= 2 || (cssRules >= 1 && cssAt >= 1)) {
    // 基础分补到阈值以上：2 个规则块即视为可信 CSS
    add('css', Math.max(3, Math.min(cssRules, 4) + (cssAt ? 2 : 0)))
  }

  // ---------- 编程语言 ----------
  // Python：def/class/import/缩进冒号等
  let py = 0
  if (/^\s*(async\s+)?def\s+\w+\s*\([^)]*\)\s*:?\s*$/m.test(text)) py += 4
  if (/^\s*class\s+\w+(\(.*\))?\s*:\s*$/m.test(text)) py += 3
  if (countMatches(/^\s*(import|from)\s+[\w.]+/m, text) >= 1) py += 1
  if (countMatches(/^\s*(if|elif|for|while|with|try|except|finally)\b.*:\s*$/m, text) >= 1) py += 2
  if (/print\s*\(/.test(text)) py += 1
  if (lines.length >= 2 && countMatches(/:\s*$/m, text) >= 2 && !/[;{}]/.test(text)) py += 1
  // py>=3 直接判定；py>=2 且全文无大括号/分号（明显不是 C 系语言）时也判定，
  // 覆盖 `import os\nprint(1)` 这类极简脚本
  if (py >= 3 || (py >= 2 && !/[{};]/.test(text))) add('python', Math.max(py, 3))

  // Shell（无 shebang 的脚本内容）
  let sh = 0
  if (countMatches(/^\s*(echo|cd|export|unset|source|alias)\b/m, text) >= 1) sh += 1
  if (countMatches(/^\s*(if|for|while|case)\b.*\bthen\b|^\s*then\s*$/m, text) >= 1) sh += 2
  if (/\$\(|\$[?#@!]|`[^`]+`/.test(text)) sh += 1
  if (countMatches(/^\s*(fi|done|esac)\s*$/m, text) >= 1) sh += 2
  if (sh >= 3) add('shell', sh)

  // PowerShell
  if (/\b(Write-Host|Get-[A-Z]\w*|Set-[A-Z]\w*|CmdletBinding|param\s*\(|Out-File)\b/.test(text)) {
    add('powershell', 3 + countMatches(/\$[A-Za-z_]\w*\s*=/g, text))
  }

  // JavaScript / TypeScript（共用特征先计数，再用 TS 专属特征分流）
  const jsCommon =
    countMatches(/\b(const|let|var)\s+[\w$]+\b/g, text) +
    countMatches(/=>\s*[{(]/g, text) +
    (countMatches(/\b(require\(|module\.exports|console\.(log|error|warn))/g, text) ? 2 : 0) +
    (countMatches(/\bfunction\s+\w+\s*\(/g, text) ? 1 : 0) +
    (countMatches(/\bawait\s+\w+/g, text) ? 1 : 0)
  const tsSignals =
    countMatches(/\b(interface|type|enum|namespace)\s+[A-Z]\w*/g, text) +
    // 类型注解：冒号 + TS 内置类型名（允许出现在行尾，如接口属性 `name: string`）
    countMatches(/:\s*(string|number|boolean|any|void|unknown|never|object|symbol|bigint|Record|Partial|Promise|Array|Readonly)\b/g, text) +
    countMatches(/\b(as|satisfies|keyof|typeof|implements|readonly|declare|abstract)\b/g, text) +
    (countMatches(/import\s+type\s+/g, text) ? 2 : 0)
  if (tsSignals >= 2 || (tsSignals >= 1 && jsCommon >= 2)) {
    add('typescript', tsSignals + jsCommon)
  } else if (jsCommon >= 3) {
    add('javascript', jsCommon)
  }

  // Java / C# 等大括号语言的弱区分（信号不足时宁可 plaintext，避免误报）
  const curly = countMatches(/\b(public|private|protected|static)\s+(class|void|final)/g, text)
  if (curly >= 2) add(/\bSystem\.out\.|import\s+java\./.test(text) ? 'java' : 'csharp', curly)

  return scores
}

// 按内容识别语言：shebang/JSON/XML 为强信号直接返回，其余按打分取最高且过阈值
export function detectLanguageByContent(content: string): string | null {
  const sample = content.slice(0, CONTENT_SAMPLE)
  const trimmed = sample.trim()
  // 过短内容不猜测：输入一两个字符就切换高亮会频繁跳变
  if (trimmed.length < 3) return null

  // 1) shebang（先交给 Monaco 自带 firstLine 正则）
  const firstLine = sample.split(/\r?\n/, 1)[0] || ''
  if (firstLine.startsWith('#!')) {
    for (const lang of monaco.languages.getLanguages()) {
      if (!lang.firstLine) continue
      try {
        if (new RegExp(lang.firstLine).test(firstLine)) return lang.id
      } catch {
        // 个别正则不兼容时忽略
      }
    }
    for (const m of SHEBANG_MAP) {
      if (m.re.test(firstLine)) return m.lang
    }
  }

  // 2) 强结构化信号 + 多语言打分
  const scores = scoreContent(sample)
  if (scores.length === 0) return null
  scores.sort((a, b) => b.score - a.score)
  const best = scores[0]
  // 阈值 3：至少两个独立特征同时成立，避免普通文本/单行代码误判
  return best.score >= 3 ? best.lang : null
}

// ============================ 综合识别 ============================

// 综合识别：
// - 扩展名明确（py/ts/json/...）时以文件名为准，尊重用户命名
// - 无映射或纯文本类（.txt/.log/未知后缀、无后缀、未命名草稿）时按内容特征判断
export function detectLanguage(filePath: string | null, content: string): string {
  const byPath = filePath ? detectLanguageByPath(filePath) : null
  if (byPath && byPath !== 'plaintext') return byPath
  const byContent = detectLanguageByContent(content)
  if (byContent) return byContent
  return byPath || 'plaintext'
}

// 语言的可读名称：优先 Monaco 别名（typescript → TypeScript），其次语言 id
export function languageLabel(id: string): string {
  const lang = monaco.languages.getLanguages().find((l) => l.id === id)
  return lang?.aliases?.[0] || id
}

// 手动选择器的常用语言清单（id 均为 Monaco 0.52 内置语言，确保选中后有真实高亮）
export const COMMON_LANGUAGES: { id: string; label: string }[] = [
  { id: 'plaintext', label: '纯文本 Plain Text' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'json', label: 'JSON' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'scss', label: 'SCSS' },
  { id: 'less', label: 'Less' },
  { id: 'python', label: 'Python' },
  { id: 'java', label: 'Java' },
  { id: 'c', label: 'C' },
  { id: 'cpp', label: 'C++' },
  { id: 'csharp', label: 'C#' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
  { id: 'php', label: 'PHP' },
  { id: 'ruby', label: 'Ruby' },
  { id: 'kotlin', label: 'Kotlin' },
  { id: 'swift', label: 'Swift' },
  { id: 'sql', label: 'SQL' },
  { id: 'shell', label: 'Shell Script' },
  { id: 'powershell', label: 'PowerShell' },
  { id: 'bat', label: 'Batch (CMD)' },
  { id: 'yaml', label: 'YAML' },
  { id: 'xml', label: 'XML' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'mdx', label: 'MDX' },
  { id: 'ini', label: 'INI / Config / TOML' },
  { id: 'dockerfile', label: 'Dockerfile' },
  { id: 'hcl', label: 'HCL / Terraform' },
  { id: 'proto', label: 'Protocol Buffers' },
  { id: 'graphql', label: 'GraphQL' },
  { id: 'lua', label: 'Lua' },
  { id: 'perl', label: 'Perl' },
  { id: 'r', label: 'R' },
  { id: 'dart', label: 'Dart' },
  { id: 'scala', label: 'Scala' },
  { id: 'clojure', label: 'Clojure' },
  { id: 'elixir', label: 'Elixir' },
  { id: 'fsharp', label: 'F#' },
  { id: 'solidity', label: 'Solidity' },
  { id: 'objective-c', label: 'Objective-C' },
  { id: 'coffee', label: 'CoffeeScript' },
  { id: 'pug', label: 'Pug' },
  { id: 'tcl', label: 'Tcl' },
  { id: 'vb', label: 'VB.NET' }
]
