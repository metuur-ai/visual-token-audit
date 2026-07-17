# Live Monitor — Collector (server)

A zero-dependency [Bun](https://bun.sh) server that tails your Claude Code
session transcripts in real time and exposes them over HTTP + Server-Sent Events
for the dashboard UI.

## Run

Anywhere with **Node ≥18** (no Bun needed):

```sh
npx claude-live-monitor
```

Or from a checkout, with either runtime:

```sh
bun run collector.ts     # Bun (dev, no build step)
npm run build && node bin/cli.js   # Node (builds dist/, then runs)
```

Then open **http://127.0.0.1:8722** in a browser.

The collector runs identically on Bun and Node: it uses `Bun.serve` when run
under Bun and adapts the same handler onto `node:http` otherwise. `npm run build`
bundles `collector.ts` → `dist/collector.js` and copies `public/` → `dist/public/`;
that `dist/` is what `npx` ships and runs.

> If the dashboard hasn't been built yet, `/` returns a `503 "UI not built yet"`
> placeholder — the API endpoints below still work regardless.

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `MONITOR_PORT` | `8722` | Port to listen on (host is always `127.0.0.1`). |

## What it watches

- `~/.claude/projects/**/*.jsonl` — Claude Code writes one JSONL transcript per
  session under a per-project directory whose name is a slug of the project cwd
  (e.g. `-Users-you-others-foo-bar`).
- **First scan:** seeds from the tail (≤200 lines) of every file modified in the
  last 48h, oldest-file-first so the ring buffer ends with the newest activity.
  Older files are registered at EOF (no history replay) but still stream new appends.
- **Live:** a recursive `fs.watch` on the projects dir triggers incremental reads
  of only the newly-appended bytes per file (byte-offset tracked per file, partial
  trailing lines buffered until the next newline).
- **Fallback:** a 15s periodic rescan catches brand-new files/dirs that
  `fs.watch` can miss on macOS, and re-checks known files for appends.
- File truncation/rotation (stored offset > current size) resets to EOF without
  replaying.

## HTTP API

| Route | Response |
|---|---|
| `GET /` | `public/index.html` (or 503 placeholder if missing) |
| `GET /app.js` | `public/app.js` (or 503 placeholder if missing) |
| `GET /api/snapshot` | `{ events: MonitorEvent[], sessions: SessionAgg[], startedAt }` — full ring buffer (last 5000 events) + per-session aggregates |
| `GET /events` | SSE stream. Each message is `id: <n>\ndata: <JSON MonitorEvent>\n\n`. Honors the `Last-Event-ID` request header (replays buffered events with a greater id before going live). Sends `: keepalive\n\n` every 25s. |

See `CONTRACT.md` for the exact `MonitorEvent` / `SessionAgg` schemas.

## Observed transcript fields

The parser was written against **real** transcripts, not assumptions. Confirmed
shapes (Bun 1.3.x, transcript format mid-2026):

- Every event line: `type`, `timestamp` (ISO-8601), `sessionId`, `cwd`.
  Project name = `basename(cwd)` when present, else decoded from the dir slug.
- `type:"assistant"` → `message.model` (e.g. `claude-fable-5`),
  `message.usage.{input_tokens, output_tokens, cache_read_input_tokens,
  cache_creation_input_tokens}`, and `message.content[]` blocks of type
  `thinking` / `text` / `tool_use` (tool_use has `name` + `input`). Tool names go
  into `tools`; a `tool_use` named `Skill` sets `skill` from its input.
- `type:"user"` → `message.content` is either a **string** (a prompt →
  `kind:"prompt"`) or an **array** containing `{type:"tool_result", tool_use_id,
  content, is_error}` blocks (→ `kind:"tool_result"`). `isMeta:true` lines
  (injected caveats) are skipped.
- `type:"system"` → surfaced only when it carries output/hook errors.
- Non-event line types present in transcripts and **skipped**: `last-prompt`,
  `mode`, `permission-mode`, `ai-title`, `file-history-snapshot`, `attachment`,
  `summary`.

Malformed JSON lines are skipped silently; all parse and IO is wrapped in
try/catch and logged to stderr — the watcher never crashes on bad input.

## Security note

- Binds **localhost only** (`127.0.0.1`). Not exposed to the network.
- **Read-only**: it reads your Claude Code transcripts (which may contain prompt
  text, tool inputs, and file paths) and serves snippets/aggregates locally. It
  never writes to or modifies transcripts. No auth is applied because it is not
  reachable off-host — do not port-forward or reverse-proxy it to the internet.
