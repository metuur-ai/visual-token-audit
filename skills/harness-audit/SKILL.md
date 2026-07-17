---
name: harness-audit
description: Audit and refactor the instruction harness around an AI — CLAUDE.md files, project instructions, .cursorrules, skills, agent definitions, saved/system prompts, MCP configs. Maps everything that's loading, finds duplicated and contradictory rules, decides where each rule should live and who owns it, converts eager-loaded context into phase-gated loading, and turns yes/no rules into enforceable schemas and checks. Use this whenever someone says their context is bloated, their CLAUDE.md has grown out of control, the model ignores their rules, they have "fifteen versions of the same rule," they want to clean up / consolidate / audit their prompts, rules, skills, or agent config, or they're wondering why their setup got slow or inconsistent — even if they don't call it a "harness."
---

# Harness Audit

The harness is everything that shapes the model's behavior before the user's actual request: rule files, project instructions, skills, agent definitions, saved prompts, tool descriptions, MCP configs, memory. It accretes. Nobody deletes anything, because nobody knows what depends on what. Eventually rules contradict each other, the same instruction lives in five places with three different word counts, and half the context window burns on an editorial style guide that only matters during a final copy edit.

This skill runs five passes over that mess. Run them in order — each depends on the one before it. Don't skip to hardening before you've mapped.

## When NOT to use this

- **A single file needs one edit.** If the user wants one rule changed in one place, just change it. The audit is for accreted sprawl, not routine edits.
- **Writing a brand-new harness from scratch.** There's nothing to map or deduplicate yet. Start from `references/placement.md` directly for the layer model.
- **The complaint is a model capability gap, not a config problem.** "It can't do X" is different from "it ignores my rule about X." Only the second is a harness problem.

## Critical rules (read first)

This skill *deletes and moves rule files across someone's entire setup*. That is destructive. Bound it:

1. **Propose before you touch.** Passes 1–5 are read-only. Produce the audit document first. Do **not** delete, move, or rewrite any artifact until the user has approved that specific change.
2. **Approve per class, never blanket.** "Yes, collapse the word-count cluster" is approval for that cluster only. Never take one yes as license to apply every finding.
3. **Archive before delete.** The first time you remove anything, move it to an `_archive/` (or the project's convention) with a dated note — don't `rm`. Deletions become permanent only after the user confirms the archived copy is safe to drop.
4. **Plugin-owned content is report-only.** Never edit files owned by an installed plugin or vendored dependency. Report the finding and propose disabling or overriding upstream — editing them just gets clobbered on update.
5. **Every finding carries evidence.** `path:line` for each artifact you cite. A finding the user can't verify is a finding they can't approve.

## Pass 1 — Map the harness

Nothing can be fixed while it's invisible. Produce a complete inventory of every artifact that reaches the model, before touching any of it.

Start with the inventory script, which finds the usual suspects and estimates their token weight:

```bash
python scripts/inventory.py <root-dir>
# Add the always-loaded global layer too — it's usually where the real weight is:
python scripts/inventory.py <root-dir> --global
```

It writes `.devlocal/harness-audit/harness-map.json` and prints a summary table. It's a starting point, not the answer — it can only find files. Ask the user about the parts that live outside the repo:

- Project instructions / custom instructions in the web or desktop UI
- Saved prompts, snippets, and templates people paste by hand
- System prompts baked into application code
- Memory or persistent context features that are turned on
- MCP servers whose tool descriptions load on every turn
- Rules that are inherited from a parent directory or an org-level config

For each artifact record: **path or location, size in tokens, when it loads (always / on trigger / manually pasted), who wrote it, and when it last changed.** Load timing is the field people forget and the one that matters most in Pass 4.

**A note the script already handles, but you must repeat to the user:** a skill or agent definition is not all-or-nothing. Its *description* (frontmatter) is always-loaded — injected into the system prompt every turn — while its *body* only loads when triggered. The inventory splits these; when you report always-loaded weight, count description tokens, not whole files. The always-loaded total is dominated by these descriptions far more often than people expect.

Present the map before analyzing it. The user will spot things you can't — "oh, that one's dead, we moved off Cursor in March" — and their corrections make every later pass cheaper.

## Pass 2 — Find bloat and duplication

Now read the artifacts against each other. You're looking for four distinct failures, and they get different treatments:

**Duplication** — the same rule restated in several places. Usually benign-looking and genuinely expensive: every copy is a copy someone has to remember to update. The classic shape is one real source rule that has drifted into fifteen near-identical variants.

**Drift** — duplicates that no longer agree. One file says 800 words, another says 750, a third says "about 800." This is worse than duplication because the model has to pick, and it picks inconsistently. Drift is the strongest evidence that a rule needs a single owner (Pass 3).

**Contradiction** — rules that can't both be satisfied. "Never use em-dashes" in the style guide, an em-dash in the few-shot example three files down. Surface these loudly; they're usually the actual cause of the "the model ignores my rules" complaint.

**Dead weight** — rules for tools no longer used, for a workflow that changed, for a bug that got fixed. Instructions that restate the model's default behavior are dead weight too: "be helpful and accurate," "think step by step before answering," "don't hallucinate." They cost tokens and buy nothing.

Report findings as a table of clusters, not a wall of prose:

| Cluster | Rule | Appears in | Variants | Verdict |
|---|---|---|---|---|
| word-count | Blog posts ~800 words | 15 files | 800 / 750 / "about 800" | Collapse to 1 canonical + hard check |

For each cluster, name the **canonical version** — the one that survives — and say why. Where variants disagree, don't pick silently. Ask. The disagreement is often a real unresolved decision that got papered over by copy-paste, and resolving it is worth more than the token savings.

## Pass 3 — Assign ownership and placement

For every surviving rule, three questions in this order:

1. **What job does it do?** Not what it says — what it's for. "Use British spelling" does the job of keeping published output consistent with the brand. A rule whose job you can't state is a candidate for deletion.
2. **Where should that job live?** The job determines the layer. A rule about *how this repo's code is structured* belongs with the repo. A rule about *how this one task should be done* belongs in the task's skill. See `references/placement.md` for the layer model and the decision table.
3. **Who updates it when reality changes?** Every rule needs a name attached — a person or a team. Ownerless rules are how drift starts: everyone assumes someone else is maintaining it, so everyone forks a local copy instead.

The output of this pass is a placement plan: a row per rule with current location, target location, owner, and what happens to the old copies. Deletions of the old copies are the whole point; a "consolidation" that leaves the duplicates in place has consolidated nothing. (Per Critical Rule 3, those deletions are proposals until approved, and archived before removed.)

## Pass 4 — Fix loading time

Read `references/placement.md` for the layer model if you haven't already.

Default state: everything loads always, because that's what happens when you append to one file for a year. But most specialized knowledge is only relevant during one phase of the work. An editorial style guide is inert during research, outlining, and drafting — it earns its keep only at copy edit. Loading it upfront means paying for it on every turn and diluting attention across everything else in context.

Sort every artifact into:

- **Always** — genuinely applies to every turn. Should be small. Identity, hard constraints, the map of where everything else lives.
- **Phase-gated** — loads when the work reaches a phase. Editorial guide at copy edit, deployment checklist at ship, schema docs when touching the database.
- **On demand** — reference material the model pulls when it hits the specific need. Rare formats, error catalogs, API details.

Then make the gating actually work. A file only loads on trigger if something triggers it — a skill description that matches the phase, an explicit pointer from the always-layer, a workflow step that names it. **Moving a file into a `references/` folder without a pointer to it doesn't defer the load, it deletes the rule.** State the trigger for every gated artifact.

Report the before/after: always-loaded token count now vs. after, and what moved where. Remember the Pass 1 correction — a skill's always-loaded cost is its description, so trimming a bloated description is a real always-loaded win even when the body stays.

## Pass 5 — Turn soft rules into hard checks

Prose is a bad enforcement mechanism for anything with a right answer. "Keep it to about 800 words" is a suggestion the model complies with approximately, and nobody notices when it doesn't. A rule that a script can answer yes-or-no about shouldn't be prose at all — it should be a schema, a validator, a hook, or a test, and the model should get told when it fails.

Scan the surviving rules for the mechanizable ones. The tell is that you could write a function returning a boolean without judgment calls:

- Counts and limits — word count, section count, max file length
- Required structure — every post has a title, dek, body, CTA
- Enumerations — status is one of draft/review/published
- Format — dates as ISO 8601, IDs matching a pattern
- Presence/absence — no TODO in shipped copy, alt text on every image

Convert these to output schemas, JSON Schema, a lint rule, a Claude Code hook, or a checker script — whatever the surrounding system can actually enforce. `references/hardening.md` has the conversion patterns, the mechanism-selection order (including when a hook beats a validator), and worked examples.

Two things to get right. First, the hard check **replaces** the prose; leaving both means you've added a rule rather than removed one. Second, know what can't be hardened. "Write with warmth" has no boolean. Don't mangle a judgment rule into a fake metric — an adjective-density lint is worse than the original prose. Judgment rules stay prose, and prose is fine for them.

## Output

Write the audit to `.devlocal/harness-audit/audit-YYYY-MM-DD.md` — it's a working document the user will act on over days, not a chat message. (`.devlocal/` is a conventional gitignored scratch home; fall back to the repo's own scratch dir if it has one.) Markdown by default.

```markdown
# Harness Audit: [scope]
## Summary
[3-5 bullets: total artifacts, always-loaded tokens before/after, N duplicate clusters, N contradictions, N rules hardened]
## The map
[inventory table: artifact, tokens (always vs body), loads when, owner, last changed]
## Bloat and duplication
[cluster table + the contradictions, called out separately]
## Placement plan
[rule, job, current location, target location, owner, old copies]
## Loading plan
[always / phase-gated / on-demand, with the trigger for each gated item]
## Hard checks
[rule → mechanism, with the schema or script]
## Do this first
[ordered actions, highest value first — contradictions and drift before token savings]
```

Then offer to execute it — one class at a time, archiving before deleting (Critical Rules 2–3). The audit is worth little until the deletions actually happen, and the user is far more likely to say yes right now than to work through the list alone next week.

## Working notes

- **Read before judging.** A rule that looks redundant is often load-bearing for a case you don't know about. Ask before cutting anything you don't understand.
- **Token savings are the least interesting result.** Contradictions and drift cause the behavior people are actually complaining about. Lead with those.
- **The user's map beats yours.** They know which files are dead. Get their corrections early.
- **Don't rewrite rules while consolidating.** Pick a canonical version, keep its words. Improving the prose at the same time makes it impossible to tell whether a behavior change came from the consolidation or the rewrite.
- **Big harnesses are for humans too.** If it's too large for one person to hold in their head, it's too large to maintain, regardless of what the model can handle.
