// 3.2 元素选择器注入脚本生成器：
// 生成可在预览页 executeJavaScript 的代码，返回唯一选择器/outerHTML/元素 bounds。
// 纯函数：不依赖 electron，可在 vitest 下直接验证输出字符串。

/** 选择器优先级：data-id > data-testid > id > CSS path */
const SELECTOR_PRIORITY = ['data-id', 'data-testid', 'id'] as const

/** 生成元素唯一 CSS 选择器（优先 data-id/data-testid/id，退化到 CSS path） */
export function buildSelectorScript(): string {
  return `(function(){
    // 优先级属性：data-id > data-testid > id
    const PRIORITY = ${JSON.stringify(SELECTOR_PRIORITY)};
    function getSelector(el) {
      // 1. 优先级属性
      for (const attr of PRIORITY) {
        const v = el.getAttribute(attr);
        if (v) return '[' + attr + '="' + v + '"]';
      }
      // 2. id
      if (el.id) return '#' + el.id;
      // 3. CSS path（向上找 5 层）
      const parts = [];
      let cur = el;
      for (let i = 0; i < 5 && cur && cur.tagName; i++) {
        let part = cur.tagName.toLowerCase();
        if (cur.id) { part += '#' + cur.id; parts.unshift(part); break; }
        const cls = Array.from(cur.classList).slice(0, 2).join('.');
        if (cls) part += '.' + cls;
        const sibs = cur.parentElement ? Array.from(cur.parentElement.children) : [];
        if (sibs.length > 1) {
          const idx = sibs.indexOf(cur) + 1;
          part += ':nth-child(' + idx + ')';
        }
        parts.unshift(part);
        cur = cur.parentElement;
      }
      return parts.join(' > ');
    }
    return getSelector;
  })()`
}

/** 注入到预览页的选择模式脚本（悬停高亮 + 点击采集） */
export function buildPickerScript(): string {
  return `(function(){
    if (window.__scholarPickerActive) return 'already';
    window.__scholarPickerActive = true;

    // 高亮 overlay（青色边框 + 半透明背景）
    const overlay = document.createElement('div');
    overlay.id = '__scholar-picker-overlay';
    overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;' +
      'border:2px solid #00D4FF;background:rgba(0,212,255,0.1);display:none;';
    document.body.appendChild(overlay);

    let hovered = null;

    function onMouseMove(e) {
      hovered = e.target;
      const r = hovered.getBoundingClientRect();
      overlay.style.display = 'block';
      overlay.style.left = r.left + 'px';
      overlay.style.top = r.top + 'px';
      overlay.style.width = r.width + 'px';
      overlay.style.height = r.height + 'px';
    }

    function onClick(e) {
      e.preventDefault();
      e.stopPropagation();
      const el = hovered || e.target;
      // 直接内联 getSelector 逻辑（避免嵌套函数引用问题）
      function getSelectorInline(el) {
        const PRIORITY = ${JSON.stringify(SELECTOR_PRIORITY)};
        for (const attr of PRIORITY) {
          const v = el.getAttribute(attr);
          if (v) return '[' + attr + '="' + v + '"]';
        }
        if (el.id) return '#' + el.id;
        const parts = [];
        let cur = el;
        for (let i = 0; i < 5 && cur && cur.tagName; i++) {
          let part = cur.tagName.toLowerCase();
          if (cur.id) { part += '#' + cur.id; parts.unshift(part); break; }
          const cls = Array.from(cur.classList).slice(0, 2).join('.');
          if (cls) part += '.' + cls;
          const sibs = cur.parentElement ? Array.from(cur.parentElement.children) : [];
          if (sibs.length > 1) {
            const idx = sibs.indexOf(cur) + 1;
            part += ':nth-child(' + idx + ')';
          }
          parts.unshift(part);
          cur = cur.parentElement;
        }
        return parts.join(' > ');
      }
      const r = el.getBoundingClientRect();
      const data = {
        selector: getSelectorInline(el),
        outerHTML: el.outerHTML.length > 8000 ? el.outerHTML.slice(0, 8000) + '...[truncated]' : el.outerHTML,
        bounds: { x: r.left, y: r.top, width: r.width, height: r.height },
        tagName: el.tagName.toLowerCase(),
        text: (el.innerText || '').slice(0, 200)
      };
      // 经 console 回传主进程（webContents.on('console-message') 接收）
      console.log('__SCHOLAR_PICKED__' + JSON.stringify(data));
      cleanup();
    }

    function onKeydown(e) {
      if (e.key === 'Escape') cleanup();
    }

    function cleanup() {
      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
      window.__scholarPickerActive = false;
    }

    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeydown, true);
    return 'injected';
  })()`
}

/** 解析 console 消息中的采集数据 */
export function parsePickedMessage(msg: string): {
  selector: string
  outerHTML: string
  bounds: { x: number; y: number; width: number; height: number }
  tagName: string
  text: string
} | null {
  const prefix = '__SCHOLAR_PICKED__'
  if (!msg.startsWith(prefix)) return null
  try {
    return JSON.parse(msg.slice(prefix.length))
  } catch {
    return null
  }
}
