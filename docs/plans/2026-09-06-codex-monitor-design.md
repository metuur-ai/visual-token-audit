# Codex usage monitoring

Add Codex rollouts to the existing local monitor. A unified dashboard preserves
the current workflow and permits comparing providers. A separate Codex app would
duplicate the UI and server; an API-backed collector would require credentials
and would not provide the same local transcript history.

A per-file Codex adapter translates metadata, message/tool records, and usage
into the internal transcript shape. Live and historical readers reuse it.
Cumulative usage becomes deltas before date filtering; cached input and reasoning
remain subsets instead of inflating totals. Last-request usage supplies context
occupancy. Namespaced session IDs and explicit provider fields prevent collisions.

The watcher discovers active and archived Codex rollouts alongside Claude files,
retains parsing state over appends, buffers partial records, and preserves offsets
on archive moves. Missing directories fall back to periodic discovery.

UI labels distinguish providers, a dashboard selector filters activity, and
Stats exposes provider totals. Codex billing and Claude harness estimates are
marked unavailable. Codex subagent rollouts are separate sessions for now.

Validation uses synthetic parser fixtures and an isolated localhost server with
both providers, exercising history, duplicate counters, SSE, partial writes, and
archive moves. Existing Claude tests remain regression checks.
