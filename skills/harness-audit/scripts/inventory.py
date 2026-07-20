#!/usr/bin/env python3
"""Discover harness artifacts under a directory and estimate their token weight.

Usage:
    python inventory.py <root-dir> [-o out.json] [--global]

Finds rule files, skills, agent definitions, prompts and MCP configs, classifies
each by layer and likely load timing, and writes a JSON map plus a summary table.

Key nuance: a skill or agent definition is NOT all-or-nothing. Its frontmatter
`description` is ALWAYS loaded (injected into the system prompt every turn) while
its body only loads when the skill/agent is triggered. This script splits those,
so the always-loaded total reflects reality instead of under-counting it.

This only finds files. Project instructions set in a web UI, saved prompts,
system prompts inside application code, and MCP tool descriptions won't appear
here -- ask the user about those and add them to the map by hand.
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone

# (regex pattern, layer, load timing, note)
# load timing: "always" | "on-trigger" | "manual" | "on-demand"
# "on-trigger" files whose description is always-loaded are marked split=True below.
PATTERNS = [
    (r"^CLAUDE\.md$",                        "project",  "always",     "Claude project rules",           False),
    (r"^CLAUDE\.local\.md$",                 "project",  "always",     "Local overrides, often untracked", False),
    (r"^AGENTS?\.md$",                        "project",  "always",     "Agent rules",                    False),
    (r"^\.cursorrules$",                      "project",  "always",     "Cursor rules",                   False),
    (r"^\.windsurfrules$",                    "project",  "always",     "Windsurf rules",                 False),
    (r"^\.clinerules$",                       "project",  "always",     "Cline rules",                    False),
    (r"^\.aider\.conf\.ya?ml$",               "project",  "always",     "Aider config",                   False),
    (r"^copilot-instructions\.md$",           "project",  "always",     "Copilot instructions",           False),
    (r"^GEMINI\.md$",                         "project",  "always",     "Gemini rules",                   False),
    (r"^\.github/instructions/.*\.md$",       "project",  "always",     "Copilot path instructions",      False),
    (r"^\.cursor/rules/.*\.mdc$",             "project",  "on-trigger", "Cursor rule (check frontmatter)", True),
    (r"SKILL\.md$",                           "task",     "on-trigger", "Skill definition (description is always-loaded)", True),
    (r"^\.claude/agents/.*\.md$",             "task",     "on-trigger", "Subagent definition (description is always-loaded)", True),
    (r"^\.claude/commands/.*\.md$",           "task",     "manual",     "Slash command",                  False),
    (r"^\.claude/settings(\.local)?\.json$",  "config",   "always",     "Claude settings",                False),
    (r"(^|/)\.mcp\.json$",                     "config",   "always",     "MCP servers - tool descriptions load every turn", False),
    (r"(^|/)mcp[_-]?config\.json$",            "config",   "always",     "MCP config",                    False),
    (r"(^|/)references?/.*\.md$",              "reference","on-demand",  "Reference doc",                 False),
    (r"(^|/)prompts?/.*\.(md|txt|ya?ml|j2)$",  "task",     "manual",     "Saved prompt",                  False),
    (r"(^|/)system[_-]?prompt.*\.(md|txt)$",   "identity", "always",     "System prompt",                 False),
]

SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build",
    ".next", ".pytest_cache", ".mypy_cache", "target", "vendor", ".tox",
}

WARN_ALWAYS_TOKENS = 2000   # an always-loaded file above this is worth flagging
WARN_DESC_TOKENS = 200      # a skill/agent description above this bloats every turn
STALE_DAYS = 365


def estimate_tokens(text: str) -> int:
    """~4 chars per token. Rough, but consistent enough to rank files."""
    return max(1, len(text) // 4)


def frontmatter_description(text: str) -> str:
    """Return the always-loaded portion of a skill/agent file: its YAML frontmatter
    description (falling back to the whole frontmatter block). Empty string if none."""
    if not text.startswith("---"):
        return ""
    end = text.find("\n---", 3)
    if end == -1:
        return ""
    block = text[3:end]
    # description: may be a single line or a folded/quoted multi-line value; grab
    # from the key to the next top-level key or end of block.
    m = re.search(r"(?ms)^description:\s*(.*?)(?=^\w[\w-]*:\s|\Z)", block)
    if m:
        return m.group(1).strip()
    return block.strip()


def classify(relpath: str):
    name = os.path.basename(relpath)
    for pattern, layer, load, note, split in PATTERNS:
        target = name if pattern.startswith("^") and "/" not in pattern else relpath
        if re.search(pattern, target):
            return layer, load, note, split
    return None


def flags_for(layer, load, tokens, always_tokens, desc_tokens, age, split):
    out = []
    if always_tokens > WARN_ALWAYS_TOKENS:
        out.append("heavy-always-loaded")
    if split and desc_tokens > WARN_DESC_TOKENS:
        out.append("bloated-description")
    if age > STALE_DAYS:
        out.append("stale")
    if layer == "config" and load == "always":
        out.append("check-tool-description-weight")
    return out


def scan(root: str):
    artifacts = []
    root = os.path.abspath(root)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root)
            hit = classify(rel)
            if not hit:
                continue
            layer, load, note, split = hit
            try:
                with open(full, encoding="utf-8", errors="replace") as f:
                    text = f.read()
            except OSError as e:
                print(f"  ! could not read {rel}: {e}", file=sys.stderr)
                continue
            st = os.stat(full)
            mtime = datetime.fromtimestamp(st.st_mtime, tz=timezone.utc)
            age = (datetime.now(timezone.utc) - mtime).days
            est = estimate_tokens(text)

            # Split always-loaded weight from on-trigger body weight.
            if split:
                desc_tokens = estimate_tokens(frontmatter_description(text))
                always_tokens = desc_tokens          # only the description loads every turn
                body_tokens = max(0, est - desc_tokens)
            elif load == "always":
                desc_tokens = 0
                always_tokens = est                  # whole file loads every turn
                body_tokens = 0
            else:
                desc_tokens = 0
                always_tokens = 0                    # nothing loads until triggered/pasted
                body_tokens = est

            artifacts.append({
                "path": rel,
                "layer": layer,
                "loads": load,
                "note": note,
                "bytes": st.st_size,
                "lines": text.count("\n") + 1,
                "est_tokens": est,
                "always_tokens": always_tokens,
                "body_tokens": body_tokens,
                "desc_tokens": desc_tokens,
                "last_modified": mtime.date().isoformat(),
                "days_since_change": age,
                "owner": None,          # fill in during Pass 3
                "flags": flags_for(layer, load, est, always_tokens, desc_tokens, age, split),
            })
    # Heaviest always-loaded first, then heaviest overall.
    artifacts.sort(key=lambda a: (-a["always_tokens"], -a["est_tokens"]))
    return artifacts


def dedupe(artifacts):
    seen, out = set(), []
    for a in artifacts:
        if a["path"] in seen:
            continue
        seen.add(a["path"])
        out.append(a)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("root", help="directory to scan")
    ap.add_argument("-o", "--out", default=os.path.join(".devlocal", "harness-audit", "harness-map.json"),
                    help="output JSON path (default: .devlocal/harness-audit/harness-map.json)")
    ap.add_argument("--global", dest="glob", action="store_true",
                    help="also scan the always-loaded global layer (~/.claude)")
    args = ap.parse_args()

    if not os.path.isdir(args.root):
        sys.exit(f"not a directory: {args.root}")

    roots = [os.path.abspath(args.root)]
    global_root = os.path.expanduser("~/.claude")
    if args.glob and os.path.isdir(global_root) and os.path.abspath(global_root) not in roots:
        roots.append(os.path.abspath(global_root))

    artifacts = []
    for r in roots:
        artifacts.extend(scan(r))
    artifacts = dedupe(artifacts)
    artifacts.sort(key=lambda a: (-a["always_tokens"], -a["est_tokens"]))

    always = sum(a["always_tokens"] for a in artifacts)
    total = sum(a["est_tokens"] for a in artifacts)

    result = {
        "roots": roots,
        "scanned_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "artifact_count": len(artifacts),
        "est_tokens_total": total,
        "est_tokens_always_loaded": always,
        "artifacts": artifacts,
    }
    out_dir = os.path.dirname(args.out)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(result, f, indent=2)

    if not artifacts:
        print("No harness files found. Either the scope is wrong, or the rules "
              "live outside the filesystem -- ask the user about UI-set project "
              "instructions, saved prompts, and system prompts in code.")
        return

    w = max(len(a["path"]) for a in artifacts)
    print(f"\n{'FILE'.ljust(w)}  {'LAYER':<9} {'LOADS':<10} {'ALWAYS':>7} {'TOTAL':>7}  FLAGS")
    print("-" * (w + 48))
    for a in artifacts:
        print(f"{a['path'].ljust(w)}  {a['layer']:<9} {a['loads']:<10} "
              f"{a['always_tokens']:>7} {a['est_tokens']:>7}  {','.join(a['flags'])}")
    print("-" * (w + 48))
    print(f"{len(artifacts)} artifacts | {total:,} est. tokens total | "
          f"{always:,} loading on EVERY turn")
    print(f"\nWrote {args.out}")
    print("ALWAYS column = tokens paid every turn. For skills/agents that's the")
    print("description only, not the body -- a bloated-description flag is a real win to fix.")
    print("Token estimates are rough (~4 chars/token) -- use them to rank, not to budget.")
    print()
    print("This scan only sees FILES. The heaviest always-loaded categories usually")
    print("are NOT files: MCP tool schemas (verbose JSON Schema from the running")
    print("server, not stored in .mcp.json), the base system prompt, and built-in")
    print("tool definitions -- MCP alone is often the single largest block.")
    print("Cross-check: run /context and compare its always-loaded number to the")
    print(f"{always:,} above. The gap is mostly MCP + system+tools. The ~4 chars/token")
    print("estimate also drifts from /context's real tokenizer, so cite /context --")
    print("not this total -- for any headline always-loaded figure.")
    print("Also ask about non-file artifacts: UI project instructions, saved prompts,")
    print("system prompts in code, memory.")


if __name__ == "__main__":
    main()
