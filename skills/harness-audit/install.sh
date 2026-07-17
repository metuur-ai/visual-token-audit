#!/usr/bin/env bash
# Install the harness-audit skill into a Claude Code skills directory.
#
#   ./install.sh            install into ./.claude/skills (project-local, default)
#   ./install.sh --global   install into ~/.claude/skills (all projects)
#   ./install.sh --dest DIR  install into DIR/harness-audit
#   ./install.sh --force     overwrite an existing install without prompting
#
# Idempotent: re-running updates the installed copy in place.
set -euo pipefail

SKILL_NAME="harness-audit"
# Directory this script lives in == the skill source root.
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DEST_BASE=""
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --global)  DEST_BASE="$HOME/.claude/skills"; shift ;;
    --dest)    DEST_BASE="${2:?--dest needs a directory}"; shift 2 ;;
    --force)   FORCE=1; shift ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$DEST_BASE" ] || DEST_BASE="$(pwd)/.claude/skills"

DEST="$DEST_BASE/$SKILL_NAME"

# Sanity-check the source before touching anything.
[ -f "$SRC/SKILL.md" ] || { echo "error: $SRC/SKILL.md not found — run this from the skill dir" >&2; exit 1; }

if [ -e "$DEST" ] && [ "$FORCE" -ne 1 ]; then
  printf 'overwrite existing install at %s? [y/N] ' "$DEST"
  read -r reply
  case "$reply" in [yY]*) ;; *) echo "aborted"; exit 0 ;; esac
fi

mkdir -p "$DEST_BASE"
rm -rf "$DEST"
mkdir -p "$DEST"

# Copy the skill payload only — never the installer or VCS/OS cruft.
copy() { # relpath
  local rel="$1"
  mkdir -p "$DEST/$(dirname "$rel")"
  cp "$SRC/$rel" "$DEST/$rel"
}
copy SKILL.md
for f in references/placement.md references/hardening.md scripts/inventory.py; do
  [ -f "$SRC/$f" ] && copy "$f"
done
chmod +x "$DEST/scripts/inventory.py" 2>/dev/null || true

echo "installed $SKILL_NAME -> $DEST"
find "$DEST" -type f | sed "s|$DEST/|  |" | sort
