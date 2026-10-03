// Monaco Vue 语言：注册独立语言 ID 'vue'（.vue 单文件组件），
// Monarch 语法按顶层块（<template>/<script>/<style>）切入嵌入规则：
//   template —— 自研 HTML 风格规则（支持嵌套 <template> 计数、{{ }} 插值、
//               v-xxx/:prop/@event/#slot 属性着色）；
//   script   —— 按 lang 嵌入 typescript/javascript（默认 javascript）；
//   style    —— 嵌入 css（scss/less 等按 css 基线高亮）。
// 设计要点见 43 计划文档 s21。
import * as monaco from 'monaco-editor'

let registered = false

/** 幂等注册 vue 语言（供 monacoLsp.setupLanguage 调用） */
export function registerVueLanguage(): void {
  if (registered) return
  registered = true
  monaco.languages.register({ id: 'vue', aliases: ['Vue', 'vue'], extensions: ['.vue'] })
  monaco.languages.setLanguageConfiguration('vue', conf)
  monaco.languages.setMonarchTokensProvider('vue', language)
}

// ============================ Language Configuration ============================

const conf: monaco.languages.LanguageConfiguration = {
  wordPattern:
    /(-?\d*\.\d\w*)|([^`~!@$^&*()=+[{\]}\\|;:'",.<>/?\s]+)/g,
  comments: { blockComment: ['<!--', '-->'] },
  brackets: [
    ['<!--', '-->'],
    ['<', '>'],
    ['{', '}'],
    ['(', ')']
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" }
  ],
  surroundingPairs: [
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '<', close: '>' }
  ],
  onEnterRules: [
    {
      // <x>...</x> 之间换行：缩进再反向缩进
      beforeText: /<([\w][\w-.\d]*)([^/>]*(?!\/)>)[^<]*$/i,
      afterText: /^<\/([\w][\w-.\d]*)\s*>$/i,
      action: { indentAction: monaco.languages.IndentAction.IndentOutdent }
    },
    {
      // 仅开标签后换行：缩进
      beforeText: /<([\w][\w-.\d]*)([^/>]*(?!\/)>)\s*$/i,
      action: { indentAction: monaco.languages.IndentAction.Indent }
    }
  ],
  folding: {
    markers: {
      start: /^\s*<!--\s*#region\b.*-->/,
      end: /^\s*<!--\s*#endregion\b.*-->/
    }
  }
}

// ============================ Monarch Grammar ============================

const language: monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.vue',
  ignoreCase: true,

  tokenizer: {
    root: [
      [/<!--/, 'comment', '@comment'],
      // 三个 SFC 顶层块（含闭合标签的容错规则在各 open 状态内）
      [/(<)(template)\b/, ['delimiter', { token: 'tag', next: '@blockOpenTemplate' }]],
      [/(<)(script)\b/, ['delimiter', { token: 'tag', next: '@blockOpenScript' }]],
      [/(<)(style)\b/, ['delimiter', { token: 'tag', next: '@blockOpenStyle' }]],
      // 其他自定义块（<i18n> 等）按普通标签处理，内容不着色
      [/(<)(\/?[\w-]+)/, ['delimiter', { token: 'tag', next: '@otherTag' }]],
      [/</, 'delimiter'],
      [/[^<]+/, '']
    ],

    // ---------- 通用 ----------
    comment: [
      [/-->/, 'comment', '@pop'],
      [/[^-]+/, 'comment.content'],
      [/./, 'comment.content']
    ],
    otherTag: [
      [/\/?>/, 'delimiter', '@pop'],
      [/"([^"]*)"/, 'attribute.value'],
      [/'([^']*)'/, 'attribute.value'],
      [/[\w-]+/, 'attribute.name'],
      [/=/, 'delimiter'],
      [/[ \t\r\n]+/, '']
    ],

    // ==================== <template> ====================
    blockOpenTemplate: [
      [/"([^"]*)"/, 'attribute.value'],
      [/'([^']*)'/, 'attribute.value'],
      [/[\w-]+/, 'attribute.name'],
      [/=/, 'delimiter'],
      [/[ \t\r\n]+/, ''],
      // 开标签结束 → 模板体（root→open→body 共两层栈）
      [/>/, { token: 'delimiter', next: '@templateBody' }],
      // 容错：裸闭合直接弹回上层
      [/<\/template\s*>/, { token: '@rematch', next: '@pop' }]
    ],

    templateBody: [
      [/<!--/, 'comment', '@comment'],
      // 插值 {{ expr }}
      [/{{/, 'delimiter', '@interp'],
      // 嵌套 <template>（v-for / v-slot 容器）：复用 open 状态，栈深度 +2，
      // 闭合时对称 -2，因此可正确计数
      [/(<)(template)\b/, ['delimiter', { token: 'tag', next: '@blockOpenTemplate' }]],
      // 普通 HTML 元素 / 组件（开标签与闭合标签）
      [/(<)(\/?[a-zA-Z][\w.-]*)/, ['delimiter', { token: 'tag', next: '@htmlTag' }]],
      // 本层闭合：rematch 弹回 open 状态，由其闭合规则再弹一层
      [/<\/template/, { token: '@rematch', next: '@pop' }],
      [/[^<{]+/, ''],
      [/[{}]/, '']
    ],

    htmlTag: [
      // Vue 指令与绑定：v-xxx / :prop / @event / #slot
      [/(v-[a-zA-Z][\w-]*|[:@#][\w.-]+)/, 'attribute.name'],
      [/[\w-]+/, 'attribute.name'],
      [/=/, 'delimiter'],
      [/"([^"]*)"/, 'attribute.value'],
      [/'([^']*)'/, 'attribute.value'],
      [/[ \t\r\n]+/, ''],
      // 标签结束（含自闭合）：弹回模板体
      [/\/?>/, 'delimiter', '@pop']
    ],

    interp: [
      [/}}/, 'delimiter', '@pop'],
      [/[^}]+/, 'variable'],
      [/}/, 'variable']
    ],

    // ==================== <script> ====================
    blockOpenScript: [
      // lang 决定嵌入语言
      [/lang/, 'attribute.name', '@scriptAfterLang'],
      [/"([^"]*)"/, 'attribute.value'],
      [/'([^']*)'/, 'attribute.value'],
      // setup 等其他属性
      [/[\w-]+/, 'attribute.name'],
      [/=/, 'delimiter'],
      [/[ \t\r\n]+/, ''],
      // 默认（无 lang）= javascript
      [
        />/,
        { token: 'delimiter', next: '@scriptEmbedded', nextEmbedded: 'javascript' }
      ],
      [/<\/script\s*>/, { token: '@rematch', next: '@pop' }]
    ],

    scriptAfterLang: [
      [/=/, 'delimiter', '@scriptAfterLangEquals'],
      [
        />/,
        { token: 'delimiter', next: '@scriptEmbedded', nextEmbedded: 'javascript' }
      ],
      [/[ \t\r\n]+/, ''],
      [/<\/script\s*>/, { token: '@rematch', next: '@pop' }]
    ],

    scriptAfterLangEquals: [
      // 已知 TS 家族值 → 参数化进入自定义嵌入
      [
        /"(ts|typescript)"|'(ts|typescript)'/,
        { token: 'attribute.value', switchTo: '@scriptWithLang.typescript' }
      ],
      [
        /"(tsx)"|'(tsx)'/,
        { token: 'attribute.value', switchTo: '@scriptWithLang.typescriptreact' }
      ],
      [
        /"(js|javascript)"|'(js|javascript)'/,
        { token: 'attribute.value', switchTo: '@scriptWithLang.javascript' }
      ],
      [
        /"(jsx)"|'(jsx)'/,
        { token: 'attribute.value', switchTo: '@scriptWithLang.javascriptreact' }
      ],
      // 未知 lang：回落 javascript（避免嵌入未注册语言）
      [/"([^"]*)"|'([^']*)'/, { token: 'attribute.value', switchTo: '@scriptWithLang.javascript' }],
      [
        />/,
        { token: 'delimiter', next: '@scriptEmbedded', nextEmbedded: 'javascript' }
      ],
      [/<\/script\s*>/, { token: '@rematch', next: '@pop' }]
    ],

    scriptWithLang: [
      // $S2 = 解析出的嵌入语言 id
      [
        />/,
        { token: 'delimiter', next: '@scriptEmbedded.$S2', nextEmbedded: '$S2' }
      ],
      [/"([^"]*)"/, 'attribute.value'],
      [/'([^']*)'/, 'attribute.value'],
      [/[\w-]+/, 'attribute.name'],
      [/=/, 'delimiter'],
      [/[ \t\r\n]+/, ''],
      [/<\/script\s*>/, { token: '@rematch', next: '@pop' }]
    ],

    scriptEmbedded: [
      // </script>：rematch 弹回 open 状态（嵌入语言随 @pop 关闭），
      // 由 open 状态的闭合规则再弹回 root
      [/<\/script/, { token: '@rematch', next: '@pop', nextEmbedded: '@pop' }],
      [/[^<]+/, '']
    ],

    // ==================== <style> ====================
    blockOpenStyle: [
      // lang（scss/less/stylus 等）：不做语言切换，统一按 css 基线高亮，
      // 保证嵌入的始终是已注册语言
      [/"([^"]*)"/, 'attribute.value'],
      [/'([^']*)'/, 'attribute.value'],
      [/[\w-]+/, 'attribute.name'],
      [/=/, 'delimiter'],
      [/[ \t\r\n]+/, ''],
      [
        />/,
        { token: 'delimiter', next: '@styleEmbedded', nextEmbedded: 'text/css' }
      ],
      [/<\/style\s*>/, { token: '@rematch', next: '@pop' }]
    ],

    styleEmbedded: [
      [/<\/style/, { token: '@rematch', next: '@pop', nextEmbedded: '@pop' }],
      [/[^<]+/, '']
    ]
  }
}
