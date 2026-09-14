#!/usr/bin/env bash
# SessionStart hook — read-only orientation.
#
# Prints the current branch and any in-flight SDLC artifact chain, so a resumed session
# knows which stage it is in. Deliberately mutates nothing: an earlier version of this hook
# ran `git checkout -b` on every session and littered the repo with throwaway branches.
set -uo pipefail

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0
echo "branch: ${branch}"

if [ "$branch" = "main" ]; then
  echo "note: on main — start a change with /sdlc-intent, which will branch for you."
fi

# Surface the most recent artifact chain and how far it has progressed.
latest=$(find sdlc -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -1)
if [ -n "$latest" ]; then
  stage=""
  for f in intent spec plan review incident; do
    [ -f "$latest/$f.md" ] && stage="$stage $f"
  done
  echo "sdlc: ${latest#sdlc/} —${stage:- (empty)}"
fi

exit 0
