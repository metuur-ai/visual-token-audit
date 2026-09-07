// Live Claude Code and Codex session monitor — collector (server half).
// Bun + TypeScript, ZERO npm dependencies. Entry/bootstrap.
//
// Watches ~/.claude/projects/**/*.jsonl (Claude Code transcripts), parses each
// appended line incrementally, keeps a ring buffer of MonitorEvents + per-session
// aggregates, and serves an HTTP + SSE API on 127.0.0.1:8722 (MONITOR_PORT override).
//
// The implementation lives in ./src/*.ts, one section per module. This file only
// resolves the public asset directory (which depends on import.meta and differs
// between `bun run collector.ts` and the built dist bundle) and wires the pieces.
//
// See CONTRACT.md for the interface. Field names were verified against real
// transcripts in ~/.claude/projects/ (see README.md "Observed transcript fields").

import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { HOST, PORT, PROJECTS_DIR, CODEX_SESSION_DIRS, RESCAN_INTERVAL_MS } from "./src/config.ts";
import { startHttpServer } from "./src/server.ts";
import { log } from "./src/util.ts";
import { firstScan, rescan, startWatch } from "./src/watch.ts";

// Resolve the directory of this module across runtimes: Bun exposes
// `import.meta.dir`, Node 20.11+ exposes `import.meta.dirname`, and older Node
// falls back to deriving it from `import.meta.url`.
const HERE =
  (import.meta as { dir?: string; dirname?: string }).dir ??
  (import.meta as { dir?: string; dirname?: string }).dirname ??
  dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "public");

const server = startHttpServer({ host: HOST, port: PORT, publicDir: PUBLIC_DIR });

// ----------------------------------------------------------------------------
// Boot
// ----------------------------------------------------------------------------
try {
  firstScan();
} catch (e) {
  log("firstScan failed", e);
}
startWatch();
setInterval(rescan, RESCAN_INTERVAL_MS);

log(`listening on http://${HOST}:${server.port}  (watching ${[PROJECTS_DIR, ...CODEX_SESSION_DIRS].join(", ")})`);
