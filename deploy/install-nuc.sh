#!/usr/bin/env bash
#
# Set up ClaudeWatch metrics + the SDLC loop on a Linux box (tested against a NUC).
#
# Installs user-level systemd units — no root, no sudo. Everything lives under $HOME and
# runs as you.
#
#   ./deploy/install-nuc.sh              # loopback only, no token
#   ./deploy/install-nuc.sh --lan        # bind 0.0.0.0, generates a token for you
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
ENV_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/claudewatch/metrics.env"
LAN=0

for arg in "$@"; do
  case "$arg" in
    --lan) LAN=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '  %s\n' "$*"; }

echo "ClaudeWatch NUC setup"
echo "  repo: $REPO_DIR"

# --- preflight -------------------------------------------------------------
command -v bun >/dev/null 2>&1 || {
  echo "bun is not on PATH. Install it first: https://bun.sh" >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || {
  echo "systemctl not found — this script targets systemd. See deploy/README.md for cron." >&2; exit 1; }

BUN_BIN="$(command -v bun)"
say "bun:  $BUN_BIN"

# --- env file --------------------------------------------------------------
mkdir -p "$(dirname "$ENV_FILE")"
if [ ! -f "$ENV_FILE" ]; then
  {
    echo "# ClaudeWatch metrics configuration. This file holds a secret — keep it 0600."
    echo "CLAUDEWATCH_METRICS_ENDPOINT=http://127.0.0.1:8787"
    if [ "$LAN" = "1" ]; then
      # The service refuses a non-loopback bind without a token, so generate a real one.
      TOKEN="$(head -c 48 /dev/urandom | base64 | tr -d '/+=' | head -c 48)"
      echo "CLAUDEWATCH_METRICS_HOST=0.0.0.0"
      echo "CLAUDEWATCH_METRICS_TOKEN=$TOKEN"
    fi
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  say "wrote $ENV_FILE"
else
  say "kept existing $ENV_FILE"
fi

# --- units -----------------------------------------------------------------
mkdir -p "$UNIT_DIR"
for unit in "$REPO_DIR"/deploy/systemd/*; do
  name="$(basename "$unit")"
  # %h expands to $HOME, but the hardcoded bun path and repo dir need substituting.
  sed -e "s|/usr/local/bin/bun|$BUN_BIN|g" \
      -e "s|%h/claudewatch|$REPO_DIR|g" \
      "$unit" > "$UNIT_DIR/$name"
  say "installed $name"
done

mkdir -p "$HOME/.local/share/claudewatch-metrics"
chmod 700 "$HOME/.local/share/claudewatch-metrics"

systemctl --user daemon-reload
systemctl --user enable --now claudewatch-metrics.service
systemctl --user enable --now claudewatch-ship.timer
systemctl --user enable --now claudewatch-sdlc-loop.timer

# Survive logout. Without this, user units stop when your session ends.
if command -v loginctl >/dev/null 2>&1; then
  loginctl enable-linger "$USER" 2>/dev/null \
    && say "lingering enabled — units keep running after logout" \
    || say "could not enable lingering; run: sudo loginctl enable-linger $USER"
fi

echo
echo "Done."
PORT="$(grep -oP '(?<=CLAUDEWATCH_METRICS_PORT=).*' "$ENV_FILE" 2>/dev/null || echo 8787)"
echo "  dashboard:  http://127.0.0.1:${PORT}/"
if [ "$LAN" = "1" ]; then
  echo "  LAN access: bound to 0.0.0.0 with a bearer token in $ENV_FILE"
  echo "              curl -H \"Authorization: Bearer \$TOKEN\" http://<nuc-ip>:${PORT}/v1/stats"
fi
echo "  status:     systemctl --user status claudewatch-metrics"
echo "  timers:     systemctl --user list-timers 'claudewatch-*'"
echo "  logs:       journalctl --user -u claudewatch-sdlc-loop -f"
