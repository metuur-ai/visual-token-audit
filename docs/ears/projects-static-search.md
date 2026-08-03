# Projects Static Search — EARS Specifications

Scope: `live-monitor/public/projects.js` and the inline `<style>` block of `live-monitor/public/projects.html`. Nothing under `live-monitor/src/` is in scope.

## Unit 1: Search input control

**Why:** The user needs a place to type. It must sit where the page's other control already lives, be obviously a search field, and never be mistaken for something that reloads the page.

| ID    | EARS statement |
| ----- | -------------- |
| R-1.1 | THE SYSTEM SHALL render a single text input in the `/projects` page header, adjacent to the existing `days` segmented selector. |
| R-1.2 | THE SYSTEM SHALL render the input with `type="search"` and an accessible label or `aria-label` identifying it as project search. |
| R-1.3 | THE SYSTEM SHALL display placeholder text in the input while the query is empty. |
| R-1.4 | WHEN the user types in the input, THE SYSTEM SHALL update the query state on every input event without waiting for a debounce interval, a blur, or an Enter keypress. |
| R-1.5 | WHILE the query is non-empty, THE SYSTEM SHALL display the query text in the input. |
| R-1.6 | THE SYSTEM SHALL hold the query in component state only, and SHALL NOT write it to the URL, `sessionStorage`, or `localStorage`. |
| R-1.7 | WHEN the input is present in the header, THE SYSTEM SHALL leave the existing `days` selector rendered, functional, and unchanged in behaviour. |
| R-1.8 | THE SYSTEM SHALL style the input within the existing inline `<style>` block of `projects.html`, and SHALL NOT introduce a new stylesheet, external font, or CSS dependency. |

## Unit 2: Match predicate

**Why:** The filter defines what "matching" means. It must be predictable enough that the user can guess what a query will do before pressing a key, and it must not silently reach for data the user did not expect to be searched.

| ID    | EARS statement |
| ----- | -------------- |
| R-2.1 | THE SYSTEM SHALL treat the query as a single literal substring after trimming leading and trailing whitespace. |
| R-2.2 | THE SYSTEM SHALL perform matching case-insensitively in both directions, such that a query of `FOYER` and a query of `foyer` produce identical results. |
| R-2.3 | THE SYSTEM SHALL consider a project a match IF the trimmed lowercased query is a substring of the project's `name`, OR a substring of the project's `cwd`, OR a substring of any entry in the project's `topTools[].name`. |
| R-2.4 | THE SYSTEM SHALL NOT match against `sessions[].sessionId`, `key`, timestamps, or any numeric usage field. |
| R-2.5 | THE SYSTEM SHALL NOT interpret the query as a regular expression, a glob, or a multi-term expression; whitespace inside the trimmed query SHALL be matched literally. |
| R-2.6 | IF the trimmed query is empty, THE SYSTEM SHALL render every project returned for the current window, in the order the server supplied. |
| R-2.7 | THE SYSTEM SHALL preserve the server-supplied ordering of matching projects and SHALL NOT re-rank them by relevance or any other criterion. |
| R-2.8 | WHILE a query is active, THE SYSTEM SHALL NOT issue any network request as a consequence of the query. |
| R-2.9 | IF a project record has an absent, empty, or non-string `cwd`, THE SYSTEM SHALL match it on its remaining fields and SHALL NOT raise an error. |
| R-2.10 | IF a project record has an absent or empty `topTools` array, THE SYSTEM SHALL match it on its remaining fields and SHALL NOT raise an error. |
| R-2.11 | THE SYSTEM SHALL NOT allow a malformed or partial project record to interrupt rendering of the remaining project cards. |
| R-2.12 | WHERE tool matching is performed, THE SYSTEM SHALL match only against the top-5 `topTools` entries present in the payload, and the input's accessible label SHALL indicate that tool matching covers each project's top tools rather than its full tool history. |

## Unit 3: Match-reason badge

**Why:** A card can match on a tool name that is invisible while the card is collapsed. Without an explanation the user sees an apparently unrelated project in their results and loses trust in the filter. The badge exists only for that case — everywhere else it would be noise.

| ID    | EARS statement |
| ----- | -------------- |
| R-3.1 | IF a project matches the query on `topTools[].name` AND does not match on `name` or `cwd`, THE SYSTEM SHALL display on that project's card the tool name or names that matched. |
| R-3.2 | IF a project matches the query on `name` or `cwd`, THE SYSTEM SHALL NOT display the match-reason badge on that project's card, regardless of whether a tool also matched. |
| R-3.3 | IF the trimmed query is empty, THE SYSTEM SHALL NOT display the match-reason badge on any card. |
| R-3.4 | WHERE more than one tool name matches a single project, THE SYSTEM SHALL list the matching tool names in their existing server-supplied order. |
| R-3.5 | WHEN a match-reason badge is displayed, THE SYSTEM SHALL leave the card's expanded/collapsed state unchanged and SHALL NOT auto-expand the card. |
| R-3.6 | THE SYSTEM SHALL preserve each card's user-controlled expand/collapse behaviour while a query is active. |

## Unit 4: Result states

**Why:** An empty region is ambiguous — the user cannot tell whether their data is gone or merely filtered out. The two conditions have different causes and different remedies, so they must read differently.

| ID    | EARS statement |
| ----- | -------------- |
| R-4.1 | IF the server returned no projects for the selected window, THE SYSTEM SHALL display the existing "no projects yet" state, irrespective of the query. |
| R-4.2 | IF the server returned at least one project AND no project matches the query, THE SYSTEM SHALL display a distinct "no matches" message that is not the "no projects yet" message. |
| R-4.3 | WHEN the "no matches" state is displayed, THE SYSTEM SHALL keep the search input rendered, focused-capable, and populated with the current query. |
| R-4.4 | WHEN the user clears the query, THE SYSTEM SHALL restore the full project list for the current window, in the server-supplied order, without issuing a fetch. |
| R-4.5 | THE SYSTEM SHALL continue to display the existing error and stale-data banners according to their current rules, independently of the query. |
| R-4.6 | WHILE the trimmed query is non-empty, THE SYSTEM SHALL suppress the card mount fade-in animation, so that cards re-entering the list as the query narrows or widens appear without re-triggering the staggered fade. |
| R-4.7 | WHEN the query returns to empty, THE SYSTEM SHALL restore the existing mount fade-in behaviour for subsequent renders. |

## Unit 5: Interaction with refresh and window selection

**Why:** The page refetches on a timer and on window change. A filter that silently resets, or that disturbs the refresh loop, would be worse than no filter at all.

| ID    | EARS statement |
| ----- | -------------- |
| R-5.1 | WHEN the 60-second background refresh replaces the project data, THE SYSTEM SHALL retain the active query and SHALL apply it to the newly received data. |
| R-5.2 | WHEN the user changes the `days` window while a query is active, THE SYSTEM SHALL refetch for the new window, retain the query, and apply it to the new result set. |
| R-5.3 | WHEN the query changes, THE SYSTEM SHALL NOT trigger a fetch, SHALL NOT cancel the refresh interval, and SHALL NOT restart the refresh interval. |
| R-5.4 | THE SYSTEM SHALL derive the filtered list during render rather than storing it in state, so that the rendered list cannot diverge from the most recently received data. |
| R-5.5 | WHILE a query is active and a refresh is in flight, THE SYSTEM SHALL continue displaying the filtered previous data rather than clearing the list. |

## Unit 6: Non-regression invariants

**Why:** This is a surgical addition to a working page. These state what must remain true so that "the search works" cannot be claimed while something else quietly broke.

| ID    | EARS statement |
| ----- | -------------- |
| R-6.1 | THE SYSTEM SHALL leave `/api/projects` and all modules under `live-monitor/src/` unmodified. |
| R-6.2 | THE SYSTEM SHALL leave the `/observe`, `/stats`, and root pages unmodified. |
| R-6.3 | THE SYSTEM SHALL introduce no new runtime dependency and SHALL import only from the existing vendored module paths. |
| R-6.4 | THE SYSTEM SHALL keep `projects.js` a valid native ES module requiring no build, transpile, or bundle step. |
| R-6.5 | THE SYSTEM SHALL preserve each card's existing key-based identity so that filtering reuses DOM nodes rather than remounting unchanged cards. |
| R-6.6 | THE SYSTEM SHALL preserve the existing card click-through behaviour to session views for all rendered cards. |
