import { expect, test } from "bun:test";
import { StartupInventory } from "./startup-inventory.ts";
import { buildBaseBreakdown, obsDyn } from "./observe.ts";
import { detectSkillLoads } from "./util.ts";
import { SessionLine } from "./types.ts";

const inv: StartupInventory = {
  skills: [{ name: "a", tk: 100 }, { name: "plug:b", tk: 50 }],
  agents: [{ name: "agentX", tk: 40 }],
  memory: [{ path: "/x/CLAUDE.md", tk: 200 }, { path: "/x/rules.md", tk: 60 }],
  rules: [],
  scannedAt: "2026-07-20T00:00:00.000Z",
  tokenizer: "o200k",
  skillListingConfig: { fraction: 0.01, maxDescChars: 1536, bytesPerToken: 4, envBudgetChars: null },
};
// Σ inventory = 100 + 50 + 40 + 200 + 60 = 450.

test("reconciliation: Σ(skill+agent+memory)+residual === base, residual ≥ 0", () => {
  const base = 90_000;
  const bb = buildBaseBreakdown(base, inv, new Set(), undefined);
  const total = bb.categories.reduce((s, c) => s + c.tk, 0);
  expect(total).toBe(base); // exact reconciliation
  const residual = bb.categories.find((c) => c.k === "residual")!;
  expect(residual.tk).toBe(base - 450);
  expect(residual.tk).toBeGreaterThanOrEqual(0);
  expect(residual.residual).toBe(true);
  expect(residual.items).toBeUndefined();
});

test("residual clamps to 0 when disk sum exceeds base", () => {
  const bb = buildBaseBreakdown(100, inv, new Set(), undefined); // base < 450
  const residual = bb.categories.find((c) => c.k === "residual")!;
  expect(residual.tk).toBe(0); // clamped, no negative
});

test("used flags: direct skill, plugin-namespace, and agent joins", () => {
  const invoked = new Set(["skill|a", "plugin|plug", "agent|agentX"]);
  const bb = buildBaseBreakdown(1000, inv, invoked, undefined);
  const skills = bb.categories.find((c) => c.k === "skill")!.items!;
  expect(skills.find((i) => i.n === "a")!.used).toBe(true); // direct skill| hit
  expect(skills.find((i) => i.n === "plug:b")!.used).toBe(true); // via plugin| namespace
  const agents = bb.categories.find((c) => c.k === "agent")!.items!;
  expect(agents.find((i) => i.n === "agentX")!.used).toBe(true);
  const mem = bb.categories.find((c) => c.k === "memory")!.items!;
  expect(mem[0].observable).toBe(false);
  expect(mem[0].used).toBe(false);
});

// ----- detectSkillLoads: loader-marker skill detection --------------------------
test("detectSkillLoads: strips loader namespace, handles COMPANION + multiline", () => {
  expect(detectSkillLoads("SKILL: agent-skills:uncle-dev-research")).toEqual(["uncle-dev-research"]);
  expect(detectSkillLoads("noise\nSKILL: agent-skills:a\nCOMPANION: agent-skills:b\n"))
    .toEqual(["a", "b"]);
  expect(detectSkillLoads("SKILL: plain-name")).toEqual(["plain-name"]);
  expect(detectSkillLoads("no markers here")).toEqual([]);
  // dedupe within a single result blob
  expect(detectSkillLoads("SKILL: x\nSKILL: x")).toEqual(["x"]);
});

// ----- obsDyn: invocation capture + invoker attribution -------------------------
const line = (p: Partial<SessionLine>): SessionLine => ({
  ts: p.ts ?? "2026-07-24T00:00:00.000Z",
  kind: p.kind ?? "assistant",
  sidechain: false,
  isMeta: false,
  reminders: [],
  toolUses: [],
  ...p,
});
const noResults = new Map<string, { ts: number; bytes: number }>();

test("obsDyn: command sets trigger; loader-skill + Skill-tool inherit it as invoker", () => {
  const lns: SessionLine[] = [
    line({ ts: "t1", kind: "prompt", command: "/uncle-dev-research", text: "go" }),
    line({ ts: "t2", kind: "tool_result", toolResultFor: "b1", skillLoads: ["uncle-dev-research"] }),
    line({ ts: "t3", toolUses: [{ id: "s1", name: "Skill", input: { skill: "superpowers:brainstorming" } }] }),
  ];
  const dyn = obsDyn(lns, noResults);
  const cmd = dyn.find((d) => d.k === "command")!;
  expect(cmd.n).toBe("/uncle-dev-research");
  expect(cmd.by).toBe("prompt"); // a command is invoked by the user turn
  const loader = dyn.find((d) => d.k === "skill" && d.n === "uncle-dev-research")!;
  expect(loader.by).toBe("/uncle-dev-research"); // inherits the active command
  const skillTool = dyn.find((d) => d.k === "skill" && d.n === "superpowers:brainstorming")!;
  expect(skillTool.by).toBe("/uncle-dev-research");
});

test("obsDyn: a plain prompt resets the invoker to 'prompt'", () => {
  const lns: SessionLine[] = [
    line({ ts: "t1", kind: "prompt", command: "/uncle-dev-research", text: "go" }),
    line({ ts: "t2", kind: "prompt", text: "just a question" }), // no command → reset
    line({ ts: "t3", toolUses: [{ id: "s1", name: "Skill", input: { skill: "graphify" } }] }),
  ];
  const dyn = obsDyn(lns, noResults);
  expect(dyn.find((d) => d.k === "skill" && d.n === "graphify")!.by).toBe("prompt");
});

test("obsDyn: repeated loader markers for the same skill emit one row", () => {
  const lns: SessionLine[] = [
    line({ ts: "t1", kind: "tool_result", toolResultFor: "b1", skillLoads: ["dup"] }),
    line({ ts: "t2", kind: "tool_result", toolResultFor: "b2", skillLoads: ["dup"] }),
  ];
  expect(obsDyn(lns, noResults).filter((d) => d.n === "dup")).toHaveLength(1);
});

// Rules: an "always" rule is on the base floor unconditionally, whereas a
// conditional rule (paths[] frontmatter) is only loaded when the session
// actually touched a matching file — so it must not be billed otherwise.
const ruleInv: StartupInventory = {
  ...inv,
  skills: [],
  agents: [],
  memory: [],
  rules: [
    { name: "always.md", tk: 30, paths: [] },
    { name: "ts-only.md", tk: 70, paths: ["**/*.ts"] },
    { name: "py-only.md", tk: 90, paths: ["**/*.py"] },
  ],
};

test("conditional rules bill only when a touched file matches their paths[]", () => {
  const touched = new Set(["src/observe.ts"]);
  const bb = buildBaseBreakdown(10_000, ruleInv, new Set(), undefined, touched);
  const rules = bb.categories.find((c) => c.k === "rule")!;
  const by = (n: string) => rules.items!.find((i) => i.n === n)!;

  expect(by("always.md").live).toBe(true); // unconditional
  expect(by("ts-only.md").live).toBe(true); // .ts touched
  expect(by("py-only.md").live).toBe(false); // no .py touched

  // Only live rules are charged against the floor.
  expect(rules.tk).toBe(30 + 70);
  const total = bb.categories.reduce((s, c) => s + c.tk, 0);
  expect(total).toBe(10_000); // still reconciles exactly
});

test("no touched files ⇒ conditional rules are all dark, always rules remain", () => {
  const bb = buildBaseBreakdown(10_000, ruleInv, new Set(), undefined, new Set());
  const rules = bb.categories.find((c) => c.k === "rule")!;
  expect(rules.tk).toBe(30);
  expect(rules.items!.filter((i) => i.live).length).toBe(1);
});

test("rule| evidence marks a live rule as used", () => {
  const touched = new Set(["src/observe.ts"]);
  const invoked = new Set(["rule|ts-only.md"]);
  const bb = buildBaseBreakdown(10_000, ruleInv, invoked, undefined, touched);
  const rules = bb.categories.find((c) => c.k === "rule")!.items!;
  expect(rules.find((i) => i.n === "ts-only.md")!.used).toBe(true);
  expect(rules.find((i) => i.n === "always.md")!.used).toBe(false);
});
