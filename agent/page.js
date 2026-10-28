// Code GPT browser agent: the part that runs inside a web page.
// It is put into a tab only while a task runs. It reads the page (a numbered list of what can be used), and does what the
// agent asked: click, type, choose, scroll. It never sends anything anywhere by itself: the side panel asks, this answers.
(function () {
  'use strict';
  if (window.__cga && window.__cga.v === 2) return;
  const refs = new Map();
  let nextRef = 1;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE', 'BASE', 'DATALIST', 'OPTION', 'OPTGROUP', 'AREA', 'MAP', 'PATH', 'DEFS', 'USE', 'SYMBOL', 'LINEARGRADIENT', 'CLIPPATH', 'G', 'RECT', 'CIRCLE', 'POLYGON', 'LINE', 'POLYLINE', 'ELLIPSE', 'TEXT', 'TSPAN']);
  const BLOCK = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT', 'DD', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'UL', 'SUMMARY', 'BR', 'CAPTION']);
  const ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'switch', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem', 'gridcell', 'listbox']);
  const SENSITIVE_NAME = /pass(word|code|wd)?\b|\bpwd\b|cvv|cvc|csc|card[\s_-]*(number|no|num)|credit[\s_-]*card|security[\s_-]*code|\botp\b|one[\s_-]*time|verification[\s_-]*code|2fa|\bssn\b|social[\s_-]*security|\biban\b|routing|account[\s_-]*number|\bpin\b|national[\s_-]*id|cnic/i;
  const SENSITIVE_AC = /^(cc-|one-time-code|new-password|current-password)/i;
  const SEARCH_NAME = /search|find|query|\bq\b|lookup|filter/i;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 100);
  const cs = (el) => getComputedStyle(el);

  /* ---------------- what an element is, in plain words ---------------- */
  function textOfIds(ids) {
    return String(ids || '').split(/\s+/).map((id) => { const e = document.getElementById(id); return e ? clean(e.innerText || e.textContent, 80) : ''; }).filter(Boolean).join(' ');
  }
  function labelOf(el, max) {
    const tag = el.tagName;
    let t = el.getAttribute('aria-label') || textOfIds(el.getAttribute('aria-labelledby'));
    if (!t && (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA')) {
      if (el.labels && el.labels.length) t = Array.from(el.labels).map((l) => clean(l.innerText || l.textContent, 80)).join(' ');
      if (!t) t = el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || el.id || '';
      if (!t && tag === 'INPUT' && /^(submit|button|reset)$/i.test(el.type)) t = el.value;
    } else if (!t) {
      t = clean(el.innerText || el.textContent, max || 90);
      if (!t) { const img = el.querySelector('img[alt], svg[aria-label], svg title'); t = img ? (img.getAttribute('alt') || img.getAttribute('aria-label') || img.textContent) : ''; }
      if (!t) t = el.getAttribute('title') || el.getAttribute('data-tooltip') || el.getAttribute('alt') || el.getAttribute('value') || '';
    }
    return clean(t, max || 90);
  }
  function roleOf(el) {
    const tag = el.tagName, role = (el.getAttribute('role') || '').toLowerCase();
    if (tag === 'A' && el.hasAttribute('href')) return 'link';
    if (tag === 'BUTTON' || role === 'button') return 'button';
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SUMMARY') return 'button';
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return t;
      if (/^(submit|button|reset|image)$/.test(t)) return 'button';
      if (t === 'range') return 'slider';
      if (t === 'file') return 'file upload';
      if (t === 'search') return 'searchbox';
      return t === 'text' ? 'textbox' : t + ' field';
    }
    if (el.isContentEditable) return 'rich text box';
    if (role) return role;
    return 'clickable';
  }
  function isSensitive(el) {
    if (!el || el.nodeType !== 1) return false;
    const t = (el.type || '').toLowerCase();
    if (t === 'password') return true;
    const ac = el.getAttribute('autocomplete') || '';
    if (SENSITIVE_AC.test(ac)) return true;
    const hay = [el.getAttribute('name'), el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('data-testid')].join(' ');
    return (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && SENSITIVE_NAME.test(hay);
  }
  function isInteractive(el, style) {
    const tag = el.tagName;
    if (tag === 'A') return el.hasAttribute('href') || el.hasAttribute('onclick') || el.getAttribute('role') === 'button';
    if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'SUMMARY') return true;
    if (tag === 'INPUT') return (el.type || '').toLowerCase() !== 'hidden';
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role && ROLES.has(role)) return true;
    if (el.isContentEditable && el.getAttribute('contenteditable') !== 'inherit' && !(el.parentElement && el.parentElement.isContentEditable)) return true;
    if (el.hasAttribute('onclick') || (el.hasAttribute('tabindex') && el.tabIndex >= 0 && (el.innerText || el.getAttribute('aria-label')))) return true;
    return false;
  }
  function pointerTop(el, style) {
    if (style.cursor !== 'pointer') return false;
    const p = el.parentElement;
    if (p && cs(p).cursor === 'pointer') return false;
    return !!(clean(el.innerText, 4) || el.getAttribute('aria-label') || el.getAttribute('title') || el.querySelector('img,svg'));
  }
  function scrollable(el, style) {
    const oy = style.overflowY;
    return (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 60 && el.clientHeight > 120 && el.clientWidth > 160;
  }
  function inView(r) { return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; }
  function attrsOf(el, role) {
    const a = [];
    const tag = el.tagName;
    if (tag === 'A' && el.href) { try { const u = new URL(el.href); if (u.origin !== location.origin) a.push('to ' + u.host + clean(u.pathname, 40)); else if (u.pathname !== location.pathname) a.push('to ' + clean(u.pathname + u.search, 50)); } catch (e) {} }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') a.push('disabled');
    if (el.required || el.getAttribute('aria-required') === 'true') a.push('required');
    if (el.readOnly) a.push('read-only');
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const t = (el.type || '').toLowerCase();
      if (t === 'checkbox' || t === 'radio') a.push(el.checked ? 'checked' : 'unchecked');
      else if (isSensitive(el)) a.push(el.value ? 'filled, hidden' : 'empty, private field');
      else if (tag === 'SELECT') {
        const opts = Array.from(el.options).slice(0, 14).map((o) => clean(o.text, 28));
        const cur = el.selectedOptions && el.selectedOptions[0] ? clean(el.selectedOptions[0].text, 40) : '';
        a.push('now: ' + (cur || 'none'), 'options: ' + opts.join(' | ') + (el.options.length > 14 ? ' | ...' : ''));
      } else if (t !== 'file' && t !== 'range') a.push(el.value ? 'value "' + clean(el.value, 80) + '"' : 'empty');
      else if (t === 'range') a.push('value ' + el.value);
    } else if (el.isContentEditable) {
      a.push(clean(el.innerText, 4) ? 'has text' : 'empty');
    }
    const ac = el.getAttribute('aria-checked') || el.getAttribute('aria-pressed') || el.getAttribute('aria-selected');
    if (ac === 'true') a.push(role === 'tab' || el.hasAttribute('aria-selected') ? 'selected' : 'on');
    const ex = el.getAttribute('aria-expanded');
    if (ex) a.push(ex === 'true' ? 'open' : 'closed');
    if (document.activeElement === el) a.push('focused');
    return a;
  }

  /* ---------------- reading the page ---------------- */
  function snapshot(opts) {
    opts = opts || {};
    refs.clear(); nextRef = opts.start || 1;
    const limit = opts.maxChars || 15000;
    const vw = innerWidth, vh = innerHeight;
    const lines = [];                       // {y, text, el, inView, depth}
    let cur = [], curY = null, visited = 0, depth = 0, stopped = false;

    function push(text, y, el, extra) { lines.push(Object.assign({ text, y, el: el || null }, extra || {})); }
    function flush() {
      if (!cur.length) return;
      const t = clean(cur.join(' '), 400);
      if (t) push(t, curY == null ? 0 : curY, null, { depth, text_line: true });
      cur = []; curY = null;
    }
    function addText(str, el) {
      const t = str.replace(/\s+/g, ' ');
      if (!t.trim()) return;
      if (curY == null) { const r = el.getBoundingClientRect(); curY = r.top + scrollY; }
      cur.push(t.trim());
    }
    function visible(el, style) {
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (el.hasAttribute('hidden') && style.display !== 'contents') return false;
      if (el.getAttribute('aria-hidden') === 'true' && !isInteractive(el, style)) return false;
      if (parseFloat(style.opacity) === 0 && !(el.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(el.type))) return false;
      return true;
    }
    function walk(node) {
      if (stopped) return;
      if (node.nodeType === 3) { if (node.parentElement) addText(node.nodeValue, node.parentElement); return; }
      if (node.nodeType !== 1) return;
      const el = node, tag = el.tagName;
      if (SKIP.has(tag) || el.id === '__cga_overlay') return;
      if (++visited > 30000) { stopped = true; return; }
      const style = cs(el);
      if (!visible(el, style)) return;
      if (tag === 'IFRAME' || tag === 'FRAME') {
        flush(); const r = el.getBoundingClientRect();
        if (r.width > 40 && r.height > 40) push('[frame] ' + clean(el.title || (el.src ? new URL(el.src, location.href).host : ''), 60), r.top + scrollY, null, { depth });
        return;
      }
      if (tag === 'CANVAS' || tag === 'VIDEO' || tag === 'AUDIO') {
        flush(); const r = el.getBoundingClientRect();
        if (r.width > 60 && r.height > 40) push('(' + tag.toLowerCase() + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + (tag === 'CANVAS' ? ': drawn content, use the screenshot' : '') + ')', r.top + scrollY, null, { depth });
        return;
      }
      if (tag === 'IMG') {
        const alt = clean(el.getAttribute('alt'), 80), r = el.getBoundingClientRect();
        if (alt && r.width > 40 && r.height > 40) addText('(image: ' + alt + ')', el);
        return;
      }
      if (tag === 'LABEL' && el.control && el.control.isConnected && isInteractive(el.control, cs(el.control))) {
        // the words of a label belong to its box: do not list them twice
        flush();
        if (el.contains(el.control)) walkControls(el);
        return;
      }
      const inter = isInteractive(el, style);
      const pointer = !inter && pointerTop(el, style);
      const scr = !inter && !pointer && scrollable(el, style);
      if (inter || pointer || scr) {
        flush();
        const r = el.getBoundingClientRect();
        if (inter && (r.width === 0 || r.height === 0) && !(tag === 'INPUT' && /^(checkbox|radio|file)$/i.test(el.type))) {
          // zero size and not a hidden checkbox: nothing to click
          if (!el.querySelector('input,button,a,select,textarea')) return;
        }
        const role = scr ? 'scrollable area' : pointer ? 'clickable' : roleOf(el);
        const label = scr ? clean(el.getAttribute('aria-label') || '', 60) : labelOf(el, pointer ? 170 : 90);
        const n = nextRef++;
        refs.set(n, el);
        const a = scr ? ['scrolled ' + Math.round(100 * el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight)) + '%'] : attrsOf(el, role);
        const where = r.bottom < 0 ? 'above' : r.top > vh ? 'below' : '';
        push('[' + n + '] ' + role + (label ? ' "' + label + '"' : '') + (a.length ? ' {' + a.join('; ') + '}' : '') + (where ? ' (' + where + ' the screen)' : ''),
          r.top + scrollY, el, { depth, ref: n, inView: inView(r) });
        const simple = inter && (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON' && !el.querySelector('a,button,input,select,[role=button],[onclick]') || tag === 'A' && !el.querySelector('a,button,input,select,[role=button],[onclick]'));
        if (simple) return;
        depth++;
        if (!inter && !pointer) { descend(el); }
        else descend(el, true);                  // text inside a clickable row is its label; only look for controls inside it
        depth--;
        return;
      }
      const block = BLOCK.has(tag) || /^(block|flex|grid|list-item|table|table-row|flow-root)/.test(style.display);
      if (block) flush();
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (tag === 'DIALOG' || role === 'dialog' || role === 'alertdialog' || el.getAttribute('aria-modal') === 'true') {
        const r = el.getBoundingClientRect();
        if (r.width > 0) push('--- dialog open: ' + clean(el.getAttribute('aria-label') || textOfIds(el.getAttribute('aria-labelledby')) || (el.querySelector('h1,h2,h3') || {}).innerText || '', 80) + ' ---', r.top + scrollY, null, { depth, always: true });
      } else if (tag === 'NAV' || tag === 'MAIN' || tag === 'ASIDE' || role === 'navigation' || role === 'main' || role === 'complementary') {
        const r = el.getBoundingClientRect(); push('-- ' + (role || tag.toLowerCase()) + (el.getAttribute('aria-label') ? ' "' + clean(el.getAttribute('aria-label'), 40) + '"' : '') + ' --', r.top + scrollY, null, { depth });
      }
      if (/^H[1-6]$/.test(tag)) { cur.push('#'.repeat(Math.min(3, +tag[1])) + ' ' + clean(el.innerText, 160)); const r = el.getBoundingClientRect(); curY = r.top + scrollY; flush(); return; }
      if (tag === 'LI' && !cur.length) cur.push('-');
      descend(el);
      if (tag === 'TD' || tag === 'TH') cur.push('|');
      if (block) flush();
    }
    function descend(el, onlyControls) {
      if (onlyControls) {
        const kids = el.shadowRoot ? Array.from(el.shadowRoot.childNodes) : Array.from(el.childNodes);
        for (const k of kids) if (k.nodeType === 1) walkControls(k);
        return;
      }
      if (el.shadowRoot) {
        for (const k of Array.from(el.shadowRoot.childNodes)) {
          if (k.nodeType === 1 && k.tagName === 'SLOT') { for (const s of k.assignedNodes({ flatten: true })) walk(s); } else walk(k);
        }
        return;
      }
      for (const k of Array.from(el.childNodes)) walk(k);
    }
    function walkControls(el) {                 // inside a clickable row: only the buttons, links and fields in it
      if (stopped || SKIP.has(el.tagName)) return;
      const style = cs(el);
      if (!visible(el, style)) return;
      if (isInteractive(el, style)) { walk(el); return; }
      if (el.shadowRoot) { for (const k of Array.from(el.shadowRoot.childNodes)) if (k.nodeType === 1) walkControls(k); }
      for (const k of Array.from(el.children)) walkControls(k);
    }
    walk(document.body || document.documentElement);
    flush();

    // choose what fits: the part of the page you can see first, then what is near it
    const bandTop = scrollY - vh * 0.5, bandBottom = scrollY + vh * 2;
    const inBand = (l) => l.always || (l.y >= bandTop && l.y <= bandBottom) || l.inView;
    const cost = (l) => l.text.length + 4;
    let used = 0;
    for (const l of lines) if (inBand(l)) { l.keep = true; used += cost(l); }
    if (used < limit) {
      const rest = lines.filter((l) => !l.keep).sort((a, b) => Math.abs(a.y - scrollY) - Math.abs(b.y - scrollY));
      for (const l of rest) { if (used + cost(l) > limit) continue; l.keep = true; used += cost(l); }
    }
    // if even the visible band is too long, keep controls before plain text
    if (used > limit * 1.4) {
      used = 0;
      for (const l of lines) { l.keep = false; }
      const pool = lines.filter(inBand).sort((a, b) => (b.ref ? 1 : 0) - (a.ref ? 1 : 0));
      for (const l of pool) { if (used + cost(l) > limit) continue; l.keep = true; used += cost(l); }
    }
    const out = []; let skipped = 0, above = true;
    const mark = () => { if (skipped) { out.push('... ' + skipped + ' more line' + (skipped > 1 ? 's' : '') + (above ? ' above' : ' further down') + ' (scroll or read to see them)'); skipped = 0; } };
    for (const l of lines) {
      if (l.keep) { mark(); above = false; out.push('  '.repeat(Math.min(l.depth || 0, 4)) + l.text); } else skipped++;
    }
    above = false; mark();
    // controls that were dropped lose their number
    const keptRefs = new Set(lines.filter((l) => l.keep && l.ref).map((l) => l.ref));
    for (const n of Array.from(refs.keys())) if (!keptRefs.has(n)) refs.delete(n);
    const se = document.scrollingElement || document.documentElement;
    return {
      url: location.href, title: document.title, text: out.join('\n'), count: refs.size, nextRef,
      viewport: { w: vw, h: vh }, scroll: { y: Math.round(scrollY), max: Math.max(0, se.scrollHeight - vh), height: se.scrollHeight },
      truncated: stopped, frame: window === window.top ? 'top' : 'child', selection: clean(String(getSelection ? getSelection() : ''), 3000)
    };
  }

  /* ---------------- what is about to be touched (so the panel can judge the risk) ---------------- */
  function inspect(ref) {
    const el = refs.get(ref);
    if (!el || !el.isConnected) return { found: false };
    const f = el.closest('form'), tag = el.tagName, type = (el.type || '').toLowerCase();
    const r = el.getBoundingClientRect();
    return {
      found: true, tag, type, role: roleOf(el), label: labelOf(el), text: clean(el.innerText || el.value || '', 200),
      title: clean(el.getAttribute('title') || el.getAttribute('aria-label') || '', 100), href: el.href || '', name: clean(el.getAttribute('name') || el.id, 60),
      sensitive: isSensitive(el), search: (type === 'search' || el.getAttribute('role') === 'searchbox' || SEARCH_NAME.test([el.name, el.id, el.placeholder, el.getAttribute('aria-label')].join(' '))) && !isSensitive(el),
      submit: (tag === 'BUTTON' && (!type || type === 'submit') && !!f) || (tag === 'INPUT' && /^(submit|image)$/.test(type)),
      inForm: !!f, formMethod: f ? (f.method || 'get').toLowerCase() : '', formFields: f ? f.querySelectorAll('input:not([type=hidden]),select,textarea').length : 0,
      disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'), visible: r.width > 0 && r.height > 0, editable: !!(el.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA')
    };
  }

  /* ---------------- the visible "Code GPT is working" cue ---------------- */
  let overlay = null;
  function ensureOverlay() {
    if (overlay && overlay.host.isConnected) return overlay;
    const host = document.createElement('div');
    host.id = '__cga_overlay';
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<style>.frame{position:fixed;inset:0;border:2px solid #34d399;box-shadow:inset 0 0 28px rgba(52,211,153,.28);border-radius:2px;opacity:0;transition:opacity .25s}' +
      '.frame.on{opacity:1}.pill{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);background:#0e0e0f;color:#ededee;font:600 12.5px/1 system-ui,sans-serif;padding:7px 8px 7px 14px;border-radius:999px;border:1px solid #2f2f33;box-shadow:0 6px 24px rgba(0,0,0,.35);display:flex;gap:8px;align-items:center;opacity:0;transition:opacity .2s;pointer-events:none;white-space:nowrap}' +
      '.pill.on{opacity:1;pointer-events:auto}.stopb{all:unset;cursor:pointer;background:#2a2a2e;color:#fff;border-radius:999px;padding:6px 11px;font:600 12px/1 system-ui,sans-serif}.stopb:hover{background:#3a3a40}.stopb:focus-visible{outline:2px solid #34d399}' +
      '.dot{width:8px;height:8px;border-radius:50%;background:#34d399;animation:p 1.2s infinite}@keyframes p{50%{opacity:.35}}' +
      '.cur{position:fixed;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;background:rgba(52,211,153,.35);border:2px solid #34d399;opacity:0;transition:left .28s ease,top .28s ease,opacity .2s,transform .12s}' +
      '.cur.on{opacity:1}.cur.press{transform:scale(.6)}.ring{position:fixed;border:2px solid #34d399;border-radius:6px;background:rgba(52,211,153,.12);opacity:0;transition:opacity .2s}.ring.on{opacity:1}</style>' +
      '<div class="frame"></div><div class="ring"></div><div class="cur"></div><div class="pill"><span class="dot"></span><span class="t">Code GPT is working in this tab</span><button class="stopb" type="button">Stop</button></div>';
    (document.documentElement).appendChild(host);
    const sb = root.querySelector('.stopb');
    if (sb) sb.addEventListener('click', (e) => { e.stopPropagation(); try { chrome.runtime.sendMessage({ type: 'cga-stop' }); } catch (err) {} });
    overlay = { host, root, frame: root.querySelector('.frame'), pill: root.querySelector('.pill'), t: root.querySelector('.t'), cur: root.querySelector('.cur'), ring: root.querySelector('.ring') };
    return overlay;
  }
  function setOverlay(on, text) {
    if (window !== window.top) return true;
    const o = ensureOverlay();
    o.frame.classList.toggle('on', !!on); o.pill.classList.toggle('on', !!on);
    if (text) o.t.textContent = text;
    if (!on) { o.cur.classList.remove('on'); o.ring.classList.remove('on'); setTimeout(() => { if (overlay && !overlay.frame.classList.contains('on')) { overlay.host.remove(); overlay = null; } }, 400); }
    return true;
  }
  async function pointAt(el) {
    if (window !== window.top && !window.frameElement) return;
    try {
      const o = ensureOverlay(), r = el.getBoundingClientRect();
      if (r.width <= 0) return;
      o.cur.style.left = (r.left + Math.min(r.width / 2, 40)) + 'px'; o.cur.style.top = (r.top + r.height / 2) + 'px';
      Object.assign(o.ring.style, { left: r.left - 3 + 'px', top: r.top - 3 + 'px', width: r.width + 6 + 'px', height: r.height + 6 + 'px' });
      o.cur.classList.add('on'); o.ring.classList.add('on');
      await sleep(260);
    } catch (e) {}
  }
  function unpoint() { if (overlay) { overlay.ring.classList.remove('on'); overlay.cur.classList.remove('press'); } }

  /* ---------------- doing things ---------------- */
  function center(el) { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height }; }
  function fire(el, type, init, Ctor) {
    const C = Ctor || MouseEvent;
    el.dispatchEvent(new C(type, Object.assign({ bubbles: true, cancelable: true, composed: true, view: window }, init || {})));
  }
  function mouseInit(el, extra) { const c = center(el); return Object.assign({ clientX: c.x, clientY: c.y, screenX: c.x, screenY: c.y, button: 0, buttons: 0 }, extra || {}); }
  function visibleCover(el) {
    const c = center(el);
    if (c.x < 0 || c.y < 0 || c.x > innerWidth || c.y > innerHeight) return null;
    let top = (document.elementsFromPoint(c.x, c.y) || []).find((n) => n.id !== '__cga_overlay') || null;
    while (top && top.shadowRoot && top.shadowRoot.elementFromPoint) { const inner = top.shadowRoot.elementFromPoint(c.x, c.y); if (!inner || inner === top) break; top = inner; }
    if (!top || top === el || el.contains(top) || top.contains(el)) return null;
    if (top.closest && el.closest && (top.closest('label') && top.closest('label') === el.closest('label'))) return null;
    return top;
  }
  function describeEl(e) { return e ? (labelOf(e) || e.tagName.toLowerCase()) : ''; }
  async function prepare(el) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await sleep(60);
  }
  async function click(el, opts) {
    opts = opts || {};
    await prepare(el);
    const cover = visibleCover(el);
    if (cover && !opts.force) return { ok: false, error: 'Another item is covering it: ' + describeEl(cover) + '. Close or use that first (a pop-up, banner or menu may be open).', covered: describeEl(cover) };
    await pointAt(el);
    const init = mouseInit(el);
    try { el.focus({ preventScroll: true }); } catch (e) {}
    const P = window.PointerEvent || MouseEvent;
    fire(el, 'pointerover', init, P); fire(el, 'mouseover', init); fire(el, 'pointermove', init, P); fire(el, 'mousemove', init);
    if (overlay) overlay.cur.classList.add('press');
    fire(el, 'pointerdown', Object.assign({}, init, { buttons: 1, isPrimary: true }), P); fire(el, 'mousedown', Object.assign({}, init, { buttons: 1 }));
    await sleep(40);
    fire(el, 'pointerup', Object.assign({}, init, { isPrimary: true }), P); fire(el, 'mouseup', init);
    if (opts.dbl) { el.click(); el.click(); fire(el, 'dblclick', init); } else if (typeof el.click === 'function') el.click(); else fire(el, 'click', init);
    unpoint();
    return { ok: true };
  }
  function selectAllIn(el) {
    if (el.select) { el.select(); return; }
    const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  function nativeSet(el, v) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, v); else el.value = v;
  }
  async function typeInto(el, text, clear) {
    if (isSensitive(el)) return { ok: false, error: 'This is a private field (password, card or code). Code GPT never types into those: please type it yourself.', sensitive: true };
    if (el.disabled || el.readOnly) return { ok: false, error: 'That field is disabled or read-only.' };
    await prepare(el);
    await pointAt(el);
    el.focus({ preventScroll: true });
    const editable = el.isContentEditable && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA';
    const before = editable ? el.innerText : el.value;
    if (clear) { selectAllIn(el); if (editable) document.execCommand('delete'); else if (!document.execCommand('delete')) { nativeSet(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); } }
    else if (!editable && el.setSelectionRange) { try { const n = el.value.length; el.setSelectionRange(n, n); } catch (e) {} }
    else if (editable) { const s = getSelection(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); s.removeAllRanges(); s.addRange(r); }
    const parts = String(text).split('\n');
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) ok = (editable ? document.execCommand('insertParagraph') : document.execCommand('insertText', false, '\n')) && ok;
      if (parts[i]) ok = document.execCommand('insertText', false, parts[i]) && ok;
    }
    let now = editable ? el.innerText : el.value;
    if (!editable && now === before && String(text)) {          // the page blocked the normal way: set the value and tell the page
      nativeSet(el, (clear ? '' : el.value) + text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      now = el.value;
    }
    if (!editable) el.dispatchEvent(new Event('change', { bubbles: true }));
    unpoint();
    const wanted = String(text).replace(/\s+/g, ' ').trim().slice(0, 12);
    if (wanted && !clean(now, 100000).includes(wanted)) return { ok: false, error: 'The page did not accept the text (the box still shows: "' + clean(now, 60) + '").' };
    return { ok: true, info: 'typed ' + String(text).length + ' characters' };
  }
  function pickOption(el, want) {
    const w = String(want).trim().toLowerCase();
    const opts = Array.from(el.options);
    return opts.find((o) => o.value.toLowerCase() === w) || opts.find((o) => clean(o.text, 200).toLowerCase() === w) || opts.find((o) => clean(o.text, 200).toLowerCase().includes(w));
  }
  const KEYS = { Enter: [13, 'Enter'], Escape: [27, 'Escape'], Tab: [9, 'Tab'], Backspace: [8, 'Backspace'], Delete: [46, 'Delete'], ArrowDown: [40, 'ArrowDown'], ArrowUp: [38, 'ArrowUp'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'], Home: [36, 'Home'], End: [35, 'End'], PageDown: [34, 'PageDown'], PageUp: [33, 'PageUp'], ' ': [32, 'Space'], Space: [32, 'Space'] };
  async function press(spec) {
    const bits = String(spec).split('+').map((s) => s.trim());
    let key = bits.pop(); const mods = bits.map((m) => m.toLowerCase());
    if (/^(esc)$/i.test(key)) key = 'Escape';
    if (/^(return)$/i.test(key)) key = 'Enter';
    if (/^(del)$/i.test(key)) key = 'Delete';
    const known = KEYS[key] || KEYS[key[0].toUpperCase() + key.slice(1)];
    const init = { key: known ? (key === 'Space' ? ' ' : key) : key, code: known ? known[1] : (key.length === 1 ? (/[a-z]/i.test(key) ? 'Key' + key.toUpperCase() : /\d/.test(key) ? 'Digit' + key : '') : key), keyCode: known ? known[0] : key.toUpperCase().charCodeAt(0),
      ctrlKey: mods.includes('control') || mods.includes('ctrl'), shiftKey: mods.includes('shift'), altKey: mods.includes('alt'), metaKey: mods.includes('meta') || mods.includes('command') || mods.includes('cmd') };
    init.which = init.keyCode;
    let el = document.activeElement || document.body;
    if (el.tagName === 'IFRAME') { try { el = el.contentDocument.activeElement || el; } catch (e) {} }
    const down = new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true, composed: true }, init));
    const notCancelled = el.dispatchEvent(down);
    el.dispatchEvent(new KeyboardEvent('keypress', Object.assign({ bubbles: true, cancelable: true, composed: true }, init)));
    // keys the page itself would normally handle when a real key is pressed
    if (notCancelled) {
      const k = init.key, field = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
      if (k === 'Enter' && !init.shiftKey) {
        if (el.tagName === 'INPUT' && el.form) { try { el.form.requestSubmit(); } catch (e) { el.form.submit(); } }
        else if (el.tagName === 'TEXTAREA' || el.isContentEditable) document.execCommand('insertParagraph');
        else if (el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') el.click();
      } else if (k === 'Tab') {
        const list = Array.from(document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')).filter((x) => !x.disabled && x.tabIndex >= 0 && x.getBoundingClientRect().width > 0);
        const i = list.indexOf(el); const nxt = list[(i + (init.shiftKey ? -1 : 1) + list.length) % list.length]; if (nxt) nxt.focus();
      } else if (init.ctrlKey && k.toLowerCase() === 'a' && field) selectAllIn(el);
      else if (k === 'Backspace' && field) document.execCommand('delete');
      else if (k === 'Delete' && field) document.execCommand('forwardDelete');
      else if (k === ' ' && (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || (el.tagName === 'INPUT' && /checkbox|radio|button/.test(el.type)))) el.click();
      else if (/^Page(Down|Up)$|^(Home|End)$/.test(k) && !field) pageScroll(k);
      else if (k.length === 1 && field && !init.ctrlKey && !init.metaKey) document.execCommand('insertText', false, k);
    }
    el.dispatchEvent(new KeyboardEvent('keyup', Object.assign({ bubbles: true, cancelable: true, composed: true }, init)));
    return { ok: true, info: 'pressed ' + spec };
  }
  function bestScroller() {
    let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    while (el && el !== document.body && el !== document.documentElement) { if (scrollable(el, cs(el))) return el; el = el.parentElement; }
    let best = null, area = 0;
    for (const c of document.querySelectorAll('main, [role=main], div, section, ul')) {
      if (c.clientHeight < 200 || c.clientWidth < 250 || c.scrollHeight <= c.clientHeight + 60) continue;
      const st = cs(c); if (st.overflowY !== 'auto' && st.overflowY !== 'scroll') continue;
      const a = c.clientHeight * c.clientWidth; if (a > area && a > innerWidth * innerHeight * 0.25) { best = c; area = a; }
    }
    return best || document.scrollingElement || document.documentElement;
  }
  function pageScroll(k) {
    const sc = bestScroller(); const page = sc === (document.scrollingElement || document.documentElement);
    const h = page ? innerHeight : sc.clientHeight;
    const to = k === 'PageDown' ? sc.scrollTop + h * 0.85 : k === 'PageUp' ? sc.scrollTop - h * 0.85 : k === 'Home' ? 0 : sc.scrollHeight;
    sc.scrollTo({ top: to, behavior: 'instant' });
  }
  async function scroll(dir, el) {
    if (el) {
      if (scrollable(el, cs(el)) || el.scrollHeight > el.clientHeight + 20) {
        const before = el.scrollTop;
        const to = dir === 'top' ? 0 : dir === 'bottom' ? el.scrollHeight : el.scrollTop + (dir === 'up' ? -1 : 1) * el.clientHeight * 0.85;
        el.scrollTo({ top: to, behavior: 'instant' });
        await sleep(120);
        return { ok: true, info: Math.abs(el.scrollTop - before) < 2 ? 'already at the ' + (dir === 'up' || dir === 'top' ? 'top' : 'end') + ' of that area' : 'scrolled that area ' + dir };
      }
      el.scrollIntoView({ block: 'center', behavior: 'instant' }); await sleep(100);
      return { ok: true, info: 'scrolled it into view' };
    }
    const sc = bestScroller(), page = sc === (document.scrollingElement || document.documentElement);
    const before = sc.scrollTop, h = page ? innerHeight : sc.clientHeight;
    const to = dir === 'top' ? 0 : dir === 'bottom' ? sc.scrollHeight : sc.scrollTop + (dir === 'up' ? -1 : 1) * h * 0.85;
    sc.scrollTo({ top: to, behavior: 'instant' });
    await sleep(150);
    const moved = Math.abs(sc.scrollTop - before);
    const max = sc.scrollHeight - h;
    return { ok: true, moved, info: moved < 2 ? 'cannot scroll ' + (dir === 'up' || dir === 'top' ? 'higher: this is the top' : 'further: this is the end') : 'scrolled ' + dir + ' (now at ' + Math.round(100 * sc.scrollTop / Math.max(1, max)) + '% of the page)' };
  }
  function readText(el, offset, max) {
    max = max || 40000; offset = offset || 0;
    const root = el || document.body;
    let t = (root.innerText || root.textContent || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const total = t.length;
    t = t.slice(offset, offset + max);
    return { ok: true, text: t, total, more: offset + max < total };
  }
  function settle(maxMs, quietMs) {
    maxMs = maxMs || 3000; quietMs = quietMs || 280;
    return new Promise((resolve) => {
      let timer = null, done = false;
      const finish = () => { if (done) return; done = true; mo.disconnect(); clearTimeout(timer); clearTimeout(cap); resolve(true); };
      const mo = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(finish, quietMs); });
      mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      timer = setTimeout(finish, quietMs);
      const cap = setTimeout(finish, maxMs);
    });
  }

  async function act(op) {
    try {
      const el = op.ref != null ? refs.get(op.ref) : null;
      if (op.ref != null && (!el || !el.isConnected)) return { ok: false, error: 'Item [' + op.ref + '] is not on the page any more. Look at the new page and choose again.', stale: true };
      switch (op.type) {
        case 'click': { if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { ok: false, error: 'That item is disabled.' }; const r = await click(el, { force: op.force, dbl: op.dbl }); if (r.ok) r.info = 'clicked "' + labelOf(el) + '"'; return r; }
        case 'hover': { await prepare(el); await pointAt(el); const init = mouseInit(el); fire(el, 'mouseover', init); fire(el, 'mouseenter', init); fire(el, 'mousemove', init); await sleep(200); unpoint(); return { ok: true, info: 'hovered "' + labelOf(el) + '"' }; }
        case 'type': return typeInto(el, op.text || '', !!op.clear);
        case 'select': {
          if (el.tagName !== 'SELECT') return { ok: false, error: 'That is not a drop-down list. Click it and then click the option.' };
          if (isSensitive(el)) return { ok: false, error: 'Private field.', sensitive: true };
          const o = pickOption(el, op.value);
          if (!o) return { ok: false, error: 'No option like "' + op.value + '". Options: ' + Array.from(el.options).slice(0, 20).map((x) => clean(x.text, 30)).join(' | ') };
          await prepare(el); await pointAt(el); el.focus();
          nativeSet(el, o.value); o.selected = true;
          el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); unpoint();
          return { ok: true, info: 'chose "' + clean(o.text, 40) + '"' };
        }
        case 'check': {
          const want = op.checked !== false;
          const state = el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.getAttribute('aria-checked') === 'true';
          if (state === want) return { ok: true, info: 'already ' + (want ? 'on' : 'off') };
          const r = await click(el, {}); if (!r.ok) return r;
          const now = el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.getAttribute('aria-checked') === 'true';
          return now === want ? { ok: true, info: (want ? 'ticked' : 'unticked') + ' "' + labelOf(el) + '"' } : { ok: false, error: 'The box did not change.' };
        }
        case 'press': return press(op.key);
        case 'scroll': return scroll(op.direction || 'down', el);
        case 'read': return readText(el, op.offset || 0);
        case 'focus': el.focus(); return { ok: true };
        default: return { ok: false, error: 'Unknown action ' + op.type };
      }
    } catch (e) { return { ok: false, error: 'The page raised an error: ' + clean(e && e.message, 160) }; }
  }

  window.__cga = { v: 2, snapshot, inspect, act, settle, setOverlay, selection: () => clean(String(getSelection ? getSelection() : ''), 4000), isSensitive };
})();
