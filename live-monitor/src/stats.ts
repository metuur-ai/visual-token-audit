// ----------------------------------------------------------------------------
// v4: global usage statistics (/api/stats) — self-contained on-disk scan.
// In-memory state only covers SEED_MTIME_WINDOW_MS (~48h), so this endpoint
// re-reads transcripts from disk for the requested window (1..30 days).
// Detection mirrors parseLine (Skill / Task|Agent / detectCommand) on purpose —
// patterns are COPIED, not refactored, to keep the live ingest path untouched.
// ----------------------------------------------------------------------------



import { readFileSync, statSync } from "fs";
import { basename } from "path";
import { PROJECTS_DIR, STATS_DAY_MS } from "./config.ts";
import { costUSD } from "./cost.ts";
import { sessions } from "./state.ts";
import { bump } from "./tree.ts";
import { detectCommand, detectRules, log, projectName, usageFrom } from "./util.ts";
import { listJsonlFiles, subagentPathOf } from "./watch.ts";

export const STATS_CACHE_MS = 60_000;
// keyed by `days`; valid while <60s old AND the file signature is unchanged.
export const statsCache = new Map<number, { at: number; sig: string; json: string }>();

export function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface StatEntity {
  count: number;
  sessions: Set<string>;
  tokens: number;
  lastMs: number;
  byDay: number[];
}

export function buildStatsJSON(days: number): string {
  const t0 = Date.now();

  // ----- window: `days` local calendar days, oldest→newest, incl. today -----
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startMs = today.getTime() - (days - 1) * STATS_DAY_MS;
  const dayKeys: string[] = [];
  const dayIdx = new Map<string, number>();
  for (let i = 0; i < days; i++) {
    // +12h before localDayKey sidesteps DST-shortened days.
    const k = localDayKey(startMs + i * STATS_DAY_MS + STATS_DAY_MS / 2);
    dayIdx.set(k, i);
    dayKeys.push(k);
  }

  // ----- candidate files (mtime in window) + cheap cache signature -----
  const files: Array<{ path: string; mtime: number; size: number }> = [];
  let maxM = 0;
  let totalB = 0;
  for (const p of listJsonlFiles()) {
    try {
      const st = statSync(p);
      if (st.mtimeMs < startMs) continue;
      files.push({ path: p, mtime: st.mtimeMs, size: st.size });
      if (st.mtimeMs > maxM) maxM = st.mtimeMs;
      totalB += st.size;
    } catch {
      // vanished between listing and stat — skip
    }
  }
  const sig = `${files.length}:${Math.round(maxM)}:${totalB}`;
  const hit = statsCache.get(days);
  if (hit && hit.sig === sig && t0 - hit.at < STATS_CACHE_MS) return hit.json;

  // ----- aggregation state -----
  const sessionsSeen = new Set<string>();
  const projectsSeen = new Set<string>();
  const daySessions: Array<Set<string>> = dayKeys.map(() => new Set());
  const dayPrompts: number[] = new Array(days).fill(0);
  const dayTokens: number[] = new Array(days).fill(0);
  let prompts = 0;
  let tokens = 0;
  let cost = 0;
  const skills = new Map<string, StatEntity>();
  const commands = new Map<string, StatEntity>();
  const rules = new Map<string, StatEntity>();
  const agents = new Map<string, StatEntity>();
  // v5: tools = built-in tool_use names (mcp__* excluded; Skill/Task/Agent have
  // their own categories); mcp = mcp__<server>__<tool> grouped by server;
  // plugins = derived from "<plugin>:" prefix on skill/command/agent names.
  const tools = new Map<string, StatEntity>();
  const mcp = new Map<string, StatEntity>();
  const plugins = new Map<string, StatEntity>();
  const models = new Map<string, { count: number; tokens: number }>();
  // Task tool_use id → agent entity, to attribute sub-agent transcript tokens
  // (join via subagents/agent-<id>.meta.json toolUseId, same link as task #11).
  const taskAgent = new Map<string, StatEntity>();
  const pendingSub: Array<{ toolUseId: string; tokens: number }> = [];

  // "<plugin>:<rest>" (skills/agents) or "/<plugin>:<rest>" (commands) → plugin name.
  const pluginOf = (name: string): string | null => {
    const n = name.startsWith("/") ? name.slice(1) : name;
    const i = n.indexOf(":");
    return i > 0 ? n.slice(0, i) : null;
  };

  const bump = (m: Map<string, StatEntity>, name: string, sid: string, tsMs: number): StatEntity => {
    let e = m.get(name);
    if (!e) {
      e = { count: 0, sessions: new Set(), tokens: 0, lastMs: 0, byDay: new Array(days).fill(0) };
      m.set(name, e);
    }
    e.count++;
    e.sessions.add(sid);
    if (tsMs > e.lastMs) e.lastMs = tsMs;
    const di = dayIdx.get(localDayKey(tsMs));
    if (di !== undefined) e.byDay[di]++;
    return e;
  };

  // ----- scan -----
  for (const f of files) {
    const sub = subagentPathOf(f.path);
    const rel = f.path.slice(PROJECTS_DIR.length + 1);
    const slug = rel.split("/")[0] ?? "";
    const fallbackSid = sub?.parentSessionId ?? basename(f.path, ".jsonl");
    let raw: string;
    try {
      raw = readFileSync(f.path, "utf8");
    } catch {
      continue;
    }
    let fileTok = 0; // sub-agent transcript in-window token sum (for agent join)
    let contributed = false;
    let projectAdded = false;

    for (let s = 0, e = 0; s < raw.length; s = e + 1) {
      e = raw.indexOf("\n", s);
      if (e === -1) e = raw.length;
      const line = raw.slice(s, e);
      if (!line) continue;
      // Cheap substring pre-filters before JSON.parse (files can be huge).
      const isAsst = line.includes('"type":"assistant"');
      const isUser = !isAsst && line.includes('"type":"user"');
      if (!isAsst && !isUser) continue;
      if (isAsst && !line.includes('"usage"') && !line.includes('"tool_use"')) continue;
      if (isUser && (line.includes('"tool_use_id"') || line.includes('"isMeta":true'))) continue;

      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (!o || typeof o !== "object") continue;
      const tsMs = Date.parse(typeof o.timestamp === "string" ? o.timestamp : "");
      if (!Number.isFinite(tsMs) || tsMs < startMs) continue; // outside window
      const di = dayIdx.get(localDayKey(tsMs));
      const sid = sub?.parentSessionId ?? (typeof o.sessionId === "string" ? o.sessionId : fallbackSid);
      const msg = o.message;

      contributed = true;
      sessionsSeen.add(sid);
      if (di !== undefined) daySessions[di].add(sid);
      if (!projectAdded) {
        projectsSeen.add(projectName(o.cwd, slug));
        projectAdded = true;
      }

      if (isAsst) {
        const u = usageFrom(msg?.usage);
        if (u) {
          const tok = u.input + u.output + u.cacheRead + u.cacheWrite;
          tokens += tok;
          fileTok += tok;
          if (di !== undefined) dayTokens[di] += tok;
          const model = typeof msg?.model === "string" ? msg.model : "unknown";
          if (model !== "<synthetic>") {
            cost += costUSD(model, u);
            const me = models.get(model) ?? { count: 0, tokens: 0 };
            me.count++;
            me.tokens += tok;
            models.set(model, me);
          }
        }
        if (Array.isArray(msg?.content)) {
          for (const b of msg.content) {
            if (!b || typeof b !== "object" || b.type !== "tool_use" || typeof b.name !== "string") continue;
            if (b.name === "Skill" && b.input && typeof b.input === "object") {
              // Real format: input.skill (verified). Keep command/name fallbacks.
              const sn = b.input.skill ?? b.input.command ?? b.input.name;
              if (typeof sn === "string") {
                bump(skills, sn, sid, tsMs);
                const pl = pluginOf(sn);
                if (pl) bump(plugins, pl, sid, tsMs);
              }
            } else if ((b.name === "Task" || b.name === "Agent") && b.input && typeof b.input === "object") {
              const at = b.input.subagent_type ?? b.input.subagentType ?? b.input.agent;
              if (typeof at === "string") {
                const ent = bump(agents, at, sid, tsMs);
                if (typeof b.id === "string" && b.id) taskAgent.set(b.id, ent);
                const pl = pluginOf(at);
                if (pl) bump(plugins, pl, sid, tsMs);
              }
            } else if (b.name.startsWith("mcp__")) {
              // mcp__<server>__<tool> → group by server (same as SessionDetail.mcp).
              const server = b.name.split("__")[1] || b.name;
              bump(mcp, server, sid, tsMs);
            } else {
              bump(tools, b.name, sid, tsMs);
            }
          }
        }
        continue;
      }

      // user line — count real human prompts only (sub-agent inputs excluded).
      if (sub || o.isSidechain === true) continue;
      const content = msg?.content;
      let ptext = "";
      if (typeof content === "string") {
        ptext = content;
      } else if (Array.isArray(content)) {
        let hasToolResult = false;
        for (const b of content) {
          if (!b || typeof b !== "object") continue;
          if (b.type === "tool_result") {
            hasToolResult = true;
            break;
          }
          if (b.type === "text" && typeof b.text === "string") ptext += b.text + "\n";
        }
        if (hasToolResult) continue;
      } else {
        continue;
      }
      if (!ptext.trim()) continue;
      prompts++;
      if (di !== undefined) dayPrompts[di]++;
      const command = detectCommand(ptext);
      if (command) {
        bump(commands, command, sid, tsMs);
        const pl = pluginOf(command);
        if (pl) bump(plugins, pl, sid, tsMs);
      }
      for (const r of detectRules(ptext)) bump(rules, r, sid, tsMs);
    }

    // Sub-agent transcript: link its token sum to the parent Task tool_use.
    if (sub && fileTok > 0) {
      try {
        const mo = JSON.parse(readFileSync(f.path.replace(/\.jsonl$/, ".meta.json"), "utf8"));
        if (mo && typeof mo.toolUseId === "string") {
          pendingSub.push({ toolUseId: mo.toolUseId, tokens: fileTok });
        }
      } catch {
        // meta missing — tokens stay in totals, unattributed to an agent (fine)
      }
    }
    if (!contributed) continue;
  }

  // ----- join sub-agent tokens onto agent entities -----
  for (const p of pendingSub) {
    const ent = taskAgent.get(p.toolUseId);
    if (ent) ent.tokens += p.tokens;
  }

  // ----- shape response (contract: EXACT keys, count desc / tokens desc) -----
  const entOut = (m: Map<string, StatEntity>) =>
    Array.from(m.entries())
      .map(([name, e]) => ({
        name,
        count: e.count,
        sessions: e.sessions.size,
        tokens: e.tokens,
        lastUsed: new Date(e.lastMs).toISOString(),
        byDay: e.byDay,
      }))
      .sort((a, b) => b.count - a.count);

  const skillsOut = entOut(skills);
  const commandsOut = entOut(commands);
  const rulesOut = entOut(rules);
  const agentsOut = entOut(agents);
  const toolsOut = entOut(tools);
  const mcpOut = entOut(mcp);
  const pluginsOut = entOut(plugins);
  const sum = (arr: Array<{ count: number }>) => arr.reduce((a, x) => a + x.count, 0);

  const json = JSON.stringify({
    days,
    generatedAt: new Date().toISOString(),
    totals: {
      sessions: sessionsSeen.size,
      projects: projectsSeen.size,
      prompts,
      tokens,
      cost,
      agentRuns: sum(agentsOut),
      skillInvocations: sum(skillsOut),
      commandRuns: sum(commandsOut),
      ruleLoads: sum(rulesOut),
      toolRuns: sum(toolsOut),
      mcpCalls: sum(mcpOut),
      pluginUses: sum(pluginsOut),
    },
    byDay: dayKeys.map((date, i) => ({
      date,
      sessions: daySessions[i].size,
      prompts: dayPrompts[i],
      tokens: dayTokens[i],
    })),
    skills: skillsOut,
    commands: commandsOut,
    rules: rulesOut,
    agents: agentsOut,
    tools: toolsOut,
    mcp: mcpOut,
    plugins: pluginsOut,
    models: Array.from(models.entries())
      .map(([name, m]) => ({ name, count: m.count, tokens: m.tokens }))
      .sort((a, b) => b.tokens - a.tokens),
  });
  statsCache.set(days, { at: Date.now(), sig, json });
  log(`stats(${days}d): ${files.length} files (${(totalB / 1e6).toFixed(1)}MB) in ${Date.now() - t0}ms`);
  return json;
}

