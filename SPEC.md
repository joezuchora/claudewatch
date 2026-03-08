# ClaudeWatch v1.0 Specification (Rev 2)

> **Status:** Ready for Scaffolding
> **Author:** Joe | **Date:** March 7, 2026

---

## 1. Overview

ClaudeWatch is a personal open-source companion tool for Claude Code that surfaces Claude account usage window data directly inside the developer workflow. Its purpose is to reduce context switching by showing usage status inside the editor and terminal, while being explicit about the limitations of undocumented upstream APIs.

ClaudeWatch ships as two complementary surfaces built from a shared usage domain model:

- **VS Code / Cursor extension** with a non-intrusive status bar item and tooltip
- **Claude Code terminal status line** via a compiled binary invoked from a shell prompt hook

ClaudeWatch is not a full analytics product in v1. Its goal is fast, trustworthy situational awareness: current usage windows, reset timing, and failure state transparency.

### 1.1 Product Principles

- Passive, glanceable, low-noise UX
- Graceful degradation over brittle failure
- Clear distinction between account-window data and session-scoped data
- No hidden credential handling or background mutation
- Open-source friendly design with explicit trust boundaries
- Implementation simplicity over speculative feature depth
- Single compiled binary for the terminal surface; no runtime dependencies

### 1.2 Goals

- Show current Claude account usage windows directly inside the development workflow
- Provide a lightweight, reliable status bar experience inside VS Code / Cursor
- Provide a lightweight terminal status line experience inside Claude Code via compiled binary
- Surface reset timing for the current usage windows
- Handle partial failure and upstream instability without crashing or becoming noisy
- Keep the implementation small, understandable, and open-source friendly

### 1.3 Non-Goals

- Session-scoped metadata (model, tokens, cost, context) in v1
- macOS support in v1 (requires Keychain integration)
- Full OAuth flow for users without Claude Code installed
- Historical persistence, trend charts, or burn-rate analytics
- Multi-account support
- Independent token refresh logic
- Official Anthropic support or API stability guarantees
- Any behavior that guesses or synthesizes unavailable fields
- Marketplace publishing in the first release

### 1.4 Constraints and Risks

| Constraint / Risk | Impact | Mitigation |
|---|---|---|
| Undocumented API endpoint | Upstream contract may change or disappear without notice | Strong disclaimer, contract isolation in core client, malformed-response handling, degraded-state UX |
| Credential file may contain stale token | ClaudeWatch may fail auth while Claude Code still appears functional | Explicit AuthInvalid state, actionable remediation message, documented limitation |
| Frequent invocation from prompt hook | Unnecessary network traffic, noisy failures, performance overhead | Cache TTL, stale-while-error behavior, in-flight request dedupe, bounded retries, cooldown after failure |
| Cross-platform shell/editor variability | Support burden and inconsistent behavior | Windows + Linux only in v1; explicit compatibility matrix and bounded support scope |
| Endpoint rate limiting (429s observed) | Usage data temporarily unavailable even with valid credentials | Stale-while-error semantics, cache TTL of 10 minutes, 5-minute cooldown after 429, no aggressive retry |

---

## 2. Technical Decisions

The following decisions are locked for v1 and must not be revisited without explicit justification.

### 2.1 Platform Scope

- **v1:** Windows 11 + Linux. Both use file-based credentials at the same path.
- **v2:** macOS (requires Keychain integration via `security find-generic-password`).

### 2.2 Toolchain

| Component | Choice |
|---|---|
| Package manager | bun workspaces |
| Bundler | bun build (all packages) |
| Test runner | bun test |
| Statusline binary | `bun build --compile` (single binary, zero runtime deps) |
| Language | TypeScript (strict mode) |
| VS Code extension bundler | bun build targeting CommonJS for VS Code host |
| Minimum Node version | 18+ (VS Code extension host) |
| Minimum bun version | 1.0+ (build and test) |

### 2.3 Statusline Runtime

The terminal status line ships as a single compiled binary produced by `bun build --compile`. It integrates via Claude Code's built-in status line feature — a single `bun run install-statusline` command copies the binary to `~/.claude/bin/` and configures `~/.claude/settings.json`. No shell profile editing required.

The binary reads the file-backed cache, returns formatted output to stdout, and exits. If the cache is expired, it performs a single HTTP fetch, updates the cache, and returns. This keeps prompt latency low on cache hits.

### 2.4 Session Data

Session-scoped metadata (model name, token counts, cost, context usage) is deferred to v2. v1 surfaces only usage-window data from the Anthropic usage endpoint. This decision simplifies the domain model and ensures both surfaces (VS Code and terminal) have identical data available.

---

## 3. API Contract (Last Observed)

> **WARNING:** This endpoint is undocumented and may change without notice. All contract details below represent the last observed behavior as of March 2026. ClaudeWatch must handle schema drift gracefully.

### 3.1 Usage Endpoint

| Property | Value |
|---|---|
| Method | `GET` |
| URL | `https://api.anthropic.com/api/oauth/usage` |
| Auth header | `Authorization: Bearer {accessToken}` |
| Required header | `anthropic-beta: oauth-2025-04-20` |
| Content-Type | `application/json` |
| HTTP timeout | 5 seconds (hard kill) |
| TLS | TLS verification must never be disabled |

### 3.2 Response Schema (Last Observed)

```json
{
  "five_hour": {
    "utilization": 6.0,
    "resets_at": "2025-11-04T04:59:59.943648+00:00"
  },
  "seven_day": {
    "utilization": 35.0,
    "resets_at": "2025-11-06T03:59:59.943679+00:00"
  },
  "seven_day_oauth_apps": null,
  "seven_day_opus": {
    "utilization": 0.0,
    "resets_at": null
  },
  "iguana_necktie": null
}
```

### 3.3 Required vs Optional Fields

| Field | Required for v1 | Notes |
|---|---|---|
| `five_hour.utilization` | Yes (at least one window) | Number, percentage 0-100 |
| `five_hour.resets_at` | Yes (if window present) | ISO 8601 timestamp with timezone |
| `seven_day.utilization` | Yes (at least one window) | Number, percentage 0-100 |
| `seven_day.resets_at` | Yes (if window present) | ISO 8601 timestamp with timezone |
| `seven_day_opus` | No | Optional separate Opus window; may be null |
| `seven_day_oauth_apps` | No | Ignore in v1 |
| `iguana_necktie` | No | Unknown Anthropic internal field — intentionally ignored |

### 3.4 Parsing Rules

- Required fields must be explicitly validated before use
- Optional and unknown fields must not break parsing
- If both windows are null, classify as Degraded
- If the response is valid JSON but missing all required fields, classify as malformed
- If the response is not valid JSON, classify as malformed
- Record normalization warnings internally but do not surface them to users

---

## 4. Authentication and Credential Handling

### 4.1 Credential Source

ClaudeWatch reads the existing Claude Code credential file from the local filesystem. It does not create, modify, or refresh credentials in v1.

### 4.2 Credential File Location

| Platform | Path | v1 Support |
|---|---|---|
| Windows | `%USERPROFILE%\.claude\.credentials.json` | Yes |
| Linux | `~/.claude/.credentials.json` | Yes |
| macOS | System Keychain (`Claude Code-credentials`) | No (v2) |

### 4.3 Credential File Format

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-...",
    "refreshToken": "sk-ant-ort01-...",
    "expiresAt": 1748276587173,
    "scopes": ["user:inference", "user:profile"]
  }
}
```

**Required fields for ClaudeWatch:** `claudeAiOauth.accessToken`. All other fields are informational.

**`expiresAt`** is a Unix timestamp in milliseconds. ClaudeWatch should check this before making API calls and surface AuthInvalid if the token is expired, but should not rely on it as the sole validity check (the endpoint may reject before expiry or accept after).

### 4.4 Limitations

- ClaudeWatch does not own or refresh the session token
- The credential file may become stale even if Claude Code otherwise appears present
- ClaudeWatch cannot guarantee continuity if the upstream auth model changes
- The `user:profile` scope is required for the usage endpoint; tokens without this scope will return 401

### 4.5 Remediation Guidance

When authentication fails, instruct the user to re-authenticate via Claude Code rather than through ClaudeWatch.

---

## 5. Usage Domain Model

### 5.1 Canonical Internal Model

All surfaces normalize the API response into a shared internal model.

```typescript
interface UsageSnapshot {
  fetchedAt: string;                    // ISO timestamp, always UTC
  source: {
    usageEndpoint: 'success' | 'failed' | 'unavailable';
  };
  authState: 'valid' | 'invalid' | 'missing' | 'unknown';
  fiveHour: {
    utilizationPct: number | null;
    resetsAt: string | null;            // ISO timestamp, always UTC
  };
  sevenDay: {
    utilizationPct: number | null;
    resetsAt: string | null;            // ISO timestamp, always UTC
  };
  display: {
    primaryWindow: 'fiveHour' | 'sevenDay' | 'unknown';
    primaryUtilizationPct: number | null;
    primaryResetsAt: string | null;
  };
  freshness: {
    isStale: boolean;
    staleReason: 'none' | 'fetchFailed' | 'authInvalid'
                | 'sourceUnavailable' | 'malformedResponse';
  };
  rawMetadata: {
    normalizationWarnings: string[];
  };
}
```

### 5.2 Source-of-Truth Policy

- Usage-window fields are sourced only from the Anthropic usage endpoint
- Derived display fields are computed locally
- If a field is unavailable from its source, it is omitted or shown as unavailable; it is never guessed

### 5.3 Primary Display Rule

The primary displayed utilization value is always the more constrained of the five-hour and seven-day usage windows, defined as the higher utilization percentage among valid window values.

If only one valid window is available, that window becomes primary. If neither window is available, the surface enters Degraded, NotConfigured, AuthInvalid, or HardFailure based on failure classification.

---

## 6. Time Handling

### 6.1 Time Normalization Rules

- All timestamps from the API must be parsed as UTC
- All internal timestamps (`fetchedAt`, cache timestamps) are stored as UTC
- Display formatting converts UTC to local system time for user-facing output
- Relative time formatting (e.g., "resets in 2h 14m") must be computed from `Date.now()` against the UTC `resets_at` value

### 6.2 Edge Cases

- If `resets_at` is in the past relative to `fetchedAt` (i.e., `resets_at < fetchedAt`), treat the window as reset imminent and display "resets soon" or equivalent rather than a negative duration
- If system clock appears significantly skewed (e.g., `fetchedAt` is more than 5 minutes in the future relative to `Date.now()`), log a normalization warning but do not block rendering

---

## 7. Runtime State Model and Failure Classification

### 7.1 Runtime States

| State | Description |
|---|---|
| Initializing | No successful snapshot yet; initial load is in progress |
| Healthy | At least one valid usage window is available and current data is fresh |
| Stale | Last known good snapshot is being shown because the latest refresh failed |
| Degraded | Tool is running but required fields are partially unavailable; partial rendering possible |
| AuthInvalid | Credential exists but endpoint returned 401 or token is expired/unusable |
| NotConfigured | Claude Code credentials file not found or cannot be parsed |
| HardFailure | Unexpected unrecoverable error prevented rendering |

### 7.2 Failure Classes

| Class | Trigger |
|---|---|
| Not configured | Credentials file missing or unreadable |
| Auth invalid | 401 or equivalent authentication failure; expired token |
| Service unavailable | Network timeout, DNS failure, API unreachable, 5xx, 429 |
| Malformed response | Response shape no longer matches minimum required contract |
| Unexpected runtime failure | Unhandled logic or environment issue |

### 7.3 UX Rules by State

| State | Behavior |
|---|---|
| Healthy | Show normal usage display |
| Stale | Show last known good usage with stale indicator |
| Degraded | Show partial usage with missing fields omitted |
| AuthInvalid | Show error styling and remediation to re-authenticate via Claude Code |
| NotConfigured | Show blocking error styling and install/sign-in guidance |
| HardFailure | Show compact error state without crashing |

---

## 8. Architecture

### 8.1 Repository Structure

All code lives in a single public GitHub repository named `claudewatch`. The repository is organized as a bun workspace monorepo with three packages:

```
claudewatch/
  package.json              # bun workspace root
  tsconfig.json             # shared TypeScript config
  packages/
    core/
      src/
        types.ts            # UsageSnapshot, all enums and interfaces
        credentials.ts      # credential file resolution + parsing
        client.ts           # API client (fetch, auth header, timeout)
        normalize.ts        # response -> UsageSnapshot
        state.ts            # state classification logic
        thresholds.ts       # warning/critical evaluation
        cache.ts            # file-backed cache with TTL + atomic write
        cooldown.ts         # endpoint failure cooldown tracking
        format.ts           # formatting helpers
        time.ts             # UTC parsing, relative formatting, edge cases
      index.ts              # public API barrel export
      package.json
    vscode/
      src/
        extension.ts        # activation, lifecycle
        statusbar.ts        # status bar item rendering
        tooltip.ts          # tooltip content generation
        commands.ts         # registered commands
      package.json          # VS Code extension manifest
    statusline/
      src/
        main.ts             # binary entrypoint
      package.json
      install/
        install.ts          # one-command installer for Claude Code status line
```

### 8.2 Architectural Rules

- Business logic lives in `packages/core`. Surfaces are thin rendering layers.
- Thresholds, state classification, formatting rules, and source precedence must behave identically across surfaces.
- The statusline binary consumes `packages/core` at compile time (bundled into the binary).
- The VS Code extension consumes `packages/core` as a workspace dependency.

### 8.3 Core Responsibilities

- Credential file resolution and parsing
- Usage endpoint request/response handling (with 5s timeout)
- Snapshot normalization
- Primary window selection
- Failure classification
- Threshold evaluation
- Stale-while-error semantics
- File-backed cache management (with corruption recovery)
- Endpoint failure cooldown tracking
- Time normalization and relative formatting
- Formatting helpers for percentages, reset times, and freshness text

### 8.4 Surface Responsibilities

**VS Code / Cursor extension:**
- Status bar rendering and color state management
- Tooltip rendering
- Settings management
- Manual refresh and open dashboard commands

**Statusline binary:**
- Fast output for frequent shell invocation
- File-backed cache reads (shared with core)
- Compact formatting under narrow width
- CLI flag handling (`--debug`, `--refresh`, `--version`, `--json`)
- Clean exit codes; no stack traces or verbose error output

---

## 9. Refresh, Polling, and Cache Semantics

Default refresh interval is 60 seconds. Minimum configurable interval for the extension is 30 seconds. Cache TTL is 10 minutes (600 seconds) — the extension re-renders from cache on each poll but only fetches from the network when the cache has expired.

### 9.1 Stale-While-Error Behavior

- If cached data is younger than TTL, return cached data without network call
- If cached data is expired, attempt refresh
- If refresh succeeds, replace cache and clear stale markers
- If refresh fails and a previous good snapshot exists, continue showing previous snapshot as stale
- If refresh fails and no previous good snapshot exists, classify into NotConfigured, AuthInvalid, Degraded, or HardFailure

### 9.2 Concurrency Rules

- Only one refresh may be in flight per surface at a time
- Concurrent requests must dedupe to the same in-flight refresh
- TTL is measured from successful response completion time
- Manual refresh bypasses TTL but still respects in-flight dedupe and cooldown

### 9.3 Retry Policy

- 1 immediate attempt + 1 retry with 2-second delay (MAX_RETRIES = 1)
- Auth errors (401) and rate limits (429) are not retried — they won't resolve on retry
- No aggressive looping beyond that

### 9.4 Endpoint Failure Cooldown

If the endpoint returns 429, 5xx, or a network failure (timeout, DNS, connection refused), ClaudeWatch enters a **cooldown period of 5 minutes (300 seconds)** during which no new network requests are attempted. Cached data continues to be served as stale. The cooldown timestamp is stored in the cache file so it is shared between the VS Code extension and the statusline binary.

This prevents accidental rate-limit amplification when the prompt hook fires frequently during an outage.

### 9.5 Non-Blocking Cache Reads

Cache reads must never trigger blocking network calls during prompt rendering. The statusline binary flow is:

1. Read cache file
2. If cache is fresh → format and return immediately
3. If cache is expired and not in cooldown → attempt fetch (subject to HTTP timeout of 5s)
4. If in cooldown → return stale cached data immediately

The VS Code extension runs fetches asynchronously on its polling interval and never blocks the extension host.

### 9.6 File-Backed Cache

**Cache location (both platforms):**

```
~/.cache/claudewatch/usage.json
```

On Linux this follows `$XDG_CACHE_HOME` convention (defaults to `~/.cache`). On Windows `~` resolves to `%USERPROFILE%`. The `~/.cache/claudewatch/` directory is created on first write if it does not exist.

**Cache file format:**

```json
{
  "version": 1,
  "snapshot": { /* UsageSnapshot */ },
  "cooldownUntil": null,
  "lastErrorClass": null,
  "lastHttpStatus": null,
  "lastErrorMessage": null
}
```

The `version` field enables future cache format migrations without corruption.

**Cache rules:**
- No access token may ever be written to the cache file
- Writes use atomic rename (write to temp file in same directory, then rename) to prevent corruption from concurrent access
- If the cache file cannot be parsed (invalid JSON, truncated, partially written), delete it and treat as a cache miss — perform a fresh fetch
- If the cache directory does not exist, create it with user-only permissions (`0700`)

---

## 10. VS Code / Cursor Extension

### 10.1 Activation

The extension activates on editor startup and initializes ClaudeWatch in the background without stealing focus.

### 10.2 Status Bar Item

The status bar item is right-aligned and displays the primary utilization percentage only.

| State | Display | Example |
|---|---|---|
| Normal | Graph icon + percentage | `$(graph) 42%` |
| Loading | Spinner + last known value | `$(sync~spin) 42%` |
| Error | Warning icon + name | `⚠ ClaudeWatch` |

### 10.3 Color States

| Condition | Default Threshold | Color |
|---|---|---|
| Normal | < 70% | Default status bar text |
| Warning | ≥ 70% | Warning foreground + background |
| Critical | ≥ 90% | Error foreground + background |
| AuthInvalid / Degraded | N/A | Error text, no background |
| NotConfigured | N/A | Error background per VS Code guidance |

### 10.4 Hover Tooltip

Tooltip content shows account-window data and status. Session data section is omitted in v1.

```
ClaudeWatch

Usage Windows
Current (5hr): 42% — resets 3:00 PM
Weekly (7d): 18% — resets Thu 7:00 AM

Status
Fresh as of 2:14 PM

Click to open usage dashboard →
```

If stale: `Showing last known good data; latest refresh failed.`

Optional fields must be omitted cleanly if unavailable. They must not render as zero unless zero is explicitly known. All displayed times are converted to local system time.

### 10.5 Commands

- `ClaudeWatch: Refresh Now` — manual refresh, bypasses TTL (still respects cooldown)
- `ClaudeWatch: Open Usage Dashboard` — opens claude.ai usage page in browser

### 10.6 Settings

| Setting | Type | Default |
|---|---|---|
| `claudewatch.refreshIntervalSeconds` | number | 60 |
| `claudewatch.warningThresholdPct` | number | 70 |
| `claudewatch.criticalThresholdPct` | number | 90 |

### 10.7 Error and Degraded States

| Error Condition | Classification | Tooltip Message |
|---|---|---|
| Credentials file not found | NotConfigured | Claude Code credentials not found. Install Claude Code and sign in. |
| Credentials unreadable/invalid | NotConfigured | Claude Code credentials not found. Install Claude Code and sign in. |
| Endpoint returns 401 | AuthInvalid | Session token is invalid or expired. Re-authenticate via Claude Code. |
| Network failure + good cache | Stale | Showing last known good data; latest refresh failed. |
| Malformed response | Degraded / HardFailure | Usage response format changed. The undocumented endpoint may have changed. |

---

## 11. Claude Code Status Line

### 11.1 Binary Behavior

The statusline binary is a self-contained executable produced by `bun build --compile`. It reads the file-backed cache, optionally performs a network fetch if cache is expired and not in cooldown, writes formatted output to stdout, and exits. The binary shares all logic from `packages/core`.

### 11.2 Output Format

| Format | Trigger | Example |
|---|---|---|
| Default | No stdin JSON | `⊙ 42% resets 3:00pm · 7d 18% resets sat 7:00am` |
| Compact | Terminal width < 60 | `⊙ 42%` |
| Rich | stdin JSON from Claude Code | Multi-line with session info, usage bars, model + reset times |
| Error | Any failure state | `⊙ error` |

**Rich statusline mode:** When Claude Code pipes session JSON via stdin, the binary switches to a multi-line ANSI-colored format:

- Line 1: Project name, context window tokens, context usage %
- Line 2: Current (5hr) and weekly (7d) usage with progress bars
- Line 3: Model name, reset times

The `SessionInfo` type consumed from stdin includes `workspace.project_dir`, `context_window` (token counts), and `model` fields. Unknown/missing fields are omitted gracefully.

### 11.3 Terminal Width Detection

Terminal width is detected using `process.stdout.columns`. If unavailable (e.g., piped output), assume width = 80. Compact mode activates when width < 60.

Priority of truncation: remove secondary reset time first, then primary reset time, then secondary window, preserve primary utilization as long as possible.

### 11.4 CLI Flags

| Flag | Behavior |
|---|---|
| `--version` | Print version string and exit |
| `--json` | Output the full UsageSnapshot as JSON instead of formatted text |
| `--refresh` | Force a fresh API call, bypassing cache TTL (still respects cooldown) |
| `--debug` | Print diagnostic info: cache age, state classification, cooldown status, credential path, normalization warnings. No secrets. |

### 11.5 Exit Codes

| Code | Meaning |
|---|---|
| 0 | Success — healthy or stale data rendered |
| 1 | Fetch failed — no cache available, could not reach endpoint |
| 2 | Configuration error — credentials missing or unreadable |
| 3 | Unexpected runtime failure |

### 11.6 Installation

ClaudeWatch installs as a Claude Code built-in status line command. A single command builds the binary, copies it to `~/.claude/bin/`, and configures `~/.claude/settings.json`:

```bash
bun run install-statusline
```

The installer:
1. Builds the statusline binary for the current platform (Windows or Linux).
2. Copies the binary to `~/.claude/bin/claudewatch[.exe]`.
3. Sets `statusLine` in `~/.claude/settings.json` to `{ type: 'command', command: '<path to binary>' }`.
4. Backs up any previous `statusLine` config to `_statusLinePrevious`.

After installation, restart Claude Code. No shell profile editing required.

**Platform support:** Windows (x64) and Linux (x64). macOS is unsupported in v1 (see §1.3); the installer exits with a clear error on unsupported platforms.

### 11.7 Performance Targets

| Scenario | Target |
|---|---|
| Cache hit (binary start → stdout) | < 50ms |
| Cache miss (binary start → fetch → stdout) | < 1000ms |
| HTTP timeout (hard kill) | 5 seconds |

---

## 12. Security and Trust Boundaries

ClaudeWatch is a local companion utility, not a credential manager.

- It reads Claude Code's credential file but never modifies it
- It never logs or persists access tokens
- It does not include telemetry in v1
- It does not transmit any data except authenticated GET requests to the Anthropic usage endpoint
- TLS verification must never be disabled
- It must redact sensitive values from all surfaced errors
- It must not include tokens in issue templates, screenshots, or debug output
- It must not shell out with token values in process arguments
- Cache files must never contain the access token
- The compiled binary must not embed credentials at build time
- The `--debug` flag must never output token values or credential file contents

---

## 13. Compatibility Matrix

### 13.1 Supported in v1

- Windows 11 with PowerShell 7+
- Linux with Bash
- VS Code Stable current major release
- Cursor on a best-effort basis, explicitly tested before claiming support

### 13.2 Not Supported in v1

- macOS (requires Keychain integration)
- WSL-specific credential path edge cases
- Fish shell, zsh (Bash wrapper may work but untested)
- Older Windows PowerShell 5.x-only environments
- Editor forks beyond VS Code/Cursor

---

## 14. Acceptance Criteria

- Given valid credentials and reachable endpoint, the extension shows a usage state within one polling cycle of activation
- Given a cached snapshot younger than TTL, no additional network call is made
- Given expired cache and successful refresh, the snapshot is updated and stale markers are cleared
- Given expired cache and failed refresh with previous good data, the previous data remains visible and is marked stale
- Given missing credentials, both surfaces show NotConfigured behavior without crashing
- Given 401 from the endpoint, both surfaces show AuthInvalid behavior and a clear remediation message
- Given 429 from the endpoint, cooldown activates for 5 minutes; stale-while-error continues serving cached data
- Given malformed endpoint data, the tool does not crash and enters Degraded or HardFailure
- Given a narrow terminal width (< 60 columns), the status line collapses to the compact format
- Given multiple refresh triggers at once, only one network fetch occurs
- Given stale data, the user can distinguish it from fresh data in the tooltip or status context
- Given a corrupt or unparseable cache file, the file is deleted and a fresh fetch is performed
- Given `resets_at` in the past, the display shows "resets soon" rather than a negative duration
- The compiled binary meets performance targets: < 50ms cache hit, < 1000ms cache miss
- `claudewatch --json` outputs valid JSON matching the UsageSnapshot schema
- `claudewatch --debug` outputs diagnostic info without any secrets

---

## 15. Test Strategy

### 15.1 Unit Tests (bun test)

- Credential path resolution per platform
- Credential JSON parsing (valid, malformed, missing fields)
- Threshold evaluation (normal, warning, critical)
- Primary window selection (both windows, one window, neither)
- Failure classification for each error type
- Tooltip formatting
- Status line formatting (default, compact, error)
- Stale-while-error cache behavior
- Width-aware status line fallback (columns > 60, < 60, undefined)
- Atomic cache write behavior
- Cache corruption recovery (invalid JSON, truncated file, empty file)
- Cooldown tracking (enter cooldown, respect cooldown, expire cooldown)
- Time normalization (UTC parsing, relative formatting, negative duration guard, clock skew warning)
- Exit code correctness for each state
- CLI flag parsing (`--json`, `--debug`, `--refresh`, `--version`)

### 15.2 Contract Tests

Use recorded or mocked responses for:

- Successful response with both windows
- Successful response with only one window
- Response with `seven_day_opus` present
- Response with unknown extra fields (forward compatibility)
- 401 response
- 429 response
- 5xx response
- Malformed JSON
- Valid JSON with missing required fields
- Network timeout (>5s)
- DNS resolution failure

### 15.3 Manual Smoke Tests

- VS Code on Windows
- VS Code on Linux
- Cursor validation
- Bash status line rendering
- PowerShell status line rendering
- Credential-missing scenario
- Auth-invalid scenario
- Offline/network-failure scenario
- Rapid repeated terminal invocation scenario (50 prompt renders in 10 seconds)
- `claudewatch --json` output validation
- `claudewatch --debug` output contains no secrets

### 15.4 Non-Functional Checks

- No token written to logs
- No token written to cache file
- No unhandled exceptions in extension host
- No user-facing stack traces in status line output
- Binary startup + cache-hit response under 50ms
- `--debug` output contains no token values

---

## 16. Packaging and Distribution

### 16.1 v1 Release Artifacts

- Public GitHub repository with source code and build instructions
- `.vsix` artifact for manual VS Code/Cursor install
- Compiled binaries for Windows (x64) and Linux (x64) via `bun build --compile --target`
- One-command installer for Claude Code status line (`bun run install-statusline`)

### 16.2 Deferred

- VS Code Marketplace publishing
- macOS binary
- Auto-update channel
- Complex onboarding workflow

---

## 17. Observability and Debugging

Logging is minimal and local-only. No telemetry in v1.

**Allowed debug information** (surfaced via `--debug` flag): state classification, timestamp of last successful refresh, cache age, cooldown status, credential file path (not contents), normalization warnings, cache file path, terminal width detected.

**Forbidden debug information:** access token, raw credential payload, raw Authorization headers, refresh token, personally sensitive filesystem detail beyond what is necessary.

---

## 18. Scaffolding Guide

This section provides the exact steps to go from zero to a working repo.

### 18.1 Prerequisites

- Bun 1.0+ installed (`curl -fsSL https://bun.sh/install | bash` or via npm/scoop on Windows)
- VS Code with `@vscode/vsce` installed globally for extension packaging
- Claude Code installed and authenticated (for credential file to exist)
- Git initialized

### 18.2 Step 1: Initialize the Monorepo

```bash
mkdir claudewatch && cd claudewatch
git init
bun init -y
```

Edit `package.json`:

```json
{
  "name": "claudewatch",
  "private": true,
  "workspaces": ["packages/*"]
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "declaration": true,
    "sourceMap": true
  }
}
```

Create `.gitignore`:

```
node_modules/
dist/
*.vsix
.cache/
```

### 18.3 Step 2: Create packages/core

```bash
mkdir -p packages/core/src
cd packages/core
bun init -y
```

`packages/core/package.json`:

```json
{
  "name": "@claudewatch/core",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "build": "bun build src/index.ts --outdir dist --target node",
    "test": "bun test"
  }
}
```

Create these source files:

| File | Responsibility |
|---|---|
| `src/types.ts` | `UsageSnapshot`, all enums, interfaces, `RuntimeState`, `FailureClass`, `CacheEnvelope` |
| `src/credentials.ts` | Resolve credential file path per platform, parse JSON, extract `accessToken`, check `expiresAt` |
| `src/client.ts` | `fetchUsage(token: string): Promise<FetchResult>` — single GET with auth headers, 5s timeout, 1 retry for 5xx/network errors |
| `src/normalize.ts` | `normalize(raw: unknown, fetchedAt?: string): UsageSnapshot` — validate required fields, compute primary window |
| `src/state.ts` | `classify(snapshot: UsageSnapshot): RuntimeState` — state machine |
| `src/thresholds.ts` | `evaluate(pct: number, warn: number, crit: number): 'normal' \| 'warning' \| 'critical'` |
| `src/cache.ts` | Read/write `~/.cache/claudewatch/usage.json` with TTL check, atomic rename, corruption recovery |
| `src/cooldown.ts` | Track and check cooldown state after endpoint failures (5-minute window) |
| `src/time.ts` | UTC parsing, local display conversion, relative formatting, negative duration guard |
| `src/format.ts` | Format percentage, reset time (relative + absolute), freshness text, compact vs default |
| `src/index.ts` | Barrel export of public API |

### 18.4 Step 3: Create packages/statusline

```bash
mkdir -p packages/statusline/src
mkdir -p packages/statusline/install
cd packages/statusline
bun init -y
```

`packages/statusline/package.json`:

```json
{
  "name": "@claudewatch/statusline",
  "version": "0.1.0",
  "type": "module",
  "dependencies": {
    "@claudewatch/core": "workspace:*"
  },
  "scripts": {
    "build": "bun build --compile src/main.ts --outfile dist/claudewatch",
    "build:windows": "bun build --compile --target=bun-windows-x64 src/main.ts --outfile dist/claudewatch.exe",
    "build:linux": "bun build --compile --target=bun-linux-x64 src/main.ts --outfile dist/claudewatch"
  }
}
```

`src/main.ts` entrypoint logic:

1. Parse CLI flags (`--version`, `--json`, `--refresh`, `--debug`)
2. If `--version` → print version → exit 0
3. Read cache file (handle corruption: delete and treat as miss)
4. If cache is fresh and not `--refresh` → format and print → exit 0
5. If in cooldown and not `--refresh` → format stale output → exit 0
6. Resolve credentials (exit 2 if missing)
7. Fetch usage (5s timeout)
8. On success → normalize → write cache → format and print → exit 0
9. On failure → enter cooldown → if stale cache exists → format stale → exit 0
10. On failure with no cache → print error → exit 1

If `--json` is set, output `UsageSnapshot` as JSON instead of formatted text.
If `--debug` is set, output diagnostic info (no secrets) instead of formatted text.

Create `install/install.ts` — the one-command installer described in Section 11.6.

### 18.5 Step 4: Create packages/vscode

```bash
mkdir -p packages/vscode/src
cd packages/vscode
bun init -y
```

`packages/vscode/package.json` must include VS Code extension manifest fields:

```json
{
  "name": "claudewatch-vscode",
  "displayName": "ClaudeWatch",
  "version": "0.1.0",
  "engines": { "vscode": "^1.85.0" },
  "categories": ["Other"],
  "activationEvents": ["onStartupFinished"],
  "main": "./dist/extension.js",
  "dependencies": {
    "@claudewatch/core": "workspace:*"
  },
  "contributes": {
    "commands": [
      { "command": "claudewatch.refresh", "title": "ClaudeWatch: Refresh Now" },
      { "command": "claudewatch.openDashboard", "title": "ClaudeWatch: Open Usage Dashboard" }
    ],
    "configuration": {
      "title": "ClaudeWatch",
      "properties": {
        "claudewatch.refreshIntervalSeconds": { "type": "number", "default": 60, "minimum": 30 },
        "claudewatch.warningThresholdPct": { "type": "number", "default": 70 },
        "claudewatch.criticalThresholdPct": { "type": "number", "default": 90 }
      }
    }
  },
  "scripts": {
    "build": "bun build src/extension.ts --outdir dist --target node --format cjs --external vscode",
    "package": "vsce package --no-dependencies"
  }
}
```

| File | Responsibility |
|---|---|
| `src/extension.ts` | `activate()` — create status bar item, start polling interval, register commands. `deactivate()` — clean up timers and status bar item. |
| `src/statusbar.ts` | Manage `StatusBarItem` — update text, color, tooltip based on `RuntimeState` and threshold evaluation |
| `src/tooltip.ts` | Generate `MarkdownString` from `UsageSnapshot` with local time formatting |
| `src/commands.ts` | `refresh()` — trigger immediate fetch (respects cooldown). `openDashboard()` — `vscode.env.openExternal` to claude.ai usage page. |

### 18.6 Step 5: Wire Up and Build

```bash
cd claudewatch  # repo root
bun install
bun run --filter @claudewatch/core build
bun run --filter @claudewatch/statusline build
bun run --filter claudewatch-vscode build
```

### 18.7 First Milestone: Prove the Pipe

Before building UI, prove the critical path end-to-end. This can be done in a single throwaway script:

1. **Credential resolution:** Read and parse `~/.claude/.credentials.json`, extract `accessToken`
2. **API call:** Hit the usage endpoint with the token, get a 200 response
3. **Normalization:** Parse the response into a `UsageSnapshot`
4. **Cache write:** Write the snapshot to `~/.cache/claudewatch/usage.json` atomically
5. **Cache read + format:** Read the cache, format output, print to stdout

If all five steps work, you have a working statusline binary. The VS Code extension is then a rendering layer on top of the same pipe.

### 18.8 Suggested Build Order

1. **packages/core types and credential resolver** — get the data model and file reading right first
2. **packages/core client and normalizer** — prove the API call works end-to-end
3. **packages/core cache, cooldown, and state classification** — add persistence and failure handling
4. **packages/core time and format** — get display output correct
5. **packages/statusline binary** — compile, test CLI flags, test prompt integration
6. **packages/vscode extension** — status bar, tooltip, commands
7. **Contract and unit tests** — formalize the test suite
8. **README, install docs, .vsix packaging** — ship it

---

## 19. Open Items and Release Gates

### 19.1 High Priority (Before v1 Ship)

- Validate API endpoint still returns expected schema on current Claude Code version
- Finalize extension ID and publisher naming
- Validate Cursor behavior explicitly
- ~~Add minimum polling interval enforcement~~ ✅ Implemented (extension.ts enforces 30s minimum)
- Test 429 rate-limiting behavior and confirm cooldown + stale-while-error handles it gracefully

### 19.2 Medium Priority

- ~~Detect stale-token-in-file scenario more explicitly (check `expiresAt` before API call)~~ ✅ Implemented (credentials.ts checks expiresAt)
- Package GitHub Releases with compiled binaries and `.vsix`
- Add WSL behavior notes if tested
- ~~Add last fetch timestamp to `--debug` output~~ ✅ Implemented (main.ts printDebug emits lastFetchedAt)
- ~~Make cache path injectable for test isolation~~ ✅ Implemented (cache.ts setCacheBaseDir)

### 19.3 v2 Backlog

- macOS Keychain credential support
- Historical usage retention and burn-rate analytics
- VS Code Marketplace publishing
- Onboarding walkthrough
- Multi-account awareness
- `seven_day_opus` as a separate tracked window

---

## 20. Explicit v1 Decisions

To avoid drift, the following are fixed for v1:

- ClaudeWatch is read-only
- ClaudeWatch uses stale-while-error behavior with 5-minute cooldown after endpoint failures
- Primary utilization is the highest valid utilization across supported windows
- Session-aware rich statusline is implemented via stdin JSON piped from Claude Code
- Session analytics (historical trends, burn-rate) are deferred to v2
- Missing optional fields are omitted, not guessed
- No telemetry is shipped
- No token is ever persisted outside the existing Claude Code credential file
- Marketplace publishing is not required for v1 success
- v1 targets Windows + Linux only; macOS is v2
- All-bun toolchain: workspaces, build, test, compile
- Compiled binary for terminal; no runtime dependencies
- Claude Code built-in status line for terminal integration
- Atomic file writes for cache consistency
- Cache at `~/.cache/claudewatch/usage.json` with version header
- All internal timestamps UTC; display times converted to local
- HTTP timeout 5 seconds; TLS verification always enabled
- Cache corruption triggers delete + fresh fetch, never a stuck failure loop
