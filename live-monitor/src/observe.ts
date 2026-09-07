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
import {
  StartupInventory,
  PluginCounts,
  SkillBudget,
  getStartupInventory,
  skillListingBudget,
  contextWindowForModel,
} from "./startup-inventory.ts";
import { observeCache, sessionLines, sessions, subagentMeta } from "./state.ts";
import { SidechainChain, chainModel, claimChain, classifyReminder, collectSidechainChains, mcpServer, promptOf, toolNodeKind } from "./tree.ts";
import { SessionLine } from "./types.ts";
import { basename } from "path";
import { clip, log } from "./util.ts";

export type ObsKind =
  | "system" | "memory" | "skill" | "command" | "plugin" | "mcp" | "hook" | "tool" | "agent"
  | "rule"; // .claude/rules/*.md — was already emitted by classifyReminder via a cast

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
// Full decomposition of a node's peak context window (`ctx`). `ctx` is a STOCK
// (peak input-window occupancy), so the flow buckets (`assistant`, `toolResults`)
// are accumulated only UP TO the turn where the window peaked — history produced
// after the peak is not resident in that window and would otherwise inflate the
// sum. `base` is the turn-1 floor and `prompts` is the residual, so segments sum
// to `ctx` (± estimation slack) with no compaction. `overflow` fires only when
// accumulated history already exceeds the peak window (compaction/eviction).
export interface CtxBreakdown {
  ctx: number;         // peak window = input + cacheRead + cacheWrite (ground truth)
  base: number;        // system prompt + tool schemas + memory/CLAUDE.md — turn-1 floor
  assistant: number;   // Σ usage.output up to the peak-window turn (resident history)
  toolResults: number; // Σ resultBytes/4 up to the peak-window turn (resident history)
  prompts: number;     // ctx − base − assistant − toolResults (user input + estimation slack)
  overflow: number;    // max(0, base+assistant+toolResults − ctx) — evicted/compacted or estimate slack
}
// Reconstruction of the `base` floor (CtxBreakdown.base) from local disk: the
// disk-itemizable categories (skills/agents/memory) plus a single residual row
// for the un-reconstructable remainder (system prompt + tool schemas + MCP).
// Σ(categories.tk) === base exactly (residual is defined to make it so). tk uses
// the vendored o200k tokenizer (provenance stamped); `est` if the vocab is absent.
export interface BaseCategory {
  k: "skill" | "agent" | "memory" | "rule" | "residual";
  label: string;
  tk: number;
  residual?: boolean;
  // `live:false` rows are conditional rules whose globs matched no file this
  // session — they were never injected, so their tk is EXCLUDED from the
  // category total (Σ items.tk may exceed tk for the rule category; that is the
  // point: it is the cost you are not paying, listed for visibility).
  items?: Array<{
    n: string;
    tk: number;
    used: boolean;
    observable?: boolean;
    live?: boolean;
    paths?: string[];
    capped?: boolean; // skills: description clamped by skillListingMaxDescChars
  }>;
}
export interface BaseBreakdown {
  base: number;
  tokenizer: "o200k" | "est";
  scannedAt: string;
  categories: BaseCategory[];
  skillBudget?: SkillBudget; // char budget for the skill listing (spec §7.6)
  plugins?: PluginCounts; // how many installed plugins survived the enablement filter
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
  evidence?: ReturnType<typeof codexNodeEvidence>;
  usage?: import("./types.ts").Usage;
  contextWindow?: number;
  selfTok: number;
  cost: number;
  ctx: number;
  turns: number;
  tools: Record<string, number>;
  pre: ObsResource[];
  dyn: ObsTrigger[];
  ctxBreakdown?: CtxBreakdown; // full window decomposition (spec §7.5)
  baseBreakdown?: BaseBreakdown; // root-only: disk reconstruction of `base` (Tier 2)
  toolTokens?: Record<string, number>; // tool/skill/agent name → Σ result tokens (bytes/4)
}

export const OBS_CAP = 200_000;
// Byte-based token estimate (bytes/4), matching the tool_result / skill-body
// sizing below so every "÷4" estimate in this module shares one basis (UTF-16
// string .length diverges from bytes for multibyte text). Not a real tokenizer.
export const estTok = (s: string | undefined): number =>
  s ? Math.max(1, Math.round(Buffer.byteLength(s, "utf8") / 4)) : 0;

// First-prompt sizing prefers the full byte length captured at parse time
// (SessionLine.textBytes); `text` is clipped to TEXT_SNIPPET_LEN and would
// undercount, folding the user's first prompt into the ctx `base` floor.
const promptTok = (ln: SessionLine): number =>
  ln.textBytes !== undefined ? Math.round(ln.textBytes / 4) : estTok(ln.text);

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
      // selfTok = fresh input + output (cache EXCLUDED) — a per-node flow.
      // cost is cache-INCLUSIVE (see costUSD), so a node can legitimately show a
      // small selfTok yet a real cost. Absent/unknown model → DEFAULT_PRICING
      // (priceFor), so cost is never silently dropped when selfTok still counts.
      selfTok += ln.usage.input + ln.usage.output;
      if (ln.provider === "codex") selfTok += ln.usage.cacheRead + ln.usage.cacheWrite;
      if (ln.provider !== "codex") cost += costUSD(ln.model ?? "", ln.usage);
      ctx = Math.max(ctx, ln.provider === "codex" ? ln.contextTokens ?? 0 : ln.usage.input + ln.usage.cacheRead + ln.usage.cacheWrite);
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
// user prompt. The flow buckets are accumulated as we walk the transcript in
// order but only FROZEN at the turn where the input window peaked: a turn's own
// output is not part of its own input window, and anything produced after the
// peak is not resident in it, so summing every turn would wrongly pin `prompts`
// to 0 and make `overflow` grow with turn count rather than signal eviction.
export function obsBreakdown(lns: SessionLine[]): CtxBreakdown {
  let ctx = 0;
  let firstCtx = 0;
  let firstPromptTok = 0;
  let sawTurn = false;
  let sawPrompt = false;
  let cumAssistant = 0; // running Σ output as we walk the lines in order
  let cumResults = 0;   // running Σ tool_result bytes/4 (deduped)
  let peakAssistant = 0; // cumAssistant frozen at the peak-window turn
  let peakResults = 0;   // cumResults frozen at the peak-window turn
  const seenResult = new Set<string>(); // avoid double-counting a shared tool_result
  for (const ln of lns) {
    if (ln.kind === "prompt" && !sawPrompt) {
      firstPromptTok = promptTok(ln);
      sawPrompt = true;
    }
    if (ln.kind === "tool_result" && ln.toolResultFor) {
      if (!seenResult.has(ln.toolResultFor)) {
        seenResult.add(ln.toolResultFor);
        cumResults += Math.round((ln.resultBytes ?? 0) / 4);
      }
    }
    if (ln.kind !== "assistant" || !ln.usage) continue;
    const w = ln.usage.input + ln.usage.cacheRead + ln.usage.cacheWrite;
    if (!sawTurn) {
      firstCtx = w;
      sawTurn = true;
    }
    if (w > ctx) {
      // New peak input window: resident history is everything accumulated
      // BEFORE this turn's own output (its output isn't in its own input).
      ctx = w;
      peakAssistant = cumAssistant;
      peakResults = cumResults;
    }
    cumAssistant += ln.usage.output;
  }
  const base = Math.max(0, firstCtx - firstPromptTok);
  const measured = base + peakAssistant + peakResults;
  const prompts = Math.max(0, ctx - measured);
  const overflow = Math.max(0, measured - ctx);
  return { ctx, base, assistant: peakAssistant, toolResults: peakResults, prompts, overflow };
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

// dyn events for one node's own lines: skill/command/mcp invocations, each
// attributed to the *invoker entity* (`by`) — the trigger active when it fired,
// not the node it ran in (the node is conveyed by the scope filter). The trigger
// is the most recent user turn on this chain: a slash command → that command
// name; a plain prompt → "prompt". Vectors are captured uniformly regardless of
// mechanism: the `Skill` tool, loader markers (SKILL:/COMPANION: in a
// tool_result), and command expansions all become rows.
export function obsDyn(
  lns: SessionLine[],
  resultFor: Map<string, { ts: number; bytes: number }>,
): ObsTrigger[] {
  const out: ObsTrigger[] = [];
  let trigger = "prompt"; // active invoker until the next user turn
  const loaderSeen = new Set<string>(); // dedupe idempotent loader-marker skills by name
  for (const ln of lns) {
    if (ln.kind === "prompt") {
      if (ln.command) {
        // A slash command is invoked by the user turn itself.
        out.push({ k: "command", n: ln.command, tk: estTok(ln.text), at: ln.ts, by: "prompt" });
        trigger = ln.command;
      } else {
        trigger = "prompt";
      }
      continue;
    }
    if (ln.kind === "tool_result") {
      // Skills resolved via a loader (no `Skill` tool_use). Body doesn't
      // materialize as a discrete blob, so tk stays 0 — the value is the
      // visible invocation + its invoker.
      for (const n of ln.skillLoads ?? []) {
        if (loaderSeen.has(n)) continue;
        loaderSeen.add(n);
        out.push({ k: "skill", n, tk: 0, at: ln.ts, by: trigger });
      }
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
          by: trigger,
        });
      } else {
        const srv = mcpServer(tu.name);
        if (srv) out.push({ k: "mcp", n: tu.name, tk: 0, at: ln.ts, by: trigger });
        else if (ln.provider === "codex") out.push({ k: kind === "agent" ? "agent" : "tool", n: name,
          tk: 0, at: ln.ts, by: trigger });
      }
    }
  }
  return out;
}

// Reconstruct `base` (turn-1 floor) from the startup inventory: itemize the
// ----- conditional-rule resolution -------------------------------------------
// A rule with `paths` globs is only injected when the session touches a matching
// file. To answer that we need the files the session actually touched — from
// EVERY line, main chain and sub-agents alike (a rule pulled in by a sub-agent's
// Read is just as loaded as one pulled in by the root's).
//
// Evidence is limited to explicit path parameters on tool inputs. Paths named
// only inside a Bash command string are deliberately NOT parsed: guessing which
// argv token is a file produces false "live" verdicts, and a wrong yes here
// silently inflates the base floor.
const PATH_KEYS = ["file_path", "notebook_path", "path", "filePath"] as const;

function relPath(p: string, cwd: string): string {
  let out = p;
  if (cwd && out.startsWith(cwd + "/")) out = out.slice(cwd.length + 1);
  return out.replace(/^\.\//, "");
}

export function collectTouchedFiles(lines: SessionLine[], cwd: string): Set<string> {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string" && v) out.add(relPath(v, cwd));
  };
  for (const ln of lines) {
    for (const tu of ln.toolUses) {
      const inp = tu.input;
      if (!inp || typeof inp !== "object") continue;
      for (const k of PATH_KEYS) add((inp as Record<string, unknown>)[k]);
      const ps = (inp as Record<string, unknown>).paths;
      if (Array.isArray(ps)) for (const p of ps) add(p);
    }
  }
  return out;
}

// Minimal glob → RegExp. Supports **, *, ? with the usual "* stops at /" rule.
const globCache = new Map<string, RegExp>();
function globToRe(glob: string): RegExp {
  const hit = globCache.get(glob);
  if (hit) return hit;
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++; // consume second star
        if (i + 1 >= glob.length) re += ".*"; // trailing ** → everything below
        else if (glob[i + 1] === "/") {
          i++; // "a/**/b" must also match "a/b"
          re += "(?:.*\\/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if ("\\^$+.()|{}[]".includes(c)) re += "\\" + c;
    else re += c;
  }
  const rx = new RegExp("^" + re + "$");
  globCache.set(glob, rx);
  return rx;
}

// Unconditional rule → always live. Conditional → live iff some touched file
// matches some glob.
export function ruleIsLive(paths: string[] | undefined, touched: Set<string>): boolean {
  if (!paths?.length) return true;
  for (const g of paths) {
    const rx = globToRe(g);
    for (const f of touched) if (rx.test(f)) return true;
  }
  return false;
}

// disk-recoverable categories (skills/agents/memory) and collapse the rest into
// a single residual row. `used` joins reuse the session's invokedNames set
// (skill|/agent|/plugin| keys), matching pre[] semantics. Memory rows are
// observable:false (excluded from waste, same stance as pre[] memory).
export function buildBaseBreakdown(
  base: number,
  inv: StartupInventory,
  invokedNames: Set<string>,
  _cwd?: string,
  touched: Set<string> = new Set(),
  model?: string,
  peakCtx = 0,
): BaseBreakdown {
  const sum = (a: { tk: number }[]) => a.reduce((s, x) => s + x.tk, 0);
  const skillTk = sum(inv.skills);
  const agentTk = sum(inv.agents);
  const memoryTk = sum(inv.memory);
  // Only rules that were actually injected count against the measured floor.
  const ruleItems = (inv.rules ?? []).map((r) => ({
    n: r.name,
    tk: r.tk,
    used: invokedNames.has("rule|" + r.name),
    live: ruleIsLive(r.paths, touched),
    ...(r.paths?.length ? { paths: r.paths } : {}),
  }));
  const ruleTk = sum(ruleItems.filter((r) => r.live));
  const rawResidual = base - skillTk - agentTk - memoryTk - ruleTk;
  if (rawResidual < 0) {
    // Negative residual signals scope/tokenizer drift (disk sum > measured base).
    log("baseBreakdown: negative residual", { base, skillTk, agentTk, memoryTk, ruleTk, rawResidual });
  }
  const residual = Math.max(0, rawResidual);

  const skillItems = inv.skills.map((s) => {
    const ns = s.name.includes(":") ? s.name.split(":")[0] : "";
    // Loader markers key on the base name (namespace stripped), which may differ
    // from the inventory's plugin namespace — match the base name too.
    const base = s.name.includes(":") ? s.name.slice(s.name.lastIndexOf(":") + 1) : s.name;
    const used =
      invokedNames.has("skill|" + s.name) ||
      invokedNames.has("skill|" + base) ||
      (ns ? invokedNames.has("plugin|" + ns) : false);
    // `capped`: this entry's description exceeds skillListingMaxDescChars, so
    // Claude Code clamps it — the tail never reaches the model.
    const capped = (s.rawChars ?? 0) > inv.skillListingConfig.maxDescChars;
    return { n: s.name, tk: s.tk, used, ...(capped ? { capped } : {}) };
  });
  const agentItems = inv.agents.map((a) => ({
    n: a.name,
    tk: a.tk,
    used: invokedNames.has("agent|" + a.name),
  }));
  const memoryItems = inv.memory.map((m) => ({
    n: basename(m.path),
    tk: m.tk,
    used: false,
    observable: false,
  }));

  const categories: BaseCategory[] = [
    { k: "skill", label: "Skills", tk: skillTk, items: skillItems },
    { k: "agent", label: "Custom agents", tk: agentTk, items: agentItems },
    { k: "memory", label: "Memory files", tk: memoryTk, items: memoryItems },
    { k: "rule", label: "Rules", tk: ruleTk, items: ruleItems },
    { k: "residual", label: "System + tools + MCP (not itemizable)", tk: residual, residual: true },
  ];
  return {
    base,
    tokenizer: inv.tokenizer,
    scannedAt: inv.scannedAt,
    categories,
    skillBudget: skillListingBudget(inv, contextWindowForModel(model, peakCtx)),
    plugins: inv.plugins,
  };
}

export function codexNodeEvidence(main: SessionLine[]) {
  const reviews: Array<{ at: string; outcome: string; risk: string; authorization: string; rationale: string; request: string }> = [];
  let request = "";
  for (const line of main) {
    if (line.kind === "prompt") request = line.detailText ?? line.text ?? "";
    if (line.kind !== "assistant" || !line.detailText) continue;
    try {
      const decision = JSON.parse(line.detailText);
      if (typeof decision?.outcome !== "string" || typeof decision?.rationale !== "string") continue;
      reviews.push({ at: line.ts, outcome: decision.outcome, risk: String(decision.risk_level ?? "unknown"),
        authorization: String(decision.user_authorization ?? "unknown"), rationale: decision.rationale, request });
    } catch { /* Ordinary assistant prose is not a structured review decision. */ }
  }
  const codexResults = new Map(main.filter(l => l.toolResultFor).map(l => [l.toolResultFor!, l]));
  const callDetails = main.flatMap(ln => ln.toolUses.map(tu => {
    const result = codexResults.get(tu.id);
    const input = typeof tu.input === "string" ? tu.input : JSON.stringify(tu.input ?? {});
    return { id: tu.id, name: tu.name, at: ln.ts, input: input.slice(0, 12000),
      inputTruncated: input.length > 12000, output: result?.detailText ?? result?.text,
      resultBytes: result?.resultBytes, status: result ? "result recorded" : "no result retained",
      durationMs: result ? Math.max(0, Date.parse(result.ts) - Date.parse(ln.ts)) : undefined,
      nestedRequests: ln.nestedToolRequests ?? [] };
  }));
  const recorded = new Map<string, { kind: string; name: string; tokens: number; path?: string }>();
  const nested = new Map<string, number>();
  for (const ln of main) {
    for (const resource of ln.codexResources ?? []) {
      const key = resource.kind + "|" + resource.name;
      const previous = recorded.get(key);
      if (!previous || previous.tokens < resource.tokens) recorded.set(key, resource);
    }
    for (const name of ln.nestedToolRequests ?? []) nested.set(name, (nested.get(name) ?? 0) + 1);
  }
  return { reviews: reviews.slice(-200), recordedContext: [...recorded.values()], callDetails: callDetails.slice(-200), nestedToolRequests: [...nested].map(([name, count]) => ({ name, count })) };
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
    // detectRules() stamps "rule:<name>" reminders on prompt lines; the name is
    // the path relative to the rules dir, matching discoverRules() exactly.
    for (const r of ln.reminders) {
      if (r.startsWith("rule:")) invokedNames.add("rule|" + r.slice(5));
    }
    if (ln.kind === "tool_result") {
      // Loader-marker skills (SKILL:/COMPANION:) count as fired too. Names are
      // normalized (loader namespace stripped), so they key on the base name.
      for (const n of ln.skillLoads ?? []) {
        invokedNames.add("skill|" + n);
        const ns = n.includes(":") ? n.split(":")[0] : "";
        if (ns) invokedNames.add("plugin|" + ns);
      }
    }
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
  const evidence = codexNodeEvidence(main);
  const rootPre = agg.provider === "codex" ? evidence.recordedContext.map(resource => ({
    k: resource.kind as ObsKind, n: resource.name, tk: resource.tokens, used: false, observable: false, est: true,
  })) : buildPre(main);

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
    selfTok: agg.provider === "codex" ? agg.usage.input + agg.usage.output + agg.usage.cacheRead + agg.usage.cacheWrite : rootSelf.selfTok,
    usage: agg.usage,
    cost: rootSelf.cost,
    ctx: rootSelf.ctx,
    turns: rootSelf.turns,
    tools: rootSelf.tools,
    pre: rootPre,
    dyn: obsDyn(main, resultFor),
    ...(agg.provider === "codex" ? {} : { ctxBreakdown: obsBreakdown(main) }),
    toolTokens: obsToolTokens(main, resultFor),
  };
  const nodes: ObsNode[] = [root];
  if (agg.provider === "codex") {
    const visited = new Set([agg.sessionId]);
    const addChildren = (parent: string, depth: number) => {
      if (depth > 4 || nodes.length >= 50) return;
      for (const child of sessions.values()) {
        if (child.provider !== "codex" || child.parentSessionId !== parent || visited.has(child.sessionId)) continue;
        visited.add(child.sessionId);
        const childLines = sessionLines.get(child.sessionId) ?? [];
        const metrics = obsSelf(childLines);
        const model = Object.keys(child.models)[0];
        nodes.push({ id: child.sessionId, type: "agent", name: child.agentName ?? child.sessionId,
          label: child.project, parentId: parent, model, start: child.firstTs,
          dur: Math.max(0, Date.parse(child.lastTs) - Date.parse(child.firstTs)),
          selfTok: child.usage.input + child.usage.output + child.usage.cacheRead + child.usage.cacheWrite,
          evidence: codexNodeEvidence(childLines),
          usage: child.usage, contextWindow: [...childLines].reverse().find(l => l.contextWindow)?.contextWindow,
          cost: 0, ctx: metrics.ctx, turns: metrics.turns, tools: child.tools, pre: [],
          dyn: obsDyn(childLines, new Map()) });
        addChildren(child.sessionId, depth + 1);
      }
    };
    addChildren(agg.sessionId, 1);
  }

  // Tier 2: reconstruct the base floor from local disk (skills/agents/memory)
  // for the ROOT only — agent nodes keep pre[] evidence. getStartupInventory is
  // its own 60s-cached scan, so this stays cheap under the observeCache path.
  // `lines`, not `main`: a conditional rule is live if ANY participant touched a
  // matching file, and sub-agent lines (inline + dedicated agent-*.jsonl) are all
  // in `lines`.
  if (agg.provider !== "codex") root.baseBreakdown = buildBaseBreakdown(
    root.ctxBreakdown?.base ?? 0,
    getStartupInventory(agg.cwd),
    invokedNames,
    agg.cwd,
    collectTouchedFiles(lines, agg.cwd),
    rootModel,
    root.ctx,
  );

  // Invoker attribution for agent dispatches: the trigger active on main at the
  // dispatch ts (a slash command name, else "prompt"). Mirrors obsDyn's per-chain
  // rule; ISO timestamps compare lexicographically and main is in order.
  const mainTriggers: { at: string; name: string }[] = [];
  for (const ln of main) {
    if (ln.kind === "prompt") mainTriggers.push({ at: ln.ts, name: ln.command ?? "prompt" });
  }
  const triggerAt = (ts: string): string => {
    let cur = "prompt";
    for (const t of mainTriggers) {
      if (t.at <= ts) cur = t.name;
      else break;
    }
    return cur;
  };

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
      dyn: obsDyn(chain.lines, resultFor),
      ctxBreakdown: obsBreakdown(chain.lines),
      toolTokens: obsToolTokens(chain.lines, resultFor),
    });
    root.dyn.push({ k: "agent", n: name, tk: self.selfTok, at, by: triggerAt(at) });
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
    cap: agg.provider === "codex" ? [...main].reverse().find(l => l.contextWindow)?.contextWindow ?? null : OBS_CAP,
    generatedAt: new Date().toISOString(),
    session: {
      sessionId: agg.sessionId,
      provider: agg.provider ?? "claude",
      usage: agg.usage,
      project: agg.project,
      ...(agg.cwd ? { cwd: agg.cwd } : {}),
      firstTs: agg.firstTs,
      lastTs: agg.lastTs,
      prompts: agg.prompts,
    },
    ...(agg.provider === "codex" ? { ...evidence,
      coverage: { retainedLines: lines.length, totalEvents: agg.events, bounded: agg.events > lines.length } } : {}),
    nodes: agg.provider === "codex" ? nodes.map(n => ({ ...n, cost: null })) : nodes,
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

