// Live Session Monitor — app.js  (v2)
// Talks to: GET /api/snapshot         → { events, sessions, startedAt }
//           GET /api/session/:id      → SessionDetail (v2)
//           GET /events               → SSE stream of MonitorEvent

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
/** @type {Map<string, object>} sessionId → SessionAgg */
const sessions = new Map();
const feedItems = [];           // MonitorEvent[], newest-first, capped 200
const FEED_CAP = 200;
const ACTIVE_THRESHOLD_MS = 60_000;

/** Currently open session id, or null */
let openSessionId = null;
let detailDebounceTimer = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const tSessions  = document.getElementById('t-sessions');
const tEvents    = document.getElementById('t-events');
const tInput     = document.getElementById('t-input');
const tOutput    = document.getElementById('t-output');
const tCr        = document.getElementById('t-cr');
const tCw        = document.getElementById('t-cw');
const connDot    = document.getElementById('conn-dot');
const connLabel  = document.getElementById('conn-label');
const sessBody   = document.getElementById('sessions-body');
const feedList   = document.getElementById('feed-list');
const mainEl     = document.getElementById('main');
const rightPanel = document.getElementById('right-panel');
const detailPanel= document.getElementById('detail-panel');
const detailPanelTitle = document.getElementById('detail-panel-title');
const backBtn    = document.getElementById('back-btn');
const detailLoading = document.getElementById('detail-loading');
const detailContent = document.getElementById('detail-content');

// ── Formatting helpers ────────────────────────────────────────────────────────
function fmt(n) {
  if (n === undefined || n === null) return '—';
  n = Number(n);
  if (Number.isNaN(n)) return '—';
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

// Short display name for a model id. Naive `split('-').slice(-2)` mangles ids
// that carry a date suffix: claude-haiku-4-5-20251001 renders as "5-20251001".
// Strip the vendor prefix and the trailing YYYYMMDD instead.
function modelLabel(m) {
  if (!m) return '';
  return String(m).replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function fmtBytes(n) {
  if (!n) return null;
  n = Number(n);
  if (n >= 1_048_576) return (n / 1_048_576).toFixed(1) + 'MB';
  if (n >= 1_024)     return (n / 1_024).toFixed(1) + 'kB';
  return n + 'B';
}

function fmtDuration(ms) {
  if (!ms) return null;
  ms = Number(ms);
  if (ms >= 60_000) return (ms / 60_000).toFixed(1) + 'm';
  if (ms >= 1_000)  return (ms / 1_000).toFixed(2) + 's';
  return ms + 'ms';
}

function relTime(isoStr) {
  if (!isoStr) return '—';
  const diff = Date.now() - new Date(isoStr).getTime();
  if (diff < 0)          return 'just now';
  if (diff < 60_000)     return Math.floor(diff / 1_000) + 's ago';
  if (diff < 3_600_000)  return Math.floor(diff / 60_000) + 'm ago';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago';
  return Math.floor(diff / 86_400_000) + 'd ago';
}

function relTimeShort(isoStr) {
  if (!isoStr) return '';
  const diff = Date.now() - new Date(isoStr).getTime();
  if (diff < 0)          return 'now';
  if (diff < 60_000)     return Math.floor(diff / 1_000) + 's';
  if (diff < 3_600_000)  return Math.floor(diff / 60_000) + 'm';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h';
  return Math.floor(diff / 86_400_000) + 'd';
}

function fmtRange(firstTs, lastTs) {
  if (!firstTs) return '—';
  const fmt12 = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (!lastTs || firstTs === lastTs) return fmt12(firstTs);
  return fmt12(firstTs) + ' – ' + fmt12(lastTs);
}

function shortId(id) {
  return id ? id.slice(0, 8) : '?';
}

function isActive(isoStr) {
  return isoStr && (Date.now() - new Date(isoStr).getTime()) < ACTIVE_THRESHOLD_MS;
}

function top3(obj) {
  if (!obj) return [];
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => k);
}

/** Safe textContent assignment — never use this with innerHTML */
function safe(s) { return s == null ? '' : String(s); }

// ── Totals strip ──────────────────────────────────────────────────────────────
function recomputeTotals() {
  let totalEvents = 0, input = 0, output = 0, cr = 0, cw = 0;
  for (const s of sessions.values()) {
    totalEvents += s.events ?? 0;
    input  += s.usage?.input      ?? 0;
    output += s.usage?.output     ?? 0;
    cr     += s.usage?.cacheRead  ?? 0;
    cw     += s.usage?.cacheWrite ?? 0;
  }
  tSessions.textContent = sessions.size;
  tEvents.textContent   = fmt(totalEvents);
  tInput.textContent    = fmt(input);
  tOutput.textContent   = fmt(output);
  tCr.textContent       = fmt(cr);
  tCw.textContent       = fmt(cw);
}

// ── Sessions table ────────────────────────────────────────────────────────────
function renderSessions() {
  const sorted = [...sessions.values()].sort(
    (a, b) => new Date(b.lastTs ?? 0) - new Date(a.lastTs ?? 0)
  );

  if (sorted.length === 0) {
    sessBody.innerHTML = '';
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 11; td.className = 'empty';
    td.textContent = 'No sessions yet.';
    tr.appendChild(td); sessBody.appendChild(tr);
    return;
  }

  sessBody.innerHTML = '';
  for (const s of sorted) {
    const tr = document.createElement('tr');
    tr.dataset.sid = s.sessionId;
    tr.className = 'clickable';
    if (s.sessionId === openSessionId) tr.classList.add('selected');

    const active  = isActive(s.lastTs);
    const tools3  = top3(s.tools);
    const models3 = top3(s.models);

    const cells = [
      () => {
        const td = document.createElement('td');
        td.title = safe(s.project);
        td.textContent = safe(s.project);
        return td;
      },
      () => {
        const td = document.createElement('td');
        if (active) {
          const dot = document.createElement('span');
          dot.className = 'live-dot';
          td.appendChild(dot);
        }
        td.appendChild(document.createTextNode(shortId(s.sessionId)));
        return td;
      },
      () => { const td = document.createElement('td'); td.textContent = safe(s.prompts ?? 0); return td; },
      () => { const td = document.createElement('td'); td.textContent = fmt(s.usage?.input);      return td; },
      () => { const td = document.createElement('td'); td.textContent = fmt(s.usage?.output);     return td; },
      () => { const td = document.createElement('td'); td.textContent = fmt(s.usage?.cacheRead);  return td; },
      () => { const td = document.createElement('td'); td.textContent = fmt(s.usage?.cacheWrite); return td; },
      () => {
        const td = document.createElement('td');
        for (const t of tools3) {
          const chip = document.createElement('span');
          chip.className = 'chip tool';
          chip.textContent = safe(t);
          td.appendChild(chip);
        }
        return td;
      },
      () => {
        const td = document.createElement('td');
        for (const m of models3) {
          const chip = document.createElement('span');
          chip.className = 'chip model';
          chip.textContent = safe(modelLabel(m));
          chip.title = safe(m);
          td.appendChild(chip);
        }
        return td;
      },
      () => {
        const td = document.createElement('td');
        td.className = 'rel-time';
        td.dataset.ts = safe(s.lastTs);
        td.textContent = relTime(s.lastTs);
        return td;
      },
      () => {
        const td = document.createElement('td');
        const a = document.createElement('a');
        a.className = 'obs-link';
        a.href = '/observe?session=' + encodeURIComponent(s.sessionId);
        a.textContent = 'Observe →';
        a.title = 'Open this session in Observe';
        a.addEventListener('click', e => e.stopPropagation());
        td.appendChild(a);
        return td;
      },
    ];

    for (const make of cells) tr.appendChild(make());

    tr.addEventListener('click', () => openDetail(s.sessionId));
    sessBody.appendChild(tr);
  }
}

// Lightweight refresh: only rel-time cells + live dots (no full re-render)
function refreshRelTimes() {
  for (const td of sessBody.querySelectorAll('.rel-time')) {
    td.textContent = relTime(td.dataset.ts);
  }
  for (const tr of sessBody.querySelectorAll('tr[data-sid]')) {
    const sid = tr.dataset.sid;
    const s = sessions.get(sid);
    if (!s) continue;
    const active = isActive(s.lastTs);
    const hasDot = !!tr.querySelector('.live-dot');
    if (active && !hasDot) {
      const dot = document.createElement('span');
      dot.className = 'live-dot';
      tr.cells[1].insertBefore(dot, tr.cells[1].firstChild);
    } else if (!active && hasDot) {
      tr.querySelector('.live-dot').remove();
    }
  }
}

// ── Live feed ─────────────────────────────────────────────────────────────────
function kindClass(kind) {
  switch (kind) {
    case 'prompt':      return 'kind-prompt';
    case 'assistant':   return 'kind-assistant';
    case 'tool_use':    return 'kind-tool_use';
    case 'tool_result': return 'kind-tool_result';
    default:            return 'kind-system';
  }
}

function makeFeedItem(ev) {
  const li = document.createElement('li');
  li.className = 'feed-item';

  const tsEl = document.createElement('span');
  tsEl.className = 'feed-ts';
  const d = new Date(ev.ts ?? 0);
  tsEl.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

  const projEl = document.createElement('span');
  projEl.className = 'feed-proj';
  projEl.textContent = safe(ev.project);
  projEl.title = safe(ev.project);

  const badgeEl = document.createElement('span');
  badgeEl.className = 'kind-badge ' + kindClass(ev.kind);
  badgeEl.textContent = safe(ev.kind ?? 'unknown');

  const bodyEl = document.createElement('span');
  bodyEl.className = 'feed-body';

  const parts = [];
  if (ev.usage) {
    const u = ev.usage;
    if (u.input || u.output) parts.push('↑' + fmt(u.input) + ' ↓' + fmt(u.output));
    if (u.cacheRead)  parts.push('CR:' + fmt(u.cacheRead));
    if (u.cacheWrite) parts.push('CW:' + fmt(u.cacheWrite));
  }
  if (ev.model) parts.push(modelLabel(ev.model));
  if (Array.isArray(ev.tools) && ev.tools.length) parts.push(ev.tools.join(','));
  if (ev.skill)   parts.push('skill:' + ev.skill);
  if (ev.command) parts.push('cmd:' + ev.command);
  if (ev.agent)   parts.push('agent:' + ev.agent);
  if (ev.text)    parts.push('· ' + ev.text.slice(0, 120));

  bodyEl.textContent = parts.join('  ');

  li.appendChild(tsEl);
  li.appendChild(projEl);
  li.appendChild(badgeEl);
  li.appendChild(bodyEl);
  return li;
}

function prependFeedItem(ev) {
  feedItems.unshift(ev);
  if (feedItems.length > FEED_CAP) feedItems.pop();

  const emptyLi = feedList.querySelector('li.empty');
  if (emptyLi) emptyLi.remove();

  const li = makeFeedItem(ev);
  feedList.insertBefore(li, feedList.firstChild);

  while (feedList.children.length > FEED_CAP) {
    feedList.removeChild(feedList.lastChild);
  }
}

// ── Session aggregate: incremental update from one MonitorEvent ───────────────
function applyEventToSession(ev) {
  let agg = sessions.get(ev.sessionId);
  if (!agg) {
    agg = {
      sessionId: ev.sessionId,
      project:   ev.project,
      firstTs:   ev.ts,
      lastTs:    ev.ts,
      prompts:   0,
      events:    0,
      models:    {},
      usage:     { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      tools:     {},
      skills:    {},
      commands:  {},
      rules:     {},
      agents:    {},
    };
    sessions.set(ev.sessionId, agg);
  }

  agg.events++;
  if (!agg.firstTs || ev.ts < agg.firstTs) agg.firstTs = ev.ts;
  if (!agg.lastTs  || ev.ts > agg.lastTs)  agg.lastTs  = ev.ts;
  if (ev.project) agg.project = ev.project;

  if (ev.kind === 'prompt') agg.prompts++;

  if (ev.usage) {
    agg.usage.input      += ev.usage.input      ?? 0;
    agg.usage.output     += ev.usage.output     ?? 0;
    agg.usage.cacheRead  += ev.usage.cacheRead  ?? 0;
    agg.usage.cacheWrite += ev.usage.cacheWrite ?? 0;
  }

  if (ev.model) agg.models[ev.model] = (agg.models[ev.model] ?? 0) + 1;

  if (Array.isArray(ev.tools)) {
    for (const t of ev.tools) agg.tools[t] = (agg.tools[t] ?? 0) + 1;
  }
  if (ev.skill)   agg.skills[ev.skill]     = (agg.skills[ev.skill]     ?? 0) + 1;
  if (ev.command) agg.commands[ev.command] = (agg.commands[ev.command] ?? 0) + 1;
  if (Array.isArray(ev.rules)) {
    for (const r of ev.rules) agg.rules[r] = (agg.rules[r] ?? 0) + 1;
  }
  if (ev.agent)   agg.agents[ev.agent]     = (agg.agents[ev.agent]     ?? 0) + 1;
}

// ── Bootstrap from /api/snapshot ─────────────────────────────────────────────
async function loadSnapshot() {
  let data;
  try {
    const res = await fetch('/api/snapshot');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch (e) {
    console.warn('snapshot fetch failed:', e);
    return;
  }

  sessions.clear();
  feedItems.length = 0;
  feedList.innerHTML = '';

  if (Array.isArray(data.sessions)) {
    for (const s of data.sessions) {
      sessions.set(s.sessionId, {
        sessionId: s.sessionId,
        project:   s.project,
        firstTs:   s.firstTs,
        lastTs:    s.lastTs,
        prompts:   s.prompts   ?? 0,
        events:    s.events    ?? 0,
        models:    s.models    ?? {},
        usage: {
          input:      s.usage?.input      ?? 0,
          output:     s.usage?.output     ?? 0,
          cacheRead:  s.usage?.cacheRead  ?? 0,
          cacheWrite: s.usage?.cacheWrite ?? 0,
        },
        tools:    s.tools    ?? {},
        skills:   s.skills   ?? {},
        commands: s.commands ?? {},
        rules:    s.rules    ?? {},
        agents:   s.agents   ?? {},
      });
    }
  }

  if (Array.isArray(data.events)) {
    const evs = [...data.events].reverse().slice(0, FEED_CAP);
    for (const ev of evs) {
      feedItems.push(ev);
      const li = makeFeedItem(ev);
      feedList.appendChild(li);
    }
  } else {
    feedList.innerHTML = '<li class="empty">No events yet.</li>';
  }

  renderSessions();
  recomputeTotals();
}

// ── Session detail ────────────────────────────────────────────────────────────

function openDetail(sessionId) {
  openSessionId = sessionId;

  // Show detail panel, hide live feed
  rightPanel.classList.add('hidden');
  detailPanel.classList.remove('hidden');
  mainEl.classList.add('detail-open');

  // Update header title
  const s = sessions.get(sessionId);
  detailPanelTitle.textContent = safe(s?.project ?? sessionId);

  // Highlight row
  for (const tr of sessBody.querySelectorAll('tr[data-sid]')) {
    tr.classList.toggle('selected', tr.dataset.sid === sessionId);
  }

  fetchAndRenderDetail(sessionId);
}

function closeDetail() {
  openSessionId = null;

  rightPanel.classList.remove('hidden');
  detailPanel.classList.add('hidden');
  mainEl.classList.remove('detail-open');
  detailPanelTitle.textContent = '';

  for (const tr of sessBody.querySelectorAll('tr[data-sid]')) {
    tr.classList.remove('selected');
  }

  detailContent.innerHTML = '';
  detailContent.style.display = 'none';
  detailLoading.style.display = 'flex';
}

async function fetchAndRenderDetail(sessionId) {
  detailContent.innerHTML = '';
  detailContent.style.display = 'none';
  detailLoading.style.display = 'flex';

  let detail;
  try {
    const res = await fetch('/api/session/' + encodeURIComponent(sessionId));
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? ('HTTP ' + res.status));
    }
    detail = await res.json();
  } catch (e) {
    detailLoading.style.display = 'none';
    detailContent.style.display = 'flex';
    const errEl = document.createElement('p');
    errEl.style.cssText = 'color:var(--red);font-size:12px;';
    errEl.textContent = 'Failed to load session: ' + safe(e.message);
    detailContent.appendChild(errEl);
    return;
  }

  // Guard: if session changed while fetching, discard
  if (openSessionId !== sessionId) return;

  renderDetail(detail);
}

/** Debounced re-fetch for open session when SSE event arrives */
function scheduleDetailRefresh(sessionId) {
  if (openSessionId !== sessionId) return;
  if (detailDebounceTimer) clearTimeout(detailDebounceTimer);
  detailDebounceTimer = setTimeout(() => {
    detailDebounceTimer = null;
    if (openSessionId === sessionId) fetchAndRenderDetail(sessionId);
  }, 2_000);
}

// ── Render helpers ────────────────────────────────────────────────────────────

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = safe(text);
  return e;
}

function makeUsageSummary(usage) {
  if (!usage) return '—';
  const u = usage;
  const parts = [];
  if (u.input)      parts.push('↑' + fmt(u.input));
  if (u.output)     parts.push('↓' + fmt(u.output));
  if (u.cacheRead)  parts.push('CR:' + fmt(u.cacheRead));
  if (u.cacheWrite) parts.push('CW:' + fmt(u.cacheWrite));
  return parts.join(' ') || '—';
}

/** Build one counts table: name → {count, usage:{...}} */
function buildCountsTable(title, map) {
  if (!map || Object.keys(map).length === 0) return null;

  const entries = Object.entries(map)
    .sort((a, b) => (b[1].count ?? 0) - (a[1].count ?? 0));

  const wrap = document.createElement('div');
  wrap.className = 'counts-table-wrap';

  const heading = el('div', 'section-heading', title);
  wrap.appendChild(heading);

  const tbl = document.createElement('table');
  tbl.style.cssText = 'width:100%;border-collapse:collapse;table-layout:fixed;';

  const thead = document.createElement('thead');
  const hrow = document.createElement('tr');
  for (const h of ['Name', 'Count', 'Input', 'Output', 'Cache R', 'Cache W']) {
    const th = document.createElement('th');
    th.textContent = h;
    th.style.cssText = 'padding:4px 8px;font-size:10px;text-align:left;background:var(--bg3);border-bottom:1px solid var(--border);color:var(--dim);font-weight:700;text-transform:uppercase;letter-spacing:.05em;';
    if (h !== 'Name') th.style.textAlign = 'right';
    hrow.appendChild(th);
  }
  thead.appendChild(hrow);
  tbl.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const [name, val] of entries) {
    const tr = document.createElement('tr');
    const u = val.usage ?? {};
    const cells = [
      { val: name,              align: 'left',  mono: false },
      { val: fmt(val.count),   align: 'right', mono: true  },
      { val: fmt(u.input),     align: 'right', mono: true  },
      { val: fmt(u.output),    align: 'right', mono: true  },
      { val: fmt(u.cacheRead), align: 'right', mono: true  },
      { val: fmt(u.cacheWrite),align: 'right', mono: true  },
    ];
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c.val;
      td.style.cssText = 'padding:3px 8px;border-bottom:1px solid var(--border);font-size:11px;text-align:' + c.align + ';';
      if (c.mono) { td.style.fontFamily = 'var(--mono)'; }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
  return wrap;
}

/** Build loading panel */
function buildLoadingPanel(loading) {
  if (!loading) return null;
  const { auto = [], invoked = [] } = loading;
  if (auto.length === 0 && invoked.length === 0) return null;

  const card = el('div', 'detail-card');
  card.appendChild(el('div', 'section-heading', 'Loading Panel'));

  const grid = el('div', 'loading-grid');

  // Auto-loaded column
  const autoCol = el('div', 'loading-col');
  autoCol.appendChild(el('div', 'loading-col-title', 'Auto-loaded (context)'));
  if (auto.length === 0) {
    autoCol.appendChild(el('p', null, '—'));
  } else {
    const ul = el('ul', 'loading-list');
    for (const item of auto) {
      const li = el('li', 'loading-item');
      const chip = el('span', 'type-chip type-' + safe(item.type), item.type);
      const name = el('span', 'loading-name', item.name);
      if (item.evidence) name.title = safe(item.evidence);
      li.appendChild(chip);
      li.appendChild(name);
      ul.appendChild(li);
    }
    autoCol.appendChild(ul);
  }
  grid.appendChild(autoCol);

  // Invoked column
  const invCol = el('div', 'loading-col');
  invCol.appendChild(el('div', 'loading-col-title', 'Invoked'));
  if (invoked.length === 0) {
    invCol.appendChild(el('p', null, '—'));
  } else {
    const ul = el('ul', 'loading-list');
    for (const item of invoked) {
      const li = el('li', 'loading-item');
      const chip = el('span', 'type-chip type-' + safe(item.type), item.type);
      const name = el('span', 'loading-name', item.name);
      const cnt  = el('span', 'loading-count', '×' + safe(item.count));
      li.appendChild(chip);
      li.appendChild(name);
      li.appendChild(cnt);
      ul.appendChild(li);
    }
    invCol.appendChild(ul);
  }
  grid.appendChild(invCol);
  card.appendChild(grid);
  return card;
}

/** Build a kind badge element for tree nodes */
function makeKindBadge(kind) {
  const badge = el('span', 'kind-badge', kind);
  // Reuse kind-badge CSS classes; map tree kinds to existing classes
  const cls = {
    prompt:    'kind-prompt',
    assistant: 'kind-assistant',
    tool:      'kind-tool_use',
    skill:     'kind-tool_use',
    command:   'kind-system',
    agent:     'kind-assistant',
  }[kind] ?? 'kind-tool_result';
  badge.classList.add(cls);
  return badge;
}

/**
 * Recursively build an invocation tree.
 * @param {object[]} nodes  - array of TreeNode
 * @param {boolean}  isRoot - whether these are root-level prompt nodes
 * @param {number}   depth  - current depth (for depth cap rendering)
 */
function buildTreeNodes(nodes, isRoot, depth) {
  if (!Array.isArray(nodes) || nodes.length === 0) return null;

  const ul = el('ul', isRoot ? 'tree-root' : 'tree-children');

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = (i === nodes.length - 1);
    const li = el('li', 'tree-node');

    // "…truncated" sentinel node
    if (node.kind === undefined && node.name === undefined && node.label && node.label.startsWith('…')) {
      const truncEl = el('div', 'tree-truncated', node.label);
      li.appendChild(truncEl);
      ul.appendChild(li);
      continue;
    }

    const hasChildren = Array.isArray(node.children) && node.children.length > 0;

    // Build inline node content (shared between summary and leaf)
    function buildNodeContent(container) {
      container.appendChild(makeKindBadge(safe(node.kind)));
      if (node.name) {
        container.appendChild(el('span', 'tree-name', node.name));
      }
      // relative time
      if (node.ts) {
        const tsEl = el('span', 'tree-ts', relTimeShort(node.ts));
        tsEl.dataset.nodets = safe(node.ts);
        container.appendChild(tsEl);
      }
      // attributed tokens
      if (node.usage) {
        const u = node.usage;
        const tok = makeUsageSummary(u);
        if (tok && tok !== '—') {
          container.appendChild(el('span', 'tree-tokens', tok));
        }
      }
      // durationMs
      if (node.durationMs != null) {
        const d = fmtDuration(node.durationMs);
        if (d) container.appendChild(el('span', 'tree-dur', d));
      }
      // resultBytes
      if (node.resultBytes != null) {
        const b = fmtBytes(node.resultBytes);
        if (b) container.appendChild(el('span', 'tree-bytes', b + ' res'));
      }
      // label snippet
      if (node.label) {
        container.appendChild(el('span', 'tree-label', node.label.slice(0, 100)));
      }
    }

    if (hasChildren) {
      const details = document.createElement('details');
      details.className = 'tree-details';

      // Prompts: collapse by default EXCEPT the last root prompt
      if (node.kind === 'prompt') {
        details.open = isRoot && isLast;
      } else {
        details.open = false;
      }

      const summary = document.createElement('summary');
      buildNodeContent(summary);
      details.appendChild(summary);

      const childList = buildTreeNodes(node.children, false, depth + 1);
      if (childList) details.appendChild(childList);

      li.appendChild(details);
    } else {
      const leaf = el('div', 'tree-leaf');
      buildNodeContent(leaf);
      li.appendChild(leaf);
    }

    ul.appendChild(li);
  }
  return ul;
}

/** Render SessionDetail into #detail-content */
function renderDetail(detail) {
  detailLoading.style.display = 'none';
  detailContent.innerHTML = '';
  detailContent.style.display = 'flex';
  detailContent.style.flexDirection = 'column';
  detailContent.style.gap = '14px';

  // ── 1. Header card ──────────────────────────────────────────────────────────
  const headerCard = el('div', 'detail-card');

  const titleRow = el('div', 'detail-title', detail.project ?? detail.sessionId);
  headerCard.appendChild(titleRow);

  // Full session id + copy button
  const idRow = el('div', 'session-id-row');
  const idText = el('span', 'session-id-text', detail.sessionId);
  const copyBtn = el('button', 'copy-btn', 'copy');
  copyBtn.type = 'button';
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(detail.sessionId ?? '').then(() => {
      copyBtn.textContent = 'copied!';
      copyBtn.classList.add('copied');
      setTimeout(() => {
        copyBtn.textContent = 'copy';
        copyBtn.classList.remove('copied');
      }, 1_500);
    }).catch(() => {});
  });
  idRow.appendChild(idText);
  idRow.appendChild(copyBtn);
  headerCard.appendChild(idRow);

  // v2.2: session working directory
  if (detail.cwd) {
    const cwdRow = el('div', 'session-id-row');
    cwdRow.appendChild(el('span', 'session-id-text', detail.cwd));
    cwdRow.title = detail.cwd;
    headerCard.appendChild(cwdRow);
  }

  // Meta row
  const metaRow = el('div', 'detail-meta');
  const metaItems = [
    ['Time', fmtRange(detail.firstTs, detail.lastTs)],
    ['Prompts', safe(detail.prompts ?? 0)],
    ['Input', fmt(detail.usage?.input)],
    ['Output', fmt(detail.usage?.output)],
    ['Cache R', fmt(detail.usage?.cacheRead)],
    ['Cache W', fmt(detail.usage?.cacheWrite)],
  ];
  // v2.3: context-window estimate + total cost
  if (detail.context && detail.context.tokens) {
    // Peak window occupancy — same definition as the observe view (input +
    // cache read + cache write on the main chain, at its fullest). Shown
    // against the inferred window so the raw number has a scale.
    const cw = detail.context.window;
    let ctxText = fmt(detail.context.tokens) + ' tok';
    if (cw) ctxText += ' / ' + fmt(cw) + ' (' + Math.round((detail.context.tokens / cw) * 100) + '%)';
    metaItems.push(['Peak context', ctxText]);
    if (detail.context.lastTokens !== undefined && detail.context.lastTokens < detail.context.tokens) {
      metaItems.push(['Now', fmt(detail.context.lastTokens) + ' tok']);
    }
  }
  if (detail.cost && detail.cost.totalUSD > 0) {
    metaItems.push(['Est. Cost', '~$' + detail.cost.totalUSD.toFixed(2)]);
  }
  for (const [label, value] of metaItems) {
    const item = el('div', 'detail-meta-item');
    item.appendChild(el('span', 'detail-meta-label', label + ':'));
    item.appendChild(el('span', 'detail-meta-value', value));
    metaRow.appendChild(item);
  }
  headerCard.appendChild(metaRow);
  detailContent.appendChild(headerCard);

  // ── 2. Counts tables ────────────────────────────────────────────────────────
  const countsMaps = [
    ['Tools',    detail.tools],
    ['Skills',   detail.skills],
    ['Commands', detail.commands],
    ['Rules',    detail.rules],
    ['Agents',   detail.agents],
    ['MCP',      detail.mcp],
  ];
  const countsCard = el('div', 'detail-card');
  countsCard.appendChild(el('div', 'section-heading', 'Counts'));
  const countsGrid = el('div', 'counts-grid');
  let anyCountsTable = false;
  for (const [title, map] of countsMaps) {
    const tbl = buildCountsTable(title, map);
    if (tbl) { countsGrid.appendChild(tbl); anyCountsTable = true; }
  }
  if (anyCountsTable) {
    countsCard.appendChild(countsGrid);
    detailContent.appendChild(countsCard);
  }

  // ── 2b. Cost estimation (v2.3) ──────────────────────────────────────────────
  if (detail.cost && detail.cost.totalUSD > 0) {
    const costCard = el('div', 'detail-card');
    costCard.appendChild(el('div', 'section-heading', 'Cost Estimation — ~$' + detail.cost.totalUSD.toFixed(2)));
    const catRow = el('div', 'detail-meta');
    const cats = [
      ['Input',   detail.cost.byCategory?.input],
      ['Output',  detail.cost.byCategory?.output],
      ['Cache R', detail.cost.byCategory?.cacheRead],
      ['Cache W', detail.cost.byCategory?.cacheWrite],
    ];
    for (const [label, v] of cats) {
      const item = el('div', 'detail-meta-item');
      item.appendChild(el('span', 'detail-meta-label', label + ':'));
      item.appendChild(el('span', 'detail-meta-value', '$' + (v ?? 0).toFixed(2)));
      catRow.appendChild(item);
    }
    costCard.appendChild(catRow);
    if (Array.isArray(detail.cost.byModel) && detail.cost.byModel.length) {
      const modelRow = el('div', 'detail-meta');
      for (const m of detail.cost.byModel) {
        const item = el('div', 'detail-meta-item');
        const pct = Math.round((m.costUSD / detail.cost.totalUSD) * 100);
        item.appendChild(el('span', 'detail-meta-label', safe(m.model) + ':'));
        item.appendChild(el('span', 'detail-meta-value', '$' + m.costUSD.toFixed(2) + ' (' + pct + '%)'));
        modelRow.appendChild(item);
      }
      costCard.appendChild(modelRow);
    }
    detailContent.appendChild(costCard);
  }

  // ── 2c. Sub-agent dispatches (v2.3) ─────────────────────────────────────────
  if (Array.isArray(detail.dispatches) && detail.dispatches.length > 0) {
    const dCard = el('div', 'detail-card');
    dCard.appendChild(el('div', 'section-heading', 'Sub-agents (' + detail.dispatches.length + ')'));
    for (const d of detail.dispatches) {
      const row = el('div', 'dispatch-row');
      const chip = el('span', 'chip model', safe(d.agent ?? 'agent'));
      chip.title = safe(d.model ?? '');
      row.appendChild(chip);
      if (d.model) {
        row.appendChild(el('span', 'dispatch-model', safe(modelLabel(d.model))));
      }
      if (d.label) {
        const lbl = el('span', 'dispatch-label', safe(d.label));
        lbl.title = safe(d.label);
        row.appendChild(lbl);
      }
      if (d.usage) {
        const inTok = (d.usage.input ?? 0) + (d.usage.cacheRead ?? 0);
        row.appendChild(el('span', 'dispatch-tokens', '↑' + fmt(inTok) + ' ↓' + fmt(d.usage.output ?? 0)));
      }
      if (typeof d.costUSD === 'number' && d.costUSD > 0) {
        row.appendChild(el('span', 'dispatch-cost', '~$' + d.costUSD.toFixed(2)));
      }
      if (d.toolCount != null) {
        row.appendChild(el('span', 'dispatch-tools', d.toolCount + ' tools'));
      }
      if (d.durationMs != null) {
        row.appendChild(el('span', 'dispatch-dur', fmtDuration(d.durationMs)));
      }
      dCard.appendChild(row);
    }
    detailContent.appendChild(dCard);
  }

  // ── 3. Loading panel ────────────────────────────────────────────────────────
  const loadingCard = buildLoadingPanel(detail.loading);
  if (loadingCard) detailContent.appendChild(loadingCard);

  // ── 4. Invocation tree ──────────────────────────────────────────────────────
  if (Array.isArray(detail.tree) && detail.tree.length > 0) {
    const treeCard = el('div', 'detail-card');
    treeCard.appendChild(el('div', 'section-heading', 'Invocation Tree'));
    const treeEl = buildTreeNodes(detail.tree, true, 0);
    if (treeEl) treeCard.appendChild(treeEl);
    detailContent.appendChild(treeCard);
  }
}

// ── Back button / Escape ──────────────────────────────────────────────────────
backBtn.addEventListener('click', closeDetail);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openSessionId) closeDetail();
});

// ── SSE ───────────────────────────────────────────────────────────────────────
let lastEventId = '';
let es = null;

function setConnStatus(state) {
  connDot.className = 'conn-dot ' + state;
  connLabel.textContent = state === 'open' ? 'live' : state === 'error' ? 'reconnecting…' : 'connecting…';
}

function connectSSE() {
  if (es) { es.close(); es = null; }

  es = new EventSource('/events');

  es.addEventListener('open', async () => {
    setConnStatus('open');
    await loadSnapshot();
  });

  es.addEventListener('error', () => {
    setConnStatus('error');
  });

  es.addEventListener('message', (msgEv) => {
    lastEventId = msgEv.lastEventId || lastEventId;
    let ev;
    try { ev = JSON.parse(msgEv.data); } catch { return; }
    if (!ev || !ev.sessionId || !ev.kind) return;

    applyEventToSession(ev);
    prependFeedItem(ev);

    // If detail for this session is open, schedule a refresh
    if (openSessionId === ev.sessionId) {
      scheduleDetailRefresh(ev.sessionId);
    }

    // Targeted session row update
    const existingRow = sessBody.querySelector('tr[data-sid="' + CSS.escape(ev.sessionId) + '"]');
    if (existingRow) {
      const s = sessions.get(ev.sessionId);
      existingRow.cells[2].textContent = safe(s.prompts);
      existingRow.cells[3].textContent = fmt(s.usage?.input);
      existingRow.cells[4].textContent = fmt(s.usage?.output);
      existingRow.cells[5].textContent = fmt(s.usage?.cacheRead);
      existingRow.cells[6].textContent = fmt(s.usage?.cacheWrite);

      const toolsTd = existingRow.cells[7];
      toolsTd.innerHTML = '';
      for (const t of top3(s.tools)) {
        const chip = el('span', 'chip tool', t);
        toolsTd.appendChild(chip);
      }

      const modelTd = existingRow.cells[8];
      modelTd.innerHTML = '';
      for (const m of top3(s.models)) {
        const chip = el('span', 'chip model', modelLabel(m));
        chip.title = safe(m);
        modelTd.appendChild(chip);
      }

      const timeTd = existingRow.cells[9];
      timeTd.dataset.ts = safe(s.lastTs);
      timeTd.textContent = relTime(s.lastTs);

      const hasDot = !!existingRow.querySelector('.live-dot');
      if (!hasDot) {
        const dot = el('span', 'live-dot');
        existingRow.cells[1].insertBefore(dot, existingRow.cells[1].firstChild);
      }

      // Re-sort if needed
      const rows = [...sessBody.querySelectorAll('tr[data-sid]')];
      if (rows[0]?.dataset.sid !== ev.sessionId && sessions.size > 1) {
        renderSessions();
      }
    } else {
      renderSessions();
    }

    recomputeTotals();
  });
}

// ── Relative-time ticker (10s, text-node updates only) ────────────────────────
setInterval(() => {
  refreshRelTimes();
  // Update tree node timestamps if detail is open
  if (openSessionId) {
    for (const el of detailContent.querySelectorAll('[data-nodets]')) {
      el.textContent = relTimeShort(el.dataset.nodets);
    }
  }
}, 10_000);

// ── Init ──────────────────────────────────────────────────────────────────────
setConnStatus('');
loadSnapshot().then(() => connectSSE());
