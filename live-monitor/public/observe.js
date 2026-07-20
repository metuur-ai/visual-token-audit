/* observe.js — Session Observability UI (Preact + htm, no build step).
   Data: GET /api/snapshot (session picker), GET /api/observe/<id> (entity model, spec §2). */
import { h, render } from '/vendor/preact.module.js';
import { useState, useEffect, useMemo, useRef } from '/vendor/hooks.module.js';
import htm from '/vendor/htm.module.js';

const html = htm.bind(h);

/* ============================ constants ============================ */
const CAP_FALLBACK = 200000;
const AUTOCOMPACT_BUF = 33000;
const POLL_MS = 5000;
const SNAPSHOT_POLL_MS = 30000;
const KORDER = ['system', 'memory', 'rule', 'skill', 'command', 'plugin', 'mcp', 'hook', 'tool', 'agent'];
const COLOR = { tool: '#f97316', skill: '#d97706', command: '#7c3aed', plugin: '#0d9488', mcp: '#2563eb', agent: '#db2777', memory: '#ca8a04', system: '#6b7280', hook: '#dc2626', rule: '#155e75' };
const REG_TABS = [['skill', 'Skills'], ['command', 'Commands'], ['rule', 'Rules'], ['plugin', 'Plugins'], ['mcp', 'MCP'], ['tool', 'Tools'], ['agent', 'Agents'], ['memory', 'Memory'], ['hook', 'Hooks']];

/* ============================ helpers ============================ */
const fmt = n => { n = n || 0; return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : '' + Math.round(n); };
const money = n => '$' + (n || 0).toFixed(2);
const durFmt = ms => {
  if (!ms || ms < 0) ms = 0;
  const s = ms / 1000;
  if (s < 60) return Math.round(s) + 's';
  const m = s / 60;
  if (m < 60) return (m < 10 ? m.toFixed(1) : Math.round(m)) + 'm';
  return Math.floor(m / 60) + 'h' + String(Math.round(m % 60)).padStart(2, '0');
};
const clock = iso => {
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
};
const dateLine = iso => {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + clock(iso);
};
const LIVE_MS = 120000;
const rel = iso => {
  const d = Date.now() - Date.parse(iso);
  if (isNaN(d)) return '—';
  const m = d / 60000;
  if (m < 1) return 'now';
  if (m < 60) return Math.floor(m) + 'm ago';
  const hh = m / 60;
  if (hh < 24) return Math.floor(hh) + 'h ago';
  return Math.floor(hh / 24) + 'd ago';
};
const base = n => String(n || '').split(' — ')[0].split(' (')[0].trim();
const shortModel = m => String(m || '?').replace(/^claude-/, '');
const sum = (arr, f) => (arr || []).reduce((a, b) => a + (f(b) || 0), 0);
const toolTotal = n => Object.values(n.tools || {}).reduce((a, b) => a + b, 0);

/* ============================ model ============================ */
/* /api/observe/<id> → { v, cap, generatedAt, session:{sessionId,project,cwd,firstTs,lastTs,prompts},
   nodes:[{id,type,name,label,model,parentId,start,dur,selfTok,cost,ctx,turns,tools,pre[],dyn[],
           ctxBreakdown:{ctx,base,assistant,toolResults,prompts,overflow}, toolTokens:{<name>:tk}}],
   waste:{preTotal,observableTotal,wasted,wastePct,turnCount} }
   ctxBreakdown reconciles the whole window: base(system+tools+memory) + toolResults + assistant + prompts = ctx.
   toolTokens attributes tool_result bytes/4 back to the tool that produced them (Read, Bash, Explore, …). */
function buildModel(data) {
  const byId = {};
  (data.nodes || []).forEach(n => { byId[n.id] = { ...n, pre: n.pre || [], dyn: n.dyn || [], tools: n.tools || {}, children: [] }; });
  const all = Object.values(byId);
  all.forEach(n => { if (n.parentId && byId[n.parentId]) byId[n.parentId].children.push(n); });
  const root = all.find(n => n.type === 'session') || all.find(n => !n.parentId || !byId[n.parentId]) || null;
  if (!root) return null;

  const rolls = {};
  const roll = n => {
    if (rolls[n.id]) return rolls[n.id];
    let tok = n.selfTok || 0, cost = n.cost || 0, agents = 0, tools = toolTotal(n), turns = n.turns || 0;
    n.children.forEach(c => { const r = roll(c); tok += r.tok; cost += r.cost; agents += 1 + r.agents; tools += r.tools; turns += r.turns; });
    return (rolls[n.id] = { tok, cost, agents, tools, turns });
  };
  roll(root);

  const durs = {};
  const rollDur = n => {
    if (durs[n.id] !== undefined) return durs[n.id];
    return (durs[n.id] = n.children.reduce((d, c) => Math.max(d, rollDur(c)), n.dur || 0));
  };
  rollDur(root);

  const depth = n => (n.children.length ? 1 + Math.max(...n.children.map(depth)) : 0);
  const walk = (n, f) => { f(n); n.children.forEach(c => walk(c, f)); };
  const descDyn = n => { let o = []; n.children.forEach(c => { o = o.concat((c.dyn || []).map(d => ({ ...d, _node: c.name })), descDyn(c)); }); return o; };
  const parentOf = {};
  walk(root, n => n.children.forEach(c => { parentOf[c.id] = n; }));
  const order = [];
  walk(root, n => order.push(n));

  return {
    byId, root, rolls, rollDur: n => durs[n.id] ?? rollDur(n), depth, walk, descDyn, parentOf, order,
    cap: data.cap || CAP_FALLBACK,
    waste: data.waste || null,
    session: data.session || null,
    generatedAt: data.generatedAt,
  };
}

/* registry fusion (spec §4.6): declared catalogue (root pre) ⨝ fired events (dyn across tree) + tool tallies */
function registryRows(m, kind) {
  const tally = name => { let c = 0; m.walk(m.root, nd => { c += (nd.tools || {})[name] || 0; }); return c; };
  const tokensOf = name => { let t = 0; m.walk(m.root, nd => { t += (nd.toolTokens || {})[name] || 0; }); return t; };
  const events = [];
  m.walk(m.root, nd => (nd.dyn || []).forEach(d => { if (d.k === kind) events.push(d); }));

  if (kind === 'agent') {
    // catalogue is the tree itself: group agent nodes by name
    const g = {};
    m.walk(m.root, nd => {
      if (nd.type !== 'agent') return;
      const r = (g[nd.name] = g[nd.name] || { name: nd.name, descTk: 0, bodyTk: 0, calls: 0, hits: [], used: true });
      r.calls++; r.bodyTk += m.rolls[nd.id].tok;
    });
    Object.values(g).forEach(r => { r.hits = events.filter(e => base(e.n) === r.name); });
    return Object.values(g).sort((a, b) => b.bodyTk - a.bodyTk);
  }

  const rows = (m.root.pre || []).filter(p => p.k === kind).map(d => {
    const key = base(d.n);
    const hits = events.filter(e => base(e.n) === key);
    const tallied = tally(key);
    const calls = (kind === 'tool' || kind === 'mcp') ? (tallied || hits.length) : hits.length;
    return { name: key, descTk: d.tk || 0, est: !!d.est, hits, bodyTk: sum(hits, x => x.tk), calls, used: !!(hits.length || calls || d.used) };
  });
  const push = (key, hits, calls) => {
    if (rows.some(r => r.name === key)) return;
    rows.push({ name: key, descTk: 0, hits, bodyTk: sum(hits, x => x.tk), calls, used: !!(calls || hits.length), runtimeOnly: true });
  };
  // runtime-only rows: fired without a preload record
  const seen = new Set();
  events.forEach(e => {
    const key = base(e.n);
    if (seen.has(key)) return; seen.add(key);
    push(key, events.filter(x => base(x.n) === key), (kind === 'tool' || kind === 'mcp') ? (tally(key) || events.filter(x => base(x.n) === key).length) : events.filter(x => base(x.n) === key).length);
  });
  // tools/mcp: union in every name seen in per-node tool tallies
  if (kind === 'tool' || kind === 'mcp') {
    const names = new Set();
    m.walk(m.root, nd => Object.keys(nd.tools || {}).forEach(t => {
      const isMcp = t.startsWith('mcp__');
      if ((kind === 'mcp') === isMcp) names.add(t);
    }));
    names.forEach(t => push(t, [], tally(t)));
    rows.forEach(r => { r.resultTk = tokensOf(r.name); });   // tool_result bytes/4 rolled up across the tree
  }
  return rows.sort((a, b) => (b.descTk + b.bodyTk + (b.resultTk || 0)) - (a.descTk + a.bodyTk + (a.resultTk || 0)) || b.calls - a.calls);
}

/* ============================ components ============================ */
const sessHref = id => '?session=' + encodeURIComponent(id);

function SessionStrip({ sessions, sid, setSid }) {
  const [openP, setOpenP] = useState(false);
  const [off, setOff] = useState(0);   // px scrolled into the strip
  const [max, setMax] = useState(0);   // max scrollable px (0 = everything fits)
  const wrapRef = useRef(null);
  const trackRef = useRef(null);
  const now = Date.now();
  const isLive = s => now - Date.parse(s.lastTs) < LIVE_MS;
  const all = (sessions || []).slice().sort((a, b) => String(b.lastTs).localeCompare(String(a.lastTs)));
  const live = all.filter(isLive);
  const past = all.filter(s => !isLive(s));
  const cur = all.find(s => s.sessionId === sid);
  const curPast = cur && !isLive(cur) ? cur : null;

  /* measure overflow — on mount, resize, and whenever the card list changes */
  useEffect(() => {
    const m = () => {
      const w = wrapRef.current, t = trackRef.current;
      if (!w || !t) return;
      setMax(Math.max(0, t.scrollWidth - w.clientWidth));
    };
    m();
    window.addEventListener('resize', m);
    return () => window.removeEventListener('resize', m);
  }, [sessions && sessions.length]);
  useEffect(() => { setOff(o => Math.min(o, max)); }, [max]);

  /* dropdown close on outside click / Esc */
  useEffect(() => {
    if (!openP) return;
    const onDoc = e => { if (!e.target.closest('.picker')) setOpenP(false); };
    const onKey = e => { if (e.key === 'Escape') setOpenP(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [openP]);

  const step = () => Math.max(160, (wrapRef.current ? wrapRef.current.clientWidth : 400) - 90);
  const nav = d => setOff(o => Math.max(0, Math.min(max, o + d * step())));
  const pick = (e, id) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // let new-tab gestures through
    e.preventDefault();
    setSid(id);
    setOpenP(false);
  };

  const card = s => html`<a key=${s.sessionId} class="ss-card ${s.sessionId === sid ? 'sel' : ''}"
    href=${sessHref(s.sessionId)} onClick=${e => pick(e, s.sessionId)}
    aria-current=${s.sessionId === sid ? 'true' : 'false'} title=${(s.project || '?') + ' · ' + s.sessionId}>
    <span class="pk-dot"></span>
    <span class="ss-p">${s.project || '?'}</span>
    <span class="pk-id">${String(s.sessionId).slice(0, 8)}</span>
    <span class="ss-meta num">${rel(s.lastTs)}</span>
  </a>`;

  return html`<div class="sbar">
    <span class="sbar-l">Live<span class="sbar-n num">${live.length}</span></span>
    ${max > 0 ? html`<button class="ss-nav" onClick=${() => nav(-1)} disabled=${off <= 0} aria-label="previous sessions">‹</button>` : null}
    <div class="ss-wrap" ref=${wrapRef}>
      <div class="ss-track" ref=${trackRef} style="transform:translateX(-${off}px)">
        ${live.length ? live.map(card)
        : html`<span class="ss-empty">${!sessions ? 'loading sessions…' : 'no live sessions — pick a previous one'}</span>`}
      </div>
    </div>
    ${max > 0 ? html`<button class="ss-nav" onClick=${() => nav(1)} disabled=${off >= max} aria-label="more sessions">›</button>` : null}
    <div class="picker">
      <button class="pk-btn ${curPast ? 'sel' : ''}" onClick=${() => setOpenP(o => !o)} aria-haspopup="listbox" aria-expanded=${openP} disabled=${past.length === 0}>
        ${curPast
        ? html`<span class="pk-dot off"></span><span class="pk-p">${curPast.project || '?'}</span><span class="pk-id">${String(curPast.sessionId).slice(0, 8)}</span>`
        : html`<span class="pk-p" style="font-weight:500">Previous</span><span class="pk-id">${past.length}</span>`}
        <span class="pk-car">▾</span>
      </button>
      ${openP ? html`<div class="pk-pop" role="listbox">
        <div class="pk-hd"><span>${past.length} inactive session${past.length === 1 ? '' : 's'}</span><span>${live.length ? live.length + ' live' : 'none live'}</span></div>
        ${past.length === 0 ? html`<div class="empty">no inactive sessions</div>` :
        past.map(s => html`<a key=${s.sessionId} role="option" aria-selected=${s.sessionId === sid}
          class="pk-row ${s.sessionId === sid ? 'sel' : ''}" href=${sessHref(s.sessionId)} onClick=${e => pick(e, s.sessionId)}>
          <span class="pk-dot off"></span>
          <span class="pk-p">${s.project || '?'}</span>
          <span class="pk-id">${String(s.sessionId).slice(0, 8)}</span>
          <span class="pk-meta num">${s.prompts ? s.prompts + ' prompt' + (s.prompts === 1 ? '' : 's') + ' · ' : ''}${rel(s.lastTs)}</span>
          <span class="pk-ck">${s.sessionId === sid ? '✓' : ''}</span>
        </a>`)}
      </div>` : null}
    </div>
  </div>`;
}

function TreeNode({ node, m, sel, onSel, open, toggle }) {
  const r = m.rolls[node.id];
  const isOpen = open.has(node.id) || node === m.root;
  return html`<div>
    <div class="node ${sel === node.id ? 'sel' : ''}" onClick=${() => onSel(node.id)}>
      <span class="tw ${isOpen ? 'open' : ''}" onClick=${e => { if (node.children.length) { e.stopPropagation(); toggle(node.id); } }}>${node.children.length ? '▶' : ''}</span>
      <span class="b ${node.type === 'session' ? 'b-system' : 'b-agent'}">${shortModel(node.model)}</span>
      <span class="nname">${node.name}</span>
      <span class="nlab" title=${node.label || ''}>${node.label || ''}</span>
      ${r && r.agents ? html`<span class="roll">+${r.agents}</span>` : null}
      <span class="ntok num">${fmt(node.selfTok)}</span>
    </div>
    ${node.children.length ? html`<div class="kids ${isOpen ? '' : 'hide'}">
      ${node.children.map(c => html`<${TreeNode} key=${c.id} node=${c} m=${m} sel=${sel} onSel=${onSel} open=${open} toggle=${toggle} />`)}
    </div>` : null}
  </div>`;
}

function ContextPanel({ n, m }) {
  const cap = m.cap;
  const buf = n === m.root ? AUTOCOMPACT_BUF : 0;
  const cb = n.ctxBreakdown;

  /* new model: every token reconciled to ctx = base + toolResults + assistant + prompts (spec §2.1) */
  if (cb && cb.ctx) {
    const ctx = cb.ctx || 0;
    const free = Math.max(0, cap - ctx - buf);
    const pre = sum(n.pre, p => p.tk);   // enumerated harness — a labelled subset of `base`
    const segs = [
      ['#6b7280', cb.base], ['#f97316', cb.toolResults], ['#db2777', cb.assistant],
      ['#2563eb', cb.prompts], ['#f59e0b', buf], ['#e5e3de', free],
    ];
    const legend = [
      ['#6b7280', 'system + tools + memory'], ['#f97316', 'tool results'], ['#db2777', 'assistant'],
      ['#2563eb', 'prompts + slack'], ...(buf ? [['#f59e0b', 'autocompact']] : []), ['#e5e3de', 'free'],
    ];
    const rows = [
      ['System + tools + memory', cb.base, '#6b7280', 'base floor before your first prompt — system prompt, tool schemas, CLAUDE.md'],
      ['Tool results', cb.toolResults, '#f97316', 'file reads · bash output · skill bodies · sub-agent reports'],
      ['Assistant output', cb.assistant, '#db2777', 'model replies + tool-call JSON (measured)'],
      ['Prompts + slack', cb.prompts, '#2563eb', 'your messages + estimation slack'],
      ...(buf ? [['Autocompact buffer', buf, '#f59e0b', 'reserved headroom before auto-compaction']] : []),
      ['Free space', free, '#d6d4ce', 'unused window'],
    ];
    return html`<section class="panel fade">
      <div class="ph"><span class="pt">Context window</span><span class="psub">${n.model || ''}</span></div>
      <div class="big">${fmt(ctx)} <span>/ ${fmt(cap)} (${Math.round(ctx / cap * 100)}%)</span>
        <div class="psub" style="margin-top:2px">this agent's own window · every token reconciled to ctx</div></div>
      <div class="stack">${segs.map(([c, v]) => html`<div style="width:${v / cap * 100}%;background:${c}"></div>`)}</div>
      <div class="legend">${legend.map(([c, l]) => html`<span><i style="background:${c}"></i>${l}</span>`)}</div>
      ${cb.overflow ? html`<div class="lp-d" style="color:#b45309;margin-top:6px">⚠ ${fmt(cb.overflow)} tokens of earlier history compacted/evicted — measured usage exceeds the live window by this much.</div>` : null}
      <div class="rows">${rows.map(([k, v, c, d]) => html`<div class="row"><span class="k" title=${d || ''}>${k}</span><span class="v num">${fmt(v)}</span><span class="bar"><i style="width:${Math.min(100, v / cap * 100)}%;background:${c}"></i></span></div>`)}</div>
      ${cb.base ? html`<div class="lp-d" style="margin-top:8px">Of the ${fmt(cb.base)} base floor, ~${fmt(pre)} is enumerated in the registry below; the remainder is the base system prompt + tool schemas the transcript doesn't itemize.</div>` : null}
    </section>`;
  }

  /* legacy fallback: older payloads without ctxBreakdown — residual "messages" catch-all */
  const pre = sum(n.pre, p => p.tk);
  const dyn = sum(n.dyn, d => d.tk);
  const sys = sum((n.pre || []).filter(p => p.k === 'system'), p => p.tk);
  const harness = Math.max(0, pre - sys);
  const ctx = n.ctx || 0;
  const msgs = Math.max(0, ctx - pre - dyn);
  const free = Math.max(0, cap - ctx - buf);
  const segs = [['#9ca3af', sys], ['#eab308', harness], ['#2563eb', dyn], ['#60a5fa', msgs], ['#f59e0b', buf], ['#e5e3de', free]];
  const legend = [['#9ca3af', 'system'], ['#eab308', 'preloaded harness'], ['#2563eb', 'invoked'], ['#60a5fa', 'messages'], ['#f59e0b', 'autocompact'], ['#e5e3de', 'free']];
  const rows = [['Preloaded harness', pre, '#eab308'], ['Invoked mid-run', dyn, '#2563eb'], ['Messages', msgs, '#60a5fa'],
    ...(buf ? [['Autocompact buffer', buf, '#f59e0b']] : []), ['Free space', free, '#d6d4ce']];
  return html`<section class="panel fade">
    <div class="ph"><span class="pt">Context window</span><span class="psub">${n.model || ''}</span></div>
    <div class="big">${fmt(ctx)} <span>/ ${fmt(cap)} (${Math.round(ctx / cap * 100)}%)</span>
      <div class="psub" style="margin-top:2px">this agent's own window · estimated from token usage</div></div>
    <div class="stack">${segs.map(([c, v]) => html`<div style="width:${v / cap * 100}%;background:${c}"></div>`)}</div>
    <div class="legend">${legend.map(([c, l]) => html`<span><i style="background:${c}"></i>${l}</span>`)}</div>
    <div class="rows">${rows.map(([k, v, c]) => html`<div class="row"><span class="k">${k}</span><span class="v num">${fmt(v)}</span><span class="bar"><i style="width:${Math.min(100, v / cap * 100)}%;background:${c}"></i></span></div>`)}</div>
  </section>`;
}

function AggregatePanel({ n, m, scope }) {
  const r = m.rolls[n.id];
  const t = scope === 'tree';
  const selfTools = toolTotal(n);
  const mets = [
    ['Total tokens', fmt(t ? r.tok : n.selfTok), t ? 'self ' + fmt(n.selfTok) + ' + ' + fmt(r.tok - (n.selfTok || 0)) + ' below' : 'excludes descendants'],
    ['Est. cost', '~' + money(t ? r.cost : n.cost), t ? 'self ' + money(n.cost) : 'this agent only', 'o'],
    ['Wall time', durFmt(t ? m.rollDur(n) : n.dur), t ? 'children run inside this span' : 'own execution'],
    ['Tool calls', '' + (t ? r.tools : selfTools), Object.keys(n.tools || {}).length + ' distinct here'],
    ['Sub-agents', '' + r.agents, r.agents ? 'depth ' + m.depth(n) : 'leaf node'],
    ['Turns', '' + (t ? r.turns : (n.turns || 0)), shortModel(n.model)],
  ];
  return html`<section class="panel fade">
    <div class="ph"><span class="pt">Aggregate</span><span class="psub">${t ? 'entire subtree' : 'self only'}</span></div>
    <div class="mets">${mets.map(([l, v, d, o]) => html`<div class="met"><div class="l">${l}</div><div class="n num ${o || ''}">${v}</div><div class="d">${d}</div></div>`)}</div>
  </section>`;
}

function RegistryPanel({ m, reg, setReg }) {
  const rows = useMemo(() => registryRows(m, reg), [m, reg]);
  const isSkill = reg === 'skill', isTool = reg === 'tool' || reg === 'mcp', isAgent = reg === 'agent';
  const head = isAgent
    ? ['Agent', 'Dispatches', 'Subtree tokens', 'Status', 'Dispatched by', 'First dispatch']
    : isSkill
    ? ['Skill', 'Description (always loaded)', 'Body (on invoke)', 'Status', 'Invoked by', 'First load']
    : isTool
    ? [reg === 'mcp' ? 'MCP tool' : 'Tool', 'Preloaded', 'Result tokens', 'Status', 'Called by', 'First use']
    : ['Resource', 'Preloaded', 'Runtime tokens', 'Status', 'Triggered by', 'First use'];
  return html`<section class="panel fade">
    <div class="ph"><span class="pt">Resource registry</span><span class="psub">what was available · what was actually touched · session-scoped</span></div>
    <div class="tabs">${REG_TABS.map(([k, l]) => {
      const rs = registryRows(m, k), un = rs.filter(r => !r.used).length;
      return html`<button class=${reg === k ? 'on' : ''} onClick=${() => setReg(k)}>${l}<span class="n">${rs.length}</span>${un ? html`<span class="n" style="background:#fef3c7;color:#92400e">${un} unused</span>` : null}</button>`;
    })}</div>
    ${rows.length === 0 ? html`<div class="empty">nothing of kind “${reg}” registered or fired in this session</div>` : html`
    <table><thead><tr>${head.map((hh, i) => html`<th class=${i > 0 && i < 3 ? 'r' : ''}>${hh}</th>`)}</tr></thead>
    <tbody>${rows.map(r => {
      const who = [...new Set((r.hits || []).map(x => x.by).filter(Boolean))].join(', ');
      const first = r.hits && r.hits.length ? clock(r.hits.reduce((a, b) => (a.at < b.at ? a : b)).at) : '';
      return html`<tr class=${r.used ? '' : 'waste'}>
        <td><span class="b b-${reg}">${reg}</span> <b>${r.name}</b>${r.runtimeOnly ? html` <span class="mut">· runtime only</span>` : null}</td>
        <td class="r num mut">${isAgent ? (r.calls || '—') : (r.descTk ? (r.est ? '~' : '') + fmt(r.descTk) : '—')}</td>
        <td class="r num">${isAgent ? fmt(r.bodyTk) : isTool ? (r.resultTk ? fmt(r.resultTk) : '—') : (r.bodyTk ? fmt(r.bodyTk) : '—')}</td>
        <td>${r.used
          ? html`<span class="ok">✓ ${isAgent ? 'dispatched ×' + r.calls : isTool ? 'used' + (r.calls ? ' ×' + r.calls : '') : 'invoked ×' + (r.hits.length || r.calls)}</span>`
          : html`<span class="warn">✗ never used</span>${r.descTk ? html` <span class="mut">· ${fmt(r.descTk)} tok/turn wasted</span>` : null}`}</td>
        <td class="who">${who || html`<span class="mut">—</span>`}</td>
        <td class="mut num">${first || '—'}</td></tr>`;
    })}</tbody></table>`}
    ${isSkill ? html`<div class="lp-d" style="margin:9px 0 0">Skills load in two stages: the <b>description</b> sits in context from startup so the model knows the skill exists; the <b>body</b> only arrives when the skill is actually invoked. Unused skills still cost their description on every single turn.</div>` : null}
  </section>`;
}

function LoadingPanel({ n, m, scope, preF, setPreF, dynF, setDynF, grpOpen, toggleGrp }) {
  const pre = n.pre || [];
  const tot = sum(pre, p => p.tk), waste = sum(pre.filter(p => !p.used), p => p.tk);
  // True preloaded floor from usage accounting (turn-1 window minus first prompt).
  // pre[] is only the reminder-enumerated subset of this; base is comparable to /context.
  const floor = (n.ctxBreakdown && n.ctxBreakdown.base) || 0;
  const itemPct = floor ? tot / floor * 100 : 0;
  const pf = pre.filter(p => preF === 'all' || (preF === 'used' && p.used) || (preF === 'unused' && !p.used));
  const selfDyn = (n.dyn || []).map(d => ({ ...d, _self: true }));
  const dDyn = scope === 'tree' ? m.descDyn(n) : [];
  const dynAll = selfDyn.concat(dDyn)
    .filter(d => dynF === 'all' || (dynF === 'self' && d._self) || (dynF === 'desc' && !d._self))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const dynTot = sum(dynAll, d => d.tk);
  return html`<section class="panel fade">
    <div class="ph"><span class="pt">Loading panel</span><span class="psub">${n === m.root ? 'session startup vs. runtime' : n.name + ' · its own boot context'}</span></div>
    <div class="lp">
      <div class="lp-col">
        <div class="lp-h"><span class="lp-t">Auto-loaded at startup</span><span class="chip">always in context</span></div>
        <div class="lp-d">Present before the first token. Paid for on every turn whether or not the model touched it.</div>
        ${floor ? html`
        <div class="stat"><b>${fmt(floor)}</b> preloaded floor <span class="mut">· system prompt + tool schemas + skill/agent descriptions + memory (comparable to /context)</span></div>
        <div class="lp-d" style="margin:3px 0 5px">Only ~${fmt(tot)} (${itemPct < 1 ? '<1' : Math.round(itemPct)}%) is itemized below from transcript evidence — the rest is harness text the transcript can't break out.</div>
        <div class="stat">${pre.length} resources itemized${tot ? html` · <span class="warn">${fmt(waste)} (${Math.round(waste / tot * 100)}%) of these never referenced</span>` : null}${pre.some(p => p.est) ? html` <span class="mut">· ~ = estimated</span>` : null}</div>`
        : html`
        <div class="stat"><b>${fmt(tot)}</b> tokens preloaded${tot ? html` · <span class="warn">${fmt(waste)} (${Math.round(waste / tot * 100)}%) never referenced</span>` : null} · ${pre.length} resources${pre.some(p => p.est) ? html` <span class="mut">· ~ = estimated</span>` : null}</div>`}
        <div class="filters">${[['all', 'all'], ['used', 'used'], ['unused', 'never used']].map(([f, l]) =>
          html`<button class=${preF === f ? 'on' : ''} onClick=${() => setPreF(f)}>${l}</button>`)}</div>
        <div class="scroll">
          ${pf.length === 0 ? html`<div class="empty">nothing recorded for this node's boot context</div>` :
          KORDER.filter(k => pf.some(p => p.k === k)).map(k => {
            const items = pf.filter(p => p.k === k), t = sum(items, i => i.tk), un = items.filter(i => !i.used).length;
            const isOpen = grpOpen.has(k);
            return html`<div class="grp">
              <div class="grp-h" onClick=${() => toggleGrp(k)}>
                <span class="tw ${isOpen ? 'open' : ''}">▶</span><span class="b b-${k}">${k}</span>
                <span>${items.length}</span>${un ? html`<span class="warn">${un} unused</span>` : html`<span class="ok">all used</span>`}
                <span class="c num">${fmt(t)} tok</span></div>
              <div class="grp-b ${isOpen ? '' : 'hide'}">${items.map(p => html`<div class="res ${p.used ? '' : 'is-unused'}">
                <span class="dot ${p.used ? 'used' : 'unused'}"></span><span class="nm" title=${p.n}>${p.n}</span>
                <span class="tk num">${p.est ? '~' : ''}${fmt(p.tk)}</span></div>`)}</div>
            </div>`;
          })}
        </div>
      </div>
      <div class="lp-col">
        <div class="lp-h"><span class="lp-t">Invoked during execution</span><span class="chip">on demand</span></div>
        <div class="lp-d">Pulled in mid-run because something asked. Each row records who triggered it and when.</div>
        <div class="stat"><b>${fmt(dynTot)}</b> tokens invoked · ${dynAll.length} events</div>
        <div class="filters">${[['all', 'all'], ['self', 'this agent'], ['desc', 'descendants']].map(([f, l]) =>
          html`<button class=${dynF === f ? 'on' : ''} onClick=${() => setDynF(f)}>${l}</button>`)}</div>
        <div class="scroll">
          ${dynAll.length === 0 ? html`<div class="empty">no runtime loads ${dynF !== 'all' ? 'matching this filter' : 'attributed to this scope'}</div>` :
          dynAll.map(d => html`<div class="res">
            <span class="dot dyn" style="background:${COLOR[d.k] || 'var(--blue)'}"></span>
            <span class="b b-${d.k}">${d.k}</span>
            <span class="nm" title=${d.n}>${d.n}</span>
            <span class="who">${d.by || ''}</span>
            <span class="tk num">${d.tk ? '+' + fmt(d.tk) : '—'}</span>
            <span class="tm num">${clock(d.at)}</span></div>`)}
        </div>
      </div>
    </div>
  </section>`;
}

function UsagePanel({ n, m, scope }) {
  const t = scope === 'tree';
  const nodes = useMemo(() => { const o = []; if (t) m.walk(n, x => o.push(x)); else o.push(n); return o; }, [n, m, t]);
  // tool calls
  const tools = {};
  nodes.forEach(x => Object.entries(x.tools || {}).forEach(([k, v]) => { tools[k] = (tools[k] || 0) + v; }));
  const trows = Object.entries(tools).sort((a, b) => b[1] - a[1]);
  const tmax = Math.max(1, ...trows.map(r => r[1]));
  // tokens by kind: amber = preloaded (this node's own boot), blue = invoked across scope
  const kinds = {};
  (n.pre || []).forEach(p => { (kinds[p.k] = kinds[p.k] || { pre: 0, dyn: 0 }).pre += p.tk || 0; });
  nodes.forEach(x => (x.dyn || []).forEach(d => { (kinds[d.k] = kinds[d.k] || { pre: 0, dyn: 0 }).dyn += d.tk || 0; }));
  // tool_result payloads counted as invoked tokens for their tool/mcp kind (spec §4.6)
  nodes.forEach(x => Object.entries(x.toolTokens || {}).forEach(([name, tk]) => {
    const k = name.startsWith('mcp__') ? 'mcp' : 'tool';
    (kinds[k] = kinds[k] || { pre: 0, dyn: 0 }).dyn += tk || 0;
  }));
  const krows = KORDER.filter(k => kinds[k]).map(k => [k, kinds[k]]);
  const kmax = Math.max(1, ...krows.map(([, v]) => v.pre + v.dyn));
  // per-model selfTok
  const models = {};
  nodes.forEach(x => { const mm = shortModel(x.model); models[mm] = (models[mm] || 0) + (x.selfTok || 0); });
  const mrows = Object.entries(models).sort((a, b) => b[1] - a[1]);
  const mmax = Math.max(1, ...mrows.map(r => r[1]));
  return html`<section class="panel fade">
    <div class="ph"><span class="pt">Usage</span><span class="psub">${t ? 'node + descendants' : 'this node only'}</span></div>
    <div class="usegrid">
      <div>
        <div class="ug-h"><span>Tool calls</span><span>${trows.length}</span></div>
        ${trows.length === 0 ? html`<div class="empty">no tool calls</div>` :
        trows.slice(0, 18).map(([k, v]) => html`<div class="ubar"><span class="un" title=${k}>${k.replace(/^mcp__/, '')}</span><span class="ut"><i style="width:${v / tmax * 100}%;background:${k.startsWith('mcp__') ? COLOR.mcp : COLOR.tool}"></i></span><span class="uc num">${v}</span></div>`)}
      </div>
      <div>
        <div class="ug-h"><span>Tokens by kind</span><span>amber = preloaded · blue = invoked</span></div>
        ${krows.length === 0 ? html`<div class="empty">no resource tokens recorded</div>` :
        krows.map(([k, v]) => html`<div class="ubar"><span class="un">${k}</span><span class="ut" style="display:flex"><i style="width:${v.pre / kmax * 100}%;background:#eab308;border-radius:0"></i><i style="width:${v.dyn / kmax * 100}%;background:#2563eb;border-radius:0"></i></span><span class="uc num">${fmt(v.pre + v.dyn)}</span></div>`)}
      </div>
      <div>
        <div class="ug-h"><span>Model interactions</span><span>self tokens</span></div>
        ${mrows.map(([k, v]) => html`<div class="ubar"><span class="un" title=${k}>${k}</span><span class="ut"><i style="width:${v / mmax * 100}%;background:${COLOR.agent}"></i></span><span class="uc num">${fmt(v)}</span></div>`)}
      </div>
    </div>
  </section>`;
}

function Timeline({ m, sel, onSel }) {
  const [tip, setTip] = useState(null); // {x, y, t, s} — custom tooltip, fixed-position
  const showTip = (e, t, s) => setTip({ x: e.clientX, y: e.clientY, t, s });
  const hideTip = () => setTip(null);
  const root = m.root;
  const t0 = Date.parse(root.start);
  let end = t0 + (root.dur || 0);
  m.walk(root, n => { const s = Date.parse(n.start); if (!isNaN(s)) end = Math.max(end, s + (n.dur || 0)); (n.dyn || []).forEach(d => { const a = Date.parse(d.at); if (!isNaN(a)) end = Math.max(end, a); }); });
  const span = Math.max(1, end - t0);
  const x = ts => Math.min(100, Math.max(0, (ts - t0) / span * 100));
  const R = m.rolls[root.id] || { tok: 0, cost: 0, agents: 0, tools: 0 };
  let skillLoads = 0, cmdRuns = 0;
  m.walk(root, n => (n.dyn || []).forEach(d => { if (d.k === 'skill') skillLoads++; if (d.k === 'command') cmdRuns++; }));
  const chips = [
    ['' + m.order.length, 'agents'],
    ['' + R.tools, 'tool calls'],
    ['' + skillLoads, 'skill loads'],
    ['' + cmdRuns, 'commands'],
    [fmt(R.tok), 'tokens'],
    ['~' + money(R.cost), 'cost'],
    [durFmt(span), 'wall time'],
  ];
  const ticks = [];
  for (let i = 0; i <= 6; i++) ticks.push(clock(new Date(t0 + span * i / 6).toISOString()));
  return html`<section class="panel fade">
    <div class="ph"><span class="pt">Timeline</span><span class="psub">click a lane to drill in · hover a marker</span></div>
    <div class="tl-head">
      ${chips.map(([b, l]) => html`<span class="tl-stat"><b>${b}</b> ${l}</span>`)}
    </div>
    <div class="axis">${ticks.map(t => html`<span>${t}</span>`)}</div>
    <div>${m.order.map(n => {
      const s = Date.parse(n.start);
      const left = isNaN(s) ? 0 : x(s);
      const w = Math.max(0.4, (n.dur || 0) / span * 100);
      return html`<div class="lane">
        <span class="lane-n ${sel === n.id ? 'sel' : ''}" onClick=${() => onSel(n.id)} title=${n.label || n.name}>${n.name}</span>
        <span class="track">
          <span class="span" style="left:${left}%;width:${Math.min(w, 100 - left)}%;background:${n.type === 'session' ? '#6b7280' : COLOR.agent}"
            onMouseEnter=${e => showTip(e, n.label || n.name, `${durFmt(n.dur || 0)} · ${fmt(n.selfTok)} tok · ${money(n.cost || 0)}`)}
            onMouseMove=${e => showTip(e, n.label || n.name, `${durFmt(n.dur || 0)} · ${fmt(n.selfTok)} tok · ${money(n.cost || 0)}`)}
            onMouseLeave=${hideTip}></span>
          ${(n.dyn || []).map(d => {
            const a = Date.parse(d.at);
            if (isNaN(a)) return null;
            return html`<span class="mk ${d.k === 'skill' || d.k === 'command' ? 'd' : ''}" style="left:${x(a)}%;background:${COLOR[d.k] || '#999'}"
              onMouseEnter=${e => showTip(e, `${(d.k || '?').toUpperCase()} · ${d.n}`, `triggered by ${d.by || '?'} at ${clock(d.at)} · ${fmt(d.tk)} tok`)}
              onMouseMove=${e => showTip(e, `${(d.k || '?').toUpperCase()} · ${d.n}`, `triggered by ${d.by || '?'} at ${clock(d.at)} · ${fmt(d.tk)} tok`)}
              onMouseLeave=${hideTip}></span>`;
          })}
        </span>
      </div>`;
    })}</div>
    ${tip ? html`<div class="tl-tip" style="left:${tip.x}px;top:${tip.y}px">
      <div class="tt-t">${tip.t}</div>
      <div class="tt-s">${tip.s}</div>
    </div>` : null}
  </section>`;
}

/* ============================ app ============================ */
function App() {
  const [sessions, setSessions] = useState(null);
  const [sid, setSid] = useState(() => { try { return new URLSearchParams(location.search).get('session'); } catch { return null; } });
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [stale, setStale] = useState(false);
  const [sel, setSel] = useState(null);
  const [scope, setScope] = useState('tree');
  const [preF, setPreF] = useState('all');
  const [dynF, setDynF] = useState('all');
  const [reg, setReg] = useState('skill');
  const [open, setOpen] = useState(() => new Set());
  const [grpOpen, setGrpOpen] = useState(() => new Set(KORDER.filter(k => k !== 'tool')));

  /* session list — picker */
  useEffect(() => {
    let alive = true;
    const load = () => fetch('/api/snapshot')
      .then(r => { if (!r.ok) throw new Error('snapshot HTTP ' + r.status); return r.json(); })
      .then(j => {
        if (!alive) return;
        const ss = (j.sessions || []).slice().sort((a, b) => String(b.lastTs).localeCompare(String(a.lastTs)));
        setSessions(ss);
        setSid(cur => cur || (ss[0] && ss[0].sessionId) || null); // keep URL/user choice even if absent from this snapshot
      })
      .catch(e => { if (alive && !sessions) setErr(String(e.message || e)); });
    load();
    const t = setInterval(load, SNAPSHOT_POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  /* keep the URL in sync so right-click → open in new tab / reload lands on the same session */
  useEffect(() => {
    if (!sid) return;
    try { history.replaceState(null, '', sessHref(sid)); } catch { /* file:// etc. */ }
  }, [sid]);

  /* observe poll — every 5s, re-fetch on session change */
  useEffect(() => {
    if (!sid) return;
    let alive = true;
    setData(null); setErr(null); setSel(null); setOpen(new Set());
    const load = () => fetch('/api/observe/' + encodeURIComponent(sid))
      .then(r => { if (!r.ok) throw new Error('/api/observe HTTP ' + r.status); return r.json(); })
      .then(j => { if (!alive) return; setData(j); setErr(null); setStale(false); })
      .catch(e => { if (!alive) return; setStale(true); setErr(String(e.message || e)); });
    load();
    const t = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [sid]);

  const m = useMemo(() => (data ? buildModel(data) : null), [data]);
  const selId = m ? (sel && m.byId[sel] ? sel : m.root.id) : null;
  const n = m ? m.byId[selId] : null;

  const toggle = id => setOpen(o => { const s = new Set(o); s.has(id) ? s.delete(id) : s.add(id); return s; });
  const toggleGrp = k => setGrpOpen(o => { const s = new Set(o); s.has(k) ? s.delete(k) : s.add(k); return s; });
  const onSel = id => {
    setSel(id);
    if (m) { // open ancestors so selection is visible
      setOpen(o => { const s = new Set(o); let c = m.parentOf[id]; while (c) { s.add(c.id); c = m.parentOf[c.id]; } return s; });
    }
  };

  /* top bar figures — always session-scoped (spec §6.1) */
  const R = m ? m.rolls[m.root.id] : null;
  const preTot = m ? sum(m.root.pre, p => p.tk) : 0;
  const w = m && m.waste ? m.waste : null;

  const strip = html`<${SessionStrip} sessions=${sessions} sid=${sid} setSid=${setSid} />`;

  const top = html`<div class="top">
    <span class="logo">Session Observability</span>
    <nav class="topnav">
      <a href="/">Dashboard</a>
      <a href="/observe" class="on">Observe</a>
      <a href="/stats">Stats</a>
      <a href="/projects">Projects</a>
    </nav>
    <span class="tstat"><span class="l">agents</span><span class="v num">${R ? R.agents : '—'}</span></span>
    <span class="tstat"><span class="l">tokens</span><span class="v num">${R ? fmt(R.tok) : '—'}</span></span>
    <span class="tstat"><span class="l">preloaded</span><span class="v num">${m ? fmt(preTot) : '—'}</span></span>
    <span class="tstat"><span class="l">never used</span><span class="v warn num">${w ? fmt(w.wasted) + ' (' + (w.observableTotal ? Math.round(w.wasted / w.observableTotal * 100) : 0) + '%)' : '—'}</span></span>
    <span class="tstat"><span class="l">cost</span><span class="v num">${R ? '~' + money(R.cost) : '—'}</span></span>
    <span class="live ${stale || (err && !m) ? 'err' : ''}">${stale ? 'stale' : 'live'}</span>
  </div>`;

  if (!m) {
    return html`${top}${strip}<div class="state">
      ${err ? html`<div class="big-msg">Cannot load data</div><div>${err}</div><div style="margin-top:6px" class="mut">retrying every ${POLL_MS / 1000}s…</div>`
        : sessions && sessions.length === 0 ? html`<div class="big-msg">No sessions observed yet</div><div>Start a Claude Code session and this page will pick it up.</div>`
        : html`<div class="big-msg">Loading…</div><div class="mut">fetching ${sid ? '/api/observe/' + String(sid).slice(0, 8) + '…' : '/api/snapshot'}</div>`}
    </div>`;
  }

  const r = m.rolls[n.id];
  const isRoot = n === m.root;
  const path = []; { let c = n; while (c) { path.unshift(c); c = m.parentOf[c.id]; } }

  return html`${top}${strip}
  <div class="shell">
    <aside class="left">
      <div class="lh"><span>Execution tree</span><span>${m.order.length} nodes</span></div>
      <div class="tree"><${TreeNode} node=${m.root} m=${m} sel=${selId} onSel=${onSel} open=${open} toggle=${toggle} /></div>
    </aside>
    <main>
      ${stale && err ? html`<div class="banner">Polling failed (${err}) — showing last good snapshot from ${clock(m.generatedAt)}.</div>` : null}
      <div class="crumb">${path.map((p, i) => html`${i ? html`<span>/</span>` : null}<button onClick=${() => onSel(p.id)}>${p.name}</button>`)}</div>
      <h1>${isRoot ? (m.session ? m.session.project : n.name) : n.name + ' — ' + (n.label || '')}</h1>
      <div class="subline">
        ${isRoot ? html`<span title=${m.session ? m.session.cwd : ''}>${m.session ? m.session.cwd : ''}</span>` : html`<span class="b b-agent">${n.type}</span>`}
        <span>${dateLine(n.start)}</span>
        <span>${durFmt(scope === 'tree' ? m.rollDur(n) : n.dur)}</span>
        <span class="cost">~${money(scope === 'tree' ? r.cost : n.cost)}</span>
        <span class="chip">${n.model || '?'}</span>
      </div>
      <div class="scopebar">
        <span class="slab">Scope</span>
        <div class="seg">
          <button class=${scope === 'tree' ? 'on' : ''} onClick=${() => setScope('tree')}>Entire subtree</button>
          <button class=${scope === 'self' ? 'on' : ''} onClick=${() => setScope('self')}>This agent only</button>
        </div>
        <span class="snote">${(scope === 'tree' ? 'rolling up ' : 'excluding ') + r.agents + ' descendant agent' + (r.agents === 1 ? '' : 's')}</span>
      </div>
      <div class="grid2">
        <${ContextPanel} n=${n} m=${m} />
        <${AggregatePanel} n=${n} m=${m} scope=${scope} />
      </div>
      <${RegistryPanel} m=${m} reg=${reg} setReg=${setReg} />
      <${LoadingPanel} n=${n} m=${m} scope=${scope} preF=${preF} setPreF=${setPreF} dynF=${dynF} setDynF=${setDynF} grpOpen=${grpOpen} toggleGrp=${toggleGrp} />
      <${UsagePanel} n=${n} m=${m} scope=${scope} />
      <${Timeline} m=${m} sel=${selId} onSel=${onSel} />
    </main>
  </div>`;
}

render(html`<${App} />`, document.getElementById('root'));
