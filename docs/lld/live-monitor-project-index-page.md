# Project-Centric Index Page for live-monitor — Low-Level Design

## Architecture

Four additive touch-points inside the existing app; no existing code path changes behavior.

### 1. New JSON endpoint `GET /api/projects` (in `collector.ts`)

Added as one more explicit `if (path === "/api/projects")` block in the single `fetch()` dispatcher (`collector.ts:2374-2407` router region), placed alongside the other `/api/*` blocks and returning JSON with the same idiom as `/api/snapshot` (`collector.ts:2403-2407`):

```
new Response(json, { headers: { "Content-Type": "application/json; charset=utf-8" } })
```

The handler folds the in-memory session index. Source: `const sessions = new Map<string, SessionAgg>()` (`collector.ts:129`) — the same map `snapshotJSON()` serializes (`collector.ts:2201-2207`). Algorithm (a pure fold, mirroring how `/api/snapshot` reads `sessions.values()`):

1. Iterate `sessions.values()` (each a `SessionAgg`, `collector.ts:82-97`).
2. Compute a **project key** per session: `cwd` when it is a non-empty string, else `project` (the basename/slug-tail already on the aggregate) when it is truthy, else the stable literal `"(unknown)"` (R-5.7 — a session can carry `project === ""` because `updateAgg` only overwrites when the incoming value is truthy). See Constraints for the collision caveat.
3. Group members into `Map<projectKey, SessionAgg[]>`.
4. For each group build a project record (the JSON contract below has no optional fields — every listed field is always present):
   - `key` — the grouping key used. WHERE both `cwd` and `project` are empty for every member, this is the stable literal `"(unknown)"` (R-5.7).
   - `name` — display name: `project` (basename) of the group's members; when grouped by `cwd`, still show `project` as the human label (basename). WHERE the members' `project` basename is empty, fall back to the literal `"(unknown)"` (R-5.4).
   - `cwd` — full-path subtitle: the members' `cwd` when present (empty string when no member carried `cwd`). Always emitted (not optional).
   - `lastActivity` — max of members' `lastTs` (`SessionAgg.lastTs`, `collector.ts:87`), ISO-8601 string identical to the source field (R-1.13).
   - `firstActivity` — min of members' `firstTs` (`collector.ts:86`), ISO-8601 string. Included in v1 (not optional).
   - `sessionCount` — group length.
   - Rolled-up `usage` — a **field-wise sum** over members of `usage.input`, `usage.output`, `usage.cacheRead`, and `usage.cacheWrite` (`collector.ts:91`), producing `{input, output, cacheRead, cacheWrite}` (R-1.14). A naive object `+` is a bug; each of the four fields is summed independently. Also sum members' `prompts` (`collector.ts:88`) and `events` (`collector.ts:89`).
   - "top tools" — merged top entries of the `tools`/`skills` frequency maps (`collector.ts:92-93`), emitted as `{name, count}[]` sorted by `count` descending, capped at 5, ties broken by `name` ascending (R-1.14).
   - `sessions` — members sorted by `lastTs` **descending** (ties broken by `sessionId` ascending, R-1.7), each projected to `{ sessionId, lastTs, prompts, usage }` (fields already on `SessionAgg`, matching R-1.8; `sessionId` at `collector.ts:83` is the deep-link key). Per-session `topTools` is intentionally omitted for v1 — project-level top tools already covers the at-a-glance need.
5. Sort project records by `lastActivity` **descending** (ties broken by group `key` ascending, R-1.6).
6. Serialize the top-level envelope `{ projects, startedAt }` (the normative shape; `startedAt` mirroring `snapshotJSON()`'s field, R-1.12) via `JSON.stringify` and return.

No path/query params are required (unlike `/api/session/:id` at `collector.ts:2417-2418` or `/api/stats` days-clamp at `collector.ts:2410-2412`); it is a parameterless GET like `/api/snapshot`, and any query string is ignored (R-1.15).

### 2. Static serving of the new page + assets (in `collector.ts`)

Two more explicit route blocks in `fetch()`, each calling `serveStatic(file, contentType)` (`collector.ts:2295-2312`), copy-shaped after the `/stats` / `/stats.js` blocks (`collector.ts:2390-2395`):

- `if (path === "/projects" || path === "/projects.html")` → `serveStatic("projects.html", "text/html; charset=utf-8")`
- `if (path === "/projects.js")` → `serveStatic("projects.js", "text/javascript; charset=utf-8")`

`serveStatic` reads `join(PUBLIC_DIR, file)` synchronously and returns the bytes; when the file is missing it already returns **503 "UI not built yet"** (`collector.ts:2307-2311`), so route-add order and build order don't matter. The page reuses the vendored ESM modules already served from `/vendor/*.js` (`collector.ts:2396-2402`) if built in the Preact style.

### 3. Header nav integration (four files)

The nav is duplicated per page (not componentized). A "Projects" link (`<a href="/projects">Projects</a>`) is added in all four navs, and marked `class="on"` on the Projects page itself. Edit targets are structural anchors (not line numbers, which rot as files change); all four navs must end up with the identical set of links and `href`s, differing only in which single link carries `class="on"` (R-3.5):

- `public/index.html` — the `<nav class="nav">` block (static HTML, Dashboard active): add the link.
- `public/observe.js` — the htm `html\`\`` nav template: add the link.
- `public/stats.js` — the htm `html\`\`` nav template: add the link.
- new `public/projects.js` (or `projects.html`) — its own nav template with `Projects` marked `class="on"`.

### 4. New frontend page `public/projects.html` + `public/projects.js`

Built from the existing standalone-page template (`stats.html:110-114` + `stats.js:189`): `<body><div id="root"></div><script type="module" src="/projects.js"></script></body>`; `projects.js` imports Preact + htm + hooks from `/vendor/`, defines an `App()` returning `html\`<header class="top">…nav…</header><main>…</main>\``, fetches `/api/projects` in a `useEffect`, and mounts via `render(html\`<${App}/>\`, document.getElementById('root'))`. Theme variables are inlined per file (no shared CSS), matching the `:root` palette convention (`index.html:10-25`) and panel/table idioms. Rendering:

- One project card/row per `projects[]` entry (already sorted by the endpoint), showing name, `lastActivity` (formatted date), `sessionCount`, and rolled-up prompts/usage/top-tools.
- Each project's `sessions[]` (already newest-first from the endpoint) rendered as a list; each session links to `/observe?session=' + encodeURIComponent(sessionId)` — the exact deep-link convention from `app.js:206-215`.

Data flow: `projects.js` → `fetch('/api/projects')` → render. Read-only, one-shot fetch on load (no SSE required for v1; consistent with the Stats page which also fetches once per range).

## Verification

Concrete checks for the two invariants that are otherwise hard to test:

- **Existing endpoints unchanged (R-1.11).** On a fixed fixture (a deterministic `sessions` map seeded before the change), capture the raw response bytes of `GET /api/snapshot`, `GET /api/stats?days=1`, `GET /api/session/:id`, and `GET /api/observe/:id`. After adding `/api/projects`, capture the same four responses on the same fixture and assert byte-for-byte equality with the pre-change capture.
- **Dual-runtime start (R-2.4).** Start the collector under both `bun collector.ts` and Node (the runtime-agnostic entry, `collector.ts:2317-2369`); in each runtime, issue `GET /api/projects` and assert it returns HTTP 200 with `Content-Type: application/json; charset=utf-8`.

## Constraints

- **Zero-dependency, dual-runtime (Bun/Node).** All server code stays inside `collector.ts`, uses only the runtime-agnostic Fetch handler (`startServer`, `collector.ts:2317-2369`), and adds no package. The endpoint uses only `JSON.stringify` and `Map`/array operations already used by `snapshotJSON`.
- **Explicit-string-match routing.** New routes are literal `path === "..."` blocks in `fetch()` (`collector.ts:2374`+), not a router abstraction. Order is additive; place `/api/projects` among the `/api/*` blocks and the static `/projects` blocks among the page blocks.
- **`serveStatic` 503-when-missing.** Missing page files must not 404 or crash — the existing `serveStatic` returns 503 "UI not built yet" (`collector.ts:2307-2311`); the new routes inherit this by construction.
- **JSON endpoint idiom.** `/api/projects` returns a pre-built JSON string with `Content-Type: application/json; charset=utf-8`, exactly like `/api/snapshot` (`collector.ts:2403-2407`). No path/query params.
- **Frontend conventions.** Match existing pages: inline theme `:root` vars (no shared CSS file), sticky header, panel cards, monospace data tables; Preact+htm standalone template (`stats.html`/`stats.js`) is the closest fit; vendored libs from `/vendor/`. Deep-link uses `'/observe?session=' + encodeURIComponent(id)` (`app.js:206-215`). Nav marked `class="on"` on the active page.
- **Grouping key = `cwd` when present, else `project` basename.** `SessionAgg.cwd` (`collector.ts:85`) is the fuller directory signal but is only populated when transcript lines carried `cwd`; `SessionAgg.project` (`collector.ts:84`) is a basename or slug-tail (from `projectName`/`decodeProjectFromSlug`, `collector.ts:167-179`) and never a full path. **Collision caveat:** two different directories sharing a basename fall together under the `project` fallback, and a `cwd`-keyed group and a basename-keyed group for the same real directory can appear as two entries if some sessions lack `cwd`. This is an accepted limitation of grouping from the aggregate; the full path / on-disk slug is not on `SessionAgg` (it exists only at scan time, `collector.ts:752-801`, and is out of scope here).
- **No new persistence / no summary field.** Fold is computed on each request from live memory; nothing written to disk. No summary/title is produced (parser skips `summary`/`ai-title`, `README.md:83-84`).

## Key Decisions

- **Group by `cwd` with `project`-basename fallback (not slug/full-path).** Rejected: keying by the on-disk slug (the only faithful full-directory identity) — it is available only during disk scanning (`listJsonlFiles`, `collector.ts:752-801`; recovered as `rel.split("/")[0]` in `buildStatsJSON`, `collector.ts:1992-1993`), not on `SessionAgg`, so using it would force a disk-scan endpoint. Chosen the aggregate fold for simplicity and zero cost; the collision/fidelity caveat is documented and accepted for v1.
- **Source = in-memory `sessions` map fold (not a disk scan).** Rejected: a `buildStatsJSON`-style disk pass (`collector.ts:1908-2196`) that re-reads files for broader/older history — it is higher cost (reads whole files into memory), needs its own caching, and is capped at 30 days. The in-memory fold over `sessions.values()` is effectively free and reuses the exact source `/api/snapshot` already exposes; retention is bounded by what the collector ingested this run, which is acceptable for a rediscovery index of *recent* work.
- **Endpoint returns the grouped structure (server-side fold), not raw sessions for client-side folding.** Rejected: reusing `/api/snapshot` and grouping in `projects.js`. Server-side folding keeps the grouping logic (key choice, sort, rollups) in one place next to the data model, keeps the payload small, and makes the grouping independently testable via the endpoint. Cost is one small pure function.
- **No new persisted summary field.** Rejected: deriving a per-project "what happened" blurb from the per-session line store (`sessionLines`, 140-char snippets, `collector.ts:132`, §5). It would require a new cross-session projection, is lossy, and expands scope; "at-a-glance" is limited to fields already on `SessionAgg`.
- **One-shot fetch, no SSE for v1.** Rejected: wiring the Projects page to `/events` for live updates — matches the Stats page's one-shot model and keeps v1 minimal; live refresh can be added later without changing the endpoint contract.
- **Preact+htm frontend (like `stats.js`) over vanilla (like `app.js`).** Either is established; Preact+htm is chosen because the standalone-page template (`stats.html`/`stats.js`) is the closest existing shape for a new self-contained page with a fetch-and-render lifecycle. (If the implementer prefers vanilla, the endpoint contract is unaffected.)

## Out of Scope

- Faithful full-directory identity via on-disk slug / disk scan (deferred — needs a `listJsonlFiles`-based endpoint and its own caching).
- Auto-derived per-project work summaries / AI titles (parser skips those lines; no summary field exists).
- Live (SSE) updating of the Projects page.
- Any change to Dashboard, Observe, Stats, or existing endpoints/data contracts.
- Persistence or new caching layers for the grouping.
- Filtering, search, or pagination on the Projects page (v1 renders the folded list as-is).
