# Live Monitor — Interface Contract (v2)

Single source of truth for the collector (server) and the dashboard (UI).
Both sides MUST build against this exactly. Runtime: **Bun 1.3.x** (no npm deps, no build step).

v2 changes: **light theme**, richer MonitorEvent (uuid/parent/command/agent), new
`GET /api/session/:id` endpoint with per-session counts, token attribution,
invocation tree, and auto-loaded vs invoked classification.

## File layout

```
live-monitor/
├── CONTRACT.md          (this file)
├── collector.ts         (Bun server — Agent A)
├── public/
│   ├── index.html       (dashboard — Agent B)
│   └── app.js           (dashboard logic — Agent B)
└── README.md            (Agent A maintains)
```

## Server

- `Bun.serve()`, bind host `127.0.0.1`, port `8722` (override via `MONITOR_PORT` env).
- Watches `~/.claude/projects/**/*.jsonl` (recursive fs.watch + 15s rescan fallback).
- Incremental byte-offset tail reads; buffer partial lines; never re-read whole files after first scan.
- First scan seeds from tails of files modified in last 48h.
- Ring buffer: last `5000` MonitorEvents, monotonic integer `id`.
- **v2:** additionally keep, per session, the **full parsed line list** (bounded: last `4000` lines per session, only sessions active in the last 7 days) so `/api/session/:id` can build trees and attribution on demand. Build SessionDetail lazily per request (cache and invalidate on new session lines).

## HTTP endpoints

| Route | Behavior |
|---|---|
| `GET /` | `public/index.html`, `text/html; charset=utf-8` |
| `GET /app.js` | `public/app.js`, `text/javascript` |
| `GET /api/snapshot` | `{ "events": MonitorEvent[], "sessions": SessionAgg[], "startedAt": string }` |
| `GET /api/session/:sessionId` | `SessionDetail` JSON (below). 404 JSON `{error:"unknown session"}` if not tracked. |
| `GET /events` | SSE. `id: <event.id>\ndata: <MonitorEvent JSON>\n\n`; honors `Last-Event-ID` replay; `: keepalive\n\n` every 25s. |

## MonitorEvent (v2 — SSE payload and `snapshot.events[]`)

```jsonc
{
  "id": 123,
  "ts": "2026-07-16T15:28:38.000Z",
  "sessionId": "fca56e70-f519-42ec-94b6-256cbdc7ba80",
  "project": "agentic-visual-spec",
  "kind": "prompt" | "assistant" | "tool_use" | "tool_result" | "system",
  "uuid": "…",           // v2: transcript line uuid (when present)
  "parentUuid": "…",     // v2: transcript line parentUuid (when present)
  "model": "claude-opus-4-8",   // optional
  "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, // optional
  "tools": ["Bash", "Read"],    // optional
  "skill": "harness-audit",     // optional; Skill tool invocation
  "command": "/fast",           // v2 optional; slash command detected in a prompt
  "agent": "general-purpose",   // v2 optional; Task/Agent tool subagent_type
  "sidechain": true,            // v2 optional; line has isSidechain:true (subagent transcript)
  "text": "first 140 chars…"    // optional snippet
}
```

## SessionAgg (`snapshot.sessions[]`) — unchanged from v1, plus:

```jsonc
{
  "sessionId": "…", "project": "…", "firstTs": "…", "lastTs": "…",
  "prompts": 12, "events": 245,
  "models": { "claude-opus-4-8": 40 },
  "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
  "tools": { "Bash": 30 }, "skills": { "harness-audit": 2 },
  "commands": { "/fast": 1 },     // v2
  "agents": { "general-purpose": 2 } // v2
}
```

## SessionDetail (`GET /api/session/:id`)

```jsonc
{
  "sessionId": "…", "project": "…", "firstTs": "…", "lastTs": "…",
  "prompts": 12,
  "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },

  // Deduplicated counts WITH token attribution. Same shape for all four maps:
  // key → { count, usage: {input, output, cacheRead, cacheWrite} }
  "tools":    { "Bash": { "count": 30, "usage": { … } } },
  "skills":   { "harness-audit": { "count": 2, "usage": { … } } },
  "commands": { "/compact": { "count": 1, "usage": { … } } },
  "agents":   { "general-purpose": { "count": 2, "usage": { … } } },
  "mcp":      { "claude_ai_Slack": { "count": 4, "usage": { … } } }, // mcp__<server>__<tool> grouped by server

  // Auto-loaded vs explicitly invoked (see Classification below)
  "loading": {
    "auto":    [ { "type": "memory"|"skill"|"command"|"plugin"|"hook"|"mcp", "name": "CLAUDE.md", "evidence": "short string, ≤120 chars" } ],
    "invoked": [ { "type": "skill"|"command"|"agent"|"tool"|"mcp", "name": "harness-audit", "count": 2 } ]
  },

  // Invocation tree: one root per user prompt, chronological
  "tree": [ TreeNode ]
}

TreeNode = {
  "kind": "prompt" | "assistant" | "tool" | "skill" | "command" | "agent",
  "name": "Bash",            // tool/skill/command/agent name; for prompt/assistant: "" or model
  "ts": "…",
  "label": "≤100 char snippet",   // prompt text, tool input summary, etc.
  "usage": { … },            // optional; attributed tokens for this node's own step
  "durationMs": 1234,        // optional; tool_use → matching tool_result delta
  "resultBytes": 5678,       // optional; size of tool_result content (context cost signal)
  "children": [ TreeNode ]
}
```

### Tree building rules (Agent A)

- Link lines via `uuid`/`parentUuid`, and `tool_use` `id` ↔ `tool_result` `tool_use_id`.
- Root = each `kind:"prompt"` user line (real user text, not tool_result carriers). Its subtree = everything until the next prompt.
- An assistant message with tool_use blocks → one child node per tool_use, in block order.
  - `Skill` tool → node kind `skill`, name from input. `Task`/`Agent` tool → kind `agent`, name = subagent_type; if sidechain lines for that agent are trackable (same file `isSidechain:true` or separate file), nest a summarized subtree (cap depth 4, cap 50 nodes per agent, append a `"…truncated"` label node if over).
  - A prompt whose text starts with a slash-command tag (see below) → root node kind `command`, name = command.
- Cap the whole tree at 2000 nodes; truncate oldest prompts first.

### Token attribution (heuristic — document it in README)

- Each assistant message's `usage` is attributed to the **scope** active when it was emitted:
  - Inside an agent sidechain → that agent.
  - Between a `Skill` invocation and its tool_result → that skill (nested scopes: innermost wins).
  - Within a prompt initiated by a slash command → that command (until next prompt).
  - Additionally, each tool named in the message adds that message's usage to its own tool entry **divided by the number of tool_use blocks** in the message (so tool sums ≈ real totals, no double counting within the tools map).
- `resultBytes` of each tool_result is recorded on the tool node (proxy for context weight).
- This is approximate; exactness is not required, consistency is.

### Auto-loaded vs invoked classification

- **auto**: things injected without the user asking in that turn — detect from user-line content:
  - `<system-reminder>` blocks (memory/CLAUDE.md loads, hook outputs — capture first line as evidence),
  - hook context markers like `UserPromptSubmit hook`, `PreToolUse:` etc.,
  - system lines announcing loaded plugins/skills if present.
  Dedupe by (type,name); keep ≤80 chars evidence.
- **invoked**: explicit uses — Skill tool calls, slash commands typed by user (`<command-name>…</command-name>` tags or leading `/word` in prompt text — VERIFY the real tag format in transcripts), Task/Agent calls, MCP tool calls.

## Dashboard requirements (Agent B) — v2

- **LIGHT theme** (white/near-white background `#fafafa`, dark gray text, subtle borders `#e2e2e2`, accent blue; keep kind-badge colors readable on light bg). No dark mode.
- Same base layout as v1 (totals strip + sessions table + live feed), plus:
- **Session detail view**: clicking a session row opens a detail panel (overlay or third column replacing the feed; back button returns). Fetch `/api/session/:id`. Contents top-to-bottom:
  1. Header: project, full session id (copyable), time range, prompts, total usage.
  2. **Counts tables** — one small table each for Tools / Skills / Commands / Agents / MCP: name · count · input · output · cacheRead · cacheWrite, sorted by count desc. Hide empty tables.
  3. **Loading panel** — two lists side by side: "Auto-loaded (context)" with type chips + evidence tooltip (title attr), "Invoked" with counts.
  4. **Invocation tree** — collapsible indented tree (details/summary or custom toggles): each node shows kind badge, name, time, attributed tokens, durationMs and resultBytes when present. Prompts collapsed by default except the most recent one. Pure DOM, no libs.
- Re-fetch the open session detail when SSE delivers an event for that session (debounce 2s).
- Escape everything transcript-derived via `textContent`. Compact numbers. Relative times every 10s.
