// ----------------------------------------------------------------------------
// v3: /api/observe — session-observability entity model (spec §2).
// One node per session (root) + one per sub-agent sidechain chain. Rules:
//   • selfTok / cost EXCLUDE descendants — rollups add upward from leaves.
//   • Every dyn TriggerEvent carries `by` (triggering node name).
//   • Agent dispatches appear BOTH as a dyn event on the parent (display-only)
//     and as a child node; token rollups must walk children, never dyn.
//   • pre[].tk is per-turn occupancy (estimated; est:true flags estimates).
//   • "used" is only claimed for mechanically observable kinds (spec §7.1c):
//     skill/command/plugin/mcp/tool. memory/hook rows carry observable:false
//     and are excluded from the waste stat.
// Decisions encoded here:
//   • selfTok = fresh input + output (cache excluded) so subtree sums stay
//     meaningful; cost uses full cache pricing via costUSD (spec §7.2 TBD).
//   • ctx = peak (input + cacheRead + cacheWrite) across the node's own calls.
//   • dur = wall span of the node's own lines (activeDur split: spec §7.3 TBD).
// ----------------------------------------------------------------------------



import { LABEL_LEN } from "./config.ts";
import { costUSD } from "./cost.ts";
import { observeCache, sessionLines, sessions, subagentMeta } from "./state.ts";
import { SidechainChain, chainModel, claimChain, classifyReminder, collectSidechainChains, mcpServer, promptOf, toolNodeKind } from "./tree.ts";
import { SessionLine } from "./types.ts";
import { clip } from "./util.ts";

export type ObsKind =
  | "system" | "memory" | "skill" | "command" | "plugin" | "mcp" | "hook" | "tool" | "agent";

export interface ObsResource {
  k: ObsKind;
  n: string;
  tk: number;
  used: boolean;
  est?: boolean; // tk is an estimate (chars/4), not a measurement
  observable?: boolean; // false → excluded from waste (memory/hook)
}
export interface ObsTrigger {
  k: ObsKind;
  n: string;
  tk: number;
  at: string;
  by: string;
}
// Full decomposition of a node's peak context window (`ctx`). All measured from
// transcript usage/bytes except `base` (derived from the turn-1 window floor)
// and `prompts` (residual). Segments sum to `ctx` when nothing was compacted;
// `overflow` records cumulative history that has been evicted out of the window.
export interface CtxBreakdown {
  ctx: number;         // peak window = input + cacheRead + cacheWrite (ground truth)
  base: number;        // system prompt + tool schemas + memory/CLAUDE.md — turn-1 floor
  assistant: number;   // Σ usage.output — assistant text + tool-call JSON (measured)
  toolResults: number; // Σ resultBytes/4 — file reads, bash, skill bodies, sub-agent reports (measured)
  prompts: number;     // ctx − base − assistant − toolResults (user input + estimation slack)
  overflow: number;    // max(0, measured − ctx) — history compacted/evicted out of window
}
export interface ObsNode {
  id: string;
  type: "session" | "agent";
  name: string;
  label: string;
  model?: string;
  src?: "file" | "inline"; // agent nodes: dedicated subagents/*.jsonl vs legacy inline sidechain
  parentId: string | null;
  start?: string;
  dur?: number;
  selfTok: number;
  cost: number;
  ctx: number;
  turns: number;
  tools: Record<string, number>;
  pre: ObsResource[];
  dyn: ObsTrigger[];
  ctxBreakdown?: CtxBreakdown; // full window decomposition (spec §7.5)
  toolTokens?: Record<string, number>; // tool/skill/agent name → Σ result tokens (bytes/4)
}

export const OBS_CAP = 200_000;
export const estTok = (s: string | undefined): number =>
  s ? Math.max(1, Math.round(s.length / 4)) : 0;

// Self metrics over a set of lines (one node's own turns only).
export function obsSelf(lns: SessionLine[]) {
  let selfTok = 0;
  let cost = 0;
  let ctx = 0;
  let turns = 0;
  const tools: Record<string, number> = {};
  let firstMs = NaN;
  let lastMs = NaN;
  for (const ln of lns) {
    const t = Date.parse(ln.ts);
    if (Number.isFinite(t)) {
      if (!Number.isFinite(firstMs)) firstMs = t;
      lastMs = t;
    }
    if (ln.kind !== "assistant") continue;
    if (ln.usage) {
      selfTok += ln.usage.input + ln.usage.output;
      if (ln.model) cost += costUSD(ln.model, ln.usage);
      ctx = Math.max(ctx, ln.usage.input + ln.usage.cacheRead + ln.usage.cacheWrite);
      turns++;
    }
    for (const tu of ln.toolUses) tools[tu.name] = (tools[tu.name] ?? 0) + 1;
  }
  const dur =
    Number.isFinite(firstMs) && Number.isFinite(lastMs) && lastMs >= firstMs
      ? lastMs - firstMs
      : undefined;
  return { selfTok, cost, ctx, turns, tools, dur };
}

// Full context-window decomposition for one node's own lines. See CtxBreakdown.
// `base` is the turn-1 window (system + tools + memory) minus that turn's own
// user prompt; the remaining buckets accumulate across the node's turns and the
// residual `prompts` absorbs user input we can't size precisely (prompt text is
// clipped in the transcript) plus cache/estimation slack.
export function obsBreakdown(
  lns: SessionLine[],
  resultFor: Map<string, { ts: number; bytes: number }>,
): CtxBreakdown {
  let ctx = 0;
  let firstCtx = 0;
  let firstPromptTok = 0;
  let assistant = 0;
  let toolResults = 0;
  let sawTurn = false;
  let sawPrompt = false;
  const seenResult = new Set<string>(); // avoid double-counting a shared tool_result
  for (const ln of lns) {
    if (ln.kind === "prompt" && !sawPrompt) {
      firstPromptTok = estTok(ln.text);
      sawPrompt = true;
    }
    if (ln.kind === "tool_result" && ln.toolResultFor) {
      if (!seenResult.has(ln.toolResultFor)) {
        seenResult.add(ln.toolResultFor);
        toolResults += Math.round((ln.resultBytes ?? 0) / 4);
      }
    }
    if (ln.kind !== "assistant" || !ln.usage) continue;
    assistant += ln.usage.output;
    const w = ln.usage.input + ln.usage.cacheRead + ln.usage.cacheWrite;
    ctx = Math.max(ctx, w);
    if (!sawTurn) {
      firstCtx = w;
      sawTurn = true;
    }
  }
  const base = Math.max(0, firstCtx - firstPromptTok);
  const measured = base + assistant + toolResults;
  const prompts = Math.max(0, ctx - measured);
  const overflow = Math.max(0, measured - ctx);
  return { ctx, base, assistant, toolResults, prompts, overflow };
}

// Runtime tokens returned by each tool/skill/agent = its tool_result byte size /4.
// Keyed by display name (skill/agent name, else the raw tool name).
export function obsToolTokens(
  lns: SessionLine[],
  resultFor: Map<string, { ts: number; bytes: number }>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const ln of lns) {
    if (ln.kind !== "assistant") continue;
    for (const tu of ln.toolUses) {
      if (!tu.id) continue;
      const r = resultFor.get(tu.id);
      if (!r || !r.bytes) continue;
      const { name } = toolNodeKind(tu);
      out[name] = (out[name] ?? 0) + Math.round(r.bytes / 4);
    }
  }
  return out;
}

// Map an AutoLoad classification to an ObsKind (identical names, typed).
export const OBS_OBSERVABLE = new Set<ObsKind>(["skill", "command", "plugin", "mcp", "tool"]);

// dyn events for one node's own lines: skill body loads + command invocations.
export function obsDyn(
  lns: SessionLine[],
  by: string,
  resultFor: Map<string, { ts: number; bytes: number }>,
): ObsTrigger[] {
  const out: ObsTrigger[] = [];
  for (const ln of lns) {
    if (ln.kind === "prompt" && ln.command) {
      out.push({ k: "command", n: ln.command, tk: estTok(ln.text), at: ln.ts, by });
      continue;
    }
    if (ln.kind !== "assistant") continue;
    for (const tu of ln.toolUses) {
      const { kind, name } = toolNodeKind(tu);
      if (kind === "skill") {
        const r = tu.id ? resultFor.get(tu.id) : undefined;
        // Body cost ≈ tool_result bytes / 4 (one-time, per invocation).
        out.push({
          k: "skill",
          n: name,
          tk: r?.bytes ? Math.round(r.bytes / 4) : 0,
          at: ln.ts,
          by,
        });
      } else {
        const srv = mcpServer(tu.name);
        if (srv) out.push({ k: "mcp", n: tu.name, tk: 0, at: ln.ts, by });
      }
    }
  }
  return out;
}

export function buildObserveSnapshot(sessionId: string): string | null {
  const cached = observeCache.get(sessionId);
  if (cached) return cached.json;
  const agg = sessions.get(sessionId);
  const lines = sessionLines.get(sessionId);
  if (!agg || !lines || lines.length === 0) return null;

  const main = lines.filter((l) => !l.sidechain);
  const chains = collectSidechainChains(lines);

  // tool_use id → result (for skill body sizes + durations).
  const resultFor = new Map<string, { ts: number; bytes: number }>();
  for (const ln of lines) {
    if (ln.toolResultFor) {
      const t = Date.parse(ln.ts);
      resultFor.set(ln.toolResultFor, {
        ts: Number.isFinite(t) ? t : NaN,
        bytes: ln.resultBytes ?? 0,
      });
    }
  }

  // ----- session-scoped invoked sets (registry "used" is a session question) -----
  const invokedNames = new Set<string>(); // "<kind>|<base name>"
  for (const ln of lines) {
    if (ln.kind === "prompt" && ln.command) invokedNames.add("command|" + ln.command);
    if (ln.kind !== "assistant") continue;
    for (const tu of ln.toolUses) {
      const { kind, name } = toolNodeKind(tu);
      if (kind === "skill") {
        invokedNames.add("skill|" + name);
        const ns = name.includes(":") ? name.split(":")[0] : "";
        if (ns) invokedNames.add("plugin|" + ns);
      } else if (kind === "agent") {
        invokedNames.add("agent|" + name);
      } else {
        invokedNames.add("tool|" + tu.name);
        const srv = mcpServer(tu.name);
        if (srv) invokedNames.add("mcp|" + srv);
      }
    }
  }

  // ----- pre[]: boot context evidence from reminders (deduped) -----
  // task #11: scoped per node — root gets main-chain evidence only; each agent
  // node gets the reminders from its own transcript lines. `used` stays a
  // session-wide question (invokedNames covers all lines).
  const buildPre = (lns: SessionLine[]): ObsResource[] => {
    const preMap = new Map<string, ObsResource>();
    for (const ln of lns) {
      for (const ev of ln.reminders) {
        const a = classifyReminder(ev);
        const k = a.type as ObsKind;
        const key = k + "|" + a.name;
        const observable = OBS_OBSERVABLE.has(k);
        const prev = preMap.get(key);
        const tk = estTok(a.evidence);
        if (prev) {
          // Keep the largest evidence estimate for per-turn occupancy.
          if (tk > prev.tk) prev.tk = tk;
          continue;
        }
        preMap.set(key, {
          k,
          n: a.name,
          tk,
          used: observable ? invokedNames.has(key) : true,
          est: true,
          ...(observable ? {} : { observable: false }),
        });
      }
    }
    return [...preMap.values()];
  };
  const rootPre = buildPre(main);

  // ----- nodes -----
  const rootSelf = obsSelf(main);
  const rootModel = (() => {
    let best = "";
    let bestN = 0;
    for (const [m, n] of Object.entries(agg.models)) if (n > bestN) { best = m; bestN = n; }
    return best || undefined;
  })();
  const root: ObsNode = {
    id: agg.sessionId,
    type: "session",
    name: "main",
    label: agg.project + (agg.cwd ? ` — ${agg.cwd}` : ""),
    ...(rootModel ? { model: rootModel } : {}),
    parentId: null,
    start: agg.firstTs,
    ...(rootSelf.dur !== undefined ? { dur: rootSelf.dur } : {}),
    selfTok: rootSelf.selfTok,
    cost: rootSelf.cost,
    ctx: rootSelf.ctx,
    turns: rootSelf.turns,
    tools: rootSelf.tools,
    pre: rootPre,
    dyn: obsDyn(main, "main", resultFor),
    ctxBreakdown: obsBreakdown(main, resultFor),
    toolTokens: obsToolTokens(main, resultFor),
  };
  const nodes: ObsNode[] = [root];

  // Agent tool_uses on the main chain claim sidechain chains → child nodes,
  // plus a display-only dyn event on the root (spec §3: never sum both).
  let ai = 0;
  const addAgentNode = (name: string, chain: SidechainChain, at: string) => {
    const self = obsSelf(chain.lines);
    const model = chainModel(chain);
    // Stable-ish id: prefer the on-disk agent id (dedicated transcripts).
    const id = chain.agentId ? `${agg.sessionId}:${chain.agentId}` : `${agg.sessionId}:a${ai++}`;
    nodes.push({
      id,
      type: "agent",
      name,
      label: clip(chain.promptText, LABEL_LEN),
      ...(model ? { model } : {}),
      src: chain.source, // "file" = dedicated subagents/*.jsonl (task #11)
      parentId: agg.sessionId,
      start: chain.rootTs,
      ...(self.dur !== undefined ? { dur: self.dur } : {}),
      selfTok: self.selfTok,
      cost: self.cost,
      ctx: self.ctx,
      turns: self.turns,
      tools: self.tools,
      // task #11: the agent's own boot context, from its dedicated transcript
      // (legacy inline chains rarely carry reminders — usually empty there).
      pre: buildPre(chain.lines),
      dyn: obsDyn(chain.lines, name, resultFor),
      ctxBreakdown: obsBreakdown(chain.lines, resultFor),
      toolTokens: obsToolTokens(chain.lines, resultFor),
    });
    root.dyn.push({ k: "agent", n: name, tk: self.selfTok, at, by: "main" });
  };

  for (const ln of main) {
    if (ln.kind !== "assistant") continue;
    for (const tu of ln.toolUses) {
      const { kind, name } = toolNodeKind(tu);
      if (kind !== "agent") continue;
      const chain = claimChain(chains, promptOf(tu.input), ln.ts, tu.id || undefined);
      if (chain) addAgentNode(name, chain, ln.ts);
    }
  }
  for (const c of chains) {
    if (!c.claimed)
      addAgentNode(
        (c.agentId && subagentMeta.get(c.agentId)?.agentType) || "(sidechain)",
        c,
        c.rootTs,
      );
  }
  root.dyn.sort((a, b) => a.at.localeCompare(b.at));

  // ----- waste (spec §4.5) — observable kinds only -----
  const observablePre = rootPre.filter((r) => r.observable !== false);
  const preTotal = rootPre.reduce((s, r) => s + r.tk, 0);
  const waste = observablePre.reduce((s, r) => s + (r.used ? 0 : r.tk), 0);
  const obsTotal = observablePre.reduce((s, r) => s + r.tk, 0);

  const json = JSON.stringify({
    v: 3,
    cap: OBS_CAP,
    generatedAt: new Date().toISOString(),
    session: {
      sessionId: agg.sessionId,
      project: agg.project,
      ...(agg.cwd ? { cwd: agg.cwd } : {}),
      firstTs: agg.firstTs,
      lastTs: agg.lastTs,
      prompts: agg.prompts,
    },
    nodes,
    waste: {
      preTotal,
      observableTotal: obsTotal,
      wasted: waste,
      wastePct: obsTotal > 0 ? waste / obsTotal : 0,
      // §7.4: per-turn cost of waste — needs cache pricing decision first.
      turnCount: root.turns,
    },
  });
  observeCache.set(sessionId, { at: Date.now(), json });
  return json;
}

