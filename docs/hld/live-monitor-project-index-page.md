# Project-Centric Index Page for live-monitor — High-Level Design

## Overview

live-monitor today exposes three pages (Dashboard, Observe, Stats) all built around a flat, per-*session* view of Claude Code activity: the Dashboard lists individual sessions and the Observer deep-inspects one session at a time. There is no view that answers "which *projects* have I been working in, and how recently?" This feature adds a fourth page — **Projects** — reachable from the existing header nav, that groups all known sessions **by project directory** and sorts projects by most-recent activity. Each project row shows its directory/project name, most-recent-activity date, total session count, and at-a-glance rolled-up metadata (prompts, token usage, top tools); expanding a project lists its sessions newest-first, each deep-linking into the existing Observer at `/observe?session=<id>`. It is a rediscovery/index layer that sits *above* the Observe page, never replacing it. The page is backed by one new read-only JSON endpoint (`/api/projects`) that folds the in-memory `sessions` map by project key — no new persistence, no change to any existing endpoint or page.

## Stakeholders & Impact

- **Primary user — the developer running live-monitor to review their own Claude Code usage.** Today, to answer "what was I doing in project X, and when did I last touch it?", they must scan a flat session table on the Dashboard (rows keyed by opaque session ids, ordered by session, not by project) and mentally re-group by the `Project` column. Multi-session projects are scattered; a project touched across many sessions has no single anchor. After ship, they open **Projects** and see one row per project directory, sorted by recency, with session counts and a drill-down to each session's Observer view — turning "hunt through sessions" into "pick a project, then a session."
- **Secondary consumer — the Observer (`observe.html`) deep-analysis surface.** It gains a natural entry point: the Projects page becomes the top of a funnel (project → session → Observer) via the existing `/observe?session=<id>` link, without any change to the Observer itself.
- **Not affected (by design):** the Dashboard, Observe, and Stats pages keep their current behavior and data; the collector's ingestion, SSE feed, and existing endpoints are untouched. Anyone depending on `/api/snapshot`, `/api/stats`, `/api/session/:id`, `/api/observe/:id`, or `/events` sees no change.

## Goals

- A new **Projects** page is reachable from the header nav on every page, marked `class="on"` when active, and renders a list of projects grouped by project directory.
- Projects are sorted **most-recent-activity first**; each project shows: project/directory name, most-recent-activity timestamp, total session count, and rolled-up at-a-glance metadata (summed prompts, token usage, top tools/skills).
- Within a project, its sessions are listed **newest-first** (by `lastTs` descending), each linking to the existing Observer at `/observe?session=<id>`.
- A new read-only endpoint `GET /api/projects` returns the grouped structure as JSON, folded from the live in-memory `sessions` map (the same source `/api/snapshot` serializes).
- The page ships as a self-contained static page (`public/projects.html` + `public/projects.js`) served through the existing `serveStatic` pattern, with zero new runtime dependencies.

## Non-Goals

- **The Observe page is not modified or replaced.** The Projects page indexes *into* it; the Observer's inputs, URL contract, and rendering are unchanged.
- **No changes to existing endpoints or pages' data contracts** — `/api/snapshot`, `/api/stats`, `/api/session/:id`, `/api/observe/:id`, `/events`, Dashboard, Stats all behave identically.
- **No new persistence.** The grouping is computed on read from the in-memory `sessions` map; nothing is written to disk, no new cache layer is required for correctness.
- **No new "work summary" / AI title field.** The parser deliberately skips `summary` and `ai-title` transcript lines, and `SessionAgg` carries no title. The page's "at-a-glance" metadata is limited to data already aggregated on `SessionAgg` (counts, usage, frequency maps); no summary text is invented or newly extracted.
- **The server stays zero-dependency and dual-runtime (Bun/Node).** No framework, router abstraction, or package is added on the server.
- **No new grouping fidelity beyond what the aggregate already carries** — grouping uses `cwd`/`project` already on `SessionAgg`; no disk re-scan or slug recovery is introduced in this change.
- **Recency scope is bounded to the in-memory `sessions` map.** Projects are derived only from sessions currently present in memory; sessions older than the startup seed window, or from before the current process, do not appear. The page is a rediscovery index of *recent* work, not a full historical archive (R-1.16).

## Success Criteria

- Navigating to `/projects` returns the new page (HTTP 200 with the page HTML) and the header "Projects" link is present and marked active there and present on Dashboard/Observe/Stats.
- `GET /api/projects` returns valid JSON containing one entry per distinct project key, each carrying `name`, most-recent-activity timestamp, `sessionCount`, rolled-up metadata, and a newest-first list of its sessions with `sessionId`.
- The rendered project list is ordered by most-recent activity (newest project first); within each project, sessions are ordered newest-first.
- Clicking a session on the Projects page navigates to `/observe?session=<that id>` and the Observer loads that session (proving the deep-link contract is honored).
- All existing pages and endpoints are byte-for-byte unchanged in behavior; the server still starts and serves under both Bun and Node with no added dependency.
- When `public/projects.html`/`projects.js` are missing (pre-build), the API remains usable and the static route returns the existing 503 "UI not built yet" placeholder rather than crashing.
