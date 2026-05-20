#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command '$1' was not found in PATH." >&2
    exit 1
  fi
}

require_command bun
require_command npx
require_command code

echo "Building VS Code extension..."
(cd "$REPO_ROOT" && bun run --filter claudewatch-vscode build)

echo "Packaging VSIX..."
(cd "$REPO_ROOT/packages/vscode" && npx @vscode/vsce package --no-dependencies)

VSIX_PATH="$(ls -t "$REPO_ROOT"/packages/vscode/claudewatch-vscode-*.vsix 2>/dev/null | head -n 1 || true)"
if [[ -z "$VSIX_PATH" ]]; then
  echo "No VSIX file found in packages/vscode." >&2
  exit 1
fi

echo "Installing VSIX: $VSIX_PATH"
echo "Uninstalling existing extension instance (if present)..."
code --uninstall-extension claudewatch.claudewatch-vscode >/dev/null 2>&1 || true
echo "Installing extension from fresh VSIX..."
code --install-extension "$VSIX_PATH" --force

echo "Reopening workspace in existing VS Code window..."
code -r "$REPO_ROOT"

echo "Done. In VS Code, run: ClaudeWatch: Refresh Now"
