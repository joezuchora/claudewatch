# Plan: actually emit the telemetry the pipeline was built for

- **ID:** 007-telemetry-call-sites
- **Stage:** 3 — Build
- **Status:** implemented
- **Derived from:** [`spec.md`](./spec.md)

## Approach

Add the process-level consent holder to `packages/core/src/telemetry.ts` first, so no call
site can be wired before there is a correct way to gate it. Then the three core sites, then
the two surfaces that push consent in.

## Scope fence

```
packages/core/src/telemetry.ts
packages/core/src/cache.ts
packages/core/src/client.ts
packages/core/src/normalize.ts
packages/core/src/call-sites.test.ts
packages/statusline/src/main.ts
packages/statusline/src/core-deps.ts
packages/vscode/src/extension.ts
packages/vscode/src/core-bridge.ts
sdlc/007-telemetry-call-sites/plan.md
sdlc/007-telemetry-call-sites/review.md
```

## Changes

- **`telemetry.ts`** — `setTelemetryConfig` / `getTelemetryConfig` / `emitProcess`. Default
  disabled. Strict `=== true` coercion, matching loop 006's gate.
- **`cache.ts`** — `cacheEvent` on the four non-hit returns of `readCacheResult`. Not on `hit`.
- **`client.ts`** — one `fetch_result` per `fetchUsage`, via a `report()` helper at each exit,
  accumulating per-attempt elapsed time so the retry sleep is excluded.
- **`normalize.ts`** — one `schema_drift` per successful normalize carrying warnings.
- **surfaces** — statusline sets consent once at startup; the extension sets it in
  `recomputeTelemetryGate`, so a mid-session change reaches core.

## Tests

`call-sites.test.ts`, 14 cases, covering the default, per-kind emission, the deliberate
non-emission on cache hits, drift counting, and the retry-sleep exclusion.

## Risks

- **A new call site forgets the gate.** Mitigated by `emitProcess` being the only sanctioned
  entry point from core, and by the default being disabled.
- **`client.ts`'s multiple exits miss a `report()`.** Mitigated by routing every `return`
  through the helper.
