# Plan: a metrics pipeline the Maintain stage can observe

- **ID:** 003-metrics-telemetry
- **Stage:** 3 — Build
- **Status:** accepted
- **Derived from:** [`spec.md`](./spec.md) (revision 2)
- **Branch:** `claude/ai-sdlc-setup-plan-nqyqbk` (same session constraint as loops 001–002)

## Approach

Build inward-out, so each layer is green before the next depends on it:

1. **Core plumbing** — config resolution, spool emitter, sidecar. Fully testable with no
   service and no call sites. This is where the security tests live.
2. **Observability of existing state** — `readCacheResult`, so cache outcomes are
   distinguishable at all. Additive; `readCache` unchanged.
3. **Call sites** — wire the four event kinds. Small diffs, each guarded by `enabled`.
4. **The metrics package** — store, service, agent, dashboard. Independent of 1–3; its tests
   need no product.
5. **The verify wrapper** — instrument the gate. Done last because it is the piece that must
   not break the gate everything else is verified by.
6. **Document amendments** — six documents, applied together so no intermediate commit leaves
   `REVIEW.md` contradicting `SPEC.md`.

Order matters most between 5 and everything else: instrumenting `verify` before the rest is
green would mean debugging the gate and the feature simultaneously.

## Scope fence

```
packages/core/src/telemetry.ts
packages/core/src/telemetry.test.ts
packages/core/src/config.ts
packages/core/src/config.test.ts
packages/core/src/cache.ts
packages/core/src/cache.test.ts
packages/core/src/client.ts
packages/core/src/normalize.ts
packages/core/src/types.ts
packages/core/src/index.ts
packages/core/src/test-helpers.ts
packages/core/src/security.test.ts
packages/statusline/src/main.ts
packages/statusline/src/core-deps.ts
packages/vscode/src/extension.ts
packages/vscode/src/core-bridge.ts
packages/vscode/package.json
packages/metrics/**
scripts/verify.ts
package.json
SPEC.md
REVIEW.md
SECURITY.md
CLAUDE.md
sdlc/003-metrics-telemetry/plan.md
sdlc/003-metrics-telemetry/review.md
```

`packages/metrics/**` is a glob, which the auditor is told to flag as vacuous. It is
deliberate and bounded: the package does not exist yet, so every file in it is new and belongs
to this change. Nothing outside it is covered by a glob.

## Changes

### 1. Core plumbing

**`config.ts`** — `resolveTelemetryConfig(overrides?)`, precedence override > env > file >
default. Returns `{ enabled: boolean }`. A malformed config file is absent, never an error.

**`telemetry.ts`** — `emit(event)`, `getSpoolPath()`, `readSpoolState()`, `recordDrop()`.
Spool path derives from `getCacheDir()`. Byte cap via one `statSync`. Lines capped at 4096 B.
Sidecar written temp+rename. `emit` never throws: every path wrapped, filesystem errors count
a drop and return.

**Payload builders** — one per event kind, each returning only typed leaves from the closed
enumerations in `spec.md`. These are the security boundary; nothing else may construct a
payload.

### 2. `cache.ts`

Add `readCacheResult(): { envelope, reason }` distinguishing `hit`, `miss`, `corruptJson`,
`versionMismatch`, `invalidShape`. Reimplement `readCache()` as `readCacheResult().envelope`
so no call site changes and existing tests stay valid.

### 3. Call sites

- `client.ts` — one `fetch_result` per `fetchUsage()`, `attempts`, retry sleep excluded.
- `cache.ts` — `cache_event` from inside `readCacheResult`.
- `normalize.ts` — `schema_drift` once per successful normalize, categories not text.
- `main.ts` / `extension.ts` — `render` after output is written.

Surfaces reach telemetry through their existing bridge modules (`core-deps.ts`,
`core-bridge.ts`), so loop 001's isolation property is preserved.

### 4. `packages/metrics`

```
packages/metrics/
  package.json
  src/types.ts      shared event shape
  src/store.ts      bun:sqlite, WAL, schema_version, retention, INSERT OR IGNORE
  src/server.ts     Bun.serve, routes, auth, body limits
  src/dashboard.ts  server-rendered HTML, no external assets
  src/agent.ts      rotate-by-rename, ship, delete on 2xx
  src/*.test.ts
```

### 5. `scripts/verify.ts`

Runs typecheck → lint → test → build, timing each, and emits `verify_run` with per-step
durations and outcome including `timeout`/`killed`. **Exit code passthrough is exact.**
`package.json`: `verify` → this script, `verify:plain` → today's `&&` chain.

### 6. Documents

`SPEC.md` §8.1, §10.6, §12, §17, §20; `REVIEW.md` pass 2; `SECURITY.md` (verbatim text from
`spec.md`); `CLAUDE.md` gains the telemetry rule.

## Tests

| Spec criterion | Test | File |
|---|---|---|
| Unset → no I/O | `emit` with config disabled makes no fs call | `telemetry.test.ts` |
| Config precedence | override > env > file > default | `config.test.ts` |
| **Adversarial leak** | poisoned token/path/hostname absent from every kind's line | `security.test.ts` |
| `emit` never throws | unwritable spool dir | `telemetry.test.ts` |
| Byte cap | drops, counts, preserves history | `telemetry.test.ts` |
| Sidecar survives process | write, re-read | `telemetry.test.ts` |
| Rotate not truncate | append during shipping is retained | `agent.test.ts` |
| Retain on failure | non-2xx keeps shipping file | `agent.test.ts` |
| Unparseable lines | skipped, counted, batch completes | `agent.test.ts` |
| `readCacheResult` | all five outcomes | `cache.test.ts` |
| `fetch_result` | attempts, sleep excluded | `client.test.ts` |
| `schema_drift` | once per normalize, never on cache hit | `normalize.test.ts` |
| Store restart | existing DB returns prior events | `store.test.ts` |
| Bind/token refusal | non-loopback without token; token < 32 | `server.test.ts` |
| Body limits | 413 / 400 / empty-batch 200 | `server.test.ts` |
| Dedupe | duplicate `event_id` → one row | `store.test.ts` |
| Dashboard | 200, recent runs, no external assets | `dashboard.test.ts` |
| **Statusline binary** | built binary, env-configured, one `render` line | `telemetry.test.ts` |
| **Perf p95** | 100 runs, 4 MB spool, < 50 ms | measured, recorded in `review.md` |

The two bolded rows are the ones that cannot be faked at module level: both must run against
the **compiled binary**, because B1 was precisely a defect invisible to module-level tests.

## Risks

- **Instrumenting `verify` breaks the gate.** Highest-consequence risk here. Mitigated by
  building it last, keeping `verify:plain`, and asserting exit-code passthrough for pass, fail
  and timeout before switching `verify` over.
- **Telemetry regresses the 50 ms budget.** Spiked at 0.003 ms/append, but the 4 MB-spool case
  is measured, not assumed.
- **A payload builder grows a free-text field later.** The adversarial test catches the known
  vectors; nothing structurally prevents a new one. Accepted, recorded.
- **`emit` inside `cache.ts` and `client.ts` creates an import cycle** (`telemetry` needs
  `getCacheDir` from `cache`). Mitigated by putting `getSpoolPath` resolution in `telemetry.ts`
  and having it import from `cache.ts` one way only; if a cycle appears, the path helper moves
  to a third module rather than being duplicated.
- **Six document amendments landing separately** would leave `REVIEW.md` contradicting
  `SPEC.md` mid-branch. They land in one commit.

---

**Next stage:** Build/Test — run `/sdlc-implement 003-metrics-telemetry`.
