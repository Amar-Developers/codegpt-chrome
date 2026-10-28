// Code GPT browser agent: the loop that runs in the side panel.
// Look at the page -> ask Code GPT what to do next -> do it (asking the user first when it matters) -> look again.
// Everything that touches a website happens here, on the user's own computer, under the rules below.
(function () {
  'use strict';
  const MAX_TURNS = 40;
  const SAFE = new Set(['read', 'scroll', 'screenshot', 'wait', 'extract', 'hover', 'finish', 'ask_user', 'back', 'forward']);   // fine before the plan is approved
  const CHANGES = new Set(['click', 'type', 'select', 'check', 'press']);                                                       // not allowed in read-only mode
  // words on a button that mean "this does something outside the page": always ask first
  const RISK = /\b(send|submit|post|publish|tweet|share|buy|purchase|pay|checkout|check ?out|place (an? )?order|order now|book( now| table)?|reserve|donate|transfer|withdraw|delete|remove|discard|erase|empty (the )?(trash|bin|spam)|permanently|unsubscribe|sign ?out|log ?out|deactivate|close (my )?account|accept (the )?terms|i agree|agree (and|&)|authori[sz]e|confirm|subscribe|apply( now)?|place bid|send money|save changes|update (password|email)|change (password|email)|invite|grant|allow access|forward)\b/i;
  const RISK_LINK = /\b(delete|remove|unsubscribe|sign ?out|log ?out|pay now|buy now|purchase|checkout|check ?out|donate|confirm (order|payment|booking))\b/i;     // links only ask for these
  const COOKIE = /cookie|consent|gdpr|privacy preferences/i;
  const GENERIC = /^(add( to (cart|basket|bag))?|buy( now)?|select|star|edit|delete|remove|open|view|more|details|learn more|read more|download|save|reply|archive|like|share|choose|see (more|details))$/i;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

  function hostOf(u) { try { return new URL(u).host.replace(/^www\./, ''); } catch (e) { return ''; } }
  function hostKey(host) { return String(host || '').toLowerCase().replace(/^www\./, '').replace(/:\d+$/, ''); }          // the host as a person would type it
  function siteOf(host) {
    host = String(host || '').toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
    const p = host.split('.');
    if (p.length <= 2) return host;
    return /^(co|com|org|net|gov|edu|ac)$/.test(p[p.length - 2]) && p[p.length - 1].length === 2 ? p.slice(-3).join('.') : p.slice(-2).join('.');
  }
  function readable(url) { return /^https?:/i.test(url || '') && !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url); }

  /* ---------------- talking to the page ---------------- */
  async function inject(tabId, allFrames) {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: !!allFrames }, files: ['agent/page.js'] });
  }
  async function call(tabId, frameId, method, args) {
    const run = () => chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId || 0] }, args: [method, args || []],
      func: (m, a) => (window.__cga ? window.__cga[m].apply(null, a) : { __missing: true })
    });
    let r = await run();
    if (r && r[0] && r[0].result && r[0].result.__missing) { await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId || 0] }, files: ['agent/page.js'] }); r = await run(); }
    return r && r[0] ? r[0].result : null;
  }
  async function snapshotFrames(tabId) {
    const take = async (target) => {
      await chrome.scripting.executeScript({ target, files: ['agent/page.js'] });
      const res = await chrome.scripting.executeScript({ target, args: [{ maxChars: 15000 }], func: (o) => (window.__cga ? window.__cga.snapshot(o) : null) });
      return (res || []).filter((r) => r && r.result).map((r) => ({ frameId: r.frameId, snap: r.result })).sort((a, b) => a.frameId - b.frameId);
    };
    try { return await take({ tabId, allFrames: true }); } catch (e) { return take({ tabId, frameIds: [0] }); }   // some frames may be off limits
  }
  function merge(frames) {
    const map = new Map(), labels = new Map(), parents = new Map(); let offset = 0, text = [], top = null, extra = 0;
    frames.forEach((f, i) => {
      const s = f.snap;
      if (i === 0) top = s;
      else if (!s.count && (s.text || '').length < 60) return;
      else if (++extra > 5) return;
      const delta = offset, stack = []; let head = '';
      const body = (s.text || '').split('\n').map((line) => {
        const hd = /^\s*#{1,6} (.+)$/.exec(line); if (hd) head = hd[1];
        const m = /^(\s*)\[(\d+)\] (.*)$/.exec(line);
        if (!m) return line;
        const g = +m[2] + delta, rest = m[3];
        const q1 = rest.indexOf('"'), q2 = rest.lastIndexOf('"');
        const role = (q1 > 0 ? rest.slice(0, q1) : rest.split(' {')[0]).trim();
        const label = q1 >= 0 && q2 > q1 ? rest.slice(q1 + 1, q2) : '';
        while (stack.length && stack[stack.length - 1].indent >= m[1].length) stack.pop();
        const parent = stack.length ? stack[stack.length - 1].label : (GENERIC.test(label) ? head : '');       // what this item belongs to (its row, or the heading above a generic button)
        stack.push({ indent: m[1].length, label });
        map.set(g, { frameId: f.frameId, ref: +m[2], role, label }); labels.set(g, label || role); if (parent) parents.set(g, parent);
        return m[1] + '[' + g + '] ' + rest;
      }).join('\n');
      text.push(i === 0 ? body : '\n=== inside a frame of the page (' + hostOf(s.url) + ') ===\n' + body);
      offset += Math.max(0, (s.nextRef || 1) - 1);
    });
    return { text: text.join('\n'), map, labels, parents, top };
  }

  async function waitLoaded(tabId, ms) {
    const t0 = Date.now();
    for (;;) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) return null;
      if (tab.status === 'complete' || Date.now() - t0 > (ms || 10000)) return tab;
      await sleep(150);
    }
  }
  async function shrink(dataUrl, maxW) {
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
      const k = Math.min(1, maxW / img.width), c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.62);
    } catch (e) { return dataUrl; }
  }

  /* ---------------- the controller ---------------- */
  function create(cfg) {
    // cfg: { task, mode, tab, settings:{allowed:[], shots, model}, api(path, json, signal), ui, previous }
    const ui = cfg.ui;
    const R = {
      task: cfg.task, mode: cfg.mode || 'ask', tabId: cfg.tab.id, windowId: cfg.tab.windowId, chatId: cfg.chatId || null, turn: 0, memory: '',
      history: cfg.previous ? [cfg.previous] : [], notes: [], answer: '', approved: false, stopped: false, ended: false, hosts: new Set(), map: new Map(), labels: new Map(), parents: new Map(),
      lastResult: '', wantShot: true, empty: 0, steps: 0, ctrl: new AbortController(), model: cfg.settings.model || '', tables: [], say: ''
    };
    const trusted = (h) => { h = hostKey(h); return !!h && (cfg.settings.allowed || []).map(hostKey).some((a) => a && (h === a || h.endsWith('.' + a))); };   // a trusted site also covers its own sub-sites
    const startHost = hostOf(cfg.tab.url);
    if (R.mode === 'allowed' && !trusted(startHost)) R.mode = 'ask';       // not a trusted site: ask first
    R.hosts.add(siteOf(startHost));
    const hostOK = (h) => { const s = siteOf(h); return !s || R.hosts.has(s) || trusted(h); };

    function logLine(text) { R.history.push((R.history.length + 1) + '. ' + clip(text, 240)); }
    function stopCheck() { if (R.stopped) throw Object.assign(new Error('stopped'), { stopped: true }); }

    async function tabInfo() {
      const tab = await chrome.tabs.get(R.tabId).catch(() => null);
      if (!tab) throw new Error('The tab was closed.');
      return tab;
    }
    async function ensureAccess(tab) {
      if (!readable(tab.url)) throw Object.assign(new Error('Chrome does not let extensions work on this kind of page (browser pages, the Web Store). Open a normal website and try again.'), { fatal: true });
      try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => 1 }); return; } catch (e) {}
      const origin = new URL(tab.url).origin + '/*';
      const ans = await ui.confirm({ kind: 'site', host: hostOf(tab.url), title: 'Allow Code GPT to work on ' + hostOf(tab.url) + '?',
        detail: 'Chrome needs your OK before an extension can read or use this website.', permission: { origins: [origin] }, always: true });
      stopCheck();
      if (ans.choice !== 'allow') throw Object.assign(new Error('You did not allow access to ' + hostOf(tab.url) + '.'), { fatal: true });
      R.hosts.add(siteOf(hostOf(tab.url)));
      if (ans.always) ui.trust(hostOf(tab.url));
    }

    /* what the page looks like now */
    async function observe() {
      let tab = await waitLoaded(R.tabId);
      if (!tab) throw new Error('The tab was closed.');
      await ensureAccess(tab);
      let frames;
      try { frames = await snapshotFrames(R.tabId); } catch (e) { frames = []; }
      if (!frames.length) { await sleep(500); frames = await snapshotFrames(R.tabId); }
      const m = merge(frames);
      R.map = m.map; R.labels = m.labels; R.parents = m.parents;
      tab = await tabInfo();
      const s = m.top || { scroll: {}, viewport: {} };
      const pct = s.scroll && s.scroll.max ? Math.round(100 * s.scroll.y / s.scroll.max) : 0;
      const scrollText = s.scroll ? ('at ' + pct + '% of the page' + (s.scroll.max ? '' : ' (the page does not scroll)') + '; viewport ' + (s.viewport && s.viewport.w) + 'x' + (s.viewport && s.viewport.h) + ', page height ' + s.scroll.height + 'px' + (pct < 98 && s.scroll.max ? '; more below' : '')) : '';
      const tabs = (await chrome.tabs.query({ windowId: tab.windowId }).catch(() => [])).slice(0, 12)
        .map((t) => ({ id: t.id, title: clip(t.title || '', 80), url: clip(t.url || '', 150), current: t.id === R.tabId }));
      let image = null;
      const wantShot = cfg.settings.shots === 'always' || (cfg.settings.shots !== 'never' && (R.wantShot || m.text.length < 500 || /drawn content/.test(m.text)));
      if (wantShot) image = await screenshot(tab);
      R.wantShot = false;
      return { page: { url: tab.url, title: tab.title, text: m.text, scroll: scrollText, tabs, result: R.lastResult }, image };
    }
    async function screenshot(tab) {
      if (R.noShot) return null;
      let hidden = false;
      try {
        if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
        await call(tab.id, 0, 'setOverlay', [false]).catch(() => {});
        hidden = true;
        await sleep(120);
        const raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
        return await shrink(raw, 1100);
      } catch (e) {
        if (/all_urls|activeTab|permission/i.test(String(e && e.message))) R.noShot = true;      // Chrome only allows pictures with access to all websites: stay with text
        return null;
      } finally {
        if (hidden) await call(tab.id, 0, 'setOverlay', [true, 'Code GPT is working in this tab']).catch(() => {});
      }
    }

    /* asking Code GPT */
    async function decide(obs, extra) {
      const body = Object.assign({ task: R.task, mode: R.mode, turn: R.turn, approved: R.approved, memory: R.memory, history: R.history.slice(-60), notes: R.notes.splice(0),
        answer: R.answer || undefined, page: obs.page, image: obs.image, model: R.model || undefined, chat_id: R.chatId || undefined }, extra || {});
      R.answer = '';
      const res = await cfg.api('/api/ext/agent', body, R.ctrl.signal);
      if (res.chat_id) { R.chatId = res.chat_id; ui.chat(res.chat_id, res.url); }
      if (res.steps) ui.meter(res.steps);
      return res;
    }

    /* what to tell the user about an action */
    function describe(a) {
      const L = (n) => {
        const l = R.labels.get(n); if (!l) return 'item ' + n;
        const par = String(R.parents.get(n) || '').replace(/^[^\p{L}\p{N}]+/u, '');
        return '“' + clip(l, 48) + '”' + (l.length <= 18 && par && par !== l ? ' in “' + clip(par, 34) + '”' : '');       // "Select" alone says little: name the row
      };
      switch (a.type) {
        case 'click': return 'Click ' + L(a.ref);
        case 'type': return 'Type “' + clip(a.text, 40) + '” in ' + L(a.ref);
        case 'select': return 'Choose “' + clip(a.value, 30) + '” in ' + L(a.ref);
        case 'check': return (a.checked === false ? 'Untick ' : 'Tick ') + L(a.ref);
        case 'press': return 'Press ' + a.key;
        case 'hover': return 'Point at ' + L(a.ref);
        case 'scroll': return a.ref ? 'Scroll to ' + L(a.ref) : 'Scroll ' + (a.direction || 'down');
        case 'read': return a.ref ? 'Read ' + L(a.ref) : 'Read the page';
        case 'navigate': return 'Open ' + hostOf(a.url) + (new URL(a.url).pathname.length > 1 ? clip(new URL(a.url).pathname, 30) : '');
        case 'new_tab': return 'Open ' + hostOf(a.url) + ' in a new tab';
        case 'switch_tab': return 'Switch to tab ' + a.tab;
        case 'close_tab': return 'Close tab ' + a.tab;
        case 'back': return 'Go back'; case 'forward': return 'Go forward';
        case 'wait': return 'Wait ' + a.seconds + ' seconds';
        case 'screenshot': return 'Look at the screen';
        case 'extract': return 'Save the table “' + clip(a.title || 'Results', 40) + '” (' + (a.rows || []).length + ' rows)';
        case 'ask_user': return 'Ask you a question';
        case 'finish': return 'Finish';
      }
      return a.type;
    }

    /* the rules about what may run */
    async function check(a, info) {
      const label = R.labels.get(a.ref) || '';
      if (R.mode === 'read' && CHANGES.has(a.type)) return { block: 'Read-only mode: I may look at pages but not click or type. Switch to “Ask before acting” in the settings if you want me to do it.' };
      if (info && info.sensitive && (a.type === 'type' || a.type === 'select')) return { sensitive: true };
      let why = '';
      if (a.confirm) why = 'Code GPT marked this as something that affects things outside the page.';
      if (!why && (a.type === 'click' || (a.type === 'press' && /^enter$/i.test(a.key)) || (a.type === 'type' && a.submit)) && info) {
        const words = [info.text, info.label, info.title, info.name].filter(Boolean).map((x) => clip(x, 60)).join(' ');
        const shortLabel = (info.text || info.label || '').length <= 48;
        const control = /button|link|clickable|submit/.test(info.role + ' ' + info.type) || info.submit;
        const rx = info.role === 'link' && !info.submit ? RISK_LINK : RISK;
        if (control && shortLabel && rx.test(words) && !COOKIE.test(words) && !(info.role === 'checkbox' || info.role === 'radio')) why = 'The button says “' + clip(info.label || info.text, 40) + '”.';
        if (!why && info.submit && info.formMethod === 'post' && info.formFields >= 3 && !info.search) why = 'This sends a form with your details.';
        if (!why && a.type === 'type' && a.submit && !info.search) why = 'Pressing Enter here sends what you typed.';
      }
      if (why) return { confirm: why };
      if ((a.type === 'navigate' || a.type === 'new_tab') && !hostOK(hostOf(a.url))) return { site: hostOf(a.url) };
      if (a.type === 'switch_tab') {
        const t = await chrome.tabs.get(a.tab).catch(() => null);
        if (t && readable(t.url) && !hostOK(hostOf(t.url))) return { site: hostOf(t.url), tab: t };
      }
      return null;
    }

    /* doing one action */
    async function doAction(a) {
      const target = a.ref != null ? R.map.get(a.ref) : null;
      if (a.ref != null && !target) return { ok: false, error: 'Item [' + a.ref + '] is not on the current page. Look at the page again and pick a listed item.' };
      switch (a.type) {
        case 'navigate': { await chrome.tabs.update(R.tabId, { url: a.url }); await sleep(300); const t = await waitLoaded(R.tabId); return { ok: true, info: 'opened ' + clip(t && t.url, 120), changed: true }; }
        case 'new_tab': { const t = await chrome.tabs.create({ url: a.url, active: true, windowId: R.windowId }); R.tabId = t.id; await sleep(300); await waitLoaded(t.id); return { ok: true, info: 'opened a new tab (tab ' + t.id + ')', changed: true }; }
        case 'switch_tab': { const t = await chrome.tabs.update(a.tab, { active: true }).catch(() => null); if (!t) return { ok: false, error: 'There is no tab ' + a.tab + '.' }; R.tabId = t.id; R.windowId = t.windowId; R.hosts.add(siteOf(hostOf(t.url))); return { ok: true, info: 'now on “' + clip(t.title, 50) + '”', changed: true }; }
        case 'close_tab': { if (a.tab === R.tabId) return { ok: false, error: 'I will not close the tab I am working in. Switch to another tab first.' }; await chrome.tabs.remove(a.tab).catch(() => {}); return { ok: true, info: 'closed tab ' + a.tab }; }
        case 'back': await chrome.tabs.goBack(R.tabId).catch(() => {}); await sleep(300); await waitLoaded(R.tabId); return { ok: true, info: 'went back', changed: true };
        case 'forward': await chrome.tabs.goForward(R.tabId).catch(() => {}); await sleep(300); await waitLoaded(R.tabId); return { ok: true, info: 'went forward', changed: true };
        case 'wait': await sleep(Math.min(10, a.seconds || 2) * 1000); return { ok: true, info: 'waited' };
        case 'screenshot': R.wantShot = true; return { ok: true, info: 'will look at the screen' };
        case 'extract': { const t = { title: a.title || 'Results', columns: a.columns || [], rows: a.rows || [] }; R.tables.push(t); ui.table(t); return { ok: true, info: 'saved ' + t.rows.length + ' rows' }; }
        case 'read': {
          const r = await call(R.tabId, target ? target.frameId : 0, 'act', [{ type: 'read', ref: target ? target.ref : undefined }]);
          if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'Could not read the page.' };
          R.lastResult = (R.lastResult ? R.lastResult + '\n\n' : '') + 'TEXT OF THE ' + (target ? 'ITEM' : 'PAGE') + ' (' + r.total + ' characters' + (r.more ? ', cut at 40000' : '') + '):\n' + r.text;
          return { ok: true, info: 'read ' + r.total + ' characters' };
        }
        default: {
          const op = { type: a.type, ref: target ? target.ref : undefined, text: a.text, clear: a.clear, value: a.value, checked: a.checked, key: a.key, direction: a.direction };
          let r = await call(R.tabId, target ? target.frameId : 0, 'act', [op]);
          if (!r) return { ok: false, error: 'The page did not answer.' };
          if (r.ok && a.type === 'type' && a.submit) { const e = await call(R.tabId, target ? target.frameId : 0, 'act', [{ type: 'press', key: 'Enter' }]); if (e && !e.ok) r = e; else r.info = (r.info || '') + ' and pressed Enter'; }
          return Object.assign(r, { changed: a.type === 'click' || a.type === 'press' || (a.type === 'type' && a.submit) });
        }
      }
    }
    async function afterChange() {
      await sleep(250);
      const t = await waitLoaded(R.tabId, 9000);
      if (t && readable(t.url)) { try { await inject(R.tabId, false); await call(R.tabId, 0, 'settle', [2500, 280]); await call(R.tabId, 0, 'setOverlay', [true, 'Code GPT is working in this tab']); } catch (e) {} }
    }

    async function runActions(actions) {
      let changed = false, failed = false;
      for (let i = 0; i < actions.length; i++) {
        stopCheck();
        const a = actions[i];
        if (a.type === 'finish') { R.final = a.answer; return { done: true }; }
        if (a.type === 'ask_user') {
          const row = ui.step(describe(a), 'run');
          const res = await ui.ask(a.question, {});
          stopCheck(); ui.stepDone(row, 'done');
          R.answer = res.text || ''; logLine('Asked you: ' + clip(a.question, 120) + ' → ' + (res.text ? 'you answered' : 'you continued'));
          return { asked: true };
        }
        const info = a.ref != null && R.map.get(a.ref) ? await call(R.tabId, R.map.get(a.ref).frameId, 'inspect', [R.map.get(a.ref).ref]).catch(() => null) : null;
        const text = describe(a);
        const gate = await check(a, info);
        let row = null;
        if (gate && gate.block) { row = ui.step(text, 'skip', 'Not allowed in read-only mode'); logLine(text + ' — blocked (read-only mode)'); R.lastResult += (R.lastResult ? '\n' : '') + 'BLOCKED: ' + gate.block; failed = true; break; }
        if (gate && gate.sensitive) {
          const shown = describe(Object.assign({}, a, { text: '••••' }));
          row = ui.step(shown, 'wait', 'Private field');
          const res = await ui.ask('This is a private field (password, card or code). Code GPT never types into those. Please fill it in yourself on the page, then press Continue.', { takeover: true });
          stopCheck(); ui.stepDone(row, 'skip', 'You did it yourself'); logLine(shown + ' — private field, the user filled it in themselves'); R.lastResult += (R.lastResult ? '\n' : '') + 'The user filled in the private field themselves.';
          changed = true; failed = true; break;
        }
        if (gate && (gate.confirm || gate.site)) {
          row = ui.step(text, 'wait', gate.site ? 'Waiting for your OK' : 'Waiting for your OK');
          const ans = gate.site
            ? await ui.confirm({ kind: 'navigate', host: gate.site, title: 'Open ' + gate.site + '?', detail: 'This is a different website from the ones you approved for this task.', always: true })
            : await ui.confirm({ kind: 'risk', host: hostOf((await tabInfo()).url), title: text + '?', detail: gate.confirm + ' Code GPT will only do it if you allow it.', say: R.say });
          stopCheck();
          if (ans.choice === 'stop') { throw Object.assign(new Error('stopped'), { stopped: true }); }
          if (ans.choice !== 'allow') { ui.stepDone(row, 'skip', 'You skipped this'); logLine(text + ' — the user said NO, do not do it'); R.lastResult += (R.lastResult ? '\n' : '') + 'THE USER DID NOT ALLOW: ' + text + '. Do not try again; choose another way or finish.'; failed = true; break; }
          if (gate.site) { R.hosts.add(siteOf(gate.site)); if (ans.always) ui.trust(gate.site); }
          ui.stepDone(row, 'run');
        } else row = ui.step(text, 'run');
        let res;
        try { res = await doAction(a); } catch (e) { if (e.stopped) throw e; res = { ok: false, error: clip(e.message, 160) }; }
        stopCheck();
        R.steps++;
        if (res.sensitive) {
          ui.stepDone(row, 'skip', 'Private field');
          await ui.ask('This is a private field (password, card or code). Code GPT never types into those. Please fill it in yourself on the page, then press Continue.', { takeover: true });
          stopCheck(); logLine(text + ' — private field, the user filled it in themselves'); R.lastResult += (R.lastResult ? '\n' : '') + 'The user filled in the private field themselves.'; changed = true; failed = true; break;
        }
        if (res.ok) {
          ui.stepDone(row, 'done');
          logLine(text + ' — ok' + (res.info && !/^clicked|^typed|^chose|^ticked/.test(res.info) ? ' (' + clip(res.info, 100) + ')' : ''));
          if (res.changed) changed = true;
          if (a.type === 'click' || a.type === 'type' || a.type === 'select' || a.type === 'check' || a.type === 'press') await sleep(120);
        } else {
          ui.stepDone(row, 'error', clip(res.error, 140));
          logLine(text + ' — FAILED: ' + clip(res.error, 160));
          R.lastResult += (R.lastResult ? '\n' : '') + 'ERROR for "' + text + '": ' + res.error;
          failed = true; changed = true;           // the page may be different now
          break;
        }
        // an action that loads or changes the page makes the next numbers invalid: stop the batch
        if (res.changed && i < actions.length - 1 && (a.type === 'navigate' || a.type === 'new_tab' || a.type === 'switch_tab' || a.type === 'back' || a.type === 'forward' || a.type === 'click')) {
          const rest = actions.slice(i + 1).filter((x) => x.ref != null);
          if (rest.length) { logLine('(the page changed, so I looked again before continuing)'); break; }
        }
      }
      return { changed, failed };
    }

    async function run() {
      try {
        const t0 = await tabInfo();
        await ensureAccess(t0);
        await inject(R.tabId, false);
        await call(R.tabId, 0, 'setOverlay', [true, 'Code GPT is working in this tab']).catch(() => {});
        ui.status('Looking at the page…');
        for (;;) {
          stopCheck();
          if (++R.turn > MAX_TURNS) { ui.finish('I stopped after ' + MAX_TURNS + ' rounds without finishing. Here is where I got to: ' + (R.memory || 'see the steps above') + '\n\nTell me how to continue and I will pick it up.', R); break; }
          ui.status(R.turn === 1 ? 'Reading the page…' : 'Looking at the page again…');
          const obs = await observe();
          R.lastResult = '';
          ui.status('Thinking…');
          let res;
          try { res = await decide(obs); } catch (e) { if (e.name === 'AbortError') throw Object.assign(new Error('stopped'), { stopped: true }); throw e; }
          stopCheck();
          R.say = res.say || ''; R.memory = res.memory || R.memory;
          if (res.say) ui.say(res.say);
          const actions = res.actions || [];
          if (res.limited) { ui.limit(res.limit_message || 'You reached today’s step limit.'); R.ended = true; }
          const unsafe = actions.some((x) => !SAFE.has(x.type));
          if (R.mode === 'ask' && !R.approved && (unsafe || (res.plan && res.plan.length && !actions.length))) {
            const sites = (res.sites || []).filter(Boolean);
            const lines = res.plan && res.plan.length ? res.plan : actions.filter((x) => !SAFE.has(x.type)).slice(0, 5).map(describe);
            const ans = await ui.plan({ lines, sites, host: hostOf((await tabInfo()).url) });
            stopCheck();
            if (!ans.ok) { ui.cancelled(); R.ended = true; break; }
            R.approved = true; sites.forEach((x) => R.hosts.add(siteOf(x)));
            if (ans.trust) { sites.concat([hostOf(t0.url)]).forEach((x) => ui.trust(x)); }
          } else if (R.mode !== 'ask') R.approved = true;
          if (!actions.length) {
            if (R.ended) break;
            if (++R.empty >= 2) { ui.finish('I could not work out what to do next on this page. ' + (R.memory ? 'What I know so far: ' + R.memory : ''), R); break; }
            continue;
          }
          R.empty = 0;
          const out = await runActions(actions);
          if (out.done) { ui.finish(R.final, R); R.ended = true; break; }
          if (R.ended) break;
          if (out.changed || out.failed || actions.some((x) => x.type === 'click' || x.type === 'navigate' || x.type === 'type')) await afterChange();
        }
      } catch (e) {
        if (e && e.stopped) { ui.stopped(R); try { await cfg.end({ chat_id: R.chatId, status: 'stopped', history: R.history }); } catch (x) {} }
        else { ui.error(e, R); try { await cfg.end({ chat_id: R.chatId, status: 'failed', reason: e && e.message, history: R.history }); } catch (x) {} }
      } finally {
        try { await call(R.tabId, 0, 'setOverlay', [false]); } catch (e) {}
        ui.ended(R);
      }
    }

    return {
      state: R,
      start() { return run(); },
      stop() { R.stopped = true; try { R.ctrl.abort(); } catch (e) {} try { if (ui.abortPending) ui.abortPending(); } catch (e) {} },
      note(text) { R.notes.push(text); },
      answer(text) { R.answer = text; }
    };
  }

  window.CGAgent = { create, hostOf, siteOf, hostKey, readable, MAX_TURNS };
})();
