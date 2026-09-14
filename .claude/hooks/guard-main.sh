#!/usr/bin/env bash
# PreToolUse hook on Bash — refuse commits made directly to main.
#
# Exit 2 blocks the tool call and returns stderr to the agent as feedback.
set -uo pipefail

payload=$(cat)

case "$payload" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0

if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
  echo "Blocked: refusing to commit directly to '${branch}'." >&2
  echo "Create a change branch first — 'sdlc/<NNN>-<slug>' for loop work." >&2
  exit 2
fi

exit 0
