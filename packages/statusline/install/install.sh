#!/usr/bin/env bash
# ClaudeWatch standalone installer for Linux.
#
# Downloads the latest release binary from GitHub and configures
# Claude Code to use it as the status line.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/joezuchora/claudewatch/main/packages/statusline/install/install.sh | bash
#
# Or if you already downloaded the binary:
#   ./install.sh /path/to/claudewatch
#
set -euo pipefail

REPO="joezuchora/claudewatch"
CLAUDE_DIR="$HOME/.claude"
BIN_DIR="$CLAUDE_DIR/bin"
SETTINGS="$CLAUDE_DIR/settings.json"
BINARY_NAME="claudewatch"
INSTALLED="$BIN_DIR/$BINARY_NAME"
STATUS_LINE_CMD="~/.claude/bin/$BINARY_NAME"

log() { echo "[claudewatch] $1"; }

install_binary() {
  local src="$1"
  mkdir -p "$BIN_DIR"

  if [ -f "$INSTALLED" ]; then
    mv "$INSTALLED" "$INSTALLED.old" 2>/dev/null || true
  fi

  cp "$src" "$INSTALLED"
  chmod +x "$INSTALLED"

  rm -f "$INSTALLED.old" 2>/dev/null || true
  log "Installed binary to $INSTALLED"
}

update_settings() {
  if [ ! -f "$SETTINGS" ]; then
    echo "{}" > "$SETTINGS"
  fi

  # Check if already configured
  if command -v python3 &>/dev/null; then
    local current
    current=$(python3 -c "
import json, sys
try:
    s = json.load(open('$SETTINGS'))
    sl = s.get('statusLine', {})
    print(sl.get('command', ''))
except: pass
" 2>/dev/null || true)

    if [ "$current" = "$STATUS_LINE_CMD" ]; then
      log "Claude Code settings already configured."
      return
    fi

    python3 -c "
import json
with open('$SETTINGS') as f:
    s = json.load(f)
prev = s.get('statusLine')
if prev:
    s['_statusLinePrevious'] = prev
s['statusLine'] = {'type': 'command', 'command': '$STATUS_LINE_CMD'}
with open('$SETTINGS', 'w') as f:
    json.dump(s, f, indent=2)
    f.write('\n')
"
  elif command -v node &>/dev/null; then
    node -e "
const fs = require('fs');
const s = JSON.parse(fs.readFileSync('$SETTINGS', 'utf-8'));
const prev = s.statusLine;
if (prev && prev.command === '$STATUS_LINE_CMD') { console.log('[claudewatch] Claude Code settings already configured.'); process.exit(0); }
if (prev) s._statusLinePrevious = prev;
s.statusLine = { type: 'command', command: '$STATUS_LINE_CMD' };
fs.writeFileSync('$SETTINGS', JSON.stringify(s, null, 2) + '\n');
"
  else
    log "WARNING: Neither python3 nor node found. Please manually add to $SETTINGS:"
    log '  "statusLine": { "type": "command", "command": "~/.claude/bin/claudewatch" }'
    return
  fi

  log "Updated $SETTINGS"
}

download_latest() {
  log "Downloading latest release from GitHub..."

  local url
  url=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | grep -o '"browser_download_url":\s*"[^"]*claudewatch-linux-x64[^"]*"' \
    | head -1 \
    | sed 's/"browser_download_url":\s*"//;s/"$//')

  if [ -z "$url" ]; then
    log "ERROR: Could not find Linux binary in latest release."
    log "Download manually from https://github.com/$REPO/releases"
    exit 1
  fi

  local tmp
  tmp=$(mktemp)
  curl -fsSL -o "$tmp" "$url"
  chmod +x "$tmp"
  echo "$tmp"
}

# --- Main ---

log "Starting ClaudeWatch install..."

if [ $# -ge 1 ] && [ -f "$1" ]; then
  log "Using provided binary: $1"
  install_binary "$1"
else
  tmp=$(download_latest)
  install_binary "$tmp"
  rm -f "$tmp"
fi

update_settings
log "Done! Restart Claude Code to see ClaudeWatch in your status line."
