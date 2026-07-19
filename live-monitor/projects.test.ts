// Unit tests for the /api/projects grouping fold (projects.ts).
// Zero-dependency: bun test. Covers the key-derivation helper (Unit 5) and the
// endpoint-fold contract (Units 1.1/1.2) without booting the HTTP server.
import { test, expect } from "bun:test";
import {
  foldProjects,
  projectGroupKey,
  projectDisplayName,
  UNKNOWN_KEY,
  type FoldSession,
} from "./src/projects.ts";

const U = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
function sess(o: Partial<FoldSession>): FoldSession {
  return {
    sessionId: "s",
    project: "",
    firstTs: "2026-07-18T00:00:00.000Z",
    lastTs: "2026-07-18T00:00:00.000Z",
    prompts: 0,
    usage: { ...U },
    tools: {},
    skills: {},
    ...o,
  };
}

// ---------- 5.1 key / name derivation ----------

test("R-5.1 cwd present → key is cwd", () => {
  expect(projectGroupKey(sess({ cwd: "/a/b/foo", project: "foo" }))).toBe("/a/b/foo");
});

test("R-5.2 cwd empty, project set → key is project basename", () => {
  expect(projectGroupKey(sess({ cwd: "", project: "foo" }))).toBe("foo");
  expect(projectGroupKey(sess({ project: "foo" }))).toBe("foo"); // cwd undefined
});

test("R-5.7 both empty → key and name are the literal (unknown)", () => {
  const s = sess({ cwd: "", project: "" });
  expect(projectGroupKey(s)).toBe(UNKNOWN_KEY);
  expect(projectDisplayName(s)).toBe(UNKNOWN_KEY);
});

test("R-5.4 display name is project basename, else (unknown)", () => {
  expect(projectDisplayName(sess({ project: "bar" }))).toBe("bar");
  expect(projectDisplayName(sess({ project: "" }))).toBe(UNKNOWN_KEY);
});

test("R-5.3 members sharing a key land in one record", () => {
  const env = foldProjects(
    [sess({ sessionId: "a", cwd: "/x", project: "x" }), sess({ sessionId: "b", cwd: "/x", project: "x" })],
    "start",
  );
  expect(env.projects.length).toBe(1);
  expect(env.projects[0].sessionCount).toBe(2);
});

test("R-5.6 two real dirs sharing a basename collide under one record", () => {
  // both fall back to project basename "svc" (no cwd)
  const env = foldProjects(
    [sess({ sessionId: "a", project: "svc" }), sess({ sessionId: "b", project: "svc" })],
    "start",
  );
  expect(env.projects.length).toBe(1);
  expect(env.projects[0].key).toBe("svc");
});

// ---------- 1.1 fold semantics ----------

test("R-1.2 distinct keys → one record each", () => {
  const env = foldProjects(
    [sess({ sessionId: "a", cwd: "/x" }), sess({ sessionId: "b", cwd: "/y" }), sess({ sessionId: "c", cwd: "/x" })],
    "start",
  );
  expect(env.projects.length).toBe(2);
  expect(new Set(env.projects.map((p) => p.key))).toEqual(new Set(["/x", "/y"]));
});

test("R-1.10 empty sessions → empty projects array", () => {
  const env = foldProjects([], "start");
  expect(env.projects).toEqual([]);
  expect(env.startedAt).toBe("start");
});

test("R-1.4 lastActivity is max member lastTs; R-1.5 sessionCount is group size", () => {
  const env = foldProjects(
    [
      sess({ sessionId: "a", cwd: "/x", lastTs: "2026-07-18T01:00:00.000Z", firstTs: "2026-07-18T00:30:00.000Z" }),
      sess({ sessionId: "b", cwd: "/x", lastTs: "2026-07-18T03:00:00.000Z", firstTs: "2026-07-18T00:10:00.000Z" }),
    ],
    "start",
  );
  const p = env.projects[0];
  expect(p.lastActivity).toBe("2026-07-18T03:00:00.000Z");
  expect(p.firstActivity).toBe("2026-07-18T00:10:00.000Z");
  expect(p.sessionCount).toBe(2);
});

test("R-1.6 projects sorted by lastActivity desc, ties by key asc", () => {
  const env = foldProjects(
    [
      sess({ sessionId: "a", cwd: "/b", lastTs: "2026-07-18T05:00:00.000Z" }),
      sess({ sessionId: "b", cwd: "/a", lastTs: "2026-07-18T05:00:00.000Z" }), // tie with /b, key asc → /a first
      sess({ sessionId: "c", cwd: "/z", lastTs: "2026-07-18T09:00:00.000Z" }),
    ],
    "start",
  );
  expect(env.projects.map((p) => p.key)).toEqual(["/z", "/a", "/b"]);
});

test("R-1.7 sessions sorted by lastTs desc, ties by sessionId asc", () => {
  const env = foldProjects(
    [
      sess({ sessionId: "b", cwd: "/x", lastTs: "2026-07-18T02:00:00.000Z" }),
      sess({ sessionId: "a", cwd: "/x", lastTs: "2026-07-18T02:00:00.000Z" }), // tie, id asc → a first
      sess({ sessionId: "c", cwd: "/x", lastTs: "2026-07-18T09:00:00.000Z" }),
    ],
    "start",
  );
  expect(env.projects[0].sessions.map((s) => s.sessionId)).toEqual(["c", "a", "b"]);
});

test("R-1.8 each session entry carries sessionId/lastTs/prompts/usage", () => {
  const env = foldProjects(
    [sess({ sessionId: "a", cwd: "/x", prompts: 3, usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } })],
    "start",
  );
  const s = env.projects[0].sessions[0];
  expect(s.sessionId).toBe("a");
  expect(s.lastTs).toBe("2026-07-18T00:00:00.000Z");
  expect(s.prompts).toBe(3);
  expect(s.usage).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
});

// ---------- 1.2 envelope / usage / top-tools contract ----------

test("R-1.12 envelope is exactly {projects, startedAt}", () => {
  const env = foldProjects([sess({ cwd: "/x" })], "2026-07-18T00:00:00.000Z");
  expect(Object.keys(env).sort()).toEqual(["projects", "startedAt"]);
  expect(env.startedAt).toBe("2026-07-18T00:00:00.000Z");
});

test("R-1.14 usage is field-wise summed (not object-added)", () => {
  const env = foldProjects(
    [
      sess({ sessionId: "a", cwd: "/x", prompts: 2, usage: { input: 10, output: 1, cacheRead: 100, cacheWrite: 5 } }),
      sess({ sessionId: "b", cwd: "/x", prompts: 3, usage: { input: 20, output: 2, cacheRead: 200, cacheWrite: 7 } }),
    ],
    "start",
  );
  const p = env.projects[0];
  expect(p.usage.input).toBe(30);
  expect(p.usage.output).toBe(3);
  expect(p.usage.cacheRead).toBe(300);
  expect(p.usage.cacheWrite).toBe(12);
  expect(p.prompts).toBe(5);
});

test("R-1.14 topTools {name,count}[] count desc, ties name asc, capped 5", () => {
  const env = foldProjects(
    [
      sess({
        cwd: "/x",
        tools: { Read: 5, Bash: 5, Edit: 9, Write: 1, Grep: 1, Glob: 1, Task: 1 },
        skills: { Read: 1 }, // merges with tools.Read → 6
      }),
    ],
    "start",
  );
  const tt = env.projects[0].topTools;
  expect(tt.length).toBe(5);
  // Edit 9, Read 6, Bash 5, then ties count=1 by name asc: Glob, Grep
  expect(tt).toEqual([
    { name: "Edit", count: 9 },
    { name: "Read", count: 6 },
    { name: "Bash", count: 5 },
    { name: "Glob", count: 1 },
    { name: "Grep", count: 1 },
  ]);
});

test("R-1.13 timestamps are strings identical to source", () => {
  const env = foldProjects(
    [sess({ cwd: "/x", firstTs: "2026-07-18T00:10:00.000Z", lastTs: "2026-07-18T00:59:00.000Z" })],
    "start",
  );
  const p = env.projects[0];
  expect(p.firstActivity).toBe("2026-07-18T00:10:00.000Z");
  expect(p.lastActivity).toBe("2026-07-18T00:59:00.000Z");
  expect(p.sessions[0].lastTs).toBe("2026-07-18T00:59:00.000Z");
});

test("R-1.3 every project field is present (none undefined)", () => {
  const env = foldProjects([sess({ cwd: "/x", project: "x" })], "start");
  const p = env.projects[0];
  for (const f of ["key", "name", "cwd", "firstActivity", "lastActivity", "sessionCount", "prompts", "usage", "topTools", "sessions"]) {
    expect((p as any)[f]).toBeDefined();
  }
});

test("no fs import in projects.ts (R-5.5 / R-1.9)", async () => {
  const src = await Bun.file(new URL("./src/projects.ts", import.meta.url)).text();
  expect(src).not.toContain("readFile");
  expect(src).not.toContain("listJsonlFiles");
  expect(src).not.toMatch(/from ["']fs["']/);
});
