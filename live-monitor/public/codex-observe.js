import { h } from './vendor/preact.module.js';
import { useState } from './vendor/hooks.module.js';
import htm from './vendor/htm.module.js';
const html = htm.bind(h);

const categories = [['skill', 'Skills'], ['command', 'Commands'], ['plugin', 'Plugins'],
  ['mcp', 'MCP'], ['tool', 'Tools'], ['agent', 'Agents'], ['memory', 'Instructions'], ['hook', 'Hooks'], ['review', 'Reviews']];

export function CodexRegistry({ n, m, reg, setReg, onSel }) {
  const [skillFilter, setSkillFilter] = useState('read');
  if (n?.evidence) m = { ...m, ...n.evidence };
  const calls = m.callDetails || [];
  const resources = m.recordedContext || [];
  const rows = Object.fromEntries(categories.map(([key]) => [key, []]));
  for (const resource of resources) {
    const category = resource.kind === 'skill' ? 'skill' : 'memory';
    // Matching a path in a recorded call is evidence of a reference, not proof
    // that the skill's instructions were followed by the model.
    const activity = (m.skillActivity || []).find(a => a.name === resource.name && a.path === resource.path);
    const refs = activity ? calls.filter(c => activity.callIds.includes(c.id)) : resource.path ? calls.filter(c => c.input.includes(resource.path)) : [];
    const state = activity?.status || (refs.length ? 'referenced' : 'advertised');
    rows[category].push({ name: resource.name, state, status: category !== 'skill' ? 'present in recorded instructions'
      : state === 'read' ? 'Used · skill document read in this session'
      : state === 'referenced' ? 'Referenced · read not confirmed' : 'Available only · advertised in context',
      info: resource.path || 'Serialized instruction block', tokens: resource.tokens, calls: refs });
  }
  const plugins = new Map();
  for (const skill of rows.skill) {
    if (!skill.name.includes(':')) continue;
    const ns = skill.name.split(':')[0];
    const p = plugins.get(ns) || { name: ns, status: 'inferred from skill namespace; plugin use unconfirmed', info: '', calls: [] };
    p.info += skill.name + '\n'; p.calls.push(...skill.calls); plugins.set(ns, p);
  }
  rows.plugin = [...plugins.values()];
  const toolMap = new Map();
  for (const call of calls) {
    const entry = toolMap.get(call.name) || { name: call.name, status: 'outer tool calls recorded', info: '', calls: [] };
    entry.calls.push(call); toolMap.set(call.name, entry);
    if (/spawn_agent|send_message|followup_task|wait_agent|wait_threads|interrupt_agent/.test(call.name))
      rows.agent.push({ name: call.name, status: call.status, info: call.input, calls: [call] });
    let input; try { input = JSON.parse(call.input); } catch {}
    const command = input?.cmd ?? input?.command;
    if (typeof command === 'string') rows.command.push({ name: command.slice(0, 100), status: call.status, info: command, calls: [call] });
  }
  for (const entry of toolMap.values()) rows[/mcp__|mcp\./.test(entry.name) ? 'mcp' : 'tool'].push(entry);
  for (const request of m.nestedToolRequests || []) {
    const category = /spawn_agent|send_message|followup_task|wait_agent|wait_threads|interrupt_agent/.test(request.name) ? 'agent'
      : /mcp__/.test(request.name) ? 'mcp' : 'tool';
    rows[category].push({ name: request.name, status: `${request.count} references inside exec`,
      info: 'Requested in wrapper source; execution may depend on branches or loops.',
      calls: calls.filter(c => c.nestedRequests.includes(request.name)) });
  }
  // Wrapper source also contains shell command arguments. Keep the exact source
  // available for inspection rather than pretending a regex is a JS evaluator.
  for (const call of calls.filter(c => c.nestedRequests.some(n => /exec_command/.test(n))))
    rows.command.push({ name: `Shell requests in ${call.name}`, status: 'inspect wrapper source', info: call.input, calls: [call] });
  const descendants = [];
  m.walk(n || m.root, node => { if (node !== n && node.type === 'agent') descendants.push(node); });
  for (const node of descendants) rows.agent.unshift({ name: node.name,
    status: 'linked child rollout', info: `${node.model || 'Unknown model'} · ${node.selfTok.toLocaleString()} tokens · ${node.id}`,
    calls: [], sessionId: node.id });
  rows.review = (m.reviews || []).map(review => ({ name: `${review.outcome} · ${review.at}`,
    status: `risk: ${review.risk} · authorization: ${review.authorization}`,
    info: review.rationale, request: review.request, calls: [] }));
  const activeReg = reg === 'skill' && rows.skill.length === 0 && rows.review.length ? 'review' : reg;
  const counts = Object.fromEntries(['read', 'referenced', 'advertised'].map(state => [state, rows.skill.filter(r => r.state === state).length]));
  const selected = activeReg === 'skill' ? rows.skill.filter(r => skillFilter === 'all' || r.state === skillFilter) : rows[activeReg] || [];
  return html`<section class="panel fade">
    <div class="ph"><span class="pt">Codex resource details</span><span class="psub">advertised resources and recorded activity</span></div>
    <div class="tabs">${categories.map(([key, label]) => html`<button class=${activeReg === key ? 'on' : ''} onClick=${() => setReg(key)}>${label}<span class="n">${rows[key].length}</span></button>`)}</div>
    ${m.reviews?.length && !calls.length ? html`<div class="lp-d wide">This agent's retained rollout records review decisions and instructions, with no direct tool calls retained. Skill invocation is unknown.</div>` : null}
    <div class="lp-d wide">Used means a call references the skill's path and its result contains that skill's instructions. References alone and advertised descriptions are listed separately. This does not prove every instruction was followed. Nested exec references and plugin associations remain inferred.</div>
    ${activeReg === 'skill' ? html`<div class="filters" aria-label="Skill activity filters">${[['read', 'Used'], ['referenced', 'Referenced'], ['advertised', 'Available only'], ['all', 'All']].map(([key, label]) => html`<button class=${skillFilter === key ? 'on' : ''} aria-pressed=${skillFilter === key} onClick=${() => setSkillFilter(key)}>${label} (${key === 'all' ? rows.skill.length : counts[key]})</button>`)}</div>` : null}
    <div key=${`${n?.id || 'root'}:${activeReg}:${skillFilter}`} class="codex-resource-scroll" role="region" aria-label="Codex resource list" tabindex="0">
    ${!selected.length ? html`<div class="empty">${activeReg === 'skill' ? 'No skills in this activity filter. Select All to inspect the recorded catalog.' : `No ${reg} evidence retained in this rollout.`}</div>` : null}
    ${selected.map(row => html`<details style="border-bottom:1px solid var(--line,#eee);padding:10px 0">
      <summary style="cursor:pointer"><b>${row.name}</b> <span class="mut">${row.status}${row.tokens ? ` · ~${row.tokens.toLocaleString()} recorded text tokens` : ''}${activeReg !== 'review' ? ` · ${row.calls.length} linked calls` : ''}</span></summary>
      ${row.sessionId ? html`<button onClick=${() => onSel(row.sessionId)}>Inspect agent in this tree →</button>` : null}
      <pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto">${row.info}</pre>
      ${row.request ? html`<details><summary>Review request (up to 6,000 characters)</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto">${row.request}</pre></details>` : null}
      ${row.calls.map(call => html`<details style="margin:8px 0 8px 16px"><summary>${call.at} · ${call.name} · ${call.status}${call.durationMs != null ? ` · ${call.durationMs} ms` : ''}</summary>
        <div class="lp-d wide">Call ID: ${call.id || 'not supplied'} · ${call.resultBytes ?? 0} result bytes</div>
        ${call.skillDocuments?.length ? html`<div class="lp-d wide">Skill documents returned: ${call.skillDocuments.join(', ')}</div>` : null}
        <b>Input${call.inputTruncated ? ' (truncated)' : ''}</b><pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto">${call.input}</pre>
        <b>Result preview (up to 6,000 characters)</b><pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto">${call.output || 'No result retained.'}</pre>
      </details>`)}
    </details>`)}
    </div>
    <div class="lp-d wide" style="margin-top:10px">Call details show the latest 200 retained calls. Child rollouts with recorded parent metadata are linked in the execution tree. A dispatch request alone is not a measured child execution.</div>
  </section>`;
}
