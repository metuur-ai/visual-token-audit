import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("help and version work without a collector build or service module", () => {
  const dir = mkdtempSync(join(tmpdir(), "monitor-cli-"));
  try {
    mkdirSync(join(dir, "bin"));
    // A different fixture version catches accidental hardcoding. Omitting the
    // collector and service also proves these commands cannot start the monitor.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module", version: "1.2.3-test" }));
    for (const name of ["claude-live-monitor", "codex-live-monitor"]) {
      const cli = join(dir, "bin", name);
      copyFileSync(new URL("cli.js", import.meta.url), cli);
      const run = command => spawnSync("node", [cli, command], { cwd: tmpdir(), encoding: "utf8", timeout: 5000 });
      for (const command of ["version", "--version", "-v"]) {
        const result = run(command);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, "1.2.3-test\n");
        assert.equal(result.stderr, "");
      }
      for (const command of ["help", "--help", "-h"]) {
        const result = run(command);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, "");
        for (const text of ["claude-live-monitor", "codex-live-monitor", "start", "stop", "status", "version", "help", "MONITOR_PORT"])
          assert.ok(result.stdout.includes(text), text);
      }
      const unknown = run("not-a-command");
      assert.equal(unknown.status, 1);
      assert.match(unknown.stderr, /Unknown command: not-a-command/);
      assert.match(unknown.stderr, /Usage:/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
