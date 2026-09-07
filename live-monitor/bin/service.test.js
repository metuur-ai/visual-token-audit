// Run after npm run build: node --test bin/service.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

test("background lifecycle, duplicate commands, stale state, and occupied port", async () => {
  const dir = mkdtempSync(join(tmpdir(), "monitor-service-"));
  const occupied = createServer(socket => socket.destroy());
  await new Promise(resolve => occupied.listen(0, "127.0.0.1", resolve));
  const port = occupied.address().port;
  const browserLog = join(dir, "browser.log");
  // Capture browser launches without opening real tabs during tests.
  for (const name of ["open", "xdg-open"]) writeFileSync(join(dir, name),
    '#!/bin/sh\nprintf "%s\\n" "$1" >> "$MONITOR_TEST_BROWSER_LOG"\n', { mode: 0o755 });
  const env = { ...process.env, MONITOR_PORT: String(port), MONITOR_STATE_DIR: dir,
    PATH: `${dir}:${process.env.PATH}`, MONITOR_TEST_BROWSER_LOG: browserLog,
    MONITOR_OPEN_BROWSER: process.platform === "win32" ? "0" : "1",
    CODEX_HOME: join(dir, "codex"), CLAUDE_PROJECTS_DIR: join(dir, "claude") };
  const cli = fileURLToPath(new URL("cli.js", import.meta.url));
  const run = command => spawnSync("node", [cli, command], { env, encoding: "utf8", timeout: 15000 });
  try {
    const failed = run("start");
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /port may already be in use/);
    assert.equal(existsSync(browserLog), false);
    await new Promise(resolve => occupied.close(resolve));
    // An unrelated/reused PID in stale state must never receive a signal.
    writeFileSync(join(dir, `${port}.json`), JSON.stringify({ pid: process.pid, token: "stale" }));
    assert.equal(run("stop").status, 0);
    assert.equal(run("status").status, 1);
    const started = run("start");
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /Started background service/);
    const first = JSON.parse(readFileSync(join(dir, `${port}.json`), "utf8"));
    const status = run("status");
    assert.equal(status.status, 0);
    assert.ok(status.stdout.includes(`URL: http://127.0.0.1:${port}`));
    assert.ok(status.stdout.includes(`Log: ${dir}`));
    assert.match(run("start").stdout, /Already running/);
    if (process.platform !== "win32") assert.deepEqual(readFileSync(browserLog, "utf8").trim().split("\n"),
      [`http://127.0.0.1:${port}`, `http://127.0.0.1:${port}`]);
    assert.equal(JSON.parse(readFileSync(join(dir, `${port}.json`), "utf8")).pid, first.pid);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/service`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/snapshot`)).status, 200);
    assert.equal(run("stop").status, 0);
    const stopped = run("status");
    assert.equal(stopped.status, 1);
    assert.ok(stopped.stdout.includes(`URL: http://127.0.0.1:${port}`));
    assert.equal(run("stop").status, 0);
  } finally {
    run("stop");
    if (occupied.listening) await new Promise(resolve => occupied.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
