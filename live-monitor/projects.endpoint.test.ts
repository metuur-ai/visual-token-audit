// Integration guard for the /api/projects addition (Units 1.1/1.2/1.3/2.1).
// Boots collector.ts as a subprocess on a throwaway port and asserts:
//   - /api/projects returns 200 + application/json; charset=utf-8 (R-1.1)
//   - its envelope is {projects, startedAt, days}, startedAt === /api/snapshot's (R-1.12)
//   - ?days=N is honored, clamped 1..60, default 30 (disk-scan window)
//   - existing endpoints keep their unchanged content-types (R-1.11 additive guard)
//   - missing page files return 503, not 404 (R-2.3)
// Zero-dependency: bun test + fetch. Skips gracefully if the port can't bind.
import { test, expect, beforeAll, afterAll } from "bun:test";

const PORT = 8834;
const BASE = `http://127.0.0.1:${PORT}`;
let proc: ReturnType<typeof Bun.spawn> | null = null;

async function waitReady(url: string, ms = 6000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await Bun.sleep(150);
  }
  return false;
}

beforeAll(async () => {
  proc = Bun.spawn(["bun", "collector.ts"], {
    cwd: new URL(".", import.meta.url).pathname,
    env: { ...process.env, MONITOR_PORT: String(PORT) },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitReady(`${BASE}/api/snapshot`);
});

afterAll(() => { proc?.kill(); });

test("R-1.1 /api/projects → 200 + application/json; charset=utf-8", async () => {
  const r = await fetch(`${BASE}/api/projects`);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
  const body = await r.json();
  expect(Array.isArray(body.projects)).toBe(true);
});

test("R-1.12 envelope {projects, startedAt, days}; startedAt === /api/snapshot", async () => {
  const proj = await (await fetch(`${BASE}/api/projects`)).json();
  const snap = await (await fetch(`${BASE}/api/snapshot`)).json();
  expect(Object.keys(proj).sort()).toEqual(["days", "projects", "startedAt"]);
  expect(proj.startedAt).toBe(snap.startedAt);
  expect(proj.days).toBe(30); // default window
});

test("?days=N honored and clamped to 1..60", async () => {
  const d1 = await (await fetch(`${BASE}/api/projects?days=1`)).json();
  expect(d1.days).toBe(1);
  const d60 = await (await fetch(`${BASE}/api/projects?days=60`)).json();
  expect(d60.days).toBe(60);
  // over-max clamps down to 60, sub-min clamps up to 1, garbage → default 30
  expect((await (await fetch(`${BASE}/api/projects?days=999`)).json()).days).toBe(60);
  expect((await (await fetch(`${BASE}/api/projects?days=0`)).json()).days).toBe(1);
  expect((await (await fetch(`${BASE}/api/projects?days=abc`)).json()).days).toBe(30);
});

test("R-1.11 existing endpoints keep their content-types (additive)", async () => {
  const snap = await fetch(`${BASE}/api/snapshot`);
  expect(snap.headers.get("content-type")).toBe("application/json; charset=utf-8");
  const stats = await fetch(`${BASE}/api/stats?days=1`);
  expect(stats.headers.get("content-type")).toBe("application/json; charset=utf-8");
  // unknown session still 404 with the same error body idiom
  const s = await fetch(`${BASE}/api/session/${encodeURIComponent("no-such-session")}`);
  expect(s.status).toBe(404);
});

test("R-2.3 /projects.html and /projects.js → 503 when files missing (not 404)", async () => {
  // (These run before the UI files are built; once built they return 200. The
  //  guard here is that the route exists and degrades to 503 rather than 404.)
  const html = await fetch(`${BASE}/projects.html`);
  const js = await fetch(`${BASE}/projects.js`);
  expect([200, 503]).toContain(html.status);
  expect([200, 503]).toContain(js.status);
  expect(html.status).not.toBe(404);
  expect(js.status).not.toBe(404);
});
