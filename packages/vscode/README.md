# ClaudeWatch for VS Code

[![GitHub Release](https://img.shields.io/github/v/release/joezuchora/claudewatch)](https://github.com/joezuchora/claudewatch/releases/latest)

See your [Claude Code](https://docs.anthropic.com/en/docs/claude-code) usage at a glance — right in the status bar.

## What it does

ClaudeWatch reads your Claude Code credentials (read-only) and queries the usage endpoint to show:

- **Current window** — 5-hour utilization percentage
- **Weekly window** — 7-day utilization percentage
- **Reset times** — when each window resets
- **Color-coded thresholds** — default (< 70%), warning/yellow (70-89%), critical/red (90%+)

Hover over the status bar item for a detailed tooltip. Click it to open the Anthropic usage dashboard.

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and signed in
- Windows or Linux (macOS support planned)

## Install

Not yet on the Marketplace. Build and install the `.vsix` manually:

```bash
git clone https://github.com/joezuchora/claudewatch.git
cd claudewatch
bun install
bun run --filter claudewatch-vscode build
cd packages/vscode
npx @vscode/vsce package --no-dependencies
```

Then in VS Code: `Ctrl+Shift+P` > **Extensions: Install from VSIX...** > select the generated `.vsix` file.

## Settings

| Setting | Default | Description |
|---|---|---|
| `claudewatch.refreshIntervalSeconds` | `60` | Polling interval (minimum 30s) |
| `claudewatch.warningThresholdPct` | `70` | Yellow threshold percentage |
| `claudewatch.criticalThresholdPct` | `90` | Red threshold percentage |

## Commands

| Command | Description |
|---|---|
| `ClaudeWatch: Refresh Now` | Force an immediate usage refresh |
| `ClaudeWatch: Open Usage Dashboard` | Open the Anthropic console in your browser |

## Error handling

ClaudeWatch uses an undocumented API endpoint and handles failures gracefully:

- **Stale data** — shows last known good data with a stale indicator if a refresh fails
- **Cooldown** — backs off for 5 minutes after rate limits or server errors
- **Auth errors** — indicates when credentials are missing, expired, or invalid

## License

[MIT](../../LICENSE)
