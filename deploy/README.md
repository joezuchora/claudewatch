# Running ClaudeWatch's metrics and SDLC loop on your own machine

Built for a Linux box you own — a NUC, a home server, anything with systemd. Everything
runs as your user under `$HOME`. No root, no sudo, no third-party account.

## The short version

```bash
git clone https://github.com/joezuchora/claudewatch.git ~/claudewatch
cd ~/claudewatch && bun install
./deploy/install-nuc.sh          # loopback only
./deploy/install-nuc.sh --lan    # reachable from your LAN, token generated for you
```

Then open <http://127.0.0.1:8787/>.

## What gets installed

| Unit | What it does | Schedule |
|---|---|---|
| `claudewatch-metrics.service` | The metrics API and dashboard | always on, restarts on failure |
| `claudewatch-ship.timer` | Ships the local telemetry spool to the service | every 5 min |
| `claudewatch-sdlc-loop.timer` | Fetches, runs the instrumented gate, ships the result | hourly at :17 |

The SDLC loop timer is what makes monitoring continuous. Every firing records a `verify_run`
event whatever the outcome — **including the firings that hang**, because the gate bounds each
step and records a `timeout` rather than blocking forever. That is the data the hang
investigation needs and could not previously collect.

Recording is **opt-in** and the unit opts in for you: `claudewatch-sdlc-loop.service` sets
`Environment=CLAUDEWATCH_VERIFY_METRICS=1`. Elsewhere — a clone on a laptop, a contributor's
fork, CI — `bun run verify` records nothing unless that variable is set. The gate's payload
carries repo-relative source paths and test names, so it is a description of a repository, and
the machine's owner decides whether to keep one. See `SPEC.md` §17.

## Network exposure

The service binds to `127.0.0.1` by default. To reach it from another machine you must set
both `CLAUDEWATCH_METRICS_HOST=0.0.0.0` **and** a token of at least 32 characters — the
service **refuses to start** with a non-loopback bind and no token rather than quietly
exposing an unauthenticated write endpoint on your network. `--lan` sets both up for you.

The token gates every route, including the dashboard, and is compared in constant time.

Secrets live in `~/.config/claudewatch/metrics.env` (mode `0600`), never in the unit files,
which are world-readable.

## Running Claude Code itself on the NUC

Claude Code on the web runs in Anthropic's cloud and **cannot target your NUC** — there is no
self-hosted runner registered for your account, and the web environment list confirms only
`Default` (`anthropic_cloud`). The direction that works is the other one: install the CLI on
the NUC and drive it there.

```bash
curl -fsSL https://claude.ai/install.sh | bash     # or: npm i -g @anthropic-ai/claude-code
claude                                              # sign in once, interactively
```

Once authenticated, headless invocation works from a timer:

```bash
claude -p "Run /sdlc-review on the current branch and report findings" \
  --output-format json
```

To wire that into the hourly loop, add an `ExecStart=` line to
`claudewatch-sdlc-loop.service`. Two cautions worth taking seriously:

- **Give it a bounded, specific prompt.** An open-ended prompt on a timer with no human
  present is how you get surprising commits at 3am.
- **Do not enable `--dangerously-skip-permissions`** on an unattended box. If a step needs
  approval, it should stop and wait for you rather than proceed.

The metrics half of this setup needs none of that — it is plain Bun and runs unattended
safely, which is why it is the part the installer wires up by default.

## Without systemd

The units are thin wrappers. The equivalent cron:

```cron
@reboot      cd ~/claudewatch && bun run packages/metrics/src/cli-serve.ts >> ~/.cache/cw-metrics.log 2>&1
*/5 * * * *  cd ~/claudewatch && CLAUDEWATCH_METRICS_ENDPOINT=http://127.0.0.1:8787 bun run packages/metrics/src/cli-ship.ts
17 * * * *   cd ~/claudewatch && bun run verify; bun run packages/metrics/src/cli-ship.ts
```

Note `@reboot` gives you no restart-on-failure — that is what the systemd unit buys.

## Enabling product telemetry

Off by default, with no destination. To turn it on for the statusline:

```bash
mkdir -p ~/.config/claudewatch
echo '{"telemetry":{"enabled":true}}' > ~/.config/claudewatch/config.json
```

Or per-invocation with `CLAUDEWATCH_TELEMETRY=1`. In VS Code, set
`claudewatch.telemetry.enabled`.

The product writes to a local spool and **never opens a socket** — the agent above is what
ships it, to the service you are hosting. Payloads carry only numbers, booleans and values
from fixed lists: no token, path, hostname, username, or account identifier can appear.

`source: "sdlc"` events, written by the repository's own `verify` gate rather than by the
product, additionally carry repo-relative source paths, test names and a failure-type
identifier — the developer's code, not yours, each scrubbed of path-shaped text first. No event of any source carries an absolute path, a home directory, a hostname, or a
username. See [`SECURITY.md`](../SECURITY.md) and `SPEC.md` §17.

The agent ships every spooled line to your service verbatim — it performs no redaction of its
own. Whatever reaches the spool reaches the service, so the sanitization above is the only
boundary, and on a LAN deployment it travels in plaintext unless you put TLS in front of the
service.

## Operating it

```bash
systemctl --user status claudewatch-metrics
systemctl --user list-timers 'claudewatch-*'
journalctl --user -u claudewatch-sdlc-loop -f

curl -s http://127.0.0.1:8787/v1/stats | jq          # aggregates
curl -s 'http://127.0.0.1:8787/v1/events?kind=verify_run&limit=20' | jq
```

The store is `~/.local/share/claudewatch-metrics/metrics.db` (SQLite, WAL, mode `0600`).
Events older than 90 days are pruned on startup and daily, so it will not grow without bound
on a box that runs for years.

## Uninstalling

```bash
systemctl --user disable --now claudewatch-metrics.service \
  claudewatch-ship.timer claudewatch-sdlc-loop.timer
rm -f ~/.config/systemd/user/claudewatch-*
systemctl --user daemon-reload
```

The store and config are left in place deliberately — delete
`~/.local/share/claudewatch-metrics` and `~/.config/claudewatch` if you want them gone.
