import { expect, test } from "bun:test";
import { CodexAdapter } from "./codex.ts";
import { parseLine } from "./parse.ts";
import { codexNodeEvidence } from "./observe.ts";
import { codexOutputText } from "./codex-evidence.ts";
import type { SessionLine } from "./types.ts";

test("skill reads survive nested exec results and preview limits without treating advertisements as use", () => {
  const adapter = new CodexAdapter("skill-evidence");
  const lines: SessionLine[] = [];
  const add = (type: string, payload: unknown) => {
    const normalized = adapter.convert(JSON.stringify({ type, payload, timestamp: "2026-10-16T12:00:00Z" }));
    const parsed = normalized && parseLine(normalized, "test");
    if (parsed) lines.push(parsed.line);
  };
  add("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text:
    "- review: Review source (file: /skills/review/SKILL.md)\n- plugin:testing: Test in browser (file: /skills/testing/SKILL.md)\n- unused: Unused (file: /skills/unused/SKILL.md)\n- failed: Failed read (file: /skills/failed/SKILL.md)" }] });
  add("response_item", { type: "custom_tool_call", name: "exec", call_id: "read", input: 'text(await tools.exec_command({cmd:"cat /skills/review/SKILL.md /skills/testing/SKILL.md"}));' });
  const docs = "---\nname: review\n---\nReview instructions\n---\nname: testing\n---\nTest instructions";
  add("response_item", { type: "custom_tool_call_output", call_id: "read", output: [
    { type: "input_text", text: "x".repeat(7000) },
    { type: "input_text", text: JSON.stringify({ exit_code: 0, output: docs }) },
  ] });
  add("response_item", { type: "function_call", name: "exec_command", call_id: "failed", arguments: JSON.stringify({ cmd: "cat /skills/failed/SKILL.md" }) });
  add("response_item", { type: "function_call_output", call_id: "failed", output: "No such file or directory" });
  // A path mentioned in source is not sufficient, even with a successful result.
  add("response_item", { type: "function_call", name: "exec_command", call_id: "reference", arguments: JSON.stringify({ cmd: "echo /skills/unused/SKILL.md" }) });
  add("response_item", { type: "function_call_output", call_id: "reference", output: "/skills/unused/SKILL.md" });
  expect(lines.find(l => l.toolResultFor === "read")?.detailText).not.toContain("Review instructions");
  const evidence = codexNodeEvidence(lines);
  expect(evidence.skillActivity.map(a => [a.name, a.status])).toEqual([
    ["review", "read"], ["plugin:testing", "read"], ["unused", "referenced"], ["failed", "referenced"],
  ]);
  expect(evidence.skillActivity[0].readCallIds).toEqual(["read"]);
  // A child with only the same catalog does not inherit the parent's reads.
  expect(codexNodeEvidence(lines.slice(0, 1)).skillActivity.every(a => a.status === "advertised")).toBe(true);
  for (let i = 0; i < 201; i++) add("response_item", { type: "function_call", name: "noop", call_id: String(i), arguments: "{}" });
  expect(codexNodeEvidence(lines).callDetails.some(c => c.id === "read")).toBe(false);
  expect(codexNodeEvidence(lines).skillActivity[0].status).toBe("read");
});

test("nested JSON strings and Promise result wrappers decode to text without executing it", () => {
  const data = [{ type: "input_text", text: JSON.stringify({ status: "fulfilled", value: { output: "---\nname: example\n---\nInstructions" } }) }];
  expect(codexOutputText(JSON.stringify(data))).toBe("---\nname: example\n---\nInstructions");
  expect(codexOutputText(42)).toBe("42");
  expect(codexOutputText({ unknown: true })).toBe('{"unknown":true}');
});
