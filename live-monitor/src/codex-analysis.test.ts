import { expect, test } from "bun:test";
import { codexApiEstimate, codexContext } from "./codex-analysis.ts";
import { codexResources } from "./codex-evidence.ts";
import { CodexAdapter } from "./codex.ts";
import { parseLine } from "./parse.ts";
import { emit, sessions, sessionLines, observeCache, detailCache } from "./state.ts";
import { buildObserveSnapshot, codexNodeEvidence } from "./observe.ts";
import { buildSessionDetail } from "./session-detail.ts";

test("API estimates use exact per-model cached rates and do not charge reasoning twice", () => {
  const usage = { a: { input: 100, cacheRead: 900, output: 100, cacheWrite: 0, reasoning: 60 },
    b: { input: 200, cacheRead: 0, output: 100, cacheWrite: 0 } };
  const rates = JSON.stringify({ a: { input: 2, cachedInput: 0.5, output: 10 }, b: { input: 4, cachedInput: 1, output: 20 } });
  expect(codexApiEstimate(usage, rates).totalUSD).toBeCloseTo(0.00445, 10);
  expect(codexApiEstimate(usage, "{}").totalUSD).toBeNull();
  const partial = codexApiEstimate(usage, JSON.stringify({ a: { input: 2, cachedInput: 0.5, output: 10 } }));
  expect(partial.totalUSD).toBeNull();
  expect(partial.knownUSD).toBeCloseTo(0.00165, 10);
  for (const raw of ["bad json", "null", '{"a":{"input":-2,"cachedInput":0.5,"output":10}}', '{"a":{"input":"2","cachedInput":0.5,"output":10}}'])
    expect(codexApiEstimate(usage, raw).totalUSD).toBeNull();
});

test("recorded advertisements resolve declared roots and remain distinct from invocation", () => {
  const resources = codexResources('### Skill roots\n- `r0` = `/tmp/skills`\n- sample:review: Review source (file: r0/review/SKILL.md)', "Skills");
  expect(resources[0]).toMatchObject({ kind: "skill", name: "sample:review", path: "/tmp/skills/review/SKILL.md", evidence: "advertised" });
  expect(resources[0].tokens).toBeGreaterThan(0);
});

test("session evidence keeps peak and latest models, multiple result chunks and separate cost semantics", () => {
  const id = "codex:analysis-test";
  const a = new CodexAdapter("analysis-test");
  const ingest = (type: string, payload: any) => {
    const raw = a.convert(JSON.stringify({ type, payload, timestamp: "2026-10-16T12:00:00Z" }));
    const result = raw && parseLine(raw, "test");
    if (result) emit(result.ev, false, result.line);
  };
  const count = (input: number, last: number, window?: number) => ({ type: "token_count", info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: input / 2, output_tokens: input / 10 },
    last_token_usage: { input_tokens: last }, model_context_window: window } });
  try {
    ingest("session_meta", { id: "analysis-test", source: "cli" });
    expect(sessions.has(id)).toBe(true);
    ingest("turn_context", { model: "a", effort: "high" });
    ingest("event_msg", count(1000, 1000, 8000));
    ingest("compacted", { message: "summary" });
    ingest("turn_context", { model: "b", effort: "low" });
    ingest("event_msg", count(1300, 300, 4000));
    ingest("response_item", { type: "function_call", name: "exec", call_id: "chunked", arguments: "{}" });
    for (const output of ["first chunk", "second chunk"]) ingest("response_item", { type: "function_call_output", call_id: "chunked", output });
    const lines = sessionLines.get(id)!;
    expect(codexNodeEvidence(lines).callDetails[0]).toMatchObject({ resultCount: 2, output: "first chunk\nsecond chunk\n", resultBytes: 23 });
    const request = codexContext(lines);
    expect(request.peak).toMatchObject({ model: "a", tokens: 1000, window: 8000 });
    expect(request.latest).toMatchObject({ model: "b", tokens: 300, window: 4000 });
    const observe = JSON.parse(buildObserveSnapshot(id)!);
    expect(observe.compactions).toHaveLength(1);
    expect(observe.turnContexts).toHaveLength(2);
    expect(observe.nodes[0]).toMatchObject({ model: "b", requestContext: request, cost: null, selfTok: 1430 });
    const detail = JSON.parse(buildSessionDetail(id)!);
    expect(detail.context).toMatchObject({ model: "a", tokens: 1000, window: 8000, lastTokens: 300 });
    expect(detail.cost.totalUSD).toBeNull();
    expect(detail.apiEquivalentCost.byModel.map((m: any) => m.model)).toEqual(["a", "b"]);
    // Cumulative per-model totals must survive eviction of old request lines.
    sessionLines.set(id, lines.slice(-1));
    expect(JSON.parse(buildSessionDetail(id)!).apiEquivalentCost.byModel).toHaveLength(2);
  } finally {
    sessions.delete(id); sessionLines.delete(id); observeCache.delete(id); detailCache.delete(id);
  }
});
