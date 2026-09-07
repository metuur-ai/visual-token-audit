import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, renameSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

test("mixed providers: startup, historical totals, detail, SSE appends and archive moves", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-monitor-test-"));
  const codexHome = join(dir, "codex");
  const claude = join(dir, "claude");
  const rollouts = join(codexHome, "sessions", "2026", "09", "06");
  const archive = join(codexHome, "archived_sessions");
  mkdirSync(rollouts, { recursive: true });
  mkdirSync(archive, { recursive: true });
  mkdirSync(join(claude, "project"), { recursive: true });
  const now = new Date().toISOString();
  const row = (type: string, payload: any, timestamp = now) => JSON.stringify({ type, timestamp, payload }) + "\n";
  const counts = (input: number, cached: number, output: number) => row("event_msg", { type: "token_count", info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
    last_token_usage: { input_tokens: 1000, cached_input_tokens: 700, output_tokens: 100 }, model_context_window: 258400,
  } });
  const file = join(rollouts, "rollout-session.jsonl");
  const old = new Date(Date.now() - 5 * 86400000).toISOString();
  writeFileSync(file, row("session_meta", { id: "session", cwd: "/tmp/shared" }, old) +
    row("turn_context", { model: "gpt-test" }, old) +
    row("event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 5000, output_tokens: 500 } } }, old) +
    row("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }) +
    counts(6000, 700, 600) + counts(6000, 700, 600));
  writeFileSync(join(claude, "project", "session.jsonl"), JSON.stringify({ type: "assistant", timestamp: now,
    sessionId: "session", cwd: "/tmp/shared", message: { model: "claude-sonnet", usage: { input_tokens: 100, output_tokens: 10 }, content: [] } }) + "\n");
  const historical = join(archive, "rollout-past.jsonl");
  writeFileSync(historical, row("session_meta", { id: "past", cwd: "/tmp/shared" }, old) +
    row("turn_context", { model: "gpt-test" }, old) +
    row("event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 20, output_tokens: 10 } } }, old));
  utimesSync(historical, new Date(old), new Date(old));
  const port = 20000 + Math.floor(Math.random() * 30000);
  const base = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn(["bun", "collector.ts"], { cwd: import.meta.dir,
    env: { ...process.env, CODEX_HOME: codexHome, CLAUDE_PROJECTS_DIR: claude, MONITOR_PORT: String(port) }, stdout: "ignore", stderr: "pipe" });
  const get = async (path: string) => {
    const res = await fetch(base + path);
    expect(res.status).toBe(200);
    return res.json();
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(base + "/api/snapshot")).ok) break; } catch {}
      await Bun.sleep(50);
    }
    if (proc.exitCode !== null) throw new Error(await new Response(proc.stderr).text());
    const snap = await get("/api/snapshot");
    expect(snap.sessions.length).toBe(2);
    expect(snap.sessions.find((s: any) => s.provider === "codex").usage).toMatchObject({ input: 5300, cacheRead: 700, output: 600 });
    const stats = await get("/api/stats?days=1");
    expect(stats.totals.tokens).toBe(1210); // old counters establish baseline before date filtering
    expect(stats.providers.codex).toEqual({ tokens: 1100, prompts: 1 });
    expect(stats.totals.cost).toBeNull();
    const projects = await get("/api/projects?days=1");
    expect(projects.projects[0].sessionCount).toBe(2);
    expect(projects.projects[0].usage.input).toBe(400);
    const detail = await get("/api/session/codex%3Asession");
    expect(detail.provider).toBe("codex");
    expect(detail.cost.totalUSD).toBeNull();
    expect(detail.context.tokens).toBe(1000); // only measured request input, not cumulative history
    const obs = await get("/api/observe/codex%3Asession");
    expect(obs.cap).toBe(258400);
    expect(obs.nodes[0].selfTok).toBe(6600);
    expect(obs.nodes[0].cost).toBeNull();
    expect(obs.nodes[0].baseBreakdown).toBeUndefined();
    const past = await get("/api/observe/codex%3Apast");
    expect(past.session.sessionId).toBe("codex:past");
    expect(past.nodes[0].selfTok).toBe(30);
    expect(past.cap).toBeNull();

    reader = (await fetch(base + "/events")).body!.getReader();
    await reader.read(); // connected comment
    const addition = counts(7000, 1400, 700);
    appendFileSync(file, addition.slice(0, -2)); // partial JSON must wait for the next append
    await Bun.sleep(150);
    expect((await get("/api/snapshot")).sessions.find((s: any) => s.provider === "codex").usage.output).toBe(600);
    appendFileSync(file, addition.slice(-2));
    const event = await Promise.race([reader.read(), Bun.sleep(3000).then(() => { throw new Error("SSE update missing"); })]);
    expect(new TextDecoder().decode(event.value)).toContain('"provider":"codex"');
    renameSync(file, join(archive, "rollout-session.jsonl"));
    await Bun.sleep(200);
    expect((await get("/api/snapshot")).sessions.find((s: any) => s.provider === "codex").usage.output).toBe(700);
    expect((await get("/api/stats?days=1")).totals.tokens).toBe(2310);
  } finally {
    await reader?.cancel();
    proc.kill();
    await proc.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
