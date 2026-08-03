# Projects Static Search — High-Level Design

## Overview

The live-monitor `/projects` page renders every project active within the selected time window as a vertical stack of cards, ordered by most-recent activity. The only way to narrow that stack today is the `days` window selector, which is a server-side filter — it changes what is fetched, not what is shown. As the number of tracked projects grows, locating a specific project becomes a scroll-and-scan exercise.

This change adds a client-side text search to `/projects`. The entire project payload for the selected window is already in browser memory after a single fetch, so the search requires no new endpoint, no server change, and no network round-trip per keystroke. Typing narrows the visible card list in place; clearing the input restores the full list.

## Stakeholders & Impact

**Primary — the developer using live-monitor locally.** Today: to find one project among dozens, they scroll the card list and read names visually, or narrow the `days` window and hope the project falls inside it. After this ships: they type a fragment of the project name, its path, or a tool it used, and the list narrows immediately.

**Secondary — none.** `/projects` is a leaf page in a single-user local tool. No other service, agent, or hook consumes its DOM or state. The `/api/projects` endpoint is untouched, so any other consumer of that endpoint is unaffected.

## Goals

- A text input in the `/projects` page header narrows the rendered project cards to those matching the typed query.
- Matching considers the project name, its working directory, and the names of tools it used — all data already present client-side.
- Filtering is instantaneous and offline: no fetch is issued in response to typing.
- When a project matches only on data that is not visible on a collapsed card, the card indicates why it matched.
- When a query matches nothing, the page says so distinctly — not silently rendering an empty region, and not falsely claiming no projects exist.
- The search coexists with the existing `days` selector; the two compose (search filters within the fetched window).

## Non-Goals

- **No server-side search.** `/api/projects` and everything in `live-monitor/src/` are unchanged.
- **No search over prompt text or tool arguments.** That content is not in the `/api/projects` payload and fetching it is out of scope.
- **No session-id matching.** Session identifiers are in memory but are deliberately excluded from the match set.
- **No persistence.** The query is not written to the URL, `sessionStorage`, or `localStorage`. It does not survive a page reload and the filtered view is not linkable.
- **No change to other pages.** `/observe`, `/stats`, and the root page keep their existing fixed-enum filters. No shared search component is extracted.
- **No change to ordering.** Server-provided sort order (activity desc, ties by key asc) is preserved through filtering; matches are not re-ranked by relevance.
- **No fuzzy matching, no regex, no query syntax.** Plain case-insensitive substring only.
- **No change to the 60-second auto-refresh cadence** or to what the page fetches.

## Success Criteria

1. Typing a fragment of a project's name into the header input leaves that project's card visible and removes non-matching cards.
2. Typing a fragment of a project's path produces the same narrowing.
3. Typing a tool name surfaces projects that used that tool, and each such card shows which tool matched.
4. Clearing the input restores exactly the card list that was rendered before the query was typed, in the same order.
5. A query matching nothing produces a visible "no matches" message that is distinguishable from the existing "no projects yet" state.
6. No network request is issued while typing — verified by observing the network panel across a multi-character query.
7. The 60-second background refresh continues while a query is active, and the refreshed data is filtered by the still-active query rather than resetting it.
8. Changing the `days` window while a query is active refetches and re-filters, keeping the query applied.
