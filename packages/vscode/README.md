# ClaudeWatch for VS Code

[![GitHub Release](https://img.shields.io/github/v/release/joezuchora/claudewatch)](https://github.com/joezuchora/claudewatch/releases/latest)

See your [Claude Code](https://docs.anthropic.com/en/docs/claude-code) usage at a glance — right in the status bar.

## What it does

ClaudeWatch reads your Claude Code credentials (read-only) and queries the usage endpoint to show usage in your status bar. It auto-detects whether your account is on standard or enterprise billing and renders the appropriate view.

**Standard accounts:**
- **Current window** — 5-hour utilization percentage
- **Weekly window** — 7-day utilization percentage
- **Reset times** — when each window resets

**Enterprise accounts:**
- **Monthly credit pool** — utilization, credits used, and monthly limit
- Status bar shows an organization icon (e.g. `$(organization) E 14%`)

Both tiers use color-coded thresholds: default (< 70%), warning/yellow (70-89%), critical/red (90%+).

Hover over the status bar item for a detailed tooltip. Click it to open the Anthropic usage dashboard.


## Telemetry

**Off by default. There is no default destination, and nothing is collected unless you turn
it on and point it somewhere you host.**

VS Code's global telemetry setting always wins. If `telemetry.telemetryLevel` is `off`,
ClaudeWatch collects nothing regardless of its own setting — the extension's setting can only
ever narrow, never widen. Turning the global setting off takes effect immediately, without a
reload.

### What is collected, when you enable it

Health signals about the extension itself:

| Field | Example values |
|---|---|
| Surface | `statusline`, `vscode` |
| Runtime state | `Healthy`, `Stale`, `Degraded`, `AuthInvalid`, … |
| Account tier | `standard`, `enterprise`, `unknown` |
| Utilization bucket | a decile — `0`–`10`, never the exact percentage |
| Fetch outcome | `2xx`, `4xx`, `5xx`, `network`, `timeout`, and an attempt count |
| Cache outcome | `hit`, `miss`, `corruptJson`, `versionMismatch`, … |
| Durations | milliseconds |

### What cannot be collected

Not "is not" — **cannot be**. Every payload field is a number, a boolean, or a value from a
fixed list, so there is no field capable of carrying free text:

- No access or refresh token
- No file path, hostname, username, or machine identifier
- No project or workspace name
- No account identifier, and **no enterprise credit amounts** — your billing position is not
  a health signal, so only the tier and a decile are recorded
- No exact utilization percentage

### Where it goes

Nowhere, by itself. The extension appends metrics to a local file. A separate agent **you**
run ships them to a metrics service **you** host — see
[`deploy/`](https://github.com/joezuchora/claudewatch/tree/main/deploy). ClaudeWatch never
opens a network connection to anything but Anthropic's documented usage endpoint.

Full detail: [SECURITY.md](https://github.com/joezuchora/claudewatch/blob/main/SECURITY.md).

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

Note: this endpoint (`/api/oauth/usage`) is not documented as a public API and has no published schema/versioning contract. The extension treats it as best-effort and degrades safely when upstream response shapes change.

- **Stale data** — shows last known good data with a stale indicator if a refresh fails
- **Cooldown** — backs off for 5 minutes after rate limits or server errors
- **Auth errors** — indicates when credentials are missing, expired, or invalid

## License

[MIT](../../LICENSE)
