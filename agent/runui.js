// The browser agent's card in the chat: plan, steps, questions, "may I?" cards, tables and the final answer.
(function () {
  'use strict';
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  const csv = (t) => [t.columns].concat(t.rows).map((r) => r.map((c) => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(',')).join('\r\n');

  function create(thread, d) {
    // d: { ICON, md, links, toast, copy, scroll, base, onStatus(text, live), onMeter(info), onChat(id, url), onTrust(host), onEnded() }
    const card = el('div', 'msg assistant');
    const run = el('div', 'run'); card.appendChild(run);
    const head = el('div', 'run-head'); head.innerHTML = d.ICON('mouse-pointer-click', 16) + '<b>Browser agent</b>';
    const st = el('span', 'st live'); head.appendChild(st); run.appendChild(head);
    const body = el('div', 'run-body'); run.appendChild(body);
    const say = el('div', 'run-say'); body.appendChild(say);
    const list = el('ol', 'steps'); body.appendChild(list);
    const more = el('button', 'steps-more'); more.type = 'button'; more.hidden = true; body.insertBefore(more, list);
    const tail = el('div'); tail.style.display = 'contents'; body.appendChild(tail);
    thread.appendChild(card);
    let expanded = false, count = 0, chatUrl = '';
    const pend = new Set();                       // questions waiting for the user: closed when the task is stopped

    function setState(text, cls) { st.className = 'st ' + (cls || ''); st.innerHTML = (cls === 'live' ? '<span class="spin"></span>' : '') + ''; st.appendChild(document.createTextNode(text)); }
    setState('Working', 'live');
    function trim() {
      const rows = Array.from(list.children);
      const keep = expanded ? rows.length : 7;
      rows.forEach((r, i) => { r.hidden = i < rows.length - keep; });
      more.hidden = rows.length <= 7;
      more.textContent = expanded ? 'Show fewer steps' : 'Show ' + (rows.length - 7) + ' earlier step' + (rows.length - 7 > 1 ? 's' : '');
    }
    more.onclick = () => { expanded = !expanded; trim(); };
    const ico = { run: () => '<span class="spin"></span>', done: () => d.ICON('check', 15), error: () => d.ICON('x', 15), skip: () => d.ICON('ban', 15), wait: () => d.ICON('hourglass', 15) };
    function paint(row, state, note) {
      row.className = 'step ' + state;
      row.querySelector('.sico').innerHTML = (ico[state] || ico.done)();
      const n = row.querySelector('.snote');
      if (note) { if (n) n.textContent = note; else row.querySelector('.stxt').appendChild(el('span', 'snote', note)); } else if (n) n.remove();
    }
    function ask(node) { tail.appendChild(node); d.scroll(); }
    function collapse(node, text) { node.innerHTML = ''; node.className = 'pcard'; node.appendChild(el('p', 'done-note', text)); }

    const ui = {
      node: card,
      status(text) { d.onStatus(text, true); },
      say(text) { say.textContent = text; d.onStatus(text, true); },
      chat(id, url) { chatUrl = url || ''; d.onChat(id, url); },
      meter(info) { d.onMeter(info); },
      trust(host) { d.onTrust(host); },
      step(text, state, note) {
        const row = el('li', 'step'); row.appendChild(el('span', 'sico')); const t = el('span', 'stxt', text); row.appendChild(t);
        paint(row, state || 'run', note); list.appendChild(row); count++; trim(); d.scroll(); return row;
      },
      stepDone(row, state, note) { paint(row, state, note); },
      table(t) {
        const box = el('div', 'tbl'), h = el('div', 'tbl-h'); h.appendChild(document.createTextNode(t.title || 'Results'));
        h.appendChild(el('span', 'sm', ' · ' + t.rows.length + ' row' + (t.rows.length === 1 ? '' : 's')));
        const acts = el('span'); const cp = el('button', 'btn ghost small'); cp.type = 'button'; cp.innerHTML = d.ICON('copy', 14) + 'Copy';
        cp.onclick = () => d.copy([t.columns].concat(t.rows).map((r) => r.join('\t')).join('\n'));
        const dl = el('button', 'btn ghost small'); dl.type = 'button'; dl.innerHTML = d.ICON('download', 14) + 'CSV';
        dl.onclick = () => { const a = el('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv(t)], { type: 'text/csv' })); a.download = (t.title || 'results').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() + '.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
        acts.appendChild(cp); acts.appendChild(dl); h.appendChild(acts); box.appendChild(h);
        const sc = el('div', 'tbl-scroll'), tb = el('table'); const hr = el('tr'); t.columns.forEach((c) => hr.appendChild(el('th', '', c))); const th = el('thead'); th.appendChild(hr); tb.appendChild(th);
        const tbd = el('tbody'); t.rows.forEach((r) => { const tr = el('tr'); for (let i = 0; i < Math.max(t.columns.length, r.length); i++) tr.appendChild(el('td', '', r[i] == null ? '' : r[i])); tbd.appendChild(tr); }); tb.appendChild(tbd); sc.appendChild(tb); box.appendChild(sc);
        ask(box);
      },
      plan(p) {
        return new Promise((resolve) => {
          setState('Needs your OK', ''); d.onStatus('Waiting for your OK…', false);
          const c = el('div', 'pcard'), ct = el('div', 'ct'); ct.innerHTML = d.ICON('list-checks', 17) + '<span>Here is what I will do</span>'; c.appendChild(ct);
          const ol = el('ol'); p.lines.forEach((l) => ol.appendChild(el('li', '', l))); c.appendChild(ol);
          const sites = Array.from(new Set((p.sites || []).concat(p.host ? [p.host] : [])));
          if (sites.length) { const s = el('div', 'sites'); sites.forEach((x) => s.appendChild(el('span', 'site', x))); c.appendChild(s); }
          const lab = el('label', 'chk'); const cb = el('input'); cb.type = 'checkbox'; lab.appendChild(cb); lab.appendChild(document.createTextNode('Trust these sites (do not ask for a plan there next time)')); c.appendChild(lab);
          const bar = el('div', 'cb'); const go = el('button', 'btn primary small', 'Start'); go.type = 'button'; const no = el('button', 'btn small', 'Cancel'); no.type = 'button'; bar.appendChild(go); bar.appendChild(no); c.appendChild(bar);
          const gone = () => { collapse(c, 'Stopped.'); resolve({ ok: false }); };
          pend.add(gone);
          go.onclick = () => { pend.delete(gone); collapse(c, 'You approved this plan.'); setState('Working', 'live'); resolve({ ok: true, trust: cb.checked }); };
          no.onclick = () => { pend.delete(gone); collapse(c, 'You cancelled.'); resolve({ ok: false }); };
          ask(c);
        });
      },
      confirm(o) {
        return new Promise((resolve) => {
          setState('Needs your OK', ''); d.onStatus('Waiting for your OK…', false);
          const risky = o.kind === 'risk';
          const c = el('div', 'pcard' + (risky ? ' risk' : '')), ct = el('div', 'ct');
          ct.innerHTML = d.ICON(risky ? 'shield-check' : 'globe', 17) + '<span></span>'; ct.lastChild.textContent = o.title; c.appendChild(ct);
          if (o.detail) c.appendChild(el('div', 'cd', o.detail + (o.host && risky ? ' (' + o.host + ')' : '')));
          if (o.say && risky) c.appendChild(el('div', 'cd', o.say));
          const bar = el('div', 'cb');
          const gone = () => { collapse(c, 'Stopped.'); resolve({ choice: 'stop', always: false }); };
          pend.add(gone);
          const done = (choice, always, note) => { pend.delete(gone); collapse(c, note); setState('Working', 'live'); resolve({ choice, always: !!always }); };
          const grant = (always) => {
            if (o.permission) {
              chrome.permissions.request(o.permission).then((ok) => { if (ok) done('allow', always, 'You allowed ' + (o.host || 'this') + '.'); else { d.toast('Chrome did not give access.', true); done('skip', false, 'Access was not given.'); } },
                () => done('skip', false, 'Access was not given.'));
            } else done('allow', always, always ? 'Allowed, and remembered as a trusted site.' : 'You allowed this.');
          };
          const ok = el('button', 'btn primary small', risky ? 'Allow' : 'Allow'); ok.type = 'button'; ok.onclick = () => grant(false); bar.appendChild(ok);
          if (o.always) { const al = el('button', 'btn small', 'Always allow ' + (o.host || 'this site')); al.type = 'button'; al.onclick = () => grant(true); bar.appendChild(al); }
          const sk = el('button', 'btn small', 'Skip'); sk.type = 'button'; sk.onclick = () => done('skip', false, 'You skipped this.'); bar.appendChild(sk);
          const sp = el('button', 'btn small danger', 'Stop task'); sp.type = 'button'; sp.onclick = () => done('stop', false, 'You stopped the task.'); bar.appendChild(sp);
          c.appendChild(bar); ask(c);
        });
      },
      ask(question, o) {
        return new Promise((resolve) => {
          setState(o && o.takeover ? 'Your turn' : 'Needs your answer', ''); d.onStatus(o && o.takeover ? 'Waiting for you…' : 'Waiting for your answer…', false);
          const c = el('div', 'pcard'), ct = el('div', 'ct');
          ct.innerHTML = d.ICON(o && o.takeover ? 'hand' : 'message-square', 17) + '<span></span>'; ct.lastChild.textContent = question; c.appendChild(ct);
          let input = null;
          if (!(o && o.takeover)) { input = el('input'); input.type = 'text'; input.placeholder = 'Your answer'; c.appendChild(input); setTimeout(() => input.focus(), 50); }
          const bar = el('div', 'cb'); const go = el('button', 'btn primary small', o && o.takeover ? 'Continue' : 'Send answer'); go.type = 'button';
          const gone = () => { collapse(c, 'Stopped.'); resolve({ text: '' }); };
          pend.add(gone);
          const finish = () => { const text = input ? input.value.trim() : ''; if (input && !text) return; pend.delete(gone); collapse(c, input ? 'You answered: ' + text : 'You continued.'); setState('Working', 'live'); resolve({ text }); };
          go.onclick = finish; if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(); });
          bar.appendChild(go); c.appendChild(bar); ask(c);
        });
      },
      abortPending() { Array.from(pend).forEach((f) => { try { f(); } catch (e) {} }); pend.clear(); },
      cancelled() { setState('Cancelled', ''); },
      limit(message) {
        const c = el('div', 'limitcard'); c.appendChild(el('div', '', message));
        const a = el('a', 'btn primary small', 'See plans'); a.href = d.base + '/upgrade'; a.target = '_blank'; c.appendChild(a); ask(c);
      },
      finish(answer) {
        say.textContent = ''; setState('Done', ''); st.querySelector('.spin') && st.querySelector('.spin').remove();
        const f = el('div', 'final'), m = el('div', 'md'); m.innerHTML = d.md(answer); d.links(m); f.appendChild(m);
        m.querySelectorAll('pre').forEach((pre) => { const b = el('button', 'code-copy'); b.type = 'button'; b.innerHTML = d.ICON('copy', 14); b.onclick = () => d.copy(pre.innerText); pre.appendChild(b); });
        const acts = el('div', 'acts'); const cp = el('button'); cp.type = 'button'; cp.innerHTML = d.ICON('copy', 15) + '<span>Copy</span>'; cp.onclick = () => d.copy(m.innerText); acts.appendChild(cp);
        if (chatUrl) { const a = el('a'); a.href = chatUrl; a.target = '_blank'; a.innerHTML = d.ICON('external-link', 15) + '<span>Open on the website</span>'; acts.appendChild(a); }
        f.appendChild(acts); body.appendChild(f); d.scroll();
      },
      stopped() { setState('Stopped', 'bad'); const c = el('div', 'pcard stopcard'); c.appendChild(el('p', 'done-note', 'Stopped. Nothing more will be done.')); body.appendChild(c); },
      error(e) {
        setState('Stopped', 'bad');
        if (e && e.limit) { ui.limit(e.message); return; }
        let m = (e && e.message) || 'Something went wrong.';
        if (/failed to fetch|networkerror|load failed/i.test(m)) m = 'Could not reach Code GPT. Please check your internet connection.';
        const c = el('div', 'pcard stopcard'); const ct = el('div', 'ct'); ct.innerHTML = d.ICON('triangle-alert', 17) + '<span></span>'; ct.lastChild.textContent = m; c.appendChild(ct); body.appendChild(c); d.scroll();
      },
      ended(R) { const sp = st.querySelector('.spin'); if (sp && st.classList.contains('live')) { setState('Done', ''); } d.onEnded(R); },
      countSteps() { return count; }
    };
    return ui;
  }
  window.CGRunUI = { create };
})();
