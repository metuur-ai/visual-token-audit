import { codexResources, nestedToolRequests, codexOutputText, codexSkillDocuments } from "./codex-evidence.ts";
// Adapt Codex rollouts to the collector's internal transcript shape. One adapter
// per file: metadata and cumulative counters must survive incremental reads.
// Source: openai/codex codex-rs/protocol/src/protocol.rs (RolloutItem).
export class CodexAdapter {
  private sessionId: string;
  private hasSessionMeta = false;
  private createdAt = NaN;
  private cwd = "";
  private parentSessionId?: string;
  private agentName?: string;
  private model = "codex-unknown";
  private totals: number[] = [0, 0, 0, 0, 0];
  private window?: number;
  private snapshot = "";
  private usageModel?: string;

  constructor(fallbackId: string) { this.sessionId = `codex:${fallbackId}`; }

  convert(raw: string): string | null {
    let o: any;
    try { o = JSON.parse(raw); } catch { return null; }
    const p = o?.payload;
    if (!p || typeof p !== "object") return null;
    const record = (type: string, message: any, extra: object = {}) => JSON.stringify({
      type, timestamp: o.timestamp, sessionId: this.sessionId,
      cwd: this.cwd, provider: "codex", parentSessionId: this.parentSessionId, agentName: this.agentName, message, ...extra,
    });
    const evidence = (type: string, data: object, extra: object = {}) => record("system", { model: this.model }, {
      hasOutput: true, codexEvent: { type, data }, ...extra,
    });
    if (o.type === "session_meta") {
      // Forked child rollouts can embed a second session_meta from copied
      // parent history. The rollout's first metadata owns its identity.
      if (this.hasSessionMeta && typeof p.id === "string" && `codex:${p.id}` !== this.sessionId) return null;
      if (!this.hasSessionMeta) this.createdAt = Date.parse(p.timestamp ?? o.timestamp) / 1000;
      this.hasSessionMeta = true;
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
      return evidence("session_meta", { originator: p.originator, source: p.source, cliVersion: p.cli_version }, {
        codexResources: typeof base === "string" ? codexResources(base, "Base instructions") : [],
      });
    }
    if (o.type === "turn_context") {
      if (typeof p.cwd === "string") this.cwd = p.cwd;
      if (typeof p.model === "string") {
        if (p.model !== this.model) this.window = undefined;
        this.model = p.model;
      }
      return evidence("turn_context", { turnId: p.turn_id, model: this.model,
        effort: p.effort ?? p.reasoning_effort, approvalPolicy: p.approval_policy, sandboxPolicy: p.sandbox_policy });
    }
    if (o.type === "compacted" || (o.type === "event_msg" && p.type === "context_compacted"))
      return evidence("compaction", { source: o.type === "compacted" ? o.type : p.type }, {
        detailText: typeof p.message === "string" ? p.message.slice(0, 6000) : undefined,
      });
    if (o.type === "event_msg" && p.type === "token_count") {
      const info = p.info;
      if (Number.isFinite(info?.model_context_window) && info.model_context_window > 0)
        this.window = info.model_context_window;
      const last = info?.last_token_usage;
      const context = {
        ...(Number.isFinite(last?.input_tokens) && last.input_tokens >= 0 ? { contextTokens: last.input_tokens } : {}),
        ...(this.window ? { contextWindow: this.window } : {}),
      };
      const snapshot = JSON.stringify([this.model, context, p.rate_limits]);
      const changed = snapshot !== this.snapshot;
      this.snapshot = snapshot;
      const tokenEvidence = { rateLimits: p.rate_limits };
      // Rate-limit-only updates repeat last_token_usage. Use cumulative deltas,
      // never sum last_token_usage (nor token_usage_record, a duplicate stream).
      const total = info?.total_token_usage;
      if (!total || !Number.isFinite(total.input_tokens) || !Number.isFinite(total.output_tokens))
        return changed && (Object.keys(context).length || p.rate_limits) ? evidence("token_count", tokenEvidence, context) : null;
      const values = counters(total);
      const reset = values[0] < this.totals[0] || values[3] < this.totals[3];
      const delta = values.map((v, i) => Math.max(0, v - this.totals[i]));
      // A counter reset establishes a new baseline, without replaying old usage.
      this.totals = values;
      if (reset) return evidence("token_count", { ...tokenEvidence, counterReset: true }, context);
      // A rate-limit refresh can repeat the previous model's last request after
      // a new turn_context. Without new usage, do not relabel it as a new-model request.
      if (!delta.some(Boolean)) {
        const staleModel = this.usageModel && this.usageModel !== this.model;
        if (staleModel) this.window = undefined;
        return changed ? evidence("token_count", tokenEvidence, staleModel ? {} : context) : null;
      }
      this.usageModel = this.model;
      const [input, cached, write, output, reasoning] = delta;
      const cacheRead = Math.min(input, cached);
      const cacheWrite = Math.min(input - cacheRead, write);
      return record("assistant", { model: this.model, content: [], usage: {
        input_tokens: input - cacheRead - cacheWrite,
        cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite,
        output_tokens: output, reasoning_output_tokens: Math.min(output, reasoning),
      } }, {
        ...context, codexEvent: { type: "token_count", data: tokenEvidence },
      });
    }
    if (o.type !== "response_item") return null;
    // Copied items are re-stamped when written to the child rollout. Their
    // original creation time identifies parent executions, which must not be
    // counted again as child prompts/tools. Keep inherited instructions.
    const itemCreatedAt = p.internal_chat_message_metadata_passthrough?.create_time;
    if (p.role !== "developer" && p.role !== "system" && Number.isFinite(itemCreatedAt) && itemCreatedAt < this.createdAt) return null;
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
      const content = codexOutputText(p.output);
      return record("user", { content: [{ type: "tool_result", tool_use_id: p.call_id, content }] }, {
        codexSkillDocuments: codexSkillDocuments(content),
      });
    }
    return null;
  }
}

function counters(u: any): number[] {
  return [u.input_tokens, u.cached_input_tokens, u.cache_write_input_tokens, u.output_tokens, u.reasoning_output_tokens]
    .map(v => typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0);
}
