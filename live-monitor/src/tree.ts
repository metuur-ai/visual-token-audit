// ----------------------------------------------------------------------------
// Tree / sidechain / attribution helpers (shared by session-detail + observe)
// ----------------------------------------------------------------------------
// mcp__<server>__<tool> → server group name ("<server>"); undefined if not MCP.



import { statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { AGENT_MAX_NODES, LABEL_LEN } from "./config.ts";
import { costUSD } from "./cost.ts";
import { subagentMeta } from "./state.ts";
import { SessionLine, ToolUseBlock, Usage } from "./types.ts";
import { addUsage, clip, emptyUsage } from "./util.ts";

export function mcpServer(name: string): string | undefined {
  const m = name.match(/^mcp__([^_]+(?:_[^_]+)*?)__/);
  return m ? m[1] : undefined;
}

export interface CountUsage {
  count: number;
  usage: Usage;
}
export type CountMap = Record<string, CountUsage>;

export function bump(map: CountMap, key: string, by: number, usage?: Usage) {
  let e = map[key];
  if (!e) {
    e = map[key] = { count: 0, usage: emptyUsage() };
  }
  e.count += by;
  addUsage(e.usage, usage);
}

export interface AutoLoad {
  type: "memory" | "rule" | "skill" | "command" | "plugin" | "hook" | "mcp";
  name: string;
  evidence: string;
}
export interface InvokedLoad {
  type: "skill" | "command" | "agent" | "tool" | "mcp";
  name: string;
  count: number;
}

export interface TreeNode {
  kind: "prompt" | "assistant" | "tool" | "skill" | "command" | "agent";
  name: string;
  ts: string;
  label: string;
  usage?: Usage;
  durationMs?: number;
  resultBytes?: number;
  children?: TreeNode[];
}

// v2.4: estimate a rule file's context load (tokens ≈ bytes/4) by statting it
// under the session cwd (.claude/rules/) or user scope (~/.claude/rules/).
// Best-effort: 0 when the file can't be found from this machine.
export const ruleSizeCache = new Map<string, number>();
export function ruleTokenEstimate(cwd: string | undefined, name: string): Usage | undefined {
  const key = (cwd ?? "") + "|" + name;
  let tok = ruleSizeCache.get(key);
  if (tok === undefined) {
    tok = 0;
    const candidates = [
      ...(cwd ? [join(cwd, ".claude", "rules", name)] : []),
      join(homedir(), ".claude", "rules", name),
    ];
    for (const p of candidates) {
      try {
        tok = Math.round(statSync(p).size / 4);
        break;
      } catch {}
    }
    ruleSizeCache.set(key, tok);
  }
  return tok > 0 ? { input: tok, output: 0, cacheRead: 0, cacheWrite: 0 } : undefined;
}

// Classify a single reminder evidence string into an auto-load entry.
export function classifyReminder(ev: string): AutoLoad {
  // Structured prefixes emitted by our own harvesters take priority.
  const pm = ev.match(/^plugin:([\w.-]+)\s*(.*)$/);
  if (pm) return { type: "plugin", name: pm[1], evidence: ev };
  const hm = ev.match(/^hook:(\S+)\s*(.*)$/);
  if (hm) return { type: "hook", name: hm[2] ? `${hm[1]} ${hm[2]}` : hm[1], evidence: ev };
  const rm = ev.match(/^rule:(\S+)/);
  if (rm) return { type: "rule", name: rm[1], evidence: ev };
  const low = ev.toLowerCase();
  if (low.includes(".claude/rules/")) {
    const rp = ev.match(/\.claude\/rules\/([\w.-]+(?:\/[\w.-]+)*\.md)/);
    return { type: "rule", name: rp ? rp[1] : "rule", evidence: ev };
  }
  if (low.includes("claude.md") || low.includes("memory")) {
    const name = ev.includes("CLAUDE.md") ? "CLAUDE.md" : "memory";
    return { type: "memory", name, evidence: ev };
  }
  if (low.includes("hook") || low.startsWith("pretooluse") || low.startsWith("posttooluse")) {
    return { type: "hook", name: ev.split(/[:\n]/)[0].trim() || "hook", evidence: ev };
  }
  if (low.includes("skill")) return { type: "skill", name: "skill", evidence: ev };
  if (low.includes("plugin")) return { type: "plugin", name: "plugin", evidence: ev };
  if (low.includes("mcp")) return { type: "mcp", name: "mcp", evidence: ev };
  return { type: "memory", name: "context", evidence: ev };
}

export function inputSummary(name: string, input: any): string {
  if (input == null) return name;
  try {
    if (typeof input === "string") return clip(input, LABEL_LEN);
    if (typeof input === "object") {
      // Prefer the most human field per common tool shapes.
      const pick =
        input.command ?? input.description ?? input.file_path ?? input.path ??
        input.pattern ?? input.query ?? input.prompt ?? input.skill ?? input.url;
      if (typeof pick === "string") return clip(pick, LABEL_LEN);
      return clip(JSON.stringify(input), LABEL_LEN);
    }
  } catch {}
  return name;
}

// Determine the tool_use block's tree kind + display name.
export function toolNodeKind(b: ToolUseBlock): { kind: TreeNode["kind"]; name: string } {
  if (b.name === "Skill") {
    const sn = b.input?.skill ?? b.input?.command ?? b.input?.name;
    return { kind: "skill", name: typeof sn === "string" ? sn : "Skill" };
  }
  if (b.name === "Task" || b.name === "Agent") {
    const at = b.input?.subagent_type ?? b.input?.subagentType ?? b.input?.agent;
    return { kind: "agent", name: typeof at === "string" ? at : b.name };
  }
  return { kind: "tool", name: b.name };
}

// v2.3: per-sub-agent dispatch summary (its own tokens/cost/tools/duration).
export interface AgentDispatch {
  agent: string;
  ts: string;
  model?: string;
  usage?: Usage;
  costUSD?: number;
  toolCount: number;
  durationMs?: number;
  label: string;
}

export function countNodes(n: TreeNode): number {
  let c = 1;
  if (n.children) for (const ch of n.children) c += countNodes(ch);
  return c;
}

// ----- sub-agent sidechain chains (v2.2, reworked for task #11) --------------
// Two sources, one chain per Task/Agent invocation:
//   • "file": dedicated <sessionId>/subagents/agent-<id>.jsonl transcripts
//     (Claude Code ≥2.1.x). Lines carry agentId, so grouping is exact and
//     robust under interleaved live tailing of concurrent agents.
//   • "inline": legacy isSidechain:true lines inside the parent transcript
//     (uuid→parentUuid walk; a chain starts at a sidechain prompt whose
//     parentUuid is missing or points outside the sidechain set).
// DOUBLE-COUNTING RULE: if the same agent run appears both ways (transitional
// versions), prefer the dedicated file — inline chains whose prompt matches a
// file chain's prompt are dropped. (Verified on disk: 2.1.170 parents contain
// ZERO inline sidechain lines, so in practice sources are disjoint.)
export interface SidechainChain {
  rootTs: string;
  promptText: string;
  lines: SessionLine[];
  claimed: boolean;
  source: "file" | "inline"; // "file" = dedicated subagents/agent-*.jsonl
  agentId?: string; // set for source:"file"
}

export function collectSidechainChains(lines: SessionLine[]): SidechainChain[] {
  const byAgent = new Map<string, SessionLine[]>();
  const inline: SessionLine[] = [];
  for (const ln of lines) {
    if (!ln.sidechain) continue;
    if (ln.agentId) {
      let arr = byAgent.get(ln.agentId);
      if (!arr) byAgent.set(ln.agentId, (arr = []));
      arr.push(ln);
    } else {
      inline.push(ln);
    }
  }
  const chains: SidechainChain[] = [];
  for (const [agentId, lns] of byAgent) {
    // Store order follows ingestion, not time (files seed/tail independently).
    lns.sort((a, b) => a.ts.localeCompare(b.ts));
    const prompt = lns.find((l) => l.kind === "prompt");
    chains.push({
      rootTs: lns[0].ts,
      promptText: prompt?.text ?? "",
      lines: lns,
      claimed: false,
      source: "file",
      agentId,
    });
  }
  const sidechainUuids = new Set<string>();
  for (const ln of inline) if (ln.uuid) sidechainUuids.add(ln.uuid);
  let cur: SidechainChain | null = null;
  for (const ln of inline) {
    const isRoot =
      ln.kind === "prompt" && (!ln.parentUuid || !sidechainUuids.has(ln.parentUuid));
    if (isRoot || !cur) {
      cur = { rootTs: ln.ts, promptText: ln.text ?? "", lines: [], claimed: false, source: "inline" };
      chains.push(cur);
    }
    cur.lines.push(ln);
  }
  // Apply the double-counting rule (prefer "file", drop matching "inline").
  const fileGuesses = chains
    .filter((c) => c.source === "file")
    .map((c) => c.promptText.slice(0, 60))
    .filter(Boolean);
  const out = chains.filter(
    (c) => c.source !== "inline" || !fileGuesses.some((g) => c.promptText.startsWith(g)),
  );
  out.sort((a, b) => a.rootTs.localeCompare(b.rootTs));
  return out;
}

export function promptOf(input: unknown): string {
  const p = (input as { prompt?: unknown } | null)?.prompt;
  return typeof p === "string" ? p : "";
}

// Match an Agent tool_use to its sidechain chain. Precedence:
//   1. exact id link (task #11): the agent's meta.json toolUseId === tool_use id;
//   2. prompt-text match;
//   3. first unclaimed chain starting at/after the tool_use timestamp
//      (small slack for clock ordering);
//   4. first unclaimed chain.
export function claimChain(
  chains: SidechainChain[],
  prompt: string,
  ts: string,
  toolUseId?: string,
): SidechainChain | null {
  if (toolUseId) {
    const exact = chains.find(
      (c) => !c.claimed && c.agentId && subagentMeta.get(c.agentId)?.toolUseId === toolUseId,
    );
    if (exact) {
      exact.claimed = true;
      return exact;
    }
  }
  const guess = prompt.slice(0, 60);
  let best: SidechainChain | null = null;
  if (guess) {
    best = chains.find((c) => !c.claimed && c.promptText.startsWith(guess)) ?? null;
  }
  if (!best) {
    const tMs = Date.parse(ts);
    best =
      chains.find((c) => {
        if (c.claimed) return false;
        const r = Date.parse(c.rootTs);
        return !Number.isFinite(tMs) || !Number.isFinite(r) || r >= tMs - 5_000;
      }) ?? null;
  }
  if (!best) best = chains.find((c) => !c.claimed) ?? null;
  if (best) best.claimed = true;
  return best;
}

// Sum the sub-agent's own token usage across its chain.

// Most frequent model across a chain's assistant lines.
export function chainModel(chain: SidechainChain): string {
  const counts = new Map<string, number>();
  for (const ln of chain.lines) {
    if (ln.model) counts.set(ln.model, (counts.get(ln.model) ?? 0) + 1);
  }
  let best = "";
  let bestN = 0;
  for (const [m, n] of counts) if (n > bestN) { best = m; bestN = n; }
  return best;
}

export function chainToolCount(chain: SidechainChain): number {
  let n = 0;
  for (const ln of chain.lines) n += ln.toolUses.length;
  return n;
}

export function chainDurationMs(chain: SidechainChain): number | undefined {
  const first = Date.parse(chain.rootTs);
  const last = Date.parse(chain.lines[chain.lines.length - 1]?.ts ?? "");
  return Number.isFinite(first) && Number.isFinite(last) && last >= first
    ? last - first
    : undefined;
}

export function chainUsage(chain: SidechainChain): NonNullable<SessionLine["usage"]> | undefined {
  let total: NonNullable<SessionLine["usage"]> | undefined;
  for (const ln of chain.lines) {
    if (!ln.usage) continue;
    if (!total) total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    total.input += ln.usage.input;
    total.output += ln.usage.output;
    total.cacheRead += ln.usage.cacheRead;
    total.cacheWrite += ln.usage.cacheWrite;
  }
  return total;
}

// The sub-agent's own invocation tree: its task prompt first, then assistant
// steps + tool uses, chronological, bounded by AGENT_MAX_NODES.
export function chainSubtree(chain: SidechainChain): TreeNode[] {
  const out: TreeNode[] = [];
  let count = 0;
  if (chain.promptText) {
    out.push({
      kind: "prompt",
      name: "",
      ts: chain.rootTs,
      label: clip(chain.promptText, LABEL_LEN),
    });
    count++;
  }
  for (const ln of chain.lines) {
    if (count >= AGENT_MAX_NODES) {
      out.push({ kind: "assistant", name: "", ts: ln.ts, label: "…truncated" });
      break;
    }
    if (ln.kind !== "assistant") continue;
    const textLabel = clip(ln.text ?? "", LABEL_LEN);
    if (textLabel || ln.usage) {
      out.push({
        kind: "assistant",
        name: ln.model ?? "",
        ts: ln.ts,
        label: textLabel,
        ...(ln.usage ? { usage: ln.usage } : {}),
      });
      count++;
    }
    for (const tu of ln.toolUses) {
      if (count >= AGENT_MAX_NODES) break;
      const { kind, name } = toolNodeKind(tu);
      out.push({ kind, name, ts: ln.ts, label: inputSummary(tu.name, tu.input) });
      count++;
    }
  }
  return out;
}
