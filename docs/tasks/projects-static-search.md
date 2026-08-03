# Projects Static Search — Tasks

Locked source of truth: `docs/ears/projects-static-search.md` + `docs/lld/projects-static-search.md`.

Scope is two files: `live-monitor/public/projects.js` and the inline `<style>` block of `live-monitor/public/projects.html`. Nothing under `live-monitor/src/` is touched. Because almost every story edits the same 139-line module, most carry `(mutex: projects-js)` and run sequentially — that is the honest shape of this work, not a planning artifact.

Verification harness is `agent-browser` against a running collector on `http://127.0.0.1:8722/projects` (port from `live-monitor/src/config.ts:11`). `live-monitor/public/*.js` has no DOM test setup and this change does not add one; every acceptance check below is an observed browser assertion, not a unit test.

Graph check: `graphify query "what depends on live-monitor/public/projects.js"` returns only server-side and doc nodes — no module imports this file; it is a browser-loaded leaf. `live-monitor/CONTRACT.md` contains no reference to `projects.html`, `projects.js`, search, or filter, so no contract doc update is required. `[graph]`

## Unit 2: Match predicate

- [ ] 1.1 Implement the null-safe `matchProject` helper (est: ~25m) (mutex: projects-js)
  - why: The predicate is the semantic core every other story hangs off, and it is the one place a crash can take down the whole page. `p.cwd` is guarded at `projects.js:56` and `p.topTools` at `projects.js:65`, proving both are legitimately absent — an unguarded `.toLowerCase()` here throws inside render and unmounts the tree. Pin the matching rules and the null-safety before any UI exists to call them.
  - acceptance:
    - R-2.1 — "THE SYSTEM SHALL treat the query as a single literal substring after trimming leading and trailing whitespace."
    - R-2.2 — "THE SYSTEM SHALL perform matching case-insensitively in both directions, such that a query of `FOYER` and a query of `foyer` produce identical results."
    - R-2.3 — "THE SYSTEM SHALL consider a project a match IF the trimmed lowercased query is a substring of the project's `name`, OR a substring of the project's `cwd`, OR a substring of any entry in the project's `topTools[].name`."
    - R-2.4 — "THE SYSTEM SHALL NOT match against `sessions[].sessionId`, `key`, timestamps, or any numeric usage field."
    - R-2.5 — "THE SYSTEM SHALL NOT interpret the query as a regular expression, a glob, or a multi-term expression; whitespace inside the trimmed query SHALL be matched literally."
    - R-2.9 — "IF a project record has an absent, empty, or non-string `cwd`, THE SYSTEM SHALL match it on its remaining fields and SHALL NOT raise an error."
    - R-2.10 — "IF a project record has an absent or empty `topTools` array, THE SYSTEM SHALL match it on its remaining fields and SHALL NOT raise an error."
    - R-2.11 — "THE SYSTEM SHALL NOT allow a malformed or partial project record to interrupt rendering of the remaining project cards."
    - R-2.12 (matching half) — "WHERE tool matching is performed, THE SYSTEM SHALL match only against the top-5 `topTools` entries present in the payload."
  - verify: Helper returns `{hit, toolHits}`. Exercise from the browser console via `agent-browser` with synthetic records: (a) `{name:'foyer'}` + query `FOYER` → hit; (b) `{cwd:'/x/y'}` + query `/X/` → hit; (c) `{topTools:[{name:'Bash'}]}` + query `bash` → hit with `toolHits:['Bash']`; (d) record with **no** `cwd` key → no throw, still matchable by name; (e) record with **no** `topTools` key → no throw; (f) query `.*` against name `abc` → no hit (literal, not regex); (g) query `  foyer  ` → same result as `foyer`; (h) query matching a sessionId substring → no hit. Confirm no `sessions` access in the helper body.
  - landed:

## Unit 1: Search input control

- [ ] 2.1 Add the header search input, query state, and its styling (deps: 1.1, est: ~25m) (mutex: projects-js, projects-html-style)
  - why: Give the user the place to type, wired to ephemeral state that cannot leak into the URL or storage. The label must also carry the top-5 tool caveat, because a search that silently returns a subset of tool matches reads as broken rather than bounded.
  - acceptance:
    - R-1.1 — "THE SYSTEM SHALL render a single text input in the `/projects` page header, adjacent to the existing `days` segmented selector."
    - R-1.2 — "THE SYSTEM SHALL render the input with `type=\"search\"` and an accessible label or `aria-label` identifying it as project search."
    - R-1.3 — "THE SYSTEM SHALL display placeholder text in the input while the query is empty."
    - R-1.4 — "WHEN the user types in the input, THE SYSTEM SHALL update the query state on every input event without waiting for a debounce interval, a blur, or an Enter keypress."
    - R-1.5 — "WHILE the query is non-empty, THE SYSTEM SHALL display the query text in the input."
    - R-1.6 — "THE SYSTEM SHALL hold the query in component state only, and SHALL NOT write it to the URL, `sessionStorage`, or `localStorage`."
    - R-1.7 — "WHEN the input is present in the header, THE SYSTEM SHALL leave the existing `days` selector rendered, functional, and unchanged in behaviour."
    - R-1.8 — "THE SYSTEM SHALL style the input within the existing inline `<style>` block of `projects.html`, and SHALL NOT introduce a new stylesheet, external font, or CSS dependency."
    - R-2.12 (label half) — "the input's accessible label SHALL indicate that tool matching covers each project's top tools rather than its full tool history."
  - verify: `agent-browser open http://127.0.0.1:8722/projects`; `snapshot` shows a searchbox in the header with a non-empty accessible name mentioning top tools; `agent-browser type` a 4-char query and assert `get value` matches after each character (no debounce delay needed); `get url` unchanged — no `?q=`; evaluate `sessionStorage.length` and `localStorage.length` before and after typing, both unchanged; click each `days` button and confirm the selector still switches and refetches; `grep -c 'stylesheet\|<link' projects.html` still 0.
  - landed:

## Unit 4: Result states

- [ ] 3.1 Wire the filter at the render seam and split the two empty states (deps: 1.1, 2.1, est: ~25m) (mutex: projects-js)
  - why: This is the story that makes the feature real — deriving the filtered list during render rather than storing it, so it can never diverge from the most recently fetched data. The two empty states must read differently: telling the user their projects are gone when they are merely filtered out destroys trust in the page.
  - acceptance:
    - R-2.6 — "IF the trimmed query is empty, THE SYSTEM SHALL render every project returned for the current window, in the order the server supplied."
    - R-2.7 — "THE SYSTEM SHALL preserve the server-supplied ordering of matching projects and SHALL NOT re-rank them by relevance or any other criterion."
    - R-2.8 — "WHILE a query is active, THE SYSTEM SHALL NOT issue any network request as a consequence of the query."
    - R-4.1 — "IF the server returned no projects for the selected window, THE SYSTEM SHALL display the existing \"no projects yet\" state, irrespective of the query."
    - R-4.2 — "IF the server returned at least one project AND no project matches the query, THE SYSTEM SHALL display a distinct \"no matches\" message that is not the \"no projects yet\" message."
    - R-4.3 — "WHEN the \"no matches\" state is displayed, THE SYSTEM SHALL keep the search input rendered, focused-capable, and populated with the current query."
    - R-4.4 — "WHEN the user clears the query, THE SYSTEM SHALL restore the full project list for the current window, in the server-supplied order, without issuing a fetch."
    - R-4.5 — "THE SYSTEM SHALL continue to display the existing error and stale-data banners according to their current rules, independently of the query."
    - R-5.4 — "THE SYSTEM SHALL derive the filtered list during render rather than storing it in state, so that the rendered list cannot diverge from the most recently received data."
  - verify: Record card names+order with empty query (`agent-browser get text` over `.pname`, `count` of `.pcard`); type a fragment → card count drops, surviving names are a subsequence of the original order; clear → list and order identical to the recorded baseline. Type a nonsense query → `.pcard` count 0 and the "no matches" text visible and textually different from the "no projects yet" copy; input still holds the query and `is enabled` true. `agent-browser network requests` across the whole typing session shows zero new `/api/projects` calls. Confirm no `useState` holding a filtered array was added.
  - landed:

## Unit 3: Match-reason badge

- [ ] 4.1 Add the tool-only match-reason badge (deps: 3.1, est: ~20m) (mutex: projects-js, projects-html-style)
  - why: A card can match on a tool name that is invisible while collapsed (`projects.js:65` only renders `topTools` when open), so without an explanation the user sees an apparently unrelated project and distrusts the filter. The badge is scoped to exactly that case — on a card whose name the user just typed it would be pure noise.
  - acceptance:
    - R-3.1 — "IF a project matches the query on `topTools[].name` AND does not match on `name` or `cwd`, THE SYSTEM SHALL display on that project's card the tool name or names that matched."
    - R-3.2 — "IF a project matches the query on `name` or `cwd`, THE SYSTEM SHALL NOT display the match-reason badge on that project's card, regardless of whether a tool also matched."
    - R-3.3 — "IF the trimmed query is empty, THE SYSTEM SHALL NOT display the match-reason badge on any card."
    - R-3.4 — "WHERE more than one tool name matches a single project, THE SYSTEM SHALL list the matching tool names in their existing server-supplied order."
    - R-3.5 — "WHEN a match-reason badge is displayed, THE SYSTEM SHALL leave the card's expanded/collapsed state unchanged and SHALL NOT auto-expand the card."
    - R-3.6 — "THE SYSTEM SHALL preserve each card's user-controlled expand/collapse behaviour while a query is active."
  - verify: Query a tool name that is not a substring of any project name or path → matching cards show the badge naming that tool. Query a project name that also appears in its tools → that card shows **no** badge. Empty query → `count` of the badge selector is 0. Assert `.pcard.open` count is 0 immediately after typing (no auto-expand), then click a `.phead` and confirm it still toggles open and closed with the query still active.
  - landed:

- [ ] 4.2 Suppress the mount fade while a query is active (deps: 3.1, est: ~10m) (mutex: projects-js, projects-html-style)
  - why: Filtering unmounts non-matching cards, so widening or clearing a query remounts them and re-triggers the `fade` class animation at `projects.js:52` with its `Math.min(i,8)*40`ms stagger — the whole list strobes on every backspace. Key-preserved identity protects only cards that stayed mounted, so identity alone does not fix this.
  - acceptance:
    - R-4.6 — "WHILE the trimmed query is non-empty, THE SYSTEM SHALL suppress the card mount fade-in animation, so that cards re-entering the list as the query narrows or widens appear without re-triggering the staggered fade."
    - R-4.7 — "WHEN the query returns to empty, THE SYSTEM SHALL restore the existing mount fade-in behaviour for subsequent renders."
  - verify: With a query active, evaluate `getComputedStyle` on a `.pcard` and confirm no running `animation-name` (or that the `fade` class is absent); type and backspace repeatedly and confirm cards do not re-animate; reload with an empty query and confirm the original staggered fade still plays on first paint.
  - landed:

## Unit 5: Interaction with refresh and window selection

- [ ] 5.1 Confirm query retention across the 60s refresh and `days` changes (deps: 3.1, est: ~15m) (mutex: projects-js)
  - why: The page refetches on a timer (`REFRESH_MS = 60000`, `projects.js:11`) and on window change. A filter that silently resets, or that adds `q` to the effect's `[days]` dependency array and thereby tears down and restarts the refresh interval on every keystroke, would be worse than no filter at all.
  - acceptance:
    - R-5.1 — "WHEN the 60-second background refresh replaces the project data, THE SYSTEM SHALL retain the active query and SHALL apply it to the newly received data."
    - R-5.2 — "WHEN the user changes the `days` window while a query is active, THE SYSTEM SHALL refetch for the new window, retain the query, and apply it to the new result set."
    - R-5.3 — "WHEN the query changes, THE SYSTEM SHALL NOT trigger a fetch, SHALL NOT cancel the refresh interval, and SHALL NOT restart the refresh interval."
    - R-5.5 — "WHILE a query is active and a refresh is in flight, THE SYSTEM SHALL continue displaying the filtered previous data rather than clearing the list."
  - verify: Read `projects.js` and confirm the `useEffect` dependency array is still exactly `[days]` and that `q` appears nowhere in it. Type a query, wait past one refresh cycle, confirm `get value` still holds the query and the filtered `.pcard` count is unchanged. With a query active, click a different `days` button and confirm exactly one new `/api/projects` request fires, the query persists in the input, and the new result set is filtered. Confirm the card list is never momentarily empty mid-refresh.
  - landed:

## Unit 6: Non-regression invariants

- [ ] 6.1 Non-regression sweep across scope, dependencies, and sibling pages (deps: 4.1, 4.2, 5.1, est: ~15m)
  - why: This is a surgical addition to a working page. These checks are what stop "the search works" being claimed while something else quietly broke — a stray import, a remount storm, or a sibling page picking up a style change.
  - acceptance:
    - R-6.1 — "THE SYSTEM SHALL leave `/api/projects` and all modules under `live-monitor/src/` unmodified."
    - R-6.2 — "THE SYSTEM SHALL leave the `/observe`, `/stats`, and root pages unmodified."
    - R-6.3 — "THE SYSTEM SHALL introduce no new runtime dependency and SHALL import only from the existing vendored module paths."
    - R-6.4 — "THE SYSTEM SHALL keep `projects.js` a valid native ES module requiring no build, transpile, or bundle step."
    - R-6.5 — "THE SYSTEM SHALL preserve each card's existing key-based identity so that filtering reuses DOM nodes rather than remounting unchanged cards."
    - R-6.6 — "THE SYSTEM SHALL preserve the existing card click-through behaviour to session views for all rendered cards."
  - verify: `git diff --stat` touches only `live-monitor/public/projects.js` and `live-monitor/public/projects.html`. `grep '^import' live-monitor/public/projects.js` shows only the pre-existing `/vendor/` paths. Load `/observe`, `/stats`, and `/` via `agent-browser` and confirm `console` is error-free and their layouts are unchanged. On `/projects`, tag a card's DOM node via `agent-browser evaluate`, type a query that keeps it visible, and confirm the same node object persists (no remount). Click a card row and confirm it still navigates to the session view. `agent-browser console` clean across the whole session.
  - landed:
```

## Dependency graph

```
1.1 matchProject helper  (foundation — pure, null-safe)
 │
 ├── 2.1 input + query state + CSS
 │     │
 └─────┴── 3.1 render seam + two empty states
            │
            ├── 4.1 match-reason badge
            ├── 4.2 fade suppression
            └── 5.1 refresh / days retention
                  │
                  └── 6.1 non-regression sweep
```

## Checkpoint: after 3.1

- [ ] Typing narrows the list and clearing restores it exactly
- [ ] Zero network requests fired by typing
- [ ] "no matches" and "no projects yet" are distinguishable on screen
- [ ] No crash on a project lacking `cwd` or `topTools`
- [ ] Review with human before proceeding to 4.x

## Notes

- Private technical breakdown belongs in `.devlocal/<user>/<story-id>/scratchpad.md`, not here.
- Stories 2.1, 4.1, and 4.2 carry `(mutex: projects-html-style)` because each appends to the same inline `<style>` block; they cannot run concurrently with one another.
- No `docs/ubiquitous-language.md` exists in this repo. Terms used here (`project record`, `match-reason badge`, `render seam`) are drawn from the LLD; if a glossary is later introduced, `match-reason badge` and `render seam` are the two candidates for canonical entry.
