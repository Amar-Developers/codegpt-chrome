// Code GPT for Chrome - the side panel.
(function () {
  'use strict';
  const DEFAULT_BASE = 'https://chat.codegpt.it.com';
  const $ = (id) => document.getElementById(id);
  const PERMS = [
    ['ask', 'shield-check', 'Ask before acting', 'Shows its plan and waits for your OK. Asks again before anything risky. (Recommended)', 'Ask first'],
    ['allowed', 'zap', 'Act on trusted sites', 'Starts right away on sites you trust. Still asks before sending, buying, deleting or posting.', 'Trusted sites'],
    ['read', 'eye', 'Read only', 'Can look at pages, scroll and collect information. Cannot click or type.', 'Read only']
  ];
  const DEFAULT_SHORTCUTS = [
    { n: 'Reply to this email', m: 'agent', t: 'Open the email I am looking at, read the whole conversation and write a clear, polite reply. Leave it as a draft in the reply box. Do not send it.' },
    { n: 'Clean up my inbox', m: 'agent', t: 'Look at my inbox. Archive newsletters and promotions, keep everything from real people, then tell me which emails need a reply. Ask me before deleting anything.' },
    { n: 'Extract a table', m: 'agent', t: 'Find the main table or list on this page and extract it into a table I can copy or download.' },
    { n: 'Fill in this form', m: 'agent', t: 'Fill in this form with these details (ask me for anything missing, and do not submit it): ' },
    { n: 'Summarise this page', m: 'chat', t: 'Summarise this page in clear, short bullet points. Start with one sentence saying what it is about.' }
  ];
  const S = { token: '', base: DEFAULT_BASE, me: null, chatId: null, chatUrl: '', web: false, page: false, shot: false, busy: false, ctrl: null, run: null,
    mode: 'agent', perm: 'ask', allowed: [], shots: 'auto', theme: 'auto', model: '', shortcuts: DEFAULT_SHORTCUTS, lastRun: null, steps: null, menu: null };

  /* ---------- small helpers ---------- */
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function toast(text, bad) {
    const t = $('toast'); t.textContent = text; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3400);
  }
  function show(view) { ['connect', 'chat', 'settings'].forEach((v) => { $('view-' + v).hidden = v !== view; }); $('btn-settings').hidden = view === 'connect'; if (view === 'settings') paintSettings(); }
  function md(text) {
    try {
      let t = String(text || ''); if (((t.match(/^```/gm) || []).length) % 2) t += '\n```';
      return DOMPurify.sanitize(marked.parse(t, { gfm: true, breaks: true }));
    } catch (e) { const d = el('div'); d.textContent = text; return d.innerHTML; }
  }
  function links(root) { root.querySelectorAll('a[href]').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; }); }
  function copy(text) { navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Could not copy', true)); }
  function scrollEnd() { const t = $('thread'); t.scrollTop = t.scrollHeight; }
  const store = (o) => chrome.storage.local.set(o);

  async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({ Authorization: 'Bearer ' + S.token }, opts.json ? { 'Content-Type': 'application/json' } : {});
    const res = await fetch(S.base + path, { method: opts.method || 'GET', headers, body: opts.json ? JSON.stringify(opts.json) : undefined, signal: opts.signal });
    if (res.status === 401) { await chrome.storage.local.remove('token'); throw new Error('Please connect your Code GPT account again.'); }
    if (!res.ok && !opts.stream) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || j.detail || 'Something went wrong. Please try again.');
    }
    return res;
  }
  async function agentApi(path, body, signal) {
    const res = await fetch(S.base + path, { method: 'POST', signal, headers: { Authorization: 'Bearer ' + S.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (res.status === 401) { await chrome.storage.local.remove('token'); throw new Error('Please connect your Code GPT account again.'); }
    if (!res.ok) {
      if (j.steps) setMeter(j.steps);
      const e = new Error(j.error || 'Something went wrong. Please try again.'); e.limit = !!j.limit; e.status = res.status; throw e;
    }
    return j;
  }

  /* ---------- start ---------- */
  async function init() {
    const st = await chrome.storage.local.get(['token', 'base', 'web', 'mode', 'perm', 'allowed', 'shots', 'theme', 'model', 'shortcuts']);
    S.token = st.token || ''; S.base = (st.base || DEFAULT_BASE).replace(/\/+$/, ''); S.web = !!st.web;
    S.mode = st.mode === 'chat' ? 'chat' : 'agent'; S.perm = ['ask', 'allowed', 'read'].includes(st.perm) ? st.perm : 'ask';
    S.allowed = Array.isArray(st.allowed) ? st.allowed : []; S.shots = ['auto', 'always', 'never'].includes(st.shots) ? st.shots : 'auto';
    S.theme = ['auto', 'light', 'dark'].includes(st.theme) ? st.theme : 'auto'; S.model = st.model || '';
    S.shortcuts = Array.isArray(st.shortcuts) && st.shortcuts.length ? st.shortcuts : DEFAULT_SHORTCUTS;
    applyTheme();
    $('link-signup').href = S.base.replace('//chat.', '//auth.') + '/signup';
    $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
    if (!S.token) { show('connect'); return; }
    try {
      S.me = await (await api('/api/ext/me')).json();
      $('hello').textContent = S.me.first_name ? 'Hello, ' + S.me.first_name : 'Hello';
      if (!S.model || !(S.me.models || []).some((m) => m.id === S.model && !m.locked)) S.model = '';
      setMeter(S.me.steps); paintAll(); show('chat');
      checkPending();
    } catch (e) {
      if (!S.token || /connect/i.test(e.message)) { show('connect'); } else { show('chat'); paintAll(); toast(e.message, true); }
    }
  }
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.token) init();
    if (area === 'session' && ch.pending && ch.pending.newValue) checkPending();
  });
  chrome.runtime.onMessage.addListener((m) => { if (m && m.type === 'cga-stop' && S.run) S.run.stop(); });

  function applyTheme() { if (S.theme === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = S.theme; }

  $('btn-connect').onclick = () => chrome.tabs.create({ url: S.base + '/connect?client=chrome' });
  $('btn-settings').innerHTML = ICON('settings'); $('btn-new').innerHTML = ICON('plus'); $('btn-web').innerHTML = ICON('external-link');
  ['f1', 'f2', 'f3'].forEach((id, i) => { const li = $(id); li.insertAdjacentHTML('afterbegin', ICON(['mouse-pointer-click', 'shield-check', 'user'][i], 18)); });
  $('btn-settings').onclick = () => show($('view-settings').hidden ? 'settings' : 'chat');
  $('btn-back').onclick = () => show('chat');
  $('btn-new').onclick = newChat;
  $('btn-logout').onclick = async () => { if (S.run) S.run.stop(); await chrome.storage.local.remove('token'); S.me = null; newChat(true); show('connect'); };
  $('btn-key').onclick = async () => {
    const key = $('key-in').value.trim(), base = ($('base-in').value.trim() || DEFAULT_BASE).replace(/\/+$/, '');
    if (!/^cgx_[\w-]{20,}$/.test(key)) { toast('That does not look like a Code GPT key.', true); return; }
    if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) { toast('The server address must start with https://', true); return; }
    if (base !== DEFAULT_BASE) {
      const ok = await chrome.permissions.request({ origins: [base + '/*'] }).catch(() => false);
      if (!ok) { toast('Chrome did not allow that address.', true); return; }
    }
    await store({ token: key, base }); $('key-in').value = ''; toast('Connected');
  };

  /* ---------- the box under the chat ---------- */
  const ta = $('prompt');
  function autosize() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'; }
  function prefill(t) { ta.value = t; ta.focus(); ta.setSelectionRange(t.length, t.length); autosize(); }
  $('m-chat').innerHTML = ICON('message-square', 14) + 'Chat'; $('m-agent').innerHTML = ICON('mouse-pointer-click', 14) + 'Agent';
  $('send').innerHTML = ICON('arrow-up'); $('stop').innerHTML = ICON('square', 14);
  $('mode-seg').addEventListener('click', (e) => { const b = e.target.closest('button[data-m]'); if (!b) return; S.mode = b.dataset.m; store({ mode: S.mode }); paintAll(); });
  function paintAll() {
    const agent = S.mode === 'agent';
    $('m-chat').classList.toggle('on', !agent); $('m-agent').classList.toggle('on', agent);
    $('t-perm').hidden = !agent; ['t-page', 't-shot', 't-web'].forEach((id) => { $(id).hidden = agent; });
    const p = PERMS.find((x) => x[0] === S.perm) || PERMS[0];
    $('t-perm').innerHTML = ICON(p[1], 14) + '<span>' + p[4] + '</span>'; $('t-perm').classList.toggle('on', S.perm === 'ask' ? false : true);
    $('t-page').innerHTML = ICON('file-text', 14) + '<span>Page</span>'; $('t-shot').innerHTML = ICON('camera', 14) + '<span>Screen</span>'; $('t-web').innerHTML = ICON('globe', 14) + '<span>Web</span>';
    ['t-page', 't-shot', 't-web'].forEach((id) => { const k = { 't-page': 'page', 't-shot': 'shot', 't-web': 'web' }[id]; $(id).classList.toggle('on', !!S[k]); $(id).setAttribute('aria-pressed', String(!!S[k])); });
    const cur = currentModel();
    $('t-model').innerHTML = ICON('sparkles', 13) + '<span>' + (cur ? cur.label : 'Model') + '</span>' + ICON('chevron-down', 12);
    ta.placeholder = S.run ? 'Add an instruction for the agent…' : agent ? 'Tell Code GPT what to do in your browser…' : 'Ask Code GPT about this page…';
    $('plan-tag').hidden = !S.me; if (S.me) { $('plan-tag').textContent = S.me.plan === 'free' ? 'Free' : S.me.plan === 'pro' ? 'Pro' : 'Business'; }
    paintCards();
  }
  function currentModel() { const ms = (S.me && S.me.models) || []; return ms.find((m) => m.id === (S.model || (S.me && S.me.model))) || ms.find((m) => m.default) || ms[0] || null; }
  $('t-page').onclick = () => { S.page = !S.page; paintAll(); };
  $('t-shot').onclick = () => { S.shot = !S.shot; paintAll(); };
  $('t-web').onclick = () => { S.web = !S.web; store({ web: S.web }); paintAll(); };
  ta.addEventListener('input', () => { autosize(); slashCheck(); });
  ta.addEventListener('keydown', (e) => {
    if (S.menu && S.menu.kind === 'slash') {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveSel(e.key === 'ArrowDown' ? 1 : -1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); const s = $('menu-host').querySelector('.mi.sel') || $('menu-host').querySelector('.mi'); if (s) s.click(); return; }
      if (e.key === 'Escape') { closeMenu(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); }
    if (e.key === 'Escape' && S.run) S.run.stop();
  });
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault(); const t = ta.value.trim(); if (!t) return;
    if (S.run) { S.run.note(t); userBubble(t, 'Sent to the agent while it works'); ta.value = ''; autosize(); return; }
    if (S.busy) return;
    ta.value = ''; autosize(); closeMenu();
    if (S.mode === 'agent') startAgent(t); else send(t, {});
  });
  $('stop').onclick = () => { if (S.ctrl) S.ctrl.abort(); };
  $('runstop').onclick = () => { if (S.run) S.run.stop(); };

  /* menus above the box */
  function closeMenu() { $('menu-host').innerHTML = ''; S.menu = null; }
  function moveSel(d) {
    const items = Array.from($('menu-host').querySelectorAll('.mi')); if (!items.length) return;
    let i = items.findIndex((x) => x.classList.contains('sel')); items.forEach((x) => x.classList.remove('sel'));
    i = (i + d + items.length) % items.length; items[i].classList.add('sel'); items[i].scrollIntoView({ block: 'nearest' });
  }
  function openMenu(kind, build) {
    if (S.menu && S.menu.kind === kind) { closeMenu(); return; }
    closeMenu(); const m = el('div', 'menu'); build(m); $('menu-host').appendChild(m); S.menu = { kind };
  }
  document.addEventListener('mousedown', (e) => { if (S.menu && S.menu.kind !== 'slash' && !e.target.closest('.menu') && !e.target.closest('.pillb')) closeMenu(); });
  $('t-model').onclick = () => openMenu('model', (m) => {
    const cur = currentModel();
    (S.me && S.me.models || []).forEach((mod) => {
      const b = el('button', 'mi' + (mod.locked ? ' lock' : '') + (cur && cur.id === mod.id ? ' sel' : '')); b.type = 'button';
      const t = el('span', 'mt'); t.appendChild(el('b', '', mod.label)); t.appendChild(el('span', '', [mod.maker, mod.note].filter(Boolean).join(' · ') || mod.level)); b.appendChild(t);
      if (mod.badge) b.appendChild(el('span', 'tag', mod.badge));
      if (mod.locked) b.insertAdjacentHTML('beforeend', ICON('lock', 14));
      else if (cur && cur.id === mod.id) b.insertAdjacentHTML('beforeend', ICON('check', 15));
      b.onclick = () => { if (mod.locked) { toast('This model is part of Code GPT Pro.'); chrome.tabs.create({ url: S.base + '/upgrade' }); closeMenu(); return; } S.model = mod.id; store({ model: S.model }); closeMenu(); paintAll(); };
      m.appendChild(b);
    });
  });
  $('t-perm').onclick = () => openMenu('perm', (m) => {
    m.appendChild(el('div', 'mh', 'What may Code GPT do on its own?'));
    PERMS.forEach(([id, icon, name, desc]) => {
      const b = el('button', 'mi' + (S.perm === id ? ' sel' : '')); b.type = 'button'; b.insertAdjacentHTML('afterbegin', ICON(icon, 17));
      const t = el('span', 'mt'); t.appendChild(el('b', '', name)); t.appendChild(el('span', '', desc)); b.appendChild(t);
      if (S.perm === id) b.insertAdjacentHTML('beforeend', ICON('check', 15));
      b.onclick = () => { S.perm = id; store({ perm: id }); closeMenu(); paintAll(); }; m.appendChild(b);
    });
  });
  function slashCheck() {
    const v = ta.value;
    if (!/^\/[^\n]*$/.test(v)) { if (S.menu && S.menu.kind === 'slash') closeMenu(); return; }
    const q = v.slice(1).toLowerCase();
    const hits = S.shortcuts.filter((s) => s.n.toLowerCase().includes(q));
    closeMenu();
    if (!hits.length) return;
    const m = el('div', 'menu'); m.appendChild(el('div', 'mh', 'Shortcuts'));
    hits.forEach((s, i) => {
      const b = el('button', 'mi' + (i === 0 ? ' sel' : '')); b.type = 'button'; b.insertAdjacentHTML('afterbegin', ICON(s.m === 'chat' ? 'message-square' : 'mouse-pointer-click', 16));
      const t = el('span', 'mt'); t.appendChild(el('b', '', s.n)); t.appendChild(el('span', '', s.t)); b.appendChild(t);
      b.onclick = () => { S.mode = s.m === 'chat' ? 'chat' : 'agent'; store({ mode: S.mode }); closeMenu(); paintAll(); prefill(s.t); };
      m.appendChild(b);
    });
    $('menu-host').appendChild(m); S.menu = { kind: 'slash' };
  }

  /* ---------- the first screen ---------- */
  const CARDS = [
    ['reply', 'Reply to this email', 'Reads the thread and drafts the answer', () => runShortcut(0)],
    ['archive', 'Clean up my inbox', 'Archives newsletters, shows what needs you', () => runShortcut(1)],
    ['text-cursor-input', 'Fill in a form', 'You give the details, it fills the fields', () => { S.mode = 'agent'; paintAll(); prefill('Fill in this form with these details (ask me for anything missing, and do not submit it): '); }],
    ['table', 'Collect data in a table', 'Lists, prices and results as CSV', () => runShortcut(2)],
    ['layers', 'Work across tabs', 'Compare pages that are open in other tabs', () => { S.mode = 'agent'; paintAll(); prefill('Look at my open tabs and compare '); }],
    ['search', 'Research something', 'Searches and reads sites, then briefs you', () => { S.mode = 'agent'; paintAll(); prefill('Search the web and give me a short, sourced summary of '); }]
  ];
  function runShortcut(i) { const s = DEFAULT_SHORTCUTS[i]; S.mode = 'agent'; paintAll(); ta.value = ''; startAgent(s.t); }
  const QUICK = [
    ['file-text', 'Summarise this page', () => { S.mode = 'chat'; paintAll(); send('Summarise this page in clear, short bullet points. Start with one sentence saying what it is about.', { page: true }); }],
    ['bulb', 'Explain selected text', async () => {
      const ctx = await pageContext(false);
      if (!ctx || !ctx.selection) { toast('Select some text on the page first.', true); return; }
      S.mode = 'chat'; paintAll(); send('Explain this in simple words.', { selection: ctx.selection });
    }],
    ['table', 'Spreadsheet formula', () => { S.mode = 'chat'; paintAll(); prefill('Give me an Excel and Google Sheets formula that '); }],
    ['eye', 'Ask about my screen', () => { S.mode = 'chat'; S.shot = true; paintAll(); prefill('Look at my screen and '); }],
    ['mail', 'Draft an email', () => { S.mode = 'chat'; paintAll(); prefill('Write a short, professional email to '); }]
  ];
  function paintCards() {
    const c = $('cards'); if (c.dataset.done) return; c.dataset.done = '1';
    CARDS.forEach(([icon, title, desc, fn]) => { const b = el('button', 'tcard'); b.type = 'button'; b.innerHTML = ICON(icon, 18); b.appendChild(el('b', '', title)); b.appendChild(el('span', '', desc)); b.onclick = fn; c.appendChild(b); });
    QUICK.forEach(([icon, label, fn]) => { const b = el('button', 'chip'); b.type = 'button'; b.innerHTML = ICON(icon === 'bulb' ? 'sparkles' : icon, 14) + '<span>' + label + '</span>'; b.onclick = fn; $('quick').appendChild(b); });
  }

  /* ---------- reading the page for Chat mode (only when asked) ---------- */
  async function activeTab() {
    const [cur] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (cur && !(cur.url || '').startsWith('chrome-extension://' + chrome.runtime.id)) return cur;
    const all = (await chrome.tabs.query({ active: true })).filter((t) => /^https?:/.test(t.url || '')).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return all[0] || cur;
  }
  function readable(tab) { return tab && CGAgent.readable(tab.url); }
  async function ensureAccess(tab) {
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => 1 }); return true; } catch (e) {}
    const origin = new URL(tab.url).origin + '/*';
    return chrome.permissions.request({ origins: [origin] }).catch(() => false);
  }
  async function pageContext(withText) {
    const tab = await activeTab();
    if (!readable(tab)) { toast('Chrome does not let extensions read this page.', true); return null; }
    if (!(await ensureAccess(tab))) { toast('Allow Code GPT to read this site to use the page.', true); return null; }
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [withText], func: (withText) => {
      const sel = String(window.getSelection ? window.getSelection() : '').trim();
      let text = '';
      if (withText) {
        const main = document.querySelector('main, article, [role=main]');
        text = ((main && main.innerText.length > 400 ? main.innerText : document.body.innerText) || '').replace(/\n{3,}/g, '\n\n');
      }
      return { title: document.title, url: location.href, selection: sel.slice(0, 40000), text: text.slice(0, 110000) };
    } });
    return r && r.result;
  }
  async function screenshot() {
    const tab = await activeTab();
    if (!readable(tab)) { toast('Chrome does not allow a picture of this page.', true); return null; }
    try { return await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 72 }); }
    catch (e) { toast('Chrome allows a picture of a page only after you click the Code GPT icon on it, or if you choose “Allow all websites” in Settings.', true); return null; }
  }
  async function insertIntoPage(text) {
    const tab = await activeTab();
    if (readable(tab) && await ensureAccess(tab)) {
      try {
        const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [text], func: (t) => {
          const e = document.activeElement;
          if (!e || e === document.body) return false;
          if (e.isContentEditable) { e.focus(); return document.execCommand('insertText', false, t); }
          if ('value' in e && !e.readOnly) {
            e.focus(); const a = e.selectionStart ?? e.value.length, b = e.selectionEnd ?? e.value.length;
            e.setRangeText(t, a, b, 'end'); e.dispatchEvent(new Event('input', { bubbles: true })); return true;
          }
          return false;
        } });
        if (r && r.result) { toast('Inserted into the page'); return; }
      } catch (e) {}
    }
    await navigator.clipboard.writeText(text).catch(() => {});
    toast('Copied. Click where you want it on the page and press Ctrl+V.');
  }

  /* ---------- right-click menu ---------- */
  const MENU = {
    explain: 'Explain this in simple words.', summarize: 'Summarise this in short bullet points.',
    translate: 'Translate this to English. Give only the translation.', improve: 'Improve this writing: fix grammar and make it clear and natural. Give only the improved text.',
    reply: 'Write a clear, polite reply to this message. Give only the reply text.', page: 'Summarise this page in clear, short bullet points.'
  };
  async function checkPending() {
    if (!S.me || S.busy || S.run) return;
    const { pending } = await chrome.storage.session.get('pending');
    if (!pending || Date.now() - pending.at > 120000) return;
    await chrome.storage.session.remove('pending');
    S.mode = 'chat'; paintAll();
    if (pending.action === 'ask') {
      if (pending.selection) S.pendingSel = pending.selection; else { S.page = true; paintAll(); }
      paintCtx(); prefill(''); return;
    }
    if (pending.action === 'page') send(MENU.page, { page: true });
    else send(MENU[pending.action] || MENU.explain, { selection: pending.selection, title: pending.title, url: pending.url });
  }
  function paintCtx() {
    const box = $('ctx-chips'); box.innerHTML = '';
    if (S.pendingSel) {
      const c = el('span', 'ctx'); c.innerHTML = ICON('pencil', 13);
      c.appendChild(el('span', '', '“' + S.pendingSel.slice(0, 60) + (S.pendingSel.length > 60 ? '…' : '') + '”'));
      const x = el('button', 'x'); x.type = 'button'; x.innerHTML = ICON('x', 12); x.onclick = () => { S.pendingSel = ''; paintCtx(); };
      c.appendChild(x); box.appendChild(c);
    }
  }

  /* ---------- messages ---------- */
  function newChat(silent) {
    if (S.busy || S.run) { if (!silent) toast('Wait until the answer is finished, or press Stop.'); return; }
    S.chatId = null; S.chatUrl = ''; S.lastRun = null;
    $('thread').querySelectorAll('.msg').forEach((m) => m.remove());
    $('welcome').hidden = false; $('btn-new').hidden = true; $('btn-web').hidden = true;
  }
  function setBusy(b) { S.busy = b; $('send').hidden = b; $('stop').hidden = !b; }
  function userBubble(text, note) {
    $('welcome').hidden = true;
    const u = el('div', 'msg user'); u.appendChild(el('div', 'bubble', text));
    if (note) u.appendChild(el('div', 'with small muted', note));
    $('thread').appendChild(u); scrollEnd();
  }
  function chatLinked(id, url) {
    S.chatId = id; S.chatUrl = url; $('btn-web').href = url; $('btn-web').hidden = false; $('btn-new').hidden = false;
  }

  /* Chat mode: a normal answer, optionally with the page or the screen */
  async function send(text, opts) {
    if (S.busy || S.run) return;
    const ctx = {}; const notes = [];
    if (opts.selection || S.pendingSel) { ctx.selection = opts.selection || S.pendingSel; notes.push('selected text'); S.pendingSel = ''; paintCtx(); }
    const aboutPage = /\b(this|the|current|that)\s+(page|article|site|website|web ?page|email|e-mail|mail|post|tab|thread|document|doc|video|product|listing|news)\b|\bsummari[sz]e\s+(it|this)\b/i.test(text);
    if (opts.page || S.page || (aboutPage && !opts.selection)) {
      const p = await pageContext(true);
      if (p) { Object.assign(ctx, { title: p.title, url: p.url, text: p.text }); if (!ctx.selection && p.selection) ctx.selection = p.selection; notes.push('this page'); }
    } else if (opts.title) { ctx.title = opts.title; ctx.url = opts.url; }
    if (opts.shot || S.shot) { const img = await screenshot(); if (img) { ctx.image = img; notes.push('your screen'); } S.shot = false; paintAll(); }
    userBubble(text, notes.length ? 'With ' + notes.join(', ') : '');
    const a = el('div', 'msg assistant'), steps = el('div', 'steps-chat'), body = el('div', 'md');
    body.innerHTML = '<div class="typing"><i></i><i></i><i></i></div>';
    a.appendChild(steps); a.appendChild(body); $('thread').appendChild(a); scrollEnd();
    setBusy(true); S.ctrl = new AbortController();
    let full = '', done = false;
    try {
      const res = await api('/api/ext/chat', { method: 'POST', signal: S.ctrl.signal, stream: true,
        json: { text, context: Object.keys(ctx).length ? ctx : null, chat_id: S.chatId, web: S.web, source: 'chrome', model: S.model || undefined } });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Something went wrong. Please try again.'); }
      const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done: end } = await reader.read(); if (end) break;
        buf += dec.decode(value, { stream: true }); let i;
        while ((i = buf.indexOf('\n\n')) > -1) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            let ev; try { ev = JSON.parse(line.slice(6)); } catch (e) { continue; }
            if (ev.t === 'start' && ev.chat_id) chatLinked(ev.chat_id, ev.url);
            else if (ev.t === 'steps') { steps.innerHTML = ''; ev.steps.forEach((s) => { const r = el('div', 'step-c'); r.innerHTML = s.state === 'done' ? ICON('check', 14) : '<span class="spin"></span>'; r.appendChild(el('span', '', s.text)); steps.appendChild(r); }); }
            else if (ev.t === 'delta') { full += ev.text; body.innerHTML = md(full); scrollEnd(); }
            else if (ev.t === 'done') { done = true; full = ev.message.content; finishChat(a, body, ev.message); }
            else if (ev.t === 'error') { throw new Error(ev.message); }
          }
        }
      }
      if (!done) { if (full) finishChat(a, body, { content: full, attachments: [] }); else throw new Error('The answer was interrupted. Please try again.'); }
    } catch (e) {
      if (e.name === 'AbortError') { if (full) finishChat(a, body, { content: full, attachments: [] }); else a.remove(); }
      else { a.remove(); $('thread').appendChild(el('div', 'msg error', e.message)); if (/connect/i.test(e.message)) init(); }
    } finally { setBusy(false); S.ctrl = null; scrollEnd(); }
  }
  function finishChat(a, body, m) {
    a.querySelectorAll('.step-c .spin').forEach((s) => { s.outerHTML = ICON('check', 14); });
    body.innerHTML = md(m.content); links(body);
    body.querySelectorAll('pre').forEach((pre) => { const b = el('button', 'code-copy'); b.type = 'button'; b.innerHTML = ICON('copy', 14); b.onclick = () => copy(pre.innerText); pre.appendChild(b); });
    (m.attachments || []).forEach((f) => { const l = el('a', 'file', f.filename); l.href = S.base + f.url; l.target = '_blank'; a.appendChild(l); });
    const acts = el('div', 'acts');
    const c = el('button'); c.type = 'button'; c.innerHTML = ICON('copy', 15) + '<span>Copy</span>'; c.onclick = () => copy(body.innerText);
    const ins = el('button'); ins.type = 'button'; ins.title = 'Put this answer into the box you clicked on the page (for example an email)';
    ins.innerHTML = ICON('corner-down-left', 15) + '<span>Insert</span>';
    ins.onclick = () => { const code = body.querySelectorAll('pre'); insertIntoPage(code.length === 1 && body.innerText.length < 400 ? code[0].innerText.trim() : body.innerText.trim()); };
    acts.appendChild(c); acts.appendChild(ins); a.appendChild(acts);
  }

  /* ---------- Agent mode ---------- */
  function setMeter(info) {
    S.steps = info || null; const m = $('meter');
    if (!info) { m.hidden = true; return; }
    m.hidden = false; m.innerHTML = '';
    if (info.limit > 0) {
      m.appendChild(document.createTextNode(info.used.toLocaleString() + ' of ' + info.limit.toLocaleString() + ' browser steps used today'));
      const bar = el('span', 'bar-s'), i = el('i'); i.style.width = Math.min(100, Math.round(100 * info.used / info.limit)) + '%'; bar.appendChild(i); m.appendChild(bar);
      if (info.plan === 'free') { const u = el('button', '', 'Get more'); u.type = 'button'; u.onclick = () => chrome.tabs.create({ url: S.base + '/upgrade' }); m.appendChild(u); }
    } else m.appendChild(document.createTextNode(info.used.toLocaleString() + ' browser steps used today'));
  }
  async function targetTab() {
    const t = await activeTab();
    return t || null;
  }
  async function startAgent(text) {
    if (S.run || S.busy) return;
    const tab = await targetTab();
    if (!tab) { toast('Open a website first.', true); return; }
    userBubble(text, '');
    const prev = S.lastRun ? 'Earlier in this chat you were asked: "' + S.lastRun.task.slice(0, 160) + '" and you answered: ' + S.lastRun.answer.slice(0, 500) : '';
    const ui = CGRunUI.create($('thread'), {
      ICON, md, links, toast, copy, base: S.base, scroll: scrollEnd,
      onStatus: (t, live) => { $('runtxt').textContent = t; $('runbar').querySelector('.spin').hidden = !live; },
      onMeter: setMeter, onChat: chatLinked,
      onTrust: (host) => { const h = CGAgent.hostKey(host); if (h && !S.allowed.includes(h)) { S.allowed.push(h); store({ allowed: S.allowed }); } },
      onEnded: () => {}
    });
    const run = CGAgent.create({ task: text, mode: S.perm, tab, chatId: S.chatId, previous: prev, settings: { allowed: S.allowed, shots: S.shots, model: S.model },
      api: agentApi, end: (b) => agentApi('/api/ext/agent/end', b), ui });
    S.run = run; $('runbar').hidden = false; $('welcome').hidden = true; $('t-model').disabled = true; paintAll();
    const origFinish = ui.finish; ui.finish = (answer, R) => { S.lastRun = { task: text, answer: answer || '' }; origFinish(answer, R); };
    const origEnded = ui.ended; ui.ended = (R) => { origEnded(R); S.run = null; $('runbar').hidden = true; $('t-model').disabled = false; paintAll(); };
    $('btn-new').hidden = false;
    await run.start();
    scrollEnd();
  }

  /* ---------- settings ---------- */
  function paintSettings() {
    const a = $('acct'); a.innerHTML = '';
    const h = el('h3'); h.innerHTML = ICON('user', 16) + '<span>' + (S.me ? (S.me.name || S.me.email) : 'Account') + '</span>'; a.appendChild(h);
    if (S.me) {
      const p = el('p', 'small muted', S.me.email + ' · '); const b = el('span', 'badge' + (S.me.plan !== 'free' ? ' pro' : ''), S.me.plan === 'free' ? 'Free plan' : S.me.plan === 'pro' ? 'Pro plan' : 'Business plan'); p.appendChild(b); a.appendChild(p);
      a.appendChild(el('p', 'small muted', 'Uses your Code GPT chats, memory and limits.'));
      const l = el('a', 'small', 'Manage your account'); l.href = S.base + '/customize/account'; l.target = '_blank'; a.appendChild(l);
      if (S.me.plan === 'free') { a.appendChild(document.createTextNode(' · ')); const u = el('a', 'small', 'See Pro'); u.href = S.base + '/upgrade'; u.target = '_blank'; a.appendChild(u); }
    }
    $('h-agent').innerHTML = ICON('mouse-pointer-click', 16) + '<span>Browser agent</span>'; $('h-sites').innerHTML = ICON('shield-check', 16) + '<span>Trusted sites</span>';
    $('h-access').innerHTML = ICON('globe', 16) + '<span>Website access</span>'; $('h-screen').innerHTML = ICON('camera', 16) + '<span>Looking at the screen</span>';
    $('h-short').innerHTML = ICON('zap', 16) + '<span>Shortcuts</span>'; $('h-look').innerHTML = ICON('sun', 16) + '<span>Look</span>';
    const po = $('perm-opts'); po.innerHTML = '';
    PERMS.forEach(([id, icon, name, desc]) => {
      const l = el('label', 'opt' + (S.perm === id ? ' on' : '')); const r = el('input'); r.type = 'radio'; r.name = 'perm'; r.checked = S.perm === id; l.appendChild(r);
      const t = el('div'); t.appendChild(el('b', '', name)); t.appendChild(el('span', '', desc)); l.appendChild(t);
      r.onchange = () => { S.perm = id; store({ perm: id }); paintSettings(); paintAll(); }; po.appendChild(l);
    });
    const sl = $('sitelist'); sl.innerHTML = '';
    if (!S.allowed.length) sl.appendChild(el('p', 'small muted', 'None yet. Sites you choose “Always allow” for will appear here.'));
    S.allowed.forEach((h) => { const r = el('div', 'siteitem'); r.appendChild(el('span', '', h)); const x = el('button', 'ib'); x.type = 'button'; x.title = 'Remove'; x.innerHTML = ICON('x', 14); x.onclick = () => { S.allowed = S.allowed.filter((y) => y !== h); store({ allowed: S.allowed }); paintSettings(); }; r.appendChild(x); sl.appendChild(r); });
    chrome.permissions.contains({ origins: ['<all_urls>'] }).then((all) => {
      $('access-note').textContent = all ? 'Code GPT can work on any website you ask it to. It still asks before opening a new site during a task.' : 'Chrome asks you once for each new site. You can allow all sites at once so it never has to ask.';
      $('btn-allsites').textContent = all ? 'Stop allowing all sites' : 'Allow all websites';
      $('btn-allsites').onclick = async () => {
        if (all) { await chrome.permissions.remove({ origins: ['<all_urls>'] }).catch(() => {}); } else { const ok = await chrome.permissions.request({ origins: ['<all_urls>'] }).catch(() => false); if (!ok) toast('Chrome did not give access.', true); }
        paintSettings();
      };
    });
    $('shot-seg').querySelectorAll('button').forEach((b) => { b.classList.toggle('on', b.dataset.s === S.shots); b.onclick = () => { S.shots = b.dataset.s; store({ shots: S.shots }); paintSettings(); }; });
    $('theme-seg').querySelectorAll('button').forEach((b) => { b.classList.toggle('on', b.dataset.t === S.theme); b.onclick = () => { S.theme = b.dataset.t; store({ theme: S.theme }); applyTheme(); paintSettings(); }; });
    const sh = $('shortlist'); sh.innerHTML = '';
    S.shortcuts.forEach((s, i) => { const r = el('div', 'siteitem'); r.insertAdjacentHTML('afterbegin', ICON(s.m === 'chat' ? 'message-square' : 'mouse-pointer-click', 14)); r.appendChild(el('span', '', '/' + s.n)); const x = el('button', 'ib'); x.type = 'button'; x.title = 'Delete'; x.innerHTML = ICON('trash', 14); x.onclick = () => { S.shortcuts.splice(i, 1); store({ shortcuts: S.shortcuts }); paintSettings(); }; r.appendChild(x); sh.appendChild(r); });
  }
  $('site-add').onclick = () => {
    const raw = $('site-in').value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(raw)) { toast('Type a website like example.com', true); return; }
    const h = CGAgent.hostKey(raw); if (!S.allowed.includes(h)) { S.allowed.push(h); store({ allowed: S.allowed }); } $('site-in').value = ''; paintSettings();
  };
  $('sc-add').onclick = () => {
    const n = $('sc-name').value.trim().slice(0, 40), t = $('sc-text').value.trim().slice(0, 2000);
    if (!n || !t) { toast('Give the shortcut a name and say what it should do.', true); return; }
    S.shortcuts.push({ n, t, m: 'agent' }); store({ shortcuts: S.shortcuts }); $('sc-name').value = ''; $('sc-text').value = ''; paintSettings(); toast('Saved. Type / to use it.');
  };

  init();
})();
