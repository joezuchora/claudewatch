#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"

echo "[claudewatch] Updating VS Code extension..."
"$REPO_ROOT/scripts/reinstall-vscode-extension.sh" "$REPO_ROOT"

echo "[claudewatch] Updating Claude Code statusline binary..."
if ! (cd "$REPO_ROOT" && bun run install-statusline); then
	echo "[claudewatch] Statusline update failed." >&2
	echo "[claudewatch] If Claude Code is running, close it and rerun: bun run install-statusline" >&2
	exit 1
fi

echo "[claudewatch] Upgrade complete."
echo "[claudewatch] Next steps:"
echo "  1) VS Code: Developer: Restart Extension Host"
echo "  2) Claude Code: fully restart the app"
