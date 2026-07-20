import { expect, test } from "bun:test";
import { StartupInventory } from "./startup-inventory.ts";
import { buildBaseBreakdown } from "./observe.ts";

const inv: StartupInventory = {
  skills: [{ name: "a", tk: 100 }, { name: "plug:b", tk: 50 }],
  agents: [{ name: "agentX", tk: 40 }],
  memory: [{ path: "/x/CLAUDE.md", tk: 200 }, { path: "/x/rules.md", tk: 60 }],
  scannedAt: "2026-07-20T00:00:00.000Z",
  tokenizer: "o200k",
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
