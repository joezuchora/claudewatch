# Plan: let the metrics act, not just display

- **ID:** 009-anomaly-detection
- **Stage:** 3 — Build
- **Status:** implemented

## Scope fence

```
packages/metrics/src/anomaly.ts
packages/metrics/src/anomaly.test.ts
packages/metrics/src/cli-detect.ts
packages/metrics/src/index.ts
packages/metrics/package.json
package.json
sdlc/009-anomaly-detection/*
```

## Changes

- **`anomaly.ts`** — `BOUNDS` (every threshold in one object), four detectors, fingerprint
  suppression, and `detect(events, now, suppressions)`. Pure: no clock, no filesystem, no store.
- **`cli-detect.ts`** — reads the store, calls `detect`, drafts `incident.md` + `intent.md` at
  the next free `sdlc/NNN`, records the fingerprint. Commits nothing.
- **scripts** — `bun run metrics:detect`.

## Tests

25 cases in `anomaly.test.ts`. Every numeric bound is asserted from **both** sides — a
threshold tested only from the firing side is one nobody has checked for false positives.

## Risks

- **A noisy detector gets ignored.** Mitigated by the three guards, and validated against this
  repo's real data: it does **not** fire on today's three red gates.
- **A bound drifts out of date as the project changes.** Accepted; `BOUNDS` is one object and
  every threshold has a two-sided test, so retuning is a one-line diff plus two assertions.
