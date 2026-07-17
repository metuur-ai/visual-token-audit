# Placement: where rules should live

Read this during Pass 3 (ownership and placement) and Pass 4 (loading). The layer model drives both — placement determines load timing, so getting the layer right mostly fixes the loading problem for free.

## The layers

Ordered from widest scope and earliest load, to narrowest and latest.

| Layer | Typical home | Scope | Loads | Should be |
|---|---|---|---|---|
| Identity | System prompt, org-level config | Everything, forever | Always | Tiny, near-immutable |
| Project | CLAUDE.md, project instructions, .cursorrules | This repo/project | Always, within the project | Small — a map, not an encyclopedia |
| Task | Skills, agent definitions, workflow docs | One kind of work | On trigger (but the *description* loads always) | As big as it needs to be |
| Reference | references/, docs, schema files | One narrow need | On demand | Unbounded |
| Data | The actual files being worked on | This request | With the request | N/A |

The failure mode this model exists to fix: rules migrate upward over time. Something goes wrong once during a task, and the fix gets pasted into the project file "so it never happens again." Repeat for two years and the project layer holds every task rule anyone ever needed, all loading on every turn, most irrelevant to any given one.

**The Task layer has a split cost.** A skill or agent isn't billed as one thing: its frontmatter description is always-loaded (that's how the model knows the skill exists), while its body loads only on trigger. So a fat skill body is cheap-until-used, but a fat *description* is a permanent tax. When you move a rule into a skill, keep the description to a trigger sentence and put the substance in the body.

## The decision table

Ask: what job does this rule do, and what's the narrowest scope where that job is real?

| If the rule... | It belongs in | Because |
|---|---|---|
| Applies to every request without exception | Identity | Nothing narrower catches it all |
| Describes how this codebase/project is arranged | Project | Any task in the repo may need it |
| Is a hard constraint that must never be violated anywhere | Identity or Project | Can't risk a gate not firing |
| Only matters while doing one kind of work | Task (skill) | Everything else is paying for it otherwise |
| Only matters during one phase of one kind of work | Task, gated within the skill's workflow | Phase-gating is a skill's job, not the project's |
| Is looked up rather than followed | Reference | It's a lookup table, not an instruction |
| Restates a model default | Nowhere — delete | Costs tokens, changes nothing |
| Was a fix for a bug that's now fixed | Nowhere — delete | Load-bearing for a world that ended |
| Nobody can explain the purpose of | Ask the owner; delete if there isn't one | See below |

## Ownership

Every surviving rule gets a name attached. Not a formality — the mechanism that prevents drift from restarting the day after the audit.

The test: **when reality changes, who edits this rule?** If the answer is "whoever notices," what actually happens is that whoever notices adds a local override in their own file instead of editing the canonical one, because editing shared config feels like someone else's call. That's exactly how one rule becomes fifteen.

Signs a rule has no owner:
- No commit touching it in a year, in a domain that has definitely changed
- It contradicts a newer rule and nobody has noticed
- Multiple near-copies with different values — each fork is someone who didn't feel authorized to edit the original
- Asking "who owns this?" produces a shrug or three different names

Fix: name an owner, or delete the rule. An ownerless rule is a rule that will be wrong soon and no one will notice.

## The project layer should be a map

The single highest-leverage change in most audits: stop treating the always-loaded project file as the place where rules live, and make it the place that says where rules live.

A project file that's mostly pointers stays small, stays readable, and makes the rest of the harness discoverable — which is what makes gating work at all. A pointer costs a line; the rule it points to costs nothing until it's needed.

```markdown
# CLAUDE.md
[what this project is — 3 lines]
[hard constraints — the short list that genuinely applies to everything]

## Where things live
- Editorial standards → skills/copy-edit/ (loads at copy edit)
- Deployment → skills/ship/ (loads at release)
- DB schema → references/schema.md (read before touching migrations)
```

## Common mistakes

**Moving a file without leaving a pointer.** Deferred loading requires something to trigger the load. A rule in `references/` that nothing points to and no description matches has not been deferred — it's been deleted, quietly, and you'll find out when the output regresses.

**Gating a hard constraint.** If a rule must never be violated, it can't depend on a trigger firing. Constraints live in the always-layer even when they're rarely relevant. The cost of tokens is not the cost of a violation.

**Splitting a rule from its context.** A rule that only makes sense next to the example demonstrating it should move with the example, or not at all.

**Optimizing the wrong file.** Check load frequency before size. A 400-token file loading every turn costs more per week than a 4,000-token file that loads twice a month.

**Bloating a skill description to "make sure it triggers."** The description is always-loaded. A paragraph where a sentence would do is a tax you pay on every unrelated turn. Write the trigger tight; the body carries the weight.
