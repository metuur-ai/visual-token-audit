# Plan: `harness-audit` skill

## Context

Custom rules, CLAUDE.md files, skills, commands, agents, plugins, hooks, and memory files have accumulated across the global (`~/.claude/`) and project harness (49 global skills, 73 commands, 12 project skill dirs, multiple CLAUDE.md/rules files). There is no way to see the whole picture, find duplicated/stale rules, decide where each rule should live, reduce always-loaded context, or enforce binary rules mechanically. This skill provides a repeatable 5-phase audit that maps the harness, finds bloat, fixes placement, optimizes loading cost, and converts soft rules into hard checks — **audit + propose, applying fixes only per-class on approval** (user decision). Skill lives **in the target project**: `.claude/skills/harness-audit/` (user decision). Hard checks use **all three mechanisms**: hooks, validation scripts, and JSON schemas (user decision).

## Files to create

```
.claude/skills/harness-audit/
├── SKILL.md                          # ~250 lines: trigger, 5-phase workflow, approval gates
├── scripts/
│   └── inventory.sh                  # read-only harness scanner (bash, ~120 lines)
└── references/
    ├── harness-map.md                # all surfaces to scan + load semantics (always/on-invoke/on-demand)
    ├── duplication-heuristics.md     # overlap/staleness detection recipes, severity rubric, evidence format
    ├── placement-rules.md            # decision tree: global CLAUDE.md vs project CLAUDE.md vs skill vs command vs hook
    ├── hard-checks.md                # templates: hook JSON, validation script, frontmatter JSON Schema
    └── report-template.md            # literal report skeleton with 4 worked examples
```

Audit reports produced by the skill go to `.devlocal/harness-audit/audit-YYYY-MM-DD.md` (`.devlocal/` is already gitignored and is the established uncle-dev scratch home).

## SKILL.md design

**Frontmatter** (house convention: minimal `name` + multi-sentence trigger `description`):

```yaml
---
name: harness-audit
description: Audit the Claude Code harness — CLAUDE.md files, skills, commands, agents, rules, hooks, plugins, MCP configs, and memory files. Use when the user asks to "audit my setup", "clean up CLAUDE.md", "find duplicate rules", "why is my context so big", "optimize loading", or "turn rules into hooks". Maps the full harness, finds bloat and duplication, proposes placement fixes, and converts soft rules into enforceable hooks, scripts, and schemas. Audit-and-propose only; never applies changes without per-class approval.
---
```

**Body** (house structure: Purpose / When to invoke / When NOT / Critical rules / Workflow phases / Anti-patterns / Done-when; details deferred to `references/` via "→ references/file.md#anchor" links):

- **Critical rules**: read-only until an approval gate passes; every finding carries file:line evidence; fixes approved per class, never blanket; deletions proposed as archive-moves first; plugin-owned content is report-only (propose disabling, never editing).
- **Phase 1 — Map the Harness**: run `scripts/inventory.sh [project-root]`, present inventory table + always-loaded token total (as % of 200k window) + top-10 heaviest always-loaded files. **STOP: confirm scope** (user may exclude global/plugins).
- **Phase 2 — Bloat & Duplication**: grep-driven detection — normalized-sentence dedup across CLAUDE.md/rules/skills, imperative-keyword clustering (MUST/NEVER/ALWAYS), skill-description overlap, dead pointers, stale tool references. Findings: `D-NN [HIGH|MED|LOW]` with side-by-side quoted evidence and proposed resolution + token saving.
- **Phase 3 — Ownership & Placement**: per instruction cluster answer: what job? needed when (always / task-type / on-ask / never)? who owns (user / team / generated)? Output placement matrix (current → recommended → reason); chat shows only rows where current ≠ recommended.
- **Phase 4 — Loading Optimization**: for every "always-loaded but phase-specific" row, design extraction into an on-demand skill (stub SKILL.md + references/ progressive disclosure) or command; before/after token table.
- **Phase 5 — Soft Rules → Hard Checks**: scan surviving rules for binary predicates (word/line limits, required frontmatter, forbidden commands). Mechanism selection: block-at-tool-time → PreToolUse hook (exit 2); post-edit artifact checks → PostToolUse/Stop hook calling script; document structure → JSON schema + validator; advisory/CI → standalone script. Show generated artifact previews in report.
- **Approval gates**: fix-class menu — A: merge/delete duplicates, B: relocations, C: extract-to-skill restructures, D: install hooks+scripts+schemas. Each approved independently. Hook JSON shown in chat before touching settings; recommend `settings.local.json` (personal) vs `settings.json` (team). All applied changes logged to report changelog.
- **Done-when**: report populated (all 5 sections), every finding evidenced, each fix class explicitly approved/declined, applied changes re-verified by re-running `inventory.sh` and confirming token delta.

## scripts/inventory.sh

Bash (POSIX + awk; shells to `python3 -c`/`node -e` only for settings.json hook counting — complies with built-in-tools-only rules). Strictly read-only, prints markdown to stdout. Emits:

- Per-surface table: Surface | Scope | Count | Bytes | ~Tokens | Load tier
- Three-tier accounting: **always** (CLAUDE.md files, rules, memory, skill/command frontmatter descriptions only — extracted via `awk '/^---$/{f++} f==1'`), **on-invoke** (skill bodies), **on-demand** (references/)
- Token estimate: `bytes / 4`; flag any always-loaded file > ~6 KB (~1,500 tokens) as a Phase 4 candidate
- Machine-readable `TOTALS always=… invoke=… ondemand=…` line for post-apply verification
- Uses `find -name SKILL.md` (skills can be nested, e.g. `.claude/skills/api/*/SKILL.md`)

Measurement is scripted; analysis (duplication, placement, hard-check judgment) stays prompt-driven in references/.

## references/ content

- **harness-map.md**: full surface table (global + project CLAUDE.md, nested CLAUDE.md, rules dirs, skills 3-tier, commands, agents, plugins, settings hooks, `.mcp.json`, `~/.claude/projects/<slug>/memory/`, AGENTS.md) with load semantics and owner (user/project/plugin).
- **duplication-heuristics.md**: grep/sort/uniq recipes, severity rubric, evidence format, resolution patterns (canonical+pointer, merge-up, delete-with-archive).
- **placement-rules.md**: decision tree (every-project+personal → global CLAUDE.md ≤~150 lines; every-session-this-repo → project CLAUDE.md; task-type → skill ≤300-line body; on-explicit-ask → command; enforceable → hook/script; >1-page reference → references/ or docs/; session-learned → memory with expiry).
- **hard-checks.md**: candidate-detection grammar; mechanism selection table; three copy-paste templates styled after the existing graphify PreToolUse hook precedent in `.claude/settings.json`. Generated artifacts live in `.claude/hooks-scripts/`, `scripts/checks/`, `.claude/schemas/`. Hooks must be O(ms), narrow `matcher`, fail open unless safety-critical. Frontmatter validation via python3 stdlib flat parse (no YAML lib installs).
- **report-template.md**: literal report skeleton with 4 embedded worked examples:
  1. Duplication: "always use bun, never npm" repeated in CLAUDE.md + rules + 3 skill bodies → canonical + delete + Phase 5 candidate
  2. Placement: 900-line editorial guide in global CLAUDE.md → `writing-style` skill with references/, ~3,400 tokens/session saved
  3. Soft→hook: block-npm PreToolUse hook JSON + `block-npm.sh` (stdin JSON, exit 2 with reason)
  4. Soft→schema: `skill-frontmatter.schema.json` (required name/description, minLength) + `validate-skills.sh` walker

## Report format

Path: `.devlocal/harness-audit/audit-YYYY-MM-DD.md`. Structure:

```markdown
# Harness Audit — <date>
Scope: ~/.claude + <project> | Generated by: harness-audit skill

## 1. Inventory
| Surface | Scope | Count | Bytes | ~Tokens | Load |
**Always-loaded total: ~N tokens (~X% of a 200k window)**

## 2. Bloat & Duplication Findings
### D-01 [HIGH] <title>
Locations: fileA:12-19, fileB:44-51 / Evidence: quoted excerpts / Proposed: resolution + token saving

## 3. Placement Matrix
| ID | Instruction | Current | Job | Needed when | Owner | Recommended | Action |

## 4. Loading Optimization Plan
| Move | From (always) | To (on-demand) | Tokens saved/session |

## 5. Hard-Check Candidates
| ID | Source rule (file:line) | Predicate | Mechanism | Artifact |
+ generated artifact previews (fenced code blocks)

## 6. Fix Classes & Approval Log
| Class | Description | Items | Status | Applied at |

## 7. Changelog
```

Re-running on the same day updates sections 1–5, appends to 6–7.

## Implementation order

1. `references/harness-map.md` (defines the surface list the script encodes)
2. `scripts/inventory.sh`
3. `SKILL.md`
4. Remaining references/ files (duplication-heuristics, placement-rules, hard-checks, report-template)

Existing patterns to reuse: `.claude/skills/api/guard-system/` references/ linking style; `.claude/skills/map-codebase/SKILL.md` STOP-gate style; graphify hook in `.claude/settings.json` as hook template precedent.

## Verification

1. `bash .claude/skills/harness-audit/scripts/inventory.sh .` — runs read-only, emits the markdown table + TOTALS line; spot-check byte counts against `wc -c` on 2 known files (e.g. project CLAUDE.md ≈ 7.2 KB → ~1,800 tokens).
2. Confirm the script finds nested skills (`.claude/skills/api/*/SKILL.md`) and counts frontmatter-only bytes for the always tier.
3. Dry-run the skill end-to-end on a real repo (foyer-platform has real duplication: duplicated graphify blocks across global/project CLAUDE.md, doubled skill listings) — verify a report lands in `.devlocal/harness-audit/` with all 5 sections and no files outside `.devlocal/` are modified without approval.
4. Validate SKILL.md frontmatter matches house convention (name + description) and body links to references/ resolve (`[ -e ]` each referenced path).
