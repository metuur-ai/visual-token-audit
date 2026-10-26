import { expect, test } from "bun:test";
import { parseLine } from "./parse.ts";
import { emit, sessions, sessionLines } from "./state.ts";
import { refreshCodexSessionNames } from "./watch.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("session directory, transcript slug and saved titles survive ingestion without counting renames as activity", () => {
  const id = "metadata-search-test";
  const ingest = (record: any) => {
    const parsed = parseLine(JSON.stringify({ sessionId: id, ...record }), "-Users-dev-service");
    if (parsed) emit(parsed.ev, false, parsed.line);
  };
  try {
    ingest({ type: "ai-title", aiTitle: "Initial title" });
    ingest({ type: "user", timestamp: "2026-10-25T12:00:00Z", cwd: "/Users/dev/service", slug: "eager-quiet-lake", message: { content: "Fix the service" } });
    expect(sessions.get(id)).toMatchObject({ sessionName: "Initial title", slug: "eager-quiet-lake", projectSlug: "-Users-dev-service", cwd: "/Users/dev/service", events: 1, prompts: 1 });
    ingest({ type: "custom-title", customTitle: "Saved custom title" });
    expect(sessions.get(id)).toMatchObject({ sessionName: "Saved custom title", lastTs: "2026-10-25T12:00:00Z", events: 1, prompts: 1 });
    expect(sessionLines.get(id)).toHaveLength(1);
  } finally {
    sessions.delete(id);
    sessionLines.delete(id);
  }
});

test("Codex saved names load from the local index and refresh without changing counters", () => {
  const root = mkdtempSync(join(tmpdir(), "monitor-names-"));
  const path = join(root, "session_index.jsonl");
  const id = "codex:index-name-test";
  try {
    emit({ sessionId: id, provider: "codex", project: "demo", kind: "prompt", ts: "2026-10-25T12:00:00Z" }, false);
    writeFileSync(path, 'bad json\n' + JSON.stringify({ id: "index-name-test", thread_name: "Invoice repair" }) + '\n' + '{"id":');
    refreshCodexSessionNames(false, path);
    expect(sessions.get(id)).toMatchObject({ sessionName: "Invoice repair", events: 1, prompts: 1, lastTs: "2026-10-25T12:00:00Z" });
    writeFileSync(path, JSON.stringify({ id: "index-name-test", thread_name: "Saved renamed session" }) + '\n');
    refreshCodexSessionNames(false, path);
    expect(sessions.get(id)).toMatchObject({ sessionName: "Saved renamed session", events: 1 });
    expect(() => refreshCodexSessionNames(false, join(root, "missing"))).not.toThrow();
  } finally {
    sessions.delete(id);
    rmSync(root, { recursive: true, force: true });
  }
});
