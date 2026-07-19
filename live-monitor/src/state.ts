// ----------------------------------------------------------------------------
// State
// ----------------------------------------------------------------------------




import { RING_MAX, SESSION_ACTIVE_MS, SESSION_LINE_MAX } from "./config.ts";
import { MonitorEvent, SessionAgg, SessionLine, SubagentMeta } from "./types.ts";
import { log } from "./util.ts";

export const ring: MonitorEvent[] = [];
export let nextId = 1;
export const sessions = new Map<string, SessionAgg>();

// v2: per-session bounded line store + lazily-built SessionDetail cache.
export const sessionLines = new Map<string, SessionLine[]>();
export const detailCache = new Map<string, { at: number; json: string }>();
// v3: cached /api/observe payloads (spec entity model), same invalidation.
export const observeCache = new Map<string, { at: number; json: string }>();

// Per-file incremental read state: byte offset + partial trailing line buffer.
export const fileState = new Map<string, { offset: number; partial: string }>();

export const subagentMeta = new Map<string, SubagentMeta>(); // agentId → meta

// SSE clients
export const clients = new Set<(ev: MonitorEvent) => void>();

// ----------------------------------------------------------------------------
// Aggregation
// ----------------------------------------------------------------------------
export function updateAgg(ev: MonitorEvent) {
  let a = sessions.get(ev.sessionId);
  if (!a) {
    a = {
      sessionId: ev.sessionId,
      project: ev.project,
      firstTs: ev.ts,
      lastTs: ev.ts,
      prompts: 0,
      events: 0,
      models: {},
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      tools: {},
      skills: {},
      commands: {},
      rules: {},
      agents: {},
    };
    sessions.set(ev.sessionId, a);
  }
  a.project = ev.project || a.project;
  if (ev.cwd) a.cwd = ev.cwd; // last-seen working directory wins
  if (ev.ts < a.firstTs) a.firstTs = ev.ts;
  if (ev.ts > a.lastTs) a.lastTs = ev.ts;
  a.events++;
  if (ev.kind === "prompt") a.prompts++;
  if (ev.model) a.models[ev.model] = (a.models[ev.model] ?? 0) + 1;
  if (ev.usage) {
    a.usage.input += ev.usage.input;
    a.usage.output += ev.usage.output;
    a.usage.cacheRead += ev.usage.cacheRead;
    a.usage.cacheWrite += ev.usage.cacheWrite;
  }
  if (ev.tools) for (const t of ev.tools) a.tools[t] = (a.tools[t] ?? 0) + 1;
  if (ev.skill) a.skills[ev.skill] = (a.skills[ev.skill] ?? 0) + 1;
  if (ev.command) a.commands[ev.command] = (a.commands[ev.command] ?? 0) + 1;
  if (ev.rules) for (const r of ev.rules) a.rules[r] = (a.rules[r] ?? 0) + 1;
  if (ev.agent) a.agents[ev.agent] = (a.agents[ev.agent] ?? 0) + 1;
}

// v2: retain the parsed line in the per-session bounded store; invalidate the
// cached SessionDetail so it rebuilds on the next request.
export function storeSessionLine(sessionId: string, line: SessionLine) {
  let arr = sessionLines.get(sessionId);
  if (!arr) {
    arr = [];
    sessionLines.set(sessionId, arr);
  }
  arr.push(line);
  if (arr.length > SESSION_LINE_MAX) arr.splice(0, arr.length - SESSION_LINE_MAX);
  detailCache.delete(sessionId);
  observeCache.delete(sessionId);
}

// v2: drop line stores + caches for sessions inactive > 7 days.
export function pruneSessionStores() {
  const now = Date.now();
  for (const [id, a] of sessions) {
    const last = Date.parse(a.lastTs);
    if (Number.isFinite(last) && now - last > SESSION_ACTIVE_MS) {
      sessionLines.delete(id);
      detailCache.delete(id);
      observeCache.delete(id);
    }
  }
}

export function emit(partial: Omit<MonitorEvent, "id">, broadcast: boolean, line?: SessionLine) {
  const ev: MonitorEvent = { id: nextId++, ...partial };
  ring.push(ev);
  if (ring.length > RING_MAX) ring.shift();
  updateAgg(ev);
  if (line) storeSessionLine(ev.sessionId, line);
  if (broadcast) {
    for (const send of clients) {
      try {
        send(ev);
      } catch (e) {
        log("client send error", e);
      }
    }
  }
}

