# Projects Static Search — Low-Level Design

## Architecture

### Component map

The change is confined to two files: `live-monitor/public/projects.js` and the inline `<style>` block in `live-monitor/public/projects.html`. No file in `live-monitor/src/` is touched.

```
App  (projects.js:88)
 ├─ state: data, err, stale, days            ← existing
 ├─ state: q                                 ← NEW, ephemeral query string
 ├─ header (projects.js:106-117)
 │    ├─ .seg days selector                  ← existing, unchanged
 │    └─ SearchInput                         ← NEW
 ├─ derive: matches = filter(data.projects, q)   ← NEW, inline at the render seam
 └─ render
      ├─ matches.map(ProjectCard …)          ← was data.projects.map (projects.js:135)
      ├─ "no projects yet"  when !data.projects.length     ← existing (projects.js:129-132)
      └─ "no matches"       when data.projects.length && !matches.length   ← NEW
```

### Data flow

Unidirectional and synchronous. `q` is a plain `useState('')` in `App`. On every keystroke the input's `onInput` sets `q`; Preact re-renders `App`; the filter runs over the in-memory `data.projects` array; `ProjectCard` receives the surviving subset. No effect, no fetch, no timer participates in this path.

The existing `useEffect` at `projects.js:99-104` keeps its `[days]` dependency array. `q` is deliberately **not** added to it — the query must not trigger a refetch or disturb the refresh interval.

### The match function

A single pure helper, defined at module scope alongside the existing `int()` / `fmt()` / `dateLab()` display helpers:

```
matchProject(p, needle) -> { hit: boolean, toolHits: string[] }
```

- `needle` is the query lowercased and trimmed by the caller once per render, not per project.
- `hit` is true when `needle` is a substring of `p.name.toLowerCase()`, of `p.cwd.toLowerCase()`, or of any `t.name.toLowerCase()` for `t` in `p.topTools`.
- `toolHits` collects the matching `topTools[].name` values in their existing order (count desc, ties by name asc, per `src/projects.ts:89`).
- An empty `needle` is short-circuited by the caller — the filter is skipped entirely and `data.projects` is passed through by reference.

### Match-reason badge

`ProjectCard` gains one optional prop, `toolHits: string[]`, defaulting to empty. The badge renders in the collapsed card header region only when **both** conditions hold:

1. `toolHits.length > 0`, and
2. the project did **not** match on `name` or `cwd`.

Condition 2 keeps the badge quiet in the common case. A card that matched because its name matched needs no explanation; a card that matched only because of a tool does. The caller therefore computes a `nameOrCwdHit` flag and passes `toolHits` only when that flag is false.

The badge does not alter the card's `open` state (`projects.js:50`), which remains user-controlled and defaults to `false`.

### Styling

A `.psearch` input rule is added to the inline `<style>` block in `projects.html`, sized and coloured to sit beside the existing `.seg` control (`projects.html:30-33`) — same `1px solid var(--line)` border, same `6px` radius, `10px`–`11px` type, `var(--dim)` placeholder. A `.pmatch` badge rule reuses the muted-chip treatment already used for tool pills. No new stylesheet, no CSS custom properties added.

## Constraints

- **No build step.** `live-monitor/public/` is served as static files; `projects.js` is a native ES module loaded via `<script type="module">` (`projects.html:84`). No JSX, no TypeScript, no bundler. Markup must be written with `htm` tagged templates, matching the existing file.
- **Vendored dependencies only.** Preact and its hooks are imported from `/vendor/hooks.module.js` (`projects.js:6`). No new dependency may be introduced; there is no package manager step for this directory and no CDN access at runtime.
- **Per-page inline CSS.** There is no shared stylesheet. Styles must go in the `projects.html` `<style>` block (`projects.html:7`) and must not be expected to affect other pages.
- **Server contract frozen.** `/api/projects`, `ProjectRecord`, `ProjectsEnvelope`, and the fold/sort logic in `live-monitor/src/projects.ts` are read-only for this change.
- **Match set bounded by the payload.** Only `name`, `cwd`, and `topTools[].name` are in scope. Prompt text and tool arguments are not in the payload at all; `sessions[].sessionId` is present but excluded by decision.
- **Single-user local tool.** No i18n, no accessibility audit beyond a correct label and `type="search"`, no analytics.

## Key Decisions

**Filter at the render seam, not in state.** The filtered list is derived inline at `projects.js:135` rather than stored in a second state atom. Deriving avoids a synchronisation bug class where the 60-second refresh replaces `data` and a cached filtered list goes stale. Rejected: keeping `filteredProjects` in state and syncing it via `useEffect`.

**No debounce.** The dataset is a few dozen objects already in memory; the filter is O(projects × topTools) with `topTools` capped small. Debouncing would add latency and a timer to a path that is already sub-millisecond. Rejected: 150 ms debounce, which is the reflex for search inputs but is only warranted when the query hits the network or a large corpus.

**No memoisation.** For the same reason, `useMemo` is omitted. It would add a dependency array to keep correct against `data` identity changes for no measurable gain.

**Single substring, not multi-term AND.** The query is trimmed and treated as one literal substring. Splitting on whitespace and requiring all terms adds a matching mode the user did not ask for and makes paths containing spaces behave surprisingly. Rejected: multi-term AND, fuzzy/subsequence matching, and regex.

**Case-insensitive via `toLowerCase()` on both sides.** Plain and predictable. `localeCompare` with sensitivity options was rejected as overkill for ASCII paths and tool names.

**Badge is suppressed when the name or cwd already matched.** Showing "matched: Bash" on a card whose name the user just typed is noise. The badge exists to explain non-obvious matches only.

**Session ids excluded from the match set.** They are in memory, and matching them would let a pasted id jump to its project. Excluded because a 36-character opaque id contributes nothing to incremental typing and would produce confusing partial-hex matches on short queries.

**Cards stay collapsed on match.** Auto-expanding matching cards was considered and rejected: it would override the user's manual open/closed state and cause the list to jump in height on every keystroke. The badge carries the explanatory load instead.

**Ephemeral query.** `q` lives only in component state. No URL param, so no interaction with the existing `days` query-string handling and no history-entry churn while typing. The filtered view is consequently not linkable — an accepted cost.

**The stagger index is computed post-filter.** `delay=${Math.min(i, 8) * 40}` at `projects.js:135` will index into the filtered array. Because `key=${p.key}` preserves node identity across re-renders, Preact reuses existing DOM nodes and the mount-time fade animation does not re-fire per keystroke. Cards entering the list for the first time animate with a delay derived from their new position, which is the desired behaviour.

**Accepted limitation — `cwd` has low discriminating power.** Every project path on the target machine shares a long common prefix (`/Users/<user>/…`), so single-character and short queries match every project via `cwd`. Matching against the path tail only, or dropping `cwd` from the match set, was considered and **rejected**: full-path matching is what was asked for, and the alternative would make a project findable by name but not by the path the user can see on the card. The consequence — the filter appears inert for the first one to three characters — is knowingly accepted.

**Accepted limitation — tool matching is incomplete by construction.** `topTools()` (`src/projects.ts:88`) ends `.slice(0, 5)`, so the payload carries only each project's five most-used tools, with tools and skills merged into one frequency map. A project that used a tool rarely has no entry for it and will not match on it. Widening the payload was rejected as out of scope (it would change the server contract). The incompleteness is instead made visible through the input's label per R-2.12, so the result set is never silently misread as exhaustive.

**Defensive field access is mandatory, not optional.** `p.cwd` is guarded at `projects.js:56` and `p.topTools` at `projects.js:65`, confirming both are legitimately absent for some records — `projectGroupKey` (`src/projects.ts:64-68`) falls back to project name and then `(unknown)`. Any unguarded `.toLowerCase()` in the match path throws during render and unmounts the whole tree. R-2.9 through R-2.11 make this explicit.

**Fade suppression while filtering.** Filtering unmounts non-matching cards, so widening a query remounts them and re-triggers the `fade` class animation at `projects.js:52` with its staggered `animation-delay`. Key-preserved identity protects only cards that stayed mounted. R-4.6 therefore suppresses the animation while a query is active rather than relying on identity alone.

**Two distinct empty states.** The existing branch at `projects.js:129-132` keys off `!data.projects.length` and means "the server returned nothing for this window". A new branch keys off `data.projects.length && !matches.length` and means "nothing matches your query". Collapsing them into one message would tell the user their data is missing when it is merely filtered.

## Out of Scope

- Extracting a reusable search component for `/observe` or `/stats`.
- Any relevance ranking or re-ordering of results.
- Highlighting the matched substring within the rendered name or path.
- A keyboard shortcut to focus the input.
- Searching within a single project's expanded session table.
- Server-side search, indexing, or a new endpoint.
- Persisting the query across reloads or sharing filtered views by URL.
