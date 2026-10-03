// s31–s33 冒烟（2.3 图片/截图输入）：
//   假 OpenAI 兼容服务（进程内 http）+ 临时工作区，验证：
//   - 粘贴/拖拽图片 → 缩略图出现、可删除
//   - vision 模型附件入口可用；非 vision 模型入口被禁用并提示
//   - 发送：附件落 <ws>/.trae/attachments、线协议含 image_url 块、气泡内图片渲染、AI 回复
//   - 历史会话大文件只存附件路径（不含 base64）；删会话联动删附件
// 用法：先 npm run dev -- --remote-debugging-port=9342，再 node scripts/cdp-test-image.cjs
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CDP = 'http://127.0.0.1:9342'
const FAKE_PORT = 19192
/** 1x1 红色 PNG（最小可验证图片载荷） */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
/** AI 对图片的固定描述回复（用于端到端断言） */
const REPLY_TEXT = '图片描述：这是一张冒烟测试图片（1x1 红色像素）'

let addedProviderId = null
let tempWs = null

// ---------------- 假 OpenAI 兼容服务 ----------------
const state = { bodies: [] } // 收到的全部请求体（解析后）

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    // fake-llava：名字命中 llava 启发 → vision=true；fake-text：无视觉
    res.end(
      JSON.stringify({
        data: [
          { id: 'fake-llava', object: 'model' },
          { id: 'fake-text', object: 'model' }
        ]
      })
    )
    return
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let parsed = {}
      try {
        parsed = JSON.parse(body)
      } catch {
        /* 忽略 */
      }
      state.bodies.push(parsed)
      // 非流式（工具循环主调用）：回标准 JSON
      if (parsed.stream !== true) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            choices: [
              {
                message: { role: 'assistant', content: REPLY_TEXT },
                finish_reason: 'stop'
              }
            ],
            usage: { prompt_tokens: 12, completion_tokens: 8 }
          })
        )
        return
      }
      // 流式：SSE
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      // 流式回复：角色 → 描述文本 → usage → [DONE]
      res.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n')
      setTimeout(() => {
        res.write(
          `data: {"choices":[{"delta":{"content":${JSON.stringify(REPLY_TEXT)}}}]}\n\n`
        )
      }, 60)
      setTimeout(() => {
        res.write(
          'data: {"choices":[{}],"usage":{"prompt_tokens":12,"completion_tokens":8}}\n\n'
        )
        res.write('data: [DONE]\n\n')
        res.end()
      }, 140)
    })
    return
  }
  res.writeHead(404)
  res.end()
})

// ---------------- CDP 工具 ----------------
async function getPageWs() {
  const res = await fetch(`${CDP}/json`)
  const targets = await res.json()
  const page = targets.find((t) => t.type === 'page' && /localhost:\d+/.test(t.url))
  if (!page) throw new Error('未找到渲染页面（dev 未就绪？）')
  return page.webSocketDebuggerUrl
}

function connect(u) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(u)
    let id = 0
    const p = new Map()
    ws.onopen = () =>
      resolve({
        call(m, a = {}) {
          return new Promise((r, j) => {
            const i = ++id
            p.set(i, { r, j })
            ws.send(JSON.stringify({ id: i, method: m, params: a }))
          })
        },
        close: () => ws.close()
      })
    ws.onerror = () => reject(new Error('ws 连接失败'))
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && p.has(m.id)) {
        const { r, j } = p.get(m.id)
        p.delete(m.id)
        m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result)
      }
    }
  })
}

/** 在渲染进程执行表达式（awaitPromise），返回 value */
async function ev(cdp, expression) {
  const r = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (r.exceptionDetails) {
    throw new Error(
      '页面内执行失败: ' +
        JSON.stringify(
          r.exceptionDetails.exception?.description || r.exceptionDetails.text
        )
    )
  }
  return r.result.value
}

/** 轮询页面表达式直至为真值或超时 */
async function waitFor(cdp, expression, timeoutMs = 20000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let v = null
    try {
      v = await ev(cdp, expression)
    } catch {
      /* 页面重载等瞬态错误，继续轮询 */
    }
    if (v) return v
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return null
}

async function reloadPage(cdp) {
  await cdp.call('Page.enable')
  await cdp.call('Page.reload', { ignoreCache: true })
  // 等页面可执行（load 事件后 DOM 就绪）
  await waitFor(cdp, `document.querySelector('.composer') ? true : null`, 20000)
  await new Promise((r) => setTimeout(r, 500))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`✓ ${name}${detail ? ' — ' + detail : ''}`)
  } else {
    fail++
    console.log(`✗ ${name}${detail ? ' — ' + detail : ''}`)
  }
}

/** 页面内：b64 → 字节 → File，供粘贴/拖拽复用 */
function makeFileExpr(filename) {
  return `
    (function(){
      const b64 = ${JSON.stringify(PNG_B64)};
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
      return new File([bytes], ${JSON.stringify(filename)}, {type:'image/png'});
    })()`
}

// ---------------- 主流程 ----------------
async function main() {
  await new Promise((r) => server.listen(FAKE_PORT, '127.0.0.1', r))

  // 1) 临时工作区
  tempWs = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'scholar-img-smoke-'))
  console.log(`临时工作区：${tempWs}`)

  let cdp = await connect(await getPageWs())

  // 2) 记住原记忆，指向临时工作区后重载（让应用真实打开它）
  const origWs = await ev(
    cdp,
    `localStorage.getItem('scholar:lastWorkspace')`
  )
  await ev(
    cdp,
    `localStorage.setItem('scholar:lastWorkspace', ${JSON.stringify(tempWs)}); 'ok'`
  )
  await reloadPage(cdp)

  // 3) 注册假 provider（清残留同名），再重载让模型进入下拉
  const existing = await ev(cdp, `window.api.ai.listProviders()`).catch(() => [])
  for (const p of existing || []) {
    const pname = p?.name || p?.displayName || ''
    if (
      pname === 'image-smoke' &&
      String(p?.id || '').startsWith('custom-')
    ) {
      await ev(
        cdp,
        `window.api.ai.removeCustomProvider(${JSON.stringify(p.id)})`
      ).catch(() => {})
    }
  }
  const added = await ev(
    cdp,
    `window.api.ai.addCustomProvider({ name: 'image-smoke', baseUrl: 'http://127.0.0.1:${FAKE_PORT}/v1' })`
  )
  addedProviderId = added?.provider?.id || added?.id
  check('注册假 OpenAI 兼容 provider', !!addedProviderId, `id=${addedProviderId}`)
  const MODEL_V = `${addedProviderId}:fake-llava`
  const MODEL_T = `${addedProviderId}:fake-text`

  await reloadPage(cdp)
  // 等工作区恢复完成：附件按钮在 auto 模型下变为可用
  const wsReady = await waitFor(
    cdp,
    `(function(){const b=document.querySelectorAll('.attach-btn'); return b.length===2 && !b[0].disabled;})()`
  )
  check('工作区已打开、附件入口默认可用', !!wsReady)

  // ===== S1 粘贴图片 → 缩略图 =====
  await ev(cdp, `
    (function(){
      const file = ${makeFileExpr('shot.png')};
      const dt = new DataTransfer();
      dt.items.add(file);
      document.querySelector('.composer-input').dispatchEvent(
        new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true})
      );
      return 'ok';
    })()`)
  const thumbOk = await waitFor(
    cdp,
    `(function(){
      const t = document.querySelector('.draft-thumb img');
      return t && t.complete && t.naturalWidth > 0 ? t.naturalWidth : null;
    })()`
  )
  check('S1 粘贴图片后缩略图出现并完成加载', thumbOk === 1, `naturalWidth=${thumbOk}`)

  // ===== S2 删除缩略图 =====
  await ev(cdp, `document.querySelector('.thumb-remove').click(); 'ok'`)
  await sleep(150)
  const afterRemove = await ev(
    cdp,
    `document.querySelectorAll('.draft-thumb').length`
  )
  check('S2 缩略图可删除', afterRemove === 0, `剩余=${afterRemove}`)

  // ===== S3 拖拽图片 → 缩略图 =====
  await ev(cdp, `
    (function(){
      const file = ${makeFileExpr('shot2.png')};
      const dt = new DataTransfer();
      dt.items.add(file);
      const composer = document.querySelector('.composer');
      composer.dispatchEvent(new DragEvent('dragover', {dataTransfer: dt, bubbles: true, cancelable: true}));
      composer.dispatchEvent(new DragEvent('drop', {dataTransfer: dt, bubbles: true, cancelable: true}));
      return 'ok';
    })()`)
  const dropOk = await waitFor(
    cdp,
    `document.querySelectorAll('.draft-thumb').length === 1 ? true : null`
  )
  check('S3 拖入图片后缩略图出现', !!dropOk)
  // 清掉拖拽草稿，发送测试用粘贴
  await ev(cdp, `document.querySelector('.thumb-remove').click(); 'ok'`)
  await sleep(150)

  // ===== S4/S5 vision 门控（显式选定模型）=====
  // 切换到视觉模型
  await ev(cdp, `
    (function(){
      const sel = document.querySelector('.model-select');
      sel.value = ${JSON.stringify(MODEL_V)};
      sel.dispatchEvent(new Event('change', {bubbles:true}));
      return 'ok';
    })()`)
  await sleep(150)
  const vState = await ev(cdp, `
    (function(){
      const b = document.querySelectorAll('.attach-btn');
      return {n: b.length, disabled: Array.from(b).map(x=>x.disabled)};
    })()`)
  check(
    'S4 vision 模型下两个附件入口均可用',
    vState.n === 2 && vState.disabled.every((d) => !d),
    JSON.stringify(vState.disabled)
  )

  // 切换到非视觉模型
  await ev(cdp, `
    (function(){
      const sel = document.querySelector('.model-select');
      sel.value = ${JSON.stringify(MODEL_T)};
      sel.dispatchEvent(new Event('change', {bubbles:true}));
      return 'ok';
    })()`)
  await sleep(150)
  const tState = await ev(cdp, `
    (function(){
      const b = document.querySelectorAll('.attach-btn');
      return {
        allDisabled: Array.from(b).every(x=>x.disabled),
        title: b[0].title
      };
    })()`)
  check(
    'S5 非 vision 模型附件入口被禁用',
    tState.allDisabled && tState.title.includes('不支持图片输入'),
    tState.title
  )

  // ===== 切回视觉模型并发送图片 =====
  // 显式关掉工具开关（可能被之前使用留在「工具调用」态），保证走纯流式路径
  await ev(cdp, `
    (function(){
      const pill = Array.from(document.querySelectorAll('.composer-left .pill'))
        .find((x) => !x.classList.contains('model-pill'));
      if (pill && pill.classList.contains('active')) pill.click();
      return 'ok';
    })()`)
  await sleep(150)
  await ev(cdp, `
    (function(){
      const sel = document.querySelector('.model-select');
      sel.value = ${JSON.stringify(MODEL_V)};
      sel.dispatchEvent(new Event('change', {bubbles:true}));
      const ta = document.querySelector('.composer-input');
      ta.value = '请描述这张图片';
      ta.dispatchEvent(new Event('input', {bubbles:true}));
      return 'ok';
    })()`)
  await sleep(150)
  // 粘贴图片
  await ev(cdp, `
    (function(){
      const file = ${makeFileExpr('shot3.png')};
      const dt = new DataTransfer();
      dt.items.add(file);
      document.querySelector('.composer-input').dispatchEvent(
        new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true})
      );
      return 'ok';
    })()`)
  await waitFor(
    cdp,
    `document.querySelectorAll('.draft-thumb').length === 1 ? true : null`
  )
  // 点发送
  await ev(cdp, `document.querySelector('.send-square').click(); 'ok'`)

  // S6 附件落盘
  const attDir = path.join(tempWs, '.trae', 'attachments')
  let attFile = null
  for (let i = 0; i < 50; i++) {
    try {
      const files = fs
        .readdirSync(attDir)
        .filter((f) => f.endsWith('.png'))
      if (files.length > 0) {
        attFile = path.join(attDir, files[0])
        break
      }
    } catch {
      /* 目录尚未创建 */
    }
    await sleep(100)
  }
  let attBytesOk = false
  if (attFile) {
    attBytesOk = fs.readFileSync(attFile).equals(Buffer.from(PNG_B64, 'base64'))
  }
  check('S6 附件落盘 .trae/attachments 且字节一致', !!attFile && attBytesOk, attFile || '')

  // S7 线协议含 image_url 块（端到端验证 OpenAI 转换）
  let wireOk = false
  for (let i = 0; i < 50; i++) {
    wireOk = state.bodies.some((b) =>
      (b.messages || []).some(
        (m) =>
          Array.isArray(m.content) &&
          m.content.some(
            (blk) =>
              blk.type === 'image_url' &&
              typeof blk.image_url?.url === 'string' &&
              blk.image_url.url.startsWith('data:image/png;base64,') &&
              blk.image_url.url.endsWith(PNG_B64)
          )
      )
    )
    if (wireOk) break
    await sleep(100)
  }
  check('S7 发送线协议：user 消息含 image_url data URL 块', wireOk)

  // S8 气泡内图片渲染（经 readAttachment 回读）
  const bubbleImg = await waitFor(
    cdp,
    `(function(){
      const imgs = document.querySelectorAll('.msg-images img.msg-image');
      for (const im of imgs) if (im.complete && im.naturalWidth > 0) return im.naturalWidth;
      return null;
    })()`,
    15000
  )
  check('S8 消息气泡内附件图片渲染成功', bubbleImg === 1, `naturalWidth=${bubbleImg}`)

  // S10 AI 回复到达
  const replyOk = await waitFor(
    cdp,
    `document.body.innerText.includes(${JSON.stringify(REPLY_TEXT)}) ? true : null`,
    15000
  )
  check('S10 vision 模型据图片给出描述回复', !!replyOk)

  // S9 历史会话大文件：只存路径、不含图片数据
  // 应用按 localStorage 中的路径（os.tmpdir() 给出的短路径）计算 wsKey，直接用 tempWs
  const wsKey = Buffer.from(tempWs, 'utf-8').toString('base64url')
  let sessionFile = null
  const appdata = process.env.APPDATA
  for (let i = 0; i < 40 && !sessionFile; i++) {
    for (const name of fs.readdirSync(appdata)) {
      const dir = path.join(appdata, name, 'chat-history', wsKey)
      try {
        const files = fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.json') && f !== 'index.json')
        if (files.length > 0) {
          // 取最新（mtime 降序），避免同分区残留旧会话干扰
          files.sort(
            (a, b) =>
              fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs
          )
          sessionFile = path.join(dir, files[0])
          break
        }
      } catch {
        /* 该分区不存在 */
      }
    }
    if (!sessionFile) await sleep(250)
  }
  let s9 = false
  let s9Detail = ''
  if (sessionFile) {
    const raw = fs.readFileSync(sessionFile, 'utf-8')
    // JSON 文本中反斜杠是转义的（\ → \\），attFile 也要按 JSON 字符串编码后再匹配
    const attFileJson = JSON.stringify(attFile).slice(1, -1)
    const hasPath = raw.includes(attFileJson)
    const noDataUrl = !raw.includes('data:image')
    // PNG base64 头若干字符不应出现
    const noBase64 = !raw.includes('iVBORw0KGgo')
    s9 = hasPath && noDataUrl && noBase64
    s9Detail = `path=${hasPath} 无dataURL=${noDataUrl} 无base64=${noBase64}`
  }
  check('S9 历史大文件仅存附件路径、不含图片数据', s9, s9Detail || '未找到会话文件')

  // S11 删会话联动删附件
  const sessionId = sessionFile
    ? path.basename(sessionFile, '.json')
    : null
  if (sessionId) {
    await ev(
      cdp,
      `window.api.ai.deleteSession(${JSON.stringify(tempWs)}, ${JSON.stringify(sessionId)})`
    )
    await sleep(500)
    const attGone = !fs.existsSync(attFile)
    const sessGone = !fs.existsSync(sessionFile)
    check('S11 删除会话联动删除附件文件', attGone && sessGone, `附件删=${attGone}`)
  } else {
    check('S11 删除会话联动删除附件文件', false, '缺少会话 id')
  }

  // ===== 收尾：移除假 provider，恢复原工作区记忆 =====
  if (addedProviderId) {
    await ev(
      cdp,
      `window.api.ai.removeCustomProvider(${JSON.stringify(addedProviderId)})`
    ).catch(() => {})
  }
  addedProviderId = null
  if (origWs) {
    await ev(
      cdp,
      `localStorage.setItem('scholar:lastWorkspace', ${JSON.stringify(origWs)}); 'ok'`
    )
  } else {
    await ev(cdp, `localStorage.removeItem('scholar:lastWorkspace'); 'ok'`)
  }
  // 先重载：让应用切回原工作区、释放临时目录上的 watcher/索引句柄，再删目录
  await reloadPage(cdp)
  cdp.close()
  server.close()

  // 删除临时工作区（附件已随会话删除；若仍有短暂句柄则重试几次）
  let removed = false
  for (let i = 0; i < 10; i++) {
    try {
      await fs.promises.rm(tempWs, { recursive: true, force: true })
      removed = true
      break
    } catch {
      await sleep(500)
    }
  }
  const tempPathForWarn = tempWs
  tempWs = null
  if (!removed) console.warn(`⚠ 临时目录未能立即删除（系统句柄延迟释放）：${tempPathForWarn}`)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(async (e) => {
  console.error('冒烟失败:', e.message)
  try {
    if (addedProviderId) {
      const cdp = await connect(await getPageWs())
      await ev(
        cdp,
        `window.api.ai.removeCustomProvider(${JSON.stringify(addedProviderId)})`
      ).catch(() => {})
      cdp.close()
    }
  } catch {
    /* 尽力清理 */
  }
  if (tempWs) {
    await fs.promises.rm(tempWs, { recursive: true, force: true }).catch(() => {})
  }
  server.close()
  process.exit(1)
})
