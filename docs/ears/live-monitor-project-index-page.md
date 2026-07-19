# Project-Centric Index Page for live-monitor — EARS Specifications

## Unit 1: Grouped projects API endpoint (`GET /api/projects`)
**Why:** Provide a single read-only, zero-cost source that folds the in-memory session index into a project-grouped structure, so the frontend can render an index without re-implementing grouping or touching existing endpoints.

| ID    | EARS statement |
| ----- | -------------- |
| R-1.1 | WHEN a `GET /api/projects` request is received, THE SYSTEM SHALL respond with HTTP 200 and `Content-Type: application/json; charset=utf-8`. |
| R-1.2 | WHEN building the `/api/projects` response, THE SYSTEM SHALL fold `sessions.values()` from the in-memory `sessions` map into one project record per distinct project key, producing exactly the set of distinct keys present across those sessions. |
| R-1.3 | THE SYSTEM SHALL include in each project record: the grouping `key`, a display `name`, a `cwd` full-path subtitle, `firstActivity`, `lastActivity`, `sessionCount`, rolled-up metadata (summed `prompts`, summed `usage`, top tools), and a `sessions` array. No field in this record is optional. |
| R-1.4 | WHEN computing a project record's `lastActivity`, THE SYSTEM SHALL set it to the maximum `lastTs` among that project's member sessions. |
| R-1.5 | WHEN computing a project record's `sessionCount`, THE SYSTEM SHALL set it to the number of member sessions in that group. |
| R-1.6 | THE SYSTEM SHALL order the `projects` array by `lastActivity` descending (most-recent project first); WHERE two projects have equal `lastActivity`, THE SYSTEM SHALL order them by group `key` ascending. |
| R-1.7 | THE SYSTEM SHALL order each project record's `sessions` array by member `lastTs` descending (newest session first); WHERE two sessions have equal `lastTs`, THE SYSTEM SHALL order them by `sessionId` ascending. |
| R-1.8 | THE SYSTEM SHALL include for each entry in a project's `sessions` array at least `sessionId`, `lastTs`, `prompts`, and `usage`, sourced from the corresponding `SessionAgg` fields. |
| R-1.9 | WHEN handling `GET /api/projects`, THE SYSTEM SHALL NOT read files from disk and SHALL derive the response solely from the in-memory `sessions` map. |
| R-1.10 | IF the in-memory `sessions` map is empty, THE SYSTEM SHALL respond with HTTP 200 and an empty `projects` array (not an error). |
| R-1.11 | THE SYSTEM SHALL NOT alter the response of `/api/snapshot`, `/api/stats`, `/api/session/:id`, `/api/observe/:id`, or `/events` as a result of adding `/api/projects`. (Verify: compare response bytes of `/api/snapshot`, `/api/stats?days=1`, `/api/session/:id`, `/api/observe/:id` before/after the change on a fixed fixture; they must be identical — see LLD Verification.) |
| R-1.12 | THE SYSTEM SHALL return a top-level object `{ projects: ProjectRecord[], startedAt: string }` where `startedAt` equals the value returned by `/api/snapshot`. |
| R-1.13 | THE SYSTEM SHALL encode `lastActivity` (and any per-session `firstTs`/`lastTs`) as ISO-8601 strings identical to the source `SessionAgg` timestamp fields. |
| R-1.14 | THE SYSTEM SHALL encode rolled-up `usage` as an object `{input, output, cacheRead, cacheWrite}` of summed member values, and "top tools" as an array of `{name, count}` sorted by `count` descending, capped at 5, ties broken by `name` ascending. |
| R-1.15 | THE SYSTEM SHALL ignore any query parameters on `GET /api/projects` and SHALL return the same response regardless of query string (the endpoint is parameterless), consistent with `/api/snapshot`. |
| R-1.16 | THE SYSTEM SHALL derive projects only from sessions currently present in the in-memory `sessions` map; projects whose sessions are not in memory (older than the startup seed window, or from before the current process) SHALL NOT appear. |

## Unit 2: Static serving of the new page and assets
**Why:** Serve the new Projects page through the existing `serveStatic` pattern so it degrades gracefully before a build and adds no runtime dependency.

| ID    | EARS statement |
| ----- | -------------- |
| R-2.1 | WHEN a `GET /projects` or `GET /projects.html` request is received, THE SYSTEM SHALL serve `public/projects.html` with `Content-Type: text/html; charset=utf-8`. |
| R-2.2 | WHEN a `GET /projects.js` request is received, THE SYSTEM SHALL serve `public/projects.js` with `Content-Type: text/javascript; charset=utf-8`. |
| R-2.3 | IF the requested static file (`projects.html` or `projects.js`) is missing from `PUBLIC_DIR`, THE SYSTEM SHALL respond with HTTP 503 and the "UI not built yet" placeholder rather than 404 or an error. |
| R-2.4 | THE SYSTEM SHALL serve the new page routes without adding any third-party dependency and SHALL start and serve identically under both Bun and Node runtimes. (Verify: start under both `bun collector.ts` and Node and assert `GET /api/projects` returns HTTP 200 in both — see LLD Verification.) |

## Unit 3: Header nav integration across all pages
**Why:** Make the Projects page discoverable from every page and keep the shared (duplicated) nav consistent, since the header is hand-written per page.

| ID    | EARS statement |
| ----- | -------------- |
| R-3.1 | THE SYSTEM SHALL render a "Projects" nav link pointing to `/projects` in the header nav of the Dashboard, Observe, Stats, and Projects pages. |
| R-3.2 | WHERE the current page is the Projects page, THE SYSTEM SHALL mark the "Projects" nav link with `class="on"`. |
| R-3.3 | WHERE the current page is Dashboard, Observe, or Stats, THE SYSTEM SHALL NOT mark the "Projects" nav link with `class="on"` and SHALL keep that page's own active-link marking unchanged. |
| R-3.4 | THE SYSTEM SHALL preserve the existing Dashboard, Observe, and Stats nav links unchanged when adding the Projects link. |
| R-3.5 | THE SYSTEM SHALL render the identical set of nav links (`Dashboard`, `Observe`, `Stats`, `Projects`) with identical `href`s across all four pages, differing only in which single link carries `class="on"`. |

## Unit 4: Projects index UI (grouping, sort, session list, deep-links)
**Why:** Present the folded data as a scannable, recency-ordered index that lets the user jump from a project to a specific session's Observer view — the core rediscovery workflow.

| ID    | EARS statement |
| ----- | -------------- |
| R-4.1 | WHEN the Projects page loads, THE SYSTEM SHALL fetch `/api/projects` and render one visible entry per project record in the returned order. |
| R-4.2 | THE SYSTEM SHALL display, for each project entry, its `name`, most-recent-activity date, and total session count. |
| R-4.3 | THE SYSTEM SHALL display, for each project entry, at-a-glance rolled-up metadata (at minimum summed prompts and token usage). |
| R-4.4 | THE SYSTEM SHALL render each project's sessions newest-first, preserving the order supplied by `/api/projects`. |
| R-4.5 | WHEN the user activates a session entry on the Projects page, THE SYSTEM SHALL navigate to `/observe?session=<sessionId>` with the session id URL-encoded, using the `sessionId` guaranteed by R-1.8. |
| R-4.6 | THE SYSTEM SHALL NOT modify the Observer page or its `?session=` URL contract; the Projects page SHALL only link into it. |
| R-4.7 | IF `/api/projects` returns an empty `projects` array, THE SYSTEM SHALL render an empty-state message and SHALL NOT error. |
| R-4.8 | THE SYSTEM SHALL apply the page's own inline theme and layout conventions (inline `:root` variables, sticky header, panel/table idioms) consistent with the existing pages. |

## Unit 5: Project-identity / grouping semantics
**Why:** Define exactly how sessions are keyed into projects given that `SessionAgg` carries only a basename/`cwd` (never the full path), so grouping is deterministic and its known collision behavior is explicit.

| ID    | EARS statement |
| ----- | -------------- |
| R-5.1 | WHERE a session's `cwd` is a non-empty string, THE SYSTEM SHALL use that `cwd` as the session's project grouping key. |
| R-5.2 | IF a session's `cwd` is absent or empty, THE SYSTEM SHALL fall back to the session's `project` (basename/slug-tail) as its grouping key. |
| R-5.3 | THE SYSTEM SHALL place all sessions sharing the same grouping key into the same project record. |
| R-5.4 | WHEN deriving a project record's display `name`, THE SYSTEM SHALL use the `project` basename of its members as the human-readable label; WHERE that basename is empty, THE SYSTEM SHALL fall back to the literal `"(unknown)"`. |
| R-5.5 | THE SYSTEM SHALL derive grouping keys solely from `SessionAgg.cwd` and `SessionAgg.project` and SHALL NOT perform a disk scan or slug recovery to obtain a fuller directory path. |
| R-5.6 | WHERE two distinct directories share the same fallback basename, THE SYSTEM SHALL group them under a single project record (an accepted collision), consistent with the aggregate-only identity available. |
| R-5.7 | WHERE both a session's `cwd` and `project` are absent or empty, THE SYSTEM SHALL group it under a stable literal key `"(unknown)"` and use that literal as the display `name`, rather than an empty key. |
