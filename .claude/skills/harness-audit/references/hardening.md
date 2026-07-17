# Hardening: prose rules → enforceable checks

Read this during Pass 5.

## The test

A rule can be hardened if a script could answer "did this comply?" with true or false, and two reasonable people would always agree with the script.

Both halves matter. "Is this under 800 words?" — script says yes, everyone agrees, harden it. "Is this on brand?" — a script could return a boolean, but nobody would trust it. That's a judgment rule; leave it as prose.

Run each candidate through it honestly. The temptation is to harden things that are almost-but-not-quite mechanical, and the result is a check that fires on correct output, which trains everyone to ignore checks.

## What to look for

| Pattern | Example prose | Mechanism |
|---|---|---|
| Count / limit | "Around 800 words" | Schema constraint or checker script |
| Required structure | "Every post needs a title, dek, body, CTA" | Required fields in an output schema |
| Enumeration | "Status is draft, review, or published" | Enum in schema |
| Format | "Dates as ISO 8601" | Pattern / format in schema |
| Presence | "Alt text on every image" | Lint rule |
| Absence | "No TODO in shipped copy" | Lint rule / grep in CI |
| Cross-field | "If status is published, publish_date is required" | Conditional schema rule |
| Tool/action gate | "Never edit files under vendor/" · "Run the formatter after every write" | Claude Code hook |

## Where the check lives

Pick by what the surrounding system can actually enforce. In rough order of preference:

1. **Structured output schema** — the model's output is validated against it. Strongest option: the constraint is enforced at generation, not discovered afterward. Use when the artifact is data-shaped.
2. **Hook (Claude Code)** — a `PreToolUse` / `PostToolUse` / `Stop` hook runs a command the harness itself enforces, outside the model's discretion. Strongest option for *behavioral* rules ("don't touch X," "always run Y after Z") because the model cannot forget to honor it — the harness executes it, not the model. Use when the rule governs an action rather than an output. See the worked hook example below.
3. **Validator script the workflow runs** — the skill or workflow calls it and reads the result. Use when output is prose or files. Requires the workflow to actually call it; a validator nobody runs is a file.
4. **CI check / lint rule** — catches everything eventually, feedback is slow. Good backstop, poor primary.
5. **Checklist step in the workflow** — weakest, but honest. Use when nothing else can run.

The check must be *reachable*. A schema that no code path validates against, a script no step invokes, a hook not wired into `settings.json` — these are prose with extra steps and a false sense of safety.

**Prefer a hook when the rule is "the model keeps doing the thing I told it not to."** That is precisely the class of failure prose can't fix — the model already read the prose and did it anyway. A hook removes the model's discretion entirely.

## Worked example: the word count

**Before**, spread across a project file, a skill, a saved prompt, and twelve pasted variants:

> Blog posts should be around 800 words.
> Aim for roughly 750–850 words per post.
> Keep posts to about 800 words (this is important!).

**After.** One canonical rule, and the number lives in exactly one place:

```json
{
  "type": "object",
  "required": ["title", "dek", "body"],
  "properties": {
    "title": { "type": "string", "maxLength": 70 },
    "dek":   { "type": "string", "maxLength": 200 },
    "body":  { "type": "string" },
    "word_count": { "type": "integer", "minimum": 750, "maximum": 850 }
  }
}
```

With a validator the workflow calls, because the model reporting its own `word_count` is not a measurement:

```python
def check_post(post: dict) -> list[str]:
    errors = []
    n = len(post["body"].split())
    if not 750 <= n <= 850:
        errors.append(f"body is {n} words, needs 750-850")
    if "TODO" in post["body"]:
        errors.append("body contains TODO")
    return errors
```

Then **delete all fifteen prose copies.** This is the step that gets skipped, and skipping it means the audit added a schema to a pile it was supposed to shrink.

Note what happened to the ambiguity: "around 800" had to become a range with real edges. Someone has to decide whether 812 passes. That decision was always required — prose just let everyone avoid making it, which is why the fifteen copies disagreed.

## Worked example: the behavioral rule → a hook

**Before**, in CLAUDE.md, ignored roughly every third session:

> NEVER edit files under `vendor/` — they're generated and your changes get clobbered.

Prose can't enforce this; the model reads it and edits `vendor/` anyway. Convert to a `PreToolUse` hook in `.claude/settings.json` that blocks the write outright:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "jq -e '.tool_input.file_path | test(\"/vendor/\") | not' >/dev/null 2>&1 || { echo 'blocked: vendor/ is generated — do not edit' >&2; exit 2; }"
          }
        ]
      }
    ]
  }
}
```

Exit code `2` tells Claude Code to block the tool call and feed the message back to the model. The rule is now enforced by the harness, not remembered by the model — and the prose line comes out of CLAUDE.md, shrinking the always-loaded layer. (Verify the hook fires before deleting the prose; an unwired hook is worse than the rule it replaced.)

## Don't harden these

- **Aesthetic and voice rules.** "Write with warmth." "Sound human." No boolean exists. A proxy metric — adjective density, sentence-length variance — will be gamed by the model and will punish good writing. Leave as prose.
- **Rules needing world knowledge.** "Don't make claims we can't support." A script can't evaluate it.
- **Rules with real exceptions.** If the answer is "usually, unless...", it's not a boolean. Hardening it means either false failures or an escape hatch that makes the check meaningless.
- **Rules that were never enforced and nobody missed.** Before building a checker, ask whether the rule matters. Sometimes the honest fix is deletion.

## Reporting

For each hardened rule, show: the prose it replaces (and where every copy lived), the mechanism, where the check runs, and what happens when it fails. That last one matters — a check whose failure nobody sees is decoration.
