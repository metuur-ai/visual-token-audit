# visual-token-audit

Tools for seeing what your Claude Code sessions are actually doing — token spend,
tool calls, skill/command activity, and agent timelines — in real time.

This repo contains two independent pieces:

| Component | What it is | Path |
|---|---|---|
| **Live Monitor** | A zero-dependency local web app that tails your Claude Code transcripts and visualizes activity live. | [`live-monitor/`](live-monitor/) |
| **harness-audit** | A skill that audits and refactors your Claude "harness" (CLAUDE.md, rules, skills, commands, agents, hooks, memory). | [`skills/harness-audit/`](skills/harness-audit/) |

---

## Live Monitor

A local **HTTP + Server-Sent Events** server that watches
`~/.claude/projects/**/*.jsonl` (the JSONL transcript Claude Code writes per
session), parses each appended line incrementally, and serves three live views on
`http://127.0.0.1:8722`. Zero npm dependencies; runs on **Node ≥18** or **Bun**.

### Quick start

Run it with `npx` (Node — no Bun required):

```sh
npx @metuur/claude-live-monitor
```

Then open **http://127.0.0.1:8722**.

> The unscoped command name is `claude-live-monitor`. Once the package is
> installed (globally or as a project dep), `npx claude-live-monitor` resolves it
> from your PATH without hitting the registry.

### Install globally

```sh
# from the published package
npm install -g @metuur/claude-live-monitor

# or from a local checkout (real standalone copy)
cd live-monitor
npm run build
npm install -g "$(npm pack | tail -1)"

claude-live-monitor        # run from anywhere
```

> `npm install -g .` on a local folder creates a **symlink**, not a copy — use the
> `npm pack` + install-the-tarball form above for an install that doesn't depend on
> your source directory. For active development, prefer `npm link` (symlink,
> reflects rebuilds).

### Run from source (dev)

```sh
cd live-monitor
bun run collector.ts               # Bun — no build step
# or
npm run build && node bin/cli.js   # Node — builds dist/, then runs
```

The collector is runtime-agnostic: it uses `Bun.serve` under Bun and adapts the
same handler onto `node:http` otherwise. `npm run build` bundles
`collector.ts` → `dist/collector.js` and copies `public/` → `dist/public/`; that
`dist/` is what `npx` ships and runs.

### The three views

| View | URL | Updates via | Cadence |
|---|---|---|---|
| **Dashboard** | `/` | **SSE push** (`EventSource`) | Instant, per-event |
| **Observe** | `/observe` | Polling | Entity every 5 s, session list every 30 s |
| **Stats** | `/stats` | Polling | Every 60 s |

- **Dashboard** — true realtime. One SSE connection streams each event and updates
  session rows, the activity feed, and totals in place (no reload). Reconnects with
  `Last-Event-ID` replay so no events are missed across drops.
- **Observe** — a per-session breakdown with an agent/tool **Timeline**; auto-refreshes
  on a 5 s poll.
- **Stats** — multi-day aggregates (`?days=N`, 1–30, default 14).

End-to-end freshness is also bounded by how fast the collector notices new
transcript lines: a recursive `fs.watch` fires near-instantly, with a 15 s periodic
rescan as a macOS fallback.

### Configuration

| Env var | Default | Meaning |
|---|---|---|
| `MONITOR_PORT` | `8722` | Port to listen on (host is always `127.0.0.1`). |

```sh
MONITOR_PORT=9000 claude-live-monitor
```

### Resource usage

Measured on Node 20 / Bun 1.3, idle after boot:

| Runtime | Resident memory | CPU (idle) |
|---|---|---|
| Node (`npx`) | ~120–140 MB | ~0% |
| Bun | ~175–200 MB | ~0% |

CPU is ~0% at idle — it only spends cycles in short bursts when parsing new
transcript lines or serving a request. Memory is dominated by the runtime baseline,
not your data: the in-memory event buffer is **bounded** to 5000 events
(`RING_MAX`) plus per-session aggregates. Run under **Node** for the lighter
footprint.

Check a running instance:

```sh
pgrep -f 'claude-live-monitor|collector' | xargs ps -o pid=,rss=,%cpu=,etime= -p \
  | awk '{printf "pid=%s  RSS=%.1f MB  CPU=%s%%  up=%s\n",$1,$2/1024,$3,$4}'
```

### HTTP API

| Route | Response |
|---|---|
| `GET /api/snapshot` | `{ events, sessions, startedAt }` — full ring buffer + per-session aggregates |
| `GET /api/stats?days=N` | Multi-day aggregate stats (N clamped 1–30, default 14) |
| `GET /api/session/<id>` | Detail for one session |
| `GET /api/observe/<id>` | Observe entity model for one session |
| `GET /events` | SSE stream of `MonitorEvent`s (honors `Last-Event-ID`, keepalive every 25 s) |

See [`live-monitor/README.md`](live-monitor/README.md) for collector internals and
[`live-monitor/CONTRACT.md`](live-monitor/CONTRACT.md) for the exact
`MonitorEvent` / `SessionAgg` schemas.

### Security

- Binds **localhost only** (`127.0.0.1`) — not exposed to the network, no auth.
- **Read-only**: it reads your transcripts (which may contain prompt text, tool
  inputs, and file paths) and serves snippets/aggregates locally. It never writes to
  or modifies transcripts. Do not port-forward or reverse-proxy it to the internet.

---

## harness-audit (skill)

A repeatable audit for the instruction "harness" around Claude — CLAUDE.md files,
rules, skills, commands, agents, plugins, hooks, and memory. It maps everything
that loads, finds duplicated/stale/contradictory rules, decides where each rule
should live, reduces always-loaded context, and converts soft yes/no rules into
enforceable checks (hooks, validation scripts, JSON schemas). Audit + propose,
applying fixes per-class on approval.

See [`skills/harness-audit/SKILL.md`](skills/harness-audit/SKILL.md).

---

## Requirements

- **Node ≥18** (for `npx` / global install) or **Bun** (for source dev).
- macOS or Linux. The monitor reads `~/.claude/projects/` — it does nothing useful
  without Claude Code session transcripts present.

## License

[Apache-2.0](LICENSE).
