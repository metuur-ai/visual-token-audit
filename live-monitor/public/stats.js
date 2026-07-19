/* stats.js — usage stats over a 14/30-day window (Preact + htm, no build step).
   Data: GET /api/stats?days=N → { days, generatedAt, totals, byDay[], skills[],
   commands[], rules[], agents[], tools[], mcp[], plugins[], models[] } */
import { h, render } from '/vendor/preact.module.js';
import { useState, useEffect, useMemo } from '/vendor/hooks.module.js';
import htm from '/vendor/htm.module.js';

const html = htm.bind(h);

const REFRESH_MS = 60000;

/* ============================ helpers ============================ */
const fmt = n => {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return '' + Math.round(n);
};
const int = n => (n || 0).toLocaleString('en-US');
const money = n => '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
const dayLab = ds => {
  const d = new Date(ds + 'T00:00:00');
  return isNaN(d) ? ds : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const shortModel = m => String(m || '?').replace(/^claude-/, '');

/* ============================ area chart ============================ */
function AreaChart({ byDay }) {
  const [tip, setTip] = useState(null);
  const W = 1000, H = 170, PAD = 6;
  const days = byDay || [];
  const max = Math.max(1, ...days.map(d => d.tokens || 0));
  const n = Math.max(1, days.length - 1);
  const pts = days.map((d, i) => [PAD + (i / n) * (W - 2 * PAD), H - PAD - ((d.tokens || 0) / max) * (H - 2 * PAD - 14)]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const area = line + ` L${(W - PAD).toFixed(1)},${H - PAD} L${PAD},${H - PAD} Z`;
  return html`<div class="chart">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#1d4ed8" stop-opacity=".18"/>
        <stop offset="1" stop-color="#1d4ed8" stop-opacity=".015"/>
      </linearGradient></defs>
      ${[.25, .5, .75].map(f => html`<line x1=${PAD} x2=${W - PAD} y1=${(H - PAD) * f} y2=${(H - PAD) * f} stroke="#efeeea" stroke-width="1"/>`)}
      <path d=${area} fill="url(#ag)"/>
      <path d=${line} fill="none" stroke="#1d4ed8" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      ${pts.map((p, i) => html`<g key=${i}>
        <circle cx=${p[0]} cy=${p[1]} r="2.4" fill="#fff" stroke="#1d4ed8" stroke-width="1.4"/>
        <rect x=${p[0] - (W - 2 * PAD) / n / 2} y="0" width=${(W - 2 * PAD) / n} height=${H} fill="transparent"
          onMouseEnter=${e => setTip({ x: e.clientX, y: e.clientY, d: days[i] })}
          onMouseMove=${e => setTip({ x: e.clientX, y: e.clientY, d: days[i] })}
          onMouseLeave=${() => setTip(null)}/>
      </g>`)}
    </svg>
    <div class="ax">${days.map(d => html`<span>${dayLab(d.date)}</span>`)}</div>
    ${tip ? html`<div class="ch-tip" style="left:${tip.x}px;top:${tip.y}px">
      <div class="tt-t">${dayLab(tip.d.date)} · ${fmt(tip.d.tokens)} tok</div>
      <div class="tt-s">${tip.d.sessions || 0} sessions · ${tip.d.prompts || 0} prompts</div>
    </div>` : null}
  </div>`;
}

/* ============================ sparkline ============================ */
function Spark({ byDay, color }) {
  const W = 56, H = 16;
  const days = byDay || [];
  const max = Math.max(1, ...days);
  const n = Math.max(1, days.length - 1);
  const pts = days.map((v, i) => [(i / n) * (W - 2) + 1, H - 1.5 - (v / max) * (H - 4)]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  return html`<svg width=${W} height=${H} viewBox="0 0 ${W} ${H}">
    <path d=${line} fill="none" stroke=${color} stroke-width="1.1" stroke-opacity=".55" stroke-linejoin="round"/>
    ${days.length ? html`<circle cx=${pts[pts.length - 1][0]} cy=${pts[pts.length - 1][1]} r="1.6" fill=${color}/>` : null}
  </svg>`;
}

/* ============================ ranked column ============================ */
const COLK = { skill: '#92400e', cmd: '#6d28d9', agent: '#be185d', rule: '#155e75', tool: '#1d4ed8', mcp: '#15803d', plugin: '#b45309' };
function RankCol({ title, kind, items, delay }) {
  const max = Math.max(1, ...(items || []).map(i => i.count || 0));
  return html`<section class="panel col k-${kind} fade" style="animation-delay:${delay}ms">
    <div class="ph"><span class="pt">${title}</span><span class="psub">${(items || []).length} · by runs</span></div>
    ${!items || items.length === 0 ? html`<div class="empty">nothing recorded in this window</div>` :
    items.slice(0, 10).map((it, i) => html`<div class="rk" key=${it.name}>
      <span class="i">${i + 1}</span>
      <div class="body">
        <div class="nm" title=${it.name}>${it.name}</div>
        <div class="sub">
          <div class="bar"><i style="width:${Math.max(2, (it.count / max) * 100)}%"></i></div>
          <span class="ls">${rel(it.lastUsed)}</span>
        </div>
      </div>
      <${Spark} byDay=${it.byDay} color=${COLK[kind]} />
      <span class="ct">${int(it.count)}<small>${it.sessions || 0} sess${it.tokens ? ' · ' + fmt(it.tokens) : ''}</small></span>
    </div>`)}
  </section>`;
}

/* ============================ app ============================ */
function App() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [stale, setStale] = useState(false);
  const [days, setDays] = useState(30);

  const load = () => fetch('/api/stats?days=' + days)
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(d => { setData(d); setErr(null); setStale(false); })
    .catch(e => { setErr(String(e.message || e)); if (data) setStale(true); });

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [days]);

  const top = html`<header class="top">
    <span class="logo">token monitor</span>
    <nav class="nav">
      <a href="/">Dashboard</a>
      <a href="/observe">Observe</a>
      <a href="/stats" class="on">Stats</a>
      <a href="/projects">Projects</a>
    </nav>
    <span class="gen">${data ? `last ${data.days || days} days · generated ${rel(data.generatedAt)}` : ''}</span>
    <div class="seg">
      <button class=${days === 14 ? 'on' : ''} onClick=${() => setDays(14)}>14d</button>
      <button class=${days === 30 ? 'on' : ''} onClick=${() => setDays(30)}>30d</button>
    </div>
    <span class="live ${err && !data ? 'err' : ''}">${err ? 'stale' : 'auto 60s'}</span>
  </header>`;

  if (err && !data) return html`${top}<main><div class="state">
    <div class="big-msg">stats unavailable</div>
    <div>could not load /api/stats — ${err}</div>
    <button onClick=${load}>retry now</button>
  </div></main>`;

  if (!data) return html`${top}<main><div class="state">
    <div class="big-msg">loading stats…</div>
    <div>aggregating the last ${days} days</div>
  </div></main>`;

  const t = data.totals || {};
  return html`${top}<main>
    ${stale ? html`<div class="banner">refresh failed (${err}) — showing last good data</div>` : null}
    <div class="hero fade" style="animation-delay:0ms">
      <div class="hs"><div class="l">Total tokens</div><div class="n">${fmt(t.tokens)}</div><div class="d">${int(t.tokens)} across ${data.days || 14} days</div></div>
      <div class="hs"><div class="l">Cost</div><div class="n cost">${money(t.cost)}</div><div class="d">estimated from model pricing</div></div>
      <div class="hs"><div class="l">Sessions</div><div class="n">${int(t.sessions)}</div><div class="d">${int(t.prompts)} prompts · ${int(t.projects)} projects</div></div>
      <div class="hs"><div class="l">Agent runs</div><div class="n">${int(t.agentRuns)}</div><div class="d">${int(t.skillInvocations)} skill · ${int(t.commandRuns)} command · ${int(t.ruleLoads)} rule loads</div></div>
    </div>
    <section class="panel fade" style="animation-delay:60ms">
      <div class="ph"><span class="pt">Daily tokens</span><span class="psub">${data.days || days}-day activity</span></div>
      <${AreaChart} byDay=${data.byDay} />
    </section>
    <div class="cols">
      <${RankCol} title="Skills" kind="skill" items=${data.skills} delay=${120} />
      <${RankCol} title="Commands" kind="cmd" items=${data.commands} delay=${150} />
      <${RankCol} title="Rules" kind="rule" items=${data.rules} delay=${180} />
      <${RankCol} title="Plugins" kind="plugin" items=${data.plugins} delay=${210} />
      <${RankCol} title="MCP" kind="mcp" items=${data.mcp} delay=${240} />
      <${RankCol} title="Tools" kind="tool" items=${data.tools} delay=${270} />
      <${RankCol} title="Agents" kind="agent" items=${data.agents} delay=${300} />
    </div>
    <section class="panel fade" style="animation-delay:300ms">
      <div class="ph"><span class="pt">Models</span><span class="psub">by tokens</span></div>
      <div class="models">
        ${(data.models || []).length === 0 ? html`<div class="empty">no model usage recorded</div>` :
        (data.models || []).map(m => html`<span class="mchip" key=${m.name}>
          <span class="mn">${shortModel(m.name)}</span>
          <span class="mt">${fmt(m.tokens)} tok</span>
          <span class="mc">${int(m.count)} msgs</span>
        </span>`)}
      </div>
    </section>
  </main>`;
}

render(html`<${App} />`, document.getElementById('root'));
