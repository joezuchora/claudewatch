# Spec: actually emit the telemetry the pipeline was built for

- **ID:** 007-telemetry-call-sites
- **Stage:** 2 — Design
- **Status:** accepted
- **Derived from:** [`intent.md`](./intent.md)

## Summary

`packages/core` gains a **process-level telemetry config**, set once by whichever surface owns
the process, and read by the four call sites. The surfaces decide consent; core never resolves
it. All four event kinds emit.

## Design decisions

### Consent is set by the surface, never resolved inside core

This is the whole problem. `client.ts` and `cache.ts` are deep in core with no access to
`vscode.env`, and loop 006 established that VS Code's global switch must win. If those modules
called `resolveTelemetryConfig()` themselves they would read env and config file only — and a
VS Code user who had turned telemetry off globally would still be emitted for.

**That would silently void loop 006's compliance guarantee**, which is the exact failure mode
loop 006 exists to prevent, reintroduced one layer down.

So core exposes:

```ts
setTelemetryConfig(cfg: TelemetryConfig): void   // default: { enabled: false }
getTelemetryConfig(): TelemetryConfig
```

- **statusline** calls `setTelemetryConfig(resolveTelemetryConfig())` once at startup.
- **the extension** calls `setTelemetryConfig(telemetryOverride())` at activation **and again
  from `recomputeTelemetryGate()`**, so a mid-session change reaches core immediately.

Default is disabled, so a surface that forgets to call it emits nothing. **Failing closed is
the only acceptable default for a consent flag**, and it means the dangerous mistake — a new
surface silently inheriting "on" — is not expressible.

Rejected: threading config through every function signature (invasive, and every new call site
is a chance to forget); resolving inside core (voids 006); a build-time flag (cannot respond to
a runtime consent change).

### `cache_event` emits only on non-hit outcomes

A `cache_event` per render is one event per prompt — the dominant volume in loop 003's own
analysis, and almost all of it would say `hit`, which is the uninteresting case.

The questions this kind exists for are "is the cache thrashing" and "did the version bump
invalidate everyone" — both answered by the *non-hit* outcomes. So `hit` is not emitted;
`miss`, `corruptJson`, `versionMismatch`, `invalidShape` and `cooldown` are.

This costs the ability to compute a hit *rate* directly. Accepted: `render` count is already
a denominator, so the rate is recoverable by division, and the alternative is a spool that
fills with `hit` in days.

### `schema_drift` emits once per successful `normalize()`, on the fetch path only

As `003`'s spec specified and for the reason it gave: warnings live on the snapshot and are
re-read from cache on every render for up to 600 s, so emitting at render time would turn one
drift into hundreds of duplicates.

One event per `normalize()` call carrying the **most severe category present** and a total
count, not one event per warning — a malformed response with eight warnings is one drift, not
eight.

### `fetch_result` is emitted by `client.ts` after the retry loop completes

One event per `fetchUsage()` call, carrying `attempts` and a `durationMs` that **excludes the
2000 ms retry sleep**, so the figure stays a latency signal rather than a bimodal constant.

## Behavior

| Kind | Emitted from | When |
|---|---|---|
| `fetch_result` | `client.ts`, after the retry loop | once per `fetchUsage()` |
| `cache_event` | `cache.ts`, in `readCacheResult` | non-hit outcomes only |
| `schema_drift` | `normalize.ts`, end of a successful normalize | when warnings exist |
| `render` | each surface, after output is written | once per render |

Every one is a no-op when the process config is disabled, which is the default.

## Data and types

No new types. `TelemetryConfig` and the four payload builders already exist from `003`.

## Edge cases

| Case | Expected |
|---|---|
| Surface never calls `setTelemetryConfig` | Disabled. No emission, no filesystem access. **The default.** |
| VS Code global flips off mid-session | `recomputeTelemetryGate` pushes the new config into core; all four kinds stop. |
| `fetchUsage` throws before the loop | No `fetch_result`. An event asserting a fetch outcome that never resolved would be a lie. |
| `normalize` returns the malformed snapshot | No `schema_drift` — that path is a failed parse, already covered by `fetch_result`. |
| Cache hit | No `cache_event`. |
| Emission throws | Impossible to observe: `emit` swallows everything by construction (`003`). |
| Two surfaces in one process | Cannot occur; each is its own process. |

## Backward compatibility

- **A user who changes nothing sees no change.** Default disabled; `emit` short-circuits
  before any I/O.
- `setTelemetryConfig` is additive. No existing signature changes.
- No change to the usage endpoint contract, cache format, `CACHE_VERSION`, exit codes, or CLI
  flags.
- Loop 006's gate is strengthened, not weakened: it now governs four kinds instead of one.

## Acceptance criteria

- [ ] Default config is disabled; with no `setTelemetryConfig` call, nothing is written — tested
- [ ] `setTelemetryConfig` governs all four kinds — tested
- [ ] `fetch_result` carries `attempts` and excludes the retry sleep from `durationMs` — tested
- [ ] `cache_event` emits on `versionMismatch`, `corruptJson`, `invalidShape`, `miss` — tested
- [ ] `cache_event` does **not** emit on `hit` — tested
- [ ] `schema_drift` emits once per normalize with warnings, never on a cache-hit render — tested
- [ ] `schema_drift` carries one category and a count, not one event per warning — tested
- [ ] The extension pushes its gate into core at activation and on change — tested
- [ ] **Adversarial leak test extended to all four kinds** against poisoned input — tested
- [ ] `bun run verify` exits 0

## Rejected alternatives

- **Core resolves its own config.** Voids loop 006 one layer down. The reason this change
  needed a design stage at all.
- **Thread config through every signature.** Invasive, and forgettable at each new site.
- **Emit `cache_event` on hits too.** Fills the spool with the uninteresting case.
- **One `schema_drift` per warning.** Turns one malformed response into eight events.

---

**Next stage:** Build — run `/sdlc-plan 007-telemetry-call-sites`.
