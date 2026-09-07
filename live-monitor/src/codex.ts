import { codexResources, nestedToolRequests } from "./codex-evidence.ts";
// Adapt Codex rollouts to the collector's internal transcript shape. One adapter
// per file: metadata and cumulative counters must survive incremental reads.
// Source: openai/codex codex-rs/protocol/src/protocol.rs (RolloutItem).
export class CodexAdapter {
  private sessionId: string;
  private cwd = "";
  private parentSessionId?: string;
  private agentName?: string;
  private model = "codex-unknown";
  private totals: number[] = [0, 0, 0, 0, 0];
  private window?: number;

  constructor(fallbackId: string) { this.sessionId = `codex:${fallbackId}`; }

  convert(raw: string): string | null {
    let o: any;
    try { o = JSON.parse(raw); } catch { return null; }
    const p = o?.payload;
    if (!p || typeof p !== "object") return null;
    if (o.type === "session_meta") {
      if (typeof p.id === "string") this.sessionId = `codex:${p.id}`;
      if (typeof p.cwd === "string") this.cwd = p.cwd;
      const spawn = p.source?.subagent?.thread_spawn ?? p.source?.subagent?.spawn;
      // Guardian/auto-review rollouts put the relationship on SessionMeta
      // itself; ordinary spawned agents nest it under source.subagent.
      const parentId = p.parent_thread_id ?? spawn?.parent_thread_id;
      if (typeof parentId === "string" && parentId !== p.id) this.parentSessionId = `codex:${parentId}`;
      this.agentName = spawn?.agent_path ?? spawn?.agent_nickname ?? spawn?.agent_role
        ?? (typeof p.source?.subagent?.other === "string" ? p.source.subagent.other : undefined);
      const base = typeof p.base_instructions === "string" ? p.base_instructions : p.base_instructions?.text;
      return typeof base === "string" ? JSON.stringify({ type: "system", timestamp: o.timestamp,
        sessionId: this.sessionId, cwd: this.cwd, provider: "codex", parentSessionId: this.parentSessionId, agentName: this.agentName, hasOutput: true,
        codexResources: codexResources(base, "Base instructions") }) : null;
    }
    if (o.type === "turn_context") {
      if (typeof p.cwd === "string") this.cwd = p.cwd;
      if (typeof p.model === "string") this.model = p.model;
      return null;
    }
    const record = (type: string, message: any, extra: object = {}) => JSON.stringify({
      type, timestamp: o.timestamp, sessionId: this.sessionId,
      cwd: this.cwd, provider: "codex", parentSessionId: this.parentSessionId, agentName: this.agentName, message, ...extra,
    });
    if (o.type === "event_msg" && p.type === "token_count") {
      const info = p.info;
      if (Number.isFinite(info?.model_context_window) && info.model_context_window > 0)
        this.window = info.model_context_window;
      // Rate-limit-only updates repeat last_token_usage. Use cumulative deltas,
      // never sum last_token_usage (nor token_usage_record, a duplicate stream).
      const total = info?.total_token_usage;
      if (!total || !Number.isFinite(total.input_tokens) || !Number.isFinite(total.output_tokens)) return null;
      const values = counters(total);
      const reset = values[0] < this.totals[0] || values[3] < this.totals[3];
      const delta = values.map((v, i) => Math.max(0, v - this.totals[i]));
      // A counter reset establishes a new baseline, without replaying old usage.
      this.totals = values;
      if (reset || !delta.some(Boolean)) return null;
      const [input, cached, write, output, reasoning] = delta;
      const cacheRead = Math.min(input, cached);
      const cacheWrite = Math.min(input - cacheRead, write);
      const last = info.last_token_usage;
      return record("assistant", { model: this.model, content: [], usage: {
        input_tokens: input - cacheRead - cacheWrite,
        cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite,
        output_tokens: output, reasoning_output_tokens: Math.min(output, reasoning),
      } }, {
        ...(Number.isFinite(last?.input_tokens) ? { contextTokens: Math.max(0, last.input_tokens) } : {}),
        ...(this.window ? { contextWindow: this.window } : {}),
      });
    }
    if (o.type !== "response_item") return null;
    if (p.type === "message" && Array.isArray(p.content)) {
      const text = p.content.filter((b: any) => typeof b?.text === "string").map((b: any) => b.text).join("\n");
      if (p.role === "developer" || p.role === "system") return record("system", {}, {
        hasOutput: true, codexResources: p.content.flatMap((b: any) => typeof b?.text === "string" ?
          codexResources(b.text, b.text.match(/^<([\w-]+)/)?.[1] ?? "Developer instructions") : []),
      });
      if (p.role === "assistant") return record("assistant", { model: this.model, content: [{ type: "text", text }] }, { detailText: text.slice(0, 6000) });
      if (p.role !== "user" || !text.trim()) return null;
      // Startup context is serialized as user messages, but is not a human prompt.
      const injected = p.content.every((b: any) => typeof b?.text === "string" &&
        /^(?:# AGENTS\.md instructions|<environment_context>|<permissions instructions>|<recommended_plugins>|<INSTRUCTIONS>)/.test(b.text.trim()));
      return record("user", { content: text }, injected ? { isMeta: true, codexResources: p.content.flatMap((b: any) => codexResources(b.text, b.text.match(/^<([\w-]+)/)?.[1] ?? "Injected instructions")) } : { detailText: text.slice(0, 6000) });
    }
    if ((p.type === "function_call" || p.type === "custom_tool_call") && typeof p.name === "string") {
      let input: any = p.input ?? p.arguments ?? "";
      if (typeof input === "string") { try { input = JSON.parse(input); } catch { input = { input }; } }
      const name = p.namespace ? `${p.namespace}.${p.name}` : p.name;
      return record("assistant", { model: this.model, content: [{ type: "tool_use", id: p.call_id, name, input }] }, { nestedToolRequests: nestedToolRequests(p.input ?? p.arguments) });
    }
    if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const content = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "");
      return record("user", { content: [{ type: "tool_result", tool_use_id: p.call_id, content }] });
    }
    return null;
  }
}

function counters(u: any): number[] {
  return [u.input_tokens, u.cached_input_tokens, u.cache_write_input_tokens, u.output_tokens, u.reasoning_output_tokens]
    .map(v => typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0);
}
