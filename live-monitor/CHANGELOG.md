# Changelog

## 0.3.0 — 2026-09-07

### Added

- Monitor local Codex sessions alongside Claude Code, including archived rollouts
  and live transcript updates. Filter the dashboard by provider and view usage
  for each provider in Stats.
- Inspect Codex token usage with separate fresh input, cached input, output, and
  reasoning counts, plus context usage and capacity reported by Codex.
- Explore session resource details in Observe: tools, commands, skills, plugins,
  MCP, agents, instructions, and hooks. Expand recorded tool calls to inspect
  inputs, results, and timing.
- View sub-agents within their parent execution tree, with individual token
  totals, model, tool activity, elapsed time, and resource details.
- Inspect guardian/auto-review decisions, rationales, risk levels, authorization
  classifications, and request previews in the Reviews tab.
- Run the monitor in the background with `claude-live-monitor start`, check it
  with `claude-live-monitor status`, and stop it with `claude-live-monitor stop`.
  `start` opens the default browser; `status` prints the local URL and log path.
  Logs and private service state are stored per port in `~/.claude-live-monitor/`.
- Use `codex-live-monitor` as an alias for the same combined monitor and service
  commands.

### Changed

- Codex skill and plugin lists show resources with recorded session activity;
  available-only catalog entries are excluded. Recorded instruction blocks
  remain visible.
- Observe keeps child agents under the parent session when selected, including
  guardian sessions with parent metadata. Known child links resolve to the parent.
- Codex usage accounting avoids counting repeated cumulative updates or reasoning
  tokens twice and preserves counters when rollouts move into the archive.
- Codex billed cost is shown as unavailable. Mixed-provider statistics retain the
  known Claude cost estimate separately from unpriced Codex usage.

### Notes

- Existing foreground commands continue to work. Background startup does not
  install a login or reboot service.
- Codex monitoring uses local rollout evidence; account subscription limits,
  cloud-only sessions, and resource-specific billed tokens are not available.
- Recorded instructions use token estimates. Nested tool references inside
  `exec` source are not independently confirmed executions.
