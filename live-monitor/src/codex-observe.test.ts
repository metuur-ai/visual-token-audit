import { test, expect } from "bun:test";
import { CodexAdapter } from "./codex.ts";
import { parseLine } from "./parse.ts";
import { emit, sessions, sessionLines, observeCache } from "./state.ts";
import { buildObserveSnapshot } from "./observe.ts";
import { buildSessionDetail } from "./session-detail.ts";

test("Codex Observe exposes recorded resources, call evidence, timeline and linked child usage", () => {
  const parent = new CodexAdapter("observe-parent");
  const child = new CodexAdapter("observe-child");
  const ingest = (a: CodexAdapter, type: string, payload: any) => {
    const raw = a.convert(JSON.stringify({ timestamp: "2026-09-06T12:00:00.000Z", type, payload }));
    const parsed = raw ? parseLine(raw, "test") : null;
    if (parsed) emit(parsed.ev, false, parsed.line);
  };
  try {
    ingest(parent, "session_meta", { id: "observe-parent", cwd: "/tmp/example", base_instructions: { text: "Base instructions" } });
    ingest(parent, "turn_context", { model: "gpt-test" });
    ingest(parent, "response_item", { type: "message", role: "developer", content: [{ type: "input_text",
      text: "<skills_instructions>\n- sample:review: Review source (file: /tmp/skills/review/SKILL.md)\n</skills_instructions>" }] });
    ingest(parent, "response_item", { type: "custom_tool_call", call_id: "call", name: "exec",
      input: 'text(await tools.exec_command({cmd:"cat /tmp/skills/review/SKILL.md"}));' });
    ingest(parent, "response_item", { type: "custom_tool_call_output", call_id: "call", output: "Review instructions in full" });
    const count = (input: number, output: number) => ({ type: "token_count", info: {
      total_token_usage: { input_tokens: input, output_tokens: output }, last_token_usage: { input_tokens: input }, model_context_window: 258400 } });
    ingest(parent, "event_msg", count(100, 10));
    ingest(child, "session_meta", { id: "observe-child", cwd: "/tmp/example", source: {
      subagent: { thread_spawn: { parent_thread_id: "observe-parent", agent_path: "/root/reviewer" } } } });
    ingest(child, "turn_context", { model: "gpt-test" });
    ingest(child, "response_item", { type: "function_call", call_id: "child-call", name: "read_file", arguments: '{"path":"child-only.txt"}' });
    ingest(child, "response_item", { type: "function_call_output", call_id: "child-call", output: "child result" });
    ingest(child, "event_msg", count(20, 10));
    const data = JSON.parse(buildObserveSnapshot("codex:observe-parent")!);
    expect(data.recordedContext).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "skill", name: "sample:review", path: "/tmp/skills/review/SKILL.md" })]));
    expect(data.callDetails[0]).toMatchObject({ name: "exec", status: "result recorded", output: "Review instructions in full\n", nestedRequests: ["exec_command"] });
    expect(data.nodes[0].dyn).toEqual(expect.arrayContaining([expect.objectContaining({ k: "tool", n: "exec" })]));
    expect(data.nodes[0].selfTok).toBe(110);
    expect(data.nodes[1]).toMatchObject({ type: "agent", name: "/root/reviewer", parentId: "codex:observe-parent", selfTok: 30 });
    expect(data.nodes[1].evidence.callDetails).toHaveLength(1);
    expect(data.nodes[1].evidence.callDetails[0]).toMatchObject({ name: "read_file", output: "child result\n" });
    const detail = JSON.parse(buildSessionDetail("codex:observe-parent")!);
    expect(detail.tree).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: "agent", name: "/root/reviewer", usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      children: expect.arrayContaining([expect.objectContaining({ kind: "tool", name: "read_file" })]),
    })]));
    expect(data.callDetails).toHaveLength(1);
    expect(data.callDetails[0].name).toBe("exec");
    ingest(child, "event_msg", count(40, 20));
    expect(JSON.parse(buildObserveSnapshot("codex:observe-parent")!).nodes[1].selfTok).toBe(60);
  } finally {
    for (const id of ["codex:observe-parent", "codex:observe-child"]) { sessions.delete(id); sessionLines.delete(id); observeCache.delete(id); }
  }
});

test("guardian review with top-level parent_thread_id stays under its owning session", () => {
  const ids = ["codex:guardian-parent", "codex:guardian-child"];
  const ingest = (a: CodexAdapter, type: string, payload: any) => {
    const raw = a.convert(JSON.stringify({ timestamp: "2026-09-06T12:00:00.000Z", type, payload }));
    const parsed = raw ? parseLine(raw, "test") : null;
    if (parsed) emit(parsed.ev, false, parsed.line);
  };
  try {
    const parent = new CodexAdapter("guardian-parent");
    const guardian = new CodexAdapter("guardian-child");
    ingest(parent, "session_meta", { id: "guardian-parent", base_instructions: { text: "Parent" } });
    ingest(guardian, "session_meta", { id: "guardian-child", session_id: "guardian-parent", parent_thread_id: "guardian-parent",
      source: { subagent: { other: "guardian" } }, thread_source: "guardian_review", base_instructions: { text: "Review" } });
    ingest(guardian, "turn_context", { model: "codex-auto-review" });
    ingest(guardian, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Review a local test run" }] });
    ingest(guardian, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({
      outcome: "allow", risk_level: "low", user_authorization: "high", rationale: "Local test requested by the user." }) }] });
    ingest(guardian, "event_msg", { type: "token_count", info: {
      total_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10 }, last_token_usage: { input_tokens: 100 } } });
    expect(sessions.get(ids[1])?.parentSessionId).toBe(ids[0]);
    const data = JSON.parse(buildObserveSnapshot(ids[0])!);
    expect(data.nodes).toHaveLength(2);
    expect(data.nodes[1]).toMatchObject({ id: ids[1], parentId: ids[0], name: "guardian", model: "codex-auto-review", selfTok: 110 });
    expect(data.nodes[0].selfTok).toBe(0);
    expect(data.nodes[1].evidence.callDetails).toEqual([]);
    expect(data.nodes[1].evidence.reviews).toEqual([expect.objectContaining({ outcome: "allow", risk: "low",
      authorization: "high", rationale: "Local test requested by the user.", request: "Review a local test run" })]);
    expect(data.reviews).toEqual([]);
    const detail = JSON.parse(buildSessionDetail(ids[0])!);
    expect(detail.tree).toEqual([expect.objectContaining({ kind: "agent", name: "guardian", usage: sessions.get(ids[1])!.usage })]);
    expect(detail.dispatches).toEqual([expect.objectContaining({ agent: "guardian", toolCount: 0 })]);
  } finally {
    for (const id of ids) { sessions.delete(id); sessionLines.delete(id); observeCache.delete(id); }
  }
});

test("nested Codex agents remain under their immediate parent, including beyond four levels", () => {
  const ids = Array.from({ length: 7 }, (_, i) => `codex:nested-${i}`);
  try {
    for (let i = 0; i < ids.length; i++) {
      const adapter = new CodexAdapter(`nested-${i}`);
      const raw = adapter.convert(JSON.stringify({ timestamp: "2026-10-25T12:00:00Z", type: "session_meta",
        payload: { id: `nested-${i}`, ...(i ? { parent_thread_id: `nested-${i - 1}` } : {}) } }));
      const parsed = parseLine(raw!, "test")!;
      emit(parsed.ev, false, parsed.line);
    }
    const detail = JSON.parse(buildSessionDetail(ids[0])!);
    let tree = detail.tree;
    for (const id of ids.slice(1)) {
      expect(tree).toHaveLength(1);
      expect(tree[0]).toMatchObject({ kind: "agent", name: id });
      tree = tree[0].children;
    }
    expect(detail.dispatches).toHaveLength(6);
    const observe = JSON.parse(buildObserveSnapshot(ids[0])!);
    expect(observe.nodes.map((node: any) => node.id)).toEqual(ids);
    expect(observe.nodes.at(-1).parentId).toBe(ids.at(-2));
  } finally {
    for (const id of ids) { sessions.delete(id); sessionLines.delete(id); observeCache.delete(id); }
  }
});
