/* projects.js — project-centric index: sessions grouped by project directory,
   sorted most-recent-first (Preact + htm, no build step).
   Data: GET /api/projects → { projects: ProjectRecord[], startedAt }.
   Each project links its sessions into the Observer at /observe?session=<id>. */
import { h, render } from '/vendor/preact.module.js';
import { useState, useEffect } from '/vendor/hooks.module.js';
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
const dateLab = iso => {
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};
const shortSid = id => (String(id || '').length > 12 ? String(id).slice(0, 8) + '…' : String(id || ''));
const usageTok = u => (u ? (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) : 0);
const sessionHref = id => '/observe?session=' + encodeURIComponent(id);

/* ============================ nav ============================ */
const Nav = () => html`<nav class="nav">
  <a href="/">Dashboard</a>
  <a href="/observe">Observe</a>
  <a href="/stats">Stats</a>
  <a href="/projects" class="on">Projects</a>
</nav>`;

/* ============================ project card ============================ */
function ProjectCard({ p, delay }) {
  const [open, setOpen] = useState(false);
  const go = id => { window.location.href = sessionHref(id); };
  return html`<section class="pcard fade ${open ? 'open' : ''}" style="animation-delay:${delay}ms">
    <div class="phead" onClick=${() => setOpen(o => !o)} title=${open ? 'collapse sessions' : 'expand sessions'}>
      <span class="pchev">${open ? '▾' : '▸'}</span>
      <span class="pname">${p.name}</span>
      ${p.cwd ? html`<span class="pcwd">${p.cwd}</span>` : null}
      <div class="pmeta">
        <div class="pm"><span class="l">Last</span><span class="v">${dateLab(p.lastActivity)}</span></div>
        <div class="pm"><span class="l">Sessions</span><span class="v">${int(p.sessionCount)}</span></div>
        <div class="pm"><span class="l">Prompts</span><span class="v">${int(p.prompts)}</span></div>
        <div class="pm"><span class="l">Tokens</span><span class="v">${fmt(usageTok(p.usage))}</span></div>
      </div>
    </div>
    ${open ? html`
      ${(p.topTools && p.topTools.length) ? html`<div class="ptools">
        ${p.topTools.map(t => html`<span class="ttool" key=${t.name}>${t.name} <b>${int(t.count)}</b></span>`)}
      </div>` : null}
      <table class="ptbl">
        <thead><tr>
          <th>Session</th><th>Last</th><th>Prompts</th><th>In</th><th>Out</th><th>C.Read</th><th>C.Wrt</th>
        </tr></thead>
        <tbody>
          ${p.sessions.map(s => html`<tr key=${s.sessionId} onClick=${() => go(s.sessionId)} title=${s.sessionId}>
            <td><a class="sid" href=${sessionHref(s.sessionId)} onClick=${e => e.stopPropagation()}>${shortSid(s.sessionId)}</a></td>
            <td>${rel(s.lastTs)}</td>
            <td>${int(s.prompts)}</td>
            <td>${fmt(s.usage.input)}</td>
            <td>${fmt(s.usage.output)}</td>
            <td>${fmt(s.usage.cacheRead)}</td>
            <td>${fmt(s.usage.cacheWrite)}</td>
          </tr>`)}
        </tbody>
      </table>` : null}
  </section>`;
}

/* ============================ app ============================ */
function App() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [stale, setStale] = useState(false);
  const [days, setDays] = useState(30);

  const load = () => fetch('/api/projects?days=' + days)
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(d => { setData(d); setErr(null); setStale(false); })
    .catch(e => { setErr(String(e.message || e)); if (data) setStale(true); });

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [days]);

  const top = html`<header class="top">
    <span class="logo">Historical Session By Project</span>
    <${Nav} />
    <span class="gen">${data ? `${data.projects.length} project${data.projects.length === 1 ? '' : 's'} · last ${data.days || days} days` : ''}</span>
    <div class="seg">
      <button class=${days === 7 ? 'on' : ''} onClick=${() => setDays(7)}>7d</button>
      <button class=${days === 30 ? 'on' : ''} onClick=${() => setDays(30)}>30d</button>
      <button class=${days === 60 ? 'on' : ''} onClick=${() => setDays(60)}>60d</button>
    </div>
    <span class="live ${err && !data ? 'err' : ''}">${err ? 'stale' : 'auto 60s'}</span>
  </header>`;

  if (err && !data) return html`${top}<main><div class="state">
    <div class="big-msg">projects unavailable</div>
    <div>could not load /api/projects — ${err}</div>
    <button onClick=${load}>retry now</button>
  </div></main>`;

  if (!data) return html`${top}<main><div class="state">
    <div class="big-msg">loading projects…</div>
    <div>grouping sessions by project directory</div>
  </div></main>`;

  if (!data.projects.length) return html`${top}<main><div class="state">
    <div class="big-msg">no projects yet</div>
    <div>no sessions found in the last ${data.days || days} days — start a Claude Code session and they'll appear here.</div>
  </div></main>`;

  return html`${top}<main>
    ${stale ? html`<div class="banner">refresh failed (${err}) — showing last good data</div>` : null}
    ${data.projects.map((p, i) => html`<${ProjectCard} key=${p.key} p=${p} delay=${Math.min(i, 8) * 40} />`)}
  </main>`;
}

render(html`<${App} />`, document.getElementById('root'));
