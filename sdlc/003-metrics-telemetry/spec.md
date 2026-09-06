# Spec: a metrics pipeline the Maintain stage can observe

- **ID:** 003-metrics-telemetry
- **Stage:** 2 — Design
- **Status:** accepted (revision 2)
- **Derived from:** [`intent.md`](./intent.md)
- **Review:** revision 1 was reviewed by `spec-reviewer` and had **5 blocking findings**. This
  revision resolves them. The findings and what changed are recorded in
  [`review.md`](./review.md) under "Design-stage findings" so the correction is part of the
  record rather than invisible.

## Summary

A new zero-dependency workspace package, `@claudewatch/metrics`, provides an HTTP metrics
service backed by SQLite, an agent that ships locally spooled events to it, and a dashboard.
`packages/core` gains a telemetry emitter that **writes to a local spool file and never opens
a socket**, plus the configuration channel the statusline currently lacks. `bun run verify`
itself becomes instrumented.

## Spikes run before specifying

Per the rule in `sdlc/README.md` — *spike before specifying anything that rests on third-party
runtime behaviour* — three assumptions were measured, not assumed:

| Assumption | Result |
|---|---|
| Statusline startup headroom | `--version` costs **25–40 ms** against a 50 ms budget. Only ~10–25 ms of headroom exists. **No network is possible on that path.** |
| Spool append cost | First append **0.05 ms**, steady state **0.003 ms**. Three orders of magnitude inside budget. |
| `bun:sqlite` on Bun 1.3.11 | WAL mode enables; 5000 inserts in 16.4 ms; concurrent read during an open writer succeeds; `INSERT OR IGNORE` on a unique `event_id` gives dedupe for free. |

The first result is what makes the design below non-negotiable rather than merely preferred.

## Design decisions

### The product never makes a network call for telemetry — it spools to disk

`SPEC.md §11.7` budgets 50 ms from binary start to stdout on a cache hit, and the measured
floor is already 25–40 ms. Any network write in that path — even fire-and-forget — risks DNS,
TLS and connect latency inside headroom of ~10 ms. The statusline also exits immediately after
printing, so a fire-and-forget request would frequently be killed mid-flight and lost.

The emitter appends one JSON line to a local spool file and returns. A separate agent — run by
the user, not by the product — ships it.

The security consequence is the point: **the shipped binary and extension still never open a
connection to anywhere but the documented usage endpoint.** The revised guarantee is not a
weakened version of the old one; it remains literally true of the product.

### Configuration: a real channel for the statusline *(resolves B1)*

Revision 1 specified `claudewatch.telemetry.*` settings. That is a **VS Code namespace**. The
statusline binary has no configuration mechanism at all — `parseFlags` accepts exactly
`--version`, `--json`, `--refresh`, `--debug`, and that list is contractual under
`SPEC.md §11.4`. As written, telemetry was unreachable on the only surface the design exists
to protect.

`packages/core` gains `resolveTelemetryConfig(overrides?)` with explicit precedence:

1. **Explicit overrides** — the VS Code extension passes its settings object.
2. **Environment** — `CLAUDEWATCH_TELEMETRY=1` and `CLAUDEWATCH_TELEMETRY_SPOOL=<path>`.
   Claude Code invokes the statusline through a shell, so the environment is the channel that
   actually reaches it.
3. **Config file** — `~/.config/claudewatch/config.json`, `{ "telemetry": { "enabled": bool } }`.
   Absent or unparseable is treated as absent, never as an error.
4. **Default** — disabled.

The **endpoint is not product configuration.** The product never sends anything, so it has no
use for a URL. The endpoint belongs to the agent alone (`CLAUDEWATCH_METRICS_ENDPOINT`).
Revision 1 coupled them and was wrong to.

CLI flags are untouched, so `SPEC.md §11.4`'s contract is preserved.

### Payloads are typed leaves from enumerated sets — no free text anywhere *(resolves B3)*

Revision 1 specified an allowlist of field *names* and claimed it prevented leaks. It does
not, and the test as described was a tautology: asserting `keys(payload) ⊆ ALLOWLIST` against
the same constant the emitter filters with passes by construction.

Every realistic leak here is in a **value**. `client.ts:70` puts `err.message` — an arbitrary
`fetch` rejection — into `FetchFailure.message`, and in Bun those routinely carry hostnames,
proxy URLs, certificate paths and `ENOENT /home/<username>/…`.

So: **every payload leaf is a number, a boolean, or a member of a closed enumeration.** There
are no string fields carrying data of unbounded origin. Concretely:

| Field | Type |
|---|---|
| `statusClass` | `'2xx' \| '4xx' \| '5xx' \| 'network' \| 'timeout'` |
| `failureClass` | the five `FailureClass` values (`SPEC.md §7.2`) |
| `runtimeState` | the eight `RuntimeState` values in `types.ts` |
| `surface` | `'statusline' \| 'vscode'` |
| `cacheOutcome` | `'hit' \| 'miss' \| 'corruptJson' \| 'versionMismatch' \| 'invalidShape' \| 'cooldown'` |
| `warningCategory` | a closed set derived from `normalize.ts`'s warning sites |
| `tier` | `'standard' \| 'enterprise' \| 'unknown'` |
| `attempts`, `durationMs`, `utilizationBucket` | numbers |

**Enterprise credit amounts are excluded.** `monthlyLimitCredits` and `usedCredits` are an
account's billing position. `tier` plus a bucketed utilization (deciles) carries the health
signal without the financial one.

The test is adversarial, not tautological: an API response whose error message and
normalization warnings contain `sk-ant-oat01-FAKE…`, `/home/testuser/x` and a hostname must
produce spool lines containing none of those substrings, for every event kind — in the style
of the existing poisoned-input test at `security.test.ts:48`.

### The agent rotates; it does not truncate *(resolves B4)*

Revision 1's "at-least-once, never lost" was false. Read-N-lines-then-rewrite-the-remainder
loses every event a concurrently running statusline appended in between, and the statusline
runs on *every prompt render*.

The protocol:

1. Agent `rename`s `metrics-spool.jsonl` → `metrics-spool.<ts>.shipping`. Rename is atomic;
   emitters recreate the primary file on their next append with no coordination.
2. Agent POSTs the shipping file's contents.
3. On 2xx the shipping file is deleted. On failure it is retained and retried next run.
4. At most 20 retained shipping files; beyond that the oldest is dropped and counted.

Serialized lines are capped at **4096 bytes** so a single `appendFileSync` with `O_APPEND`
stays within the POSIX atomicity guarantee. Windows offers no equivalent guarantee — noted in
Security below rather than pretended away. Unparseable lines are skipped and counted, never
aborting a batch.

The honest guarantee: **at-least-once for events that reach the spool. Events may be dropped
at the cap or on filesystem error, and both are counted.**

### `bun run verify` itself is instrumented *(resolves B5)*

Revision 1 put instrumentation in an opt-in `verify:metrics`, which meant the runs that hang
would be exactly the runs nobody remembered to instrument — defeating the stated reason for
building this.

`verify` becomes the instrumented wrapper. `verify:plain` is the uninstrumented chain for
anyone who wants it. The wrapper preserves exit codes exactly, so the gate's contract is
unchanged; only its implementation is. It records per-step durations and the outcome
including `timeout` and `killed`, which is the case the hang investigation depends on.

Telemetry for *process* metrics is not opt-in and needs no consent gate: it is a dev-loop
tool writing to a local store, contains no user data, and never runs in a shipped artifact.

### `readCache` gains a discriminated result *(resolves M3)*

`readCache()` returns `null` for four distinct situations — absent, corrupt JSON, version
mismatch, invalid shape — and deletes the file first, so no caller can tell them apart. The
`cacheOutcome` enumeration above is unobservable without this.

`readCacheResult(): { envelope: CacheEnvelope | null; reason: CacheOutcome }` is added.
`readCache()` is kept as a wrapper returning `.envelope`, so **no existing call site changes**.
This is an additive core API change and is listed in Backward compatibility, which revision 1
wrongly claimed was untouched.

## Behavior

### Emit call sites and expected volume *(resolves M6)*

| Kind | Emitted from | Frequency |
|---|---|---|
| `fetch_result` | `client.ts`, once per `fetchUsage()` call | per cache miss (TTL 600 s) |
| `cache_event` | `cache.ts`, inside `readCacheResult` | once per render |
| `render` | each surface, after output is written | once per prompt render — **the dominant volume** |
| `schema_drift` | `normalize.ts`, once per successful `normalize()`, **fetch path only** | rare |

`render` dominates: an active user may produce thousands per day at ~200 B/line, so a 5 MB
spool fills in days if the agent never runs. `verify` invokes the agent opportunistically, and
the dashboard surfaces drop counts, so the condition is visible somewhere rather than silently
swallowing everything.

`schema_drift` is emitted at normalization time only. Cache-hit renders never emit it —
otherwise one drift would produce hundreds of duplicates over a 600 s TTL *(resolves M4)*.

`fetch_result` is one event per `fetchUsage()` call, carrying `attempts: 1 | 2`, with
`durationMs` **excluding** the 2000 ms retry sleep so it remains a latency signal rather than a
bimodal constant *(resolves M5)*.

### Spool mechanics

- Path derives from `getCacheDir()`, so `setCacheBaseDir` governs the spool and the cache
  together and tests cannot write to a developer's real `~/.cache` *(resolves M9)*.
- File `0600`, directory `0700`, append-only.
- Cap is **bytes only** (5 MB), checked with one `statSync().size` before append. A line-count
  cap would mean reading up to 5 MB on a path budgeted at 50 ms *(resolves M2)*.
- Drop counts live in a sidecar `metrics-spool.state.json` (atomic temp+rename), so the
  counter survives the 30 ms statusline process that observed it *(resolves M1)*.

### Service

| Route | Behavior |
|---|---|
| `POST /v1/events` | Batch ingest. Max body 1 MB, max 1000 events. Empty batch → 200 `{accepted:0}`. Oversized → 413. Malformed → 400. Store unchanged, process alive. |
| `GET /v1/events` | Filter by `source`, `kind`, `since`, `limit`. `since` filters on `received_at`, not emitter `ts` — emitter clocks skew. |
| `GET /v1/stats` | Run counts, pass rate, duration percentiles. |
| `GET /health` | Liveness plus store reachability. |
| `GET /` | Server-rendered dashboard, no external assets. |

- **Storage:** `~/.local/share/claudewatch-metrics/metrics.db`, `0600`, WAL mode, a
  `schema_version` table, parameterized SQL exclusively.
- **Retention:** events older than 90 days pruned on startup and daily, bounding disk on a NUC
  that runs for years *(resolves M7)*.
- **Dedupe:** client-generated `event_id`, `UNIQUE` index, `INSERT OR IGNORE`. The spike
  showed this is free, and it keeps `/v1/stats`' pass rate from drifting on agent retries.
- **Auth** *(resolves M10)*: `Authorization: Bearer <token>`, constant-time comparison, minimum
  32 characters, rejected at startup if shorter. Gates **all** routes including `/`. Binding
  to a non-loopback interface without a token **refuses to start**. On loopback with no token,
  any local process can inject events — accepted deliberately for a single-user NUC, recorded
  here as a decision rather than an oversight.

## Data and types

`MetricEvent = { eventId, ts, source: 'sdlc'|'product', kind, ok, durationMs, schemaVersion, payload }`.

`schemaVersion` is **per event kind**. The service stores unknown versions and flags them
rather than rejecting — a metrics service that drops data on version skew loses exactly the
data explaining the skew.

## Edge cases

| Case | Expected behavior |
|---|---|
| Telemetry unset | `emit` no-ops before any I/O. **The default.** |
| Config file absent/unparseable | Treated as absent. Never an error. |
| Spool unwritable / disk full | `emit` returns silently, drop counted in sidecar. |
| Spool at byte cap | New events dropped, counted, history preserved. |
| **Spool full because the agent never ran** | Drops counted; surfaced on the dashboard and by `verify`'s opportunistic agent run. |
| Service down | Shipping file retained, retried. |
| Agent interrupted after rename, before POST | Shipping file retained and retried next run. |
| Concurrent statusline + extension appends | Both append `O_APPEND` under 4096 B; rename is atomic. |
| Torn final line | Skipped and counted, batch continues. |
| Duplicate events from retry | `INSERT OR IGNORE` on `event_id`. |
| Non-loopback bind, no token | **Refuses to start**, explanatory error. |
| Token set but < 32 chars | **Refuses to start.** |
| Verify step killed | `ok:false`, `outcome:'timeout'` — the case that matters most. |
| Clock skew | Both `ts` and `received_at` stored; queries use `received_at`. |
| Unknown `schemaVersion` | Stored and flagged. |

## Backward compatibility

- **A user who changes nothing sees no change.** Telemetry defaults off; `emit` short-circuits
  before touching the filesystem.
- **`readCache()` keeps its signature.** `readCacheResult()` is additive. No call site changes.
- `bun run verify` keeps its exit-code contract; its implementation becomes the wrapper.
- Usage endpoint contract, credential handling, cache format, `CACHE_VERSION`, CLI flags: all
  untouched. The spool is a separate file.
- New workspace package; existing package builds untouched.

## Security

`SPEC.md §12`'s invariants are **re-asserted, not relaxed**. No token, hostname, username,
path, project name or account identifier can appear, because no payload leaf is free text.
Credentials remain read-only; telemetry never reads the credential file. The product opens no
socket.

**File modes are advisory on Windows**, a v1-supported platform (`SPEC.md §13.1`). The cache
already has this caveat, so it is inherited rather than introduced — but a section listing
modes as enforcement should say where it holds.

**The spool is append-only and deliberately exempt** from `CLAUDE.md`'s temp+rename rule, which
does not compose with append. `SPEC.md §9.6` continues to govern `usage.json`. The sidecar
state file *does* use temp+rename.

### Documents amended *(resolves B2)*

Revision 1 listed two. There are six:

| Document | Change |
|---|---|
| `SPEC.md §12` | Gains the telemetry trust boundary |
| `SPEC.md §17` | "No telemetry in v1" — directly contradicted |
| `SPEC.md §20` | "No telemetry is shipped" → "no telemetry is enabled by default and no default destination exists" |
| `SPEC.md §8.1` | "three packages" → four |
| `SPEC.md §10.6` | Settings table gains the telemetry setting |
| `REVIEW.md` Pass 2 | Standing check "No telemetry" rewritten — otherwise every future metrics change trips a Pass 2 violation, or reviewers learn to wave it through |

**The replacement `SECURITY.md` sentence, verbatim** *(resolves the nit — a revoked guarantee's
replacement belongs where it can be reviewed)*:

> **Telemetry is off by default and has no default destination.** ClaudeWatch never opens a
> network connection to anything but the documented Anthropic usage endpoint. When you enable
> telemetry, the tool appends metrics to a local file; a separate agent *you* run ships them
> to a service *you* host. The tool reports on itself to a service its owner runs — it does not
> report on you to anyone else. No payload can contain a token, a path, a hostname, a
> username, or an account identifier, because every field is a number, a boolean, or a value
> from a fixed list.

## Acceptance criteria

- [ ] Telemetry unset → no spool file created, no I/O performed — tested
- [ ] **The compiled statusline binary**, run with `CLAUDEWATCH_TELEMETRY=1`, appends exactly
      one `render` line; run without it, creates no spool file — tested against the built
      binary, not the module *(B1)*
- [ ] Config precedence override > env > file > default — tested
- [ ] **Adversarial leak test**: poisoned error message and warnings containing a fake token,
      `/home/testuser/x` and a hostname produce spool lines containing none of those
      substrings, for every event kind — tested *(B3)*
- [ ] `emit` never throws, including on an unwritable spool — tested
- [ ] Byte cap drops new events, counts them in the sidecar, preserves history — tested
- [ ] Sidecar drop count survives across processes — tested
- [ ] Agent rotates by rename; concurrent appends during shipping are not lost — tested *(B4)*
- [ ] Shipping file retained on failure, deleted only on 2xx — tested
- [ ] Unparseable lines skipped and counted; batch completes — tested
- [ ] `readCacheResult` distinguishes all five outcomes; `readCache` behavior unchanged — tested
- [ ] `fetch_result` carries `attempts` and excludes retry sleep from `durationMs` — tested
- [ ] `schema_drift` emitted once per `normalize()`, never on cache-hit renders — tested
- [ ] Service ingests, stores, queries; survives restart with an existing DB — tested *(M7)*
- [ ] Service refuses non-loopback bind without a token, and a token under 32 chars — tested
- [ ] 2 MB body → 413, malformed → 400, empty batch → 200; store unchanged, process alive
- [ ] Duplicate `event_id` ingested twice yields one row — tested
- [ ] `GET /` returns 200 with recent runs and pass rate, no external asset references — tested
- [ ] **Perf**: compiled binary, cache-hit path, telemetry enabled with a 4 MB spool present,
      p95 < 50 ms over 100 runs; the telemetry-unset baseline recorded in `review.md` *(M8)*
- [ ] `bun run verify` exits 0 and records a `verify_run` event

## Rejected alternatives

- **Direct POST from the product** — spends a 50 ms budget with 10 ms headroom, loses events on
  exit, and makes "never opens a socket" unstateable.
- **Telemetry on by default** — converts a promise into a surprise. Rejected outright.
- **Deleting the `SECURITY.md` section** — the change is worth making and worth stating.
- **Field-name allowlist** — revision 1's mechanism. Does not stop value leaks and its test is
  a tautology.
- **Truncate-based shipping** — revision 1's mechanism. Loses concurrent appends.
- **Percentile aggregation deferred to loop 004** — considered, kept here: `/v1/stats` is the
  only thing making "queried for history" checkable, and loop 004 consumes rather than
  computes it.

## Out of scope, discovered during design

`getCacheDir()` hardcodes `~/.cache/claudewatch` and **ignores `$XDG_CACHE_HOME`**, while
`SPEC.md:488` states it "follows `$XDG_CACHE_HOME` convention". Real drift and a real bug for
anyone who sets that variable. Not fixed here — unrelated to telemetry and it would widen the
change. Deriving the spool path from `getCacheDir()` means both stay consistent whichever way
it is later resolved. Recorded as a follow-up.

---

**Next stage:** Build — run `/sdlc-plan 003-metrics-telemetry`.
