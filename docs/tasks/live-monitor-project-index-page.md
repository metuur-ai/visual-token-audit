# Project-Centric Index Page for live-monitor — Tasks

Locked source of truth: `docs/ears/live-monitor-project-index-page.md` + `docs/lld/live-monitor-project-index-page.md`.
All server edits land in the single `collector.ts` `fetch()` router; nav edits touch shared per-page files. Mutex tags reflect that reality.

## Unit 5: Project-identity / grouping semantics

- [x] 5.1 Implement the project-key + display-name derivation helper (est: ~20m)
  - why: Grouping must be deterministic from aggregate-only fields (`SessionAgg` carries `cwd` and a basename `project`, never a full path), so the key/name rules and the accepted basename collision are pinned before any folding runs. This is the semantic core the endpoint depends on.
  - acceptance:
    - R-5.1 — "WHERE a session's `cwd` is a non-empty string, THE SYSTEM SHALL use that `cwd` as the session's project grouping key."
    - R-5.2 — "IF a session's `cwd` is absent or empty, THE SYSTEM SHALL fall back to the session's `project` (basename/slug-tail) as its grouping key."
    - R-5.3 — "THE SYSTEM SHALL place all sessions sharing the same grouping key into the same project record."
    - R-5.4 — "WHEN deriving a project record's display `name`, THE SYSTEM SHALL use the `project` basename of its members as the human-readable label; WHERE that basename is empty, THE SYSTEM SHALL fall back to the literal `\"(unknown)\"`."
    - R-5.5 — "THE SYSTEM SHALL derive grouping keys solely from `SessionAgg.cwd` and `SessionAgg.project` and SHALL NOT perform a disk scan or slug recovery to obtain a fuller directory path."
    - R-5.6 — "WHERE two distinct directories share the same fallback basename, THE SYSTEM SHALL group them under a single project record (an accepted collision)."
    - R-5.7 — "WHERE both a session's `cwd` and `project` are absent or empty, THE SYSTEM SHALL group it under a stable literal key `\"(unknown)\"` and use that literal as the display `name`, rather than an empty key."
  - verify: Unit-level: feed synthetic `SessionAgg` inputs — (a) `cwd` set → key === cwd; (b) `cwd` empty, `project` set → key === project; (c) both empty → key === name === `"(unknown)"`; (d) two members with same basename, different real dirs → one record. Confirm no disk/`fs` call is introduced in the helper (grep the new code for `readFile`/`listJsonlFiles`).

## Unit 1: Grouped projects API endpoint (`GET /api/projects`)

- [x] 1.1 Add the `/api/projects` fold-and-serve endpoint block (deps: 5.1, est: ~40m) (mutex: collector-router)
  - why: Give the frontend a single read-only, zero-cost source that folds `sessions.values()` into project-grouped records with correct rollups/sorts, so the UI never re-implements grouping or touches existing endpoints. This is the data foundation the whole page hangs on; grouping semantics (Unit 5) attach here.
  - acceptance:
    - R-1.1 — "WHEN a `GET /api/projects` request is received, THE SYSTEM SHALL respond with HTTP 200 and `Content-Type: application/json; charset=utf-8`."
    - R-1.2 — "WHEN building the `/api/projects` response, THE SYSTEM SHALL fold `sessions.values()` from the in-memory `sessions` map into one project record per distinct project key, producing exactly the set of distinct keys present across those sessions."
    - R-1.3 — "THE SYSTEM SHALL include in each project record: the grouping `key`, a display `name`, a `cwd` full-path subtitle, `firstActivity`, `lastActivity`, `sessionCount`, rolled-up metadata (summed `prompts`, summed `usage`, top tools), and a `sessions` array. No field in this record is optional."
    - R-1.4 — "WHEN computing a project record's `lastActivity`, THE SYSTEM SHALL set it to the maximum `lastTs` among that project's member sessions."
    - R-1.5 — "WHEN computing a project record's `sessionCount`, THE SYSTEM SHALL set it to the number of member sessions in that group."
    - R-1.6 — "THE SYSTEM SHALL order the `projects` array by `lastActivity` descending; WHERE two projects have equal `lastActivity`, THE SYSTEM SHALL order them by group `key` ascending."
    - R-1.7 — "THE SYSTEM SHALL order each project record's `sessions` array by member `lastTs` descending; WHERE two sessions have equal `lastTs`, THE SYSTEM SHALL order them by `sessionId` ascending."
    - R-1.8 — "THE SYSTEM SHALL include for each entry in a project's `sessions` array at least `sessionId`, `lastTs`, `prompts`, and `usage`, sourced from the corresponding `SessionAgg` fields."
    - R-1.9 — "WHEN handling `GET /api/projects`, THE SYSTEM SHALL NOT read files from disk and SHALL derive the response solely from the in-memory `sessions` map."
    - R-1.10 — "IF the in-memory `sessions` map is empty, THE SYSTEM SHALL respond with HTTP 200 and an empty `projects` array (not an error)."
    - R-1.16 — "THE SYSTEM SHALL derive projects only from sessions currently present in the in-memory `sessions` map; projects whose sessions are not in memory SHALL NOT appear."
  - verify: With a seeded in-memory `sessions` map: `GET /api/projects` returns 200 + `application/json; charset=utf-8`; distinct-key count equals distinct keys in the map; each record has all R-1.3 fields present (none undefined); `lastActivity` === max member `lastTs`; `sessionCount` === group length; projects sorted by `lastActivity` desc then `key` asc; sessions sorted by `lastTs` desc then `sessionId` asc, each carrying `sessionId/lastTs/prompts/usage`. Empty map → `{projects:[]}` with 200. Confirm handler makes no `fs` read.

- [x] 1.2 Pin the response envelope, ISO timestamps, usage/top-tools shape, and parameterless contract (deps: 1.1, est: ~20m) (mutex: collector-router)
  - why: The wire contract the frontend codes against must be exact — the `{projects, startedAt}` envelope, field-wise `usage` sums (a naive object `+` is a bug), `{name,count}` top-tools capped/tie-broken, ISO-8601 timestamps identical to source, and query-string invariance. These pin the same endpoint block from 1.1 and belong with it.
  - acceptance:
    - R-1.12 — "THE SYSTEM SHALL return a top-level object `{ projects: ProjectRecord[], startedAt: string }` where `startedAt` equals the value returned by `/api/snapshot`."
    - R-1.13 — "THE SYSTEM SHALL encode `lastActivity` (and any per-session `firstTs`/`lastTs`) as ISO-8601 strings identical to the source `SessionAgg` timestamp fields."
    - R-1.14 — "THE SYSTEM SHALL encode rolled-up `usage` as an object `{input, output, cacheRead, cacheWrite}` of summed member values, and \"top tools\" as an array of `{name, count}` sorted by `count` descending, capped at 5, ties broken by `name` ascending."
    - R-1.15 — "THE SYSTEM SHALL ignore any query parameters on `GET /api/projects` and SHALL return the same response regardless of query string."
  - verify: Response top level is exactly `{projects, startedAt}` and `startedAt` byte-equals `/api/snapshot`'s `startedAt`. For a group with two members, each of `usage.{input,output,cacheRead,cacheWrite}` equals the per-field sum (assert independently, not object-add). `topTools` is `{name,count}[]`, ≤5, sorted count desc / name asc. All timestamp fields are strings identical to source `SessionAgg`. `GET /api/projects?days=1&x=2` byte-equals `GET /api/projects`.

- [x] 1.3 Prove existing endpoints are byte-for-byte unchanged by the addition (deps: 1.1, 1.2, est: ~20m)
  - why: The whole design is "four additive touch-points, no existing path changes behavior." This is the regression guard that makes that claim true rather than asserted — without it the additive promise is untested.
  - acceptance:
    - R-1.11 — "THE SYSTEM SHALL NOT alter the response of `/api/snapshot`, `/api/stats`, `/api/session/:id`, `/api/observe/:id`, or `/events` as a result of adding `/api/projects`."
  - verify: On a fixed seeded `sessions` fixture, capture raw response bytes of `GET /api/snapshot`, `GET /api/stats?days=1`, `GET /api/session/:id`, `GET /api/observe/:id` before the change; capture again after adding `/api/projects` on the same fixture; assert byte-for-byte equality (per LLD Verification).

## Unit 2: Static serving of the new page and assets

- [x] 2.1 Add `/projects`, `/projects.html`, `/projects.js` static route blocks with 503-when-missing and dual-runtime start (deps: 1.1, est: ~20m) (mutex: collector-router)
  - why: Serve the new page through the existing `serveStatic` pattern so it degrades gracefully before a build (503 "UI not built yet", not 404/crash) and adds zero runtime dependency, working identically under Bun and Node. Adds routes but no data, so it can land right after the endpoint.
  - acceptance:
    - R-2.1 — "WHEN a `GET /projects` or `GET /projects.html` request is received, THE SYSTEM SHALL serve `public/projects.html` with `Content-Type: text/html; charset=utf-8`."
    - R-2.2 — "WHEN a `GET /projects.js` request is received, THE SYSTEM SHALL serve `public/projects.js` with `Content-Type: text/javascript; charset=utf-8`."
    - R-2.3 — "IF the requested static file (`projects.html` or `projects.js`) is missing from `PUBLIC_DIR`, THE SYSTEM SHALL respond with HTTP 503 and the \"UI not built yet\" placeholder rather than 404 or an error."
    - R-2.4 — "THE SYSTEM SHALL serve the new page routes without adding any third-party dependency and SHALL start and serve identically under both Bun and Node runtimes."
  - verify: With the files present, `GET /projects` and `GET /projects.html` → 200 `text/html; charset=utf-8`; `GET /projects.js` → 200 `text/javascript; charset=utf-8`. Temporarily remove the files → those routes return 503 with the "UI not built yet" body (not 404). Start via `bun collector.ts` and via Node; in both, `GET /api/projects` returns 200 `application/json; charset=utf-8`. Confirm no package added.

## Unit 4: Projects index UI (grouping, sort, session list, deep-links)

- [ ] 4.1 Build `public/projects.html` + `public/projects.js` to fetch and render the index with session deep-links (deps: 1.1, 1.2, 2.1, est: ~50m)
  - why: Present the folded data as a scannable, recency-ordered index and let the user jump from a project straight to a session's Observer view — the core rediscovery workflow this feature exists for. Consumes the endpoint contract pinned in 1.1/1.2 and is served by 2.1.
  - acceptance:
    - R-4.1 — "WHEN the Projects page loads, THE SYSTEM SHALL fetch `/api/projects` and render one visible entry per project record in the returned order."
    - R-4.2 — "THE SYSTEM SHALL display, for each project entry, its `name`, most-recent-activity date, and total session count."
    - R-4.3 — "THE SYSTEM SHALL display, for each project entry, at-a-glance rolled-up metadata (at minimum summed prompts and token usage)."
    - R-4.4 — "THE SYSTEM SHALL render each project's sessions newest-first, preserving the order supplied by `/api/projects`."
    - R-4.5 — "WHEN the user activates a session entry on the Projects page, THE SYSTEM SHALL navigate to `/observe?session=<sessionId>` with the session id URL-encoded, using the `sessionId` guaranteed by R-1.8."
    - R-4.6 — "THE SYSTEM SHALL NOT modify the Observer page or its `?session=` URL contract; the Projects page SHALL only link into it."
    - R-4.7 — "IF `/api/projects` returns an empty `projects` array, THE SYSTEM SHALL render an empty-state message and SHALL NOT error."
    - R-4.8 — "THE SYSTEM SHALL apply the page's own inline theme and layout conventions (inline `:root` variables, sticky header, panel/table idioms) consistent with the existing pages."
  - verify: Load `/projects` in a browser against a seeded server: one entry per project in endpoint order; each shows name + formatted most-recent date + session count + summed prompts/usage; sessions listed newest-first matching the endpoint order; clicking a session navigates to `/observe?session=<encoded id>` (verify `encodeURIComponent`, matching `app.js:206-215`). Point at an empty map → empty-state message renders, no console error. Confirm no edits to `observe.js`'s `?session=` handling. Visual check: inline `:root` vars + sticky header + panel/table idioms match existing pages.

## Unit 3: Header nav integration across all pages

- [ ] 3.1 Add the "Projects" nav link across all four pages with correct active-marking (deps: 4.1, est: ~25m) (mutex: nav-shared-files)
  - why: Make the Projects page discoverable from every page and keep the hand-duplicated nav consistent — identical link set/hrefs across pages, differing only in which single link is `class="on"`. Done last so the target page exists and each nav points at a real route; edits `index.html`, `observe.js`, `stats.js`, and the new `projects.js` nav.
  - acceptance:
    - R-3.1 — "THE SYSTEM SHALL render a \"Projects\" nav link pointing to `/projects` in the header nav of the Dashboard, Observe, Stats, and Projects pages."
    - R-3.2 — "WHERE the current page is the Projects page, THE SYSTEM SHALL mark the \"Projects\" nav link with `class=\"on\"`."
    - R-3.3 — "WHERE the current page is Dashboard, Observe, or Stats, THE SYSTEM SHALL NOT mark the \"Projects\" nav link with `class=\"on\"` and SHALL keep that page's own active-link marking unchanged."
    - R-3.4 — "THE SYSTEM SHALL preserve the existing Dashboard, Observe, and Stats nav links unchanged when adding the Projects link."
    - R-3.5 — "THE SYSTEM SHALL render the identical set of nav links (`Dashboard`, `Observe`, `Stats`, `Projects`) with identical `href`s across all four pages, differing only in which single link carries `class=\"on\"`."
  - verify: On each of Dashboard, Observe, Stats, Projects, the nav renders exactly the four links `Dashboard/Observe/Stats/Projects` with identical hrefs (`/projects` for the new one). Only the Projects page marks "Projects" as `class="on"`; on the other three "Projects" has no `on` and each retains its own pre-existing active link. Diff each of `index.html`, `observe.js`, `stats.js` to confirm only the added link changed and existing links are untouched.
