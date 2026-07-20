# Token Accounting — Tier 2 follow-up

Status: **frontend shipped / backend pending.** The Loading-panel category +
per-item drill-down view is implemented in `public/observe.js` (gated on the
root node's `baseBreakdown`); the backend that produces `baseBreakdown` (vendored
o200k tokenizer, disk inventory, payload assembly) is still to build. Tracks the
remaining work on the Session Observability token model after Tier 1 (UI) and
Tier 1b (sound `CtxBreakdown` math) shipped. See `src/observe.ts` for the current
implementation and `.devlocal/knowledge-nudge/.knowledge-capture-nudged` for the history.

---

## Where we are today

The observe payload decomposes each node's **peak context window** (`ctx`) into
`CtxBreakdown` (`src/observe.ts`):

```
ctx = base + assistant + toolResults + prompts        (overflow = eviction signal)
```

- `ctx` — peak `input + cacheRead + cacheWrite` across the node's turns. **Ground truth.**
- `base` — turn-1 window floor minus the first user prompt. This is the
  **preloaded floor**: system prompt + tool schemas + skill/agent *descriptions* +
  MCP tool schemas + memory (CLAUDE.md, rules, auto-memory). Exact in aggregate.
- `assistant` / `toolResults` — resident history, frozen at the peak-window turn.
- `prompts` — residual (user input + estimation slack).
- `overflow` — accumulated history beyond the peak window (compaction/eviction, or estimate slack).

**The gap Tier 2 closes:** `base` is a single opaque number. `/context` shows it
broken out (MCP 26k, Skills 27.9k, System tools 7.4k, …); the observe UI cannot,
because those categories are harness text the transcript never writes out. The
only per-item evidence we have is `pre[]` — the reminder-enumerated subset — whose
`tk` values are `estTok` (bytes/4) of ≤80-char evidence snippets, i.e. a tiny,
non-quantitative sliver (`<1%` of `base`).

Two limitations remain:

1. **No per-category split of `base`.** We can't say how much of the floor is
   MCP vs skills vs agents vs system+tools.
2. **Estimates are `÷4`, not a real tokenizer.** `estTok` and every `bytes/4` /
   `resultBytes/4` figure are crude. Fine for relative sizing, wrong for
   headline numbers a user compares against `/context`.

---

## Goal

Reconstruct the `base` floor as a **categorized, tokenizer-accurate** breakdown:

```
base ≈ system+tools (residual)
     + Σ mcp_server_schema
     + Σ skill_description
     + Σ agent_description
     + Σ memory_file            (CLAUDE.md, .claude/rules/*.md, auto-memory)
```

so the Loading panel can show the same category rows as `/context`, sourced from
local files rather than reminder evidence.

## Approach

Everything auto-loaded at startup comes from files on disk that the collector can
read directly (it already resolves `PROJECTS_DIR` and reads transcripts):

| Category | Source to re-tokenize |
|---|---|
| Skills | `**/.claude/skills/**/SKILL.md` front-matter + body (descriptions load eagerly; bodies load on invoke → belong to `dyn`, not `base`) |
| Agents | agent definition front-matter/description in `.claude/agents/**` and plugin agents |
| MCP | registered server tool schemas (names + descriptions + JSON Schema) |
| Memory | `CLAUDE.md` (all scopes), `~/.claude/rules/*.md`, `.claude/rules/*.md`, auto-memory `MEMORY.md` + recalled files |
| System + tools | **residual**: `base − Σ(measured categories)` |

**Algorithm**

1. Enumerate the local files above that were in scope for the session (respect
   user/project/enterprise layering; a session's `cwd` scopes project files).
2. Tokenize each with a **real BPE tokenizer** (see below), not `length/4`.
3. Sum per category → measured categories.
4. `systemAndTools = max(0, base − Σ measured)`. Keep it as an explicit residual
   row so the categories always reconcile to `base` (the ground-truth floor).
5. Attach as an optional `baseBreakdown` on `CtxBreakdown` (or a sibling field);
   keep it additive so existing consumers are unaffected.

**Tokenizer.** The project is zero-dependency by design (`package.json`), so the
BPE step must not pull an npm tree at runtime. Options, in order of preference:
- Vendor a small, self-contained BPE encoder (cl100k/o200k-style) as a single
  local module. One-time cost; keeps the zero-dep runtime promise.
- Gate it behind a flag and only tokenize on demand (the Loading panel is
  opt-in), so the hot path (SSE/agg) stays `÷4`.
- Last resort: keep `÷4` but calibrate a per-category correction factor measured
  once against a real tokenizer.

## Risks & subtleties

- **Scope drift.** What's actually loaded depends on the harness version, enabled
  plugins, and MCP servers connected *at session time* — not what's on disk now.
  Files may have changed or been added since. Treat the split as **best-effort
  reconstruction** and label it as such (same honesty stance as `pre[]`).
- **Descriptions vs bodies.** Skill/agent *descriptions* are in `base`; their
  *bodies* load on invocation and already surface as `dyn` skill-body tokens
  (`obsDyn`, `bytes/4`). Don't double-count — Tier 2 is descriptions only.
- **MCP schema size** is the real driver (JSON Schema is verbose) and is the
  hardest to source locally; it may require reading the MCP server manifest/
  capabilities rather than a markdown file.
- **Residual can go negative** if estimates overshoot `base`; clamp at 0 and log
  when it does (signals a tokenizer/scope error worth surfacing).

## Acceptance criteria

- [ ] `Σ measured categories + systemAndTools == base` exactly (residual reconciles).
- [ ] Category totals are within a small tolerance of `/context`'s rows on a
      session where both are available (the original discrepancy case).
- [ ] Tokenization uses a real BPE encoder; `÷4` no longer appears in any
      headline `base`-category number.
- [ ] Zero-dependency runtime preserved (vendored encoder or opt-in flag).
- [ ] Additive to the payload — no breaking change to `CtxBreakdown` consumers.
- [x] Loading panel renders the category rows with a "reconstructed from local
      files — may drift from session-time state" caveat. **(frontend shipped)**
      Stacked bar + category rows (label · tk · % of base) + per-item drill-down
      with used/unused dots, an honest skill/agent waste stat, and a residual row
      reconciling to base. Falls back to the `pre[]` view when `baseBreakdown` is
      absent. Tokenizer-accuracy and exact-reconciliation ACs remain with the backend.

## Out of scope

- Changing `ctx`, `selfTok`, or `cost` (ground-truth metrics, already correct).
- Bodies/`dyn`/`toolTokens` accuracy — separate track; still `bytes/4`.
- Cross-session or fleet rollups.
