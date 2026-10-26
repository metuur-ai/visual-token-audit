import { expect, test } from "bun:test";
import { CodexAdapter } from "./codex.ts";
import { parseLine } from "./parse.ts";

const ts = "2026-09-06T12:00:00.000Z";
const row = (type: string, payload: any) => JSON.stringify({ timestamp: ts, type, payload });
const usage = (input: number, cached: number, output: number, reasoning = 0) => ({
  input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning,
});
const count = (total: any, last = total) => row("event_msg", { type: "token_count", info: {
  total_token_usage: total, last_token_usage: last, model_context_window: 258400,
} });
function setup() {
  const a = new CodexAdapter("fallback");
  a.convert(row("session_meta", { id: "session", cwd: "/tmp/example" }));
  a.convert(row("turn_context", { model: "gpt-test" }));
  return a;
}
function parse(a: CodexAdapter, raw: string) {
  const normalized = a.convert(raw);
  return normalized ? parseLine(normalized, "fallback") : null;
}

test("Codex cumulative deltas separate cached input and reasoning subsets", () => {
  const a = setup();
  const first = parse(a, count(usage(1000, 700, 100, 60)))!;
  expect(first.ev).toMatchObject({ sessionId: "codex:session", provider: "codex", project: "example", model: "gpt-test",
    usage: { input: 300, cacheRead: 700, cacheWrite: 0, output: 100, reasoning: 60 }, contextTokens: 1000, contextWindow: 258400 });
  expect(parse(a, count(usage(1000, 700, 100, 60)))).toBeNull();
  const second = parse(a, count(usage(2500, 1700, 300, 140), usage(1500, 1000, 200, 80)))!;
  expect(second.ev.usage).toEqual({ input: 500, cacheRead: 1000, cacheWrite: 0, output: 200, reasoning: 80 });
  expect(second.line.contextTokens).toBe(1500);
});

test("malformed, rate-limit-only and duplicate usage streams do not contribute", () => {
  const a = setup();
  for (const raw of ["{", "null", row("event_msg", { type: "token_count", info: null }),
    row("token_usage_record", { usage: usage(1000, 0, 10) }),
    row("event_msg", { type: "agent_message", message: "duplicate" })]) expect(a.convert(raw)).toBeNull();
});

test("metadata survives across appends and model switches", () => {
  const a = setup();
  parse(a, count(usage(1000, 0, 100)));
  a.convert(row("turn_context", { cwd: "/tmp/other", model: "gpt-next" }));
  expect(parse(a, count(usage(2000, 0, 200)))!.ev).toMatchObject({ project: "other", model: "gpt-next", usage: { input: 1000 } });
});

test("inherited parent metadata cannot replace a child rollout identity", () => {
  const child = new CodexAdapter("fallback");
  parse(child, row("session_meta", { id: "child", cwd: "/tmp/child", parent_thread_id: "parent",
    source: { subagent: { thread_spawn: { parent_thread_id: "parent", agent_path: "/root/reviewer" } } } }));
  expect(parse(child, row("session_meta", { id: "parent", session_id: "parent", cwd: "/tmp/parent", source: "cli" }))).toBeNull();
  const own = parse(child, count(usage(100, 40, 10)))!;
  expect(own.ev).toMatchObject({ sessionId: "codex:child", parentSessionId: "codex:parent", agentName: "/root/reviewer", cwd: "/tmp/child" });
});

test("copied response history is context rather than new child executions", () => {
  const child = new CodexAdapter("child");
  parse(child, row("session_meta", { id: "child", timestamp: ts, parent_thread_id: "parent" }));
  expect(parse(child, row("response_item", { type: "function_call", name: "old_parent_tool", call_id: "old", arguments: "{}",
    internal_chat_message_metadata_passthrough: { create_time: Date.parse(ts) / 1000 - 60 } }))).toBeNull();
  expect(parse(child, row("response_item", { type: "function_call", name: "child_tool", call_id: "new", arguments: "{}",
    internal_chat_message_metadata_passthrough: { create_time: Date.parse(ts) / 1000 + 1 } }))!.ev).toMatchObject({ sessionId: "codex:child", tools: ["child_tool"] });
});

test("counter resets establish a baseline then count new increments", () => {
  const a = setup();
  parse(a, count(usage(1000, 700, 100)));
  const reset = parse(a, count(usage(0, 0, 0)))!;
  expect(reset.ev.usage).toBeUndefined();
  expect(reset.line.codexEvent?.data.counterReset).toBe(true);
  expect(parse(a, count(usage(100, 0, 20)))!.ev.usage?.input).toBe(100);
});

test("metadata, turn settings and compactions survive without usage or base instructions", () => {
  const a = new CodexAdapter("fallback");
  const meta = parse(a, row("session_meta", { id: "child", cwd: "/tmp/work", parent_thread_id: "parent", originator: "codex_cli_rs", source: "cli" }))!;
  expect(meta.ev).toMatchObject({ kind: "system", sessionId: "codex:child", parentSessionId: "codex:parent" });
  expect(meta.line.codexEvent).toMatchObject({ type: "session_meta", data: { source: "cli", originator: "codex_cli_rs" } });
  const context = parse(a, row("turn_context", { model: "model-a", effort: "high", turn_id: "t1", approval_policy: "never" }))!;
  expect(context.line).toMatchObject({ model: "model-a", codexEvent: { type: "turn_context", data: { model: "model-a", effort: "high", turnId: "t1" } } });
  for (const [type, payload] of [["compacted", { message: "Summary" }], ["event_msg", { type: "context_compacted" }]] as const) {
    expect(parse(a, row(type, payload))!.line.codexEvent?.type).toBe("compaction");
  }
});

test("rate-only and last-only updates preserve evidence without inventing usage", () => {
  const a = setup();
  const limits = { primary: { used_percent: 40 } };
  const rateOnly = row("event_msg", { type: "token_count", info: null, rate_limits: limits });
  const parsed = parse(a, rateOnly)!;
  expect(parsed.ev.usage).toBeUndefined();
  expect(parsed.line.codexEvent?.data.rateLimits).toEqual(limits);
  expect(parse(a, rateOnly)).toBeNull();
  const lastOnly = row("event_msg", { type: "token_count", info: { last_token_usage: usage(300, 100, 20), model_context_window: 8000 } });
  expect(parse(a, lastOnly)!.ev).toMatchObject({ kind: "system", contextTokens: 300, contextWindow: 8000 });
  expect(parse(a, lastOnly)).toBeNull();
  a.convert(row("turn_context", { model: "model-b" }));
  const next = parse(a, row("event_msg", { type: "token_count", info: { total_token_usage: usage(500, 100, 30), last_token_usage: usage(200, 0, 10) } }))!;
  expect(next.ev.contextWindow).toBeUndefined();
  expect(next.ev.model).toBe("model-b");
});

test("a repeated total after a model switch does not relabel the previous request", () => {
  const a = setup();
  const previous = count(usage(1000, 700, 100));
  parse(a, previous);
  a.convert(row("turn_context", { model: "model-b" }));
  const refresh = parse(a, previous)!;
  expect(refresh.ev.usage).toBeUndefined();
  expect(refresh.line.contextTokens).toBeUndefined();
  const next = parse(a, row("event_msg", { type: "token_count", info: {
    total_token_usage: usage(1200, 700, 120), last_token_usage: usage(200, 0, 20),
  } }))!;
  expect(next.line.contextTokens).toBe(200);
  expect(next.line.contextWindow).toBeUndefined();
});

test("response messages and tools become linked monitor events without duplicate prompts", () => {
  const a = setup();
  expect(parse(a, row("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the bug" }] }))!.ev.kind).toBe("prompt");
  expect(parse(a, row("event_msg", { type: "user_message", message: "Fix the bug" }))).toBeNull();
  expect(parse(a, row("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\ncontext" }, { type: "input_text", text: "<environment_context>here</environment_context>" }] }))!.ev.kind).toBe("system");
  const call = parse(a, row("response_item", { type: "function_call", name: "exec_command", namespace: "functions", call_id: "call1", arguments: '{"cmd":"ls"}' }))!;
  expect(call.line.toolUses).toEqual([{ id: "call1", name: "functions.exec_command", input: { cmd: "ls" } }]);
  expect(parse(a, row("response_item", { type: "function_call_output", call_id: "call1", output: "ok" }))!.line).toMatchObject({ toolResultFor: "call1", resultBytes: 2 });
  expect(parse(a, row("response_item", { type: "custom_tool_call", name: "apply_patch", call_id: "call2", input: "patch text" }))!.line.toolUses[0].input).toEqual({ input: "patch text" });
});
