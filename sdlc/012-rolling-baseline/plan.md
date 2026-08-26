# Plan: give the duration detector a window it actually controls

- **ID:** 012-rolling-baseline
- **Stage:** 3 — Build
- **Status:** draft
- **Derived from:** [`spec.md`](./spec.md)
- **Branch:** `claude/ai-sdlc-setup-plan-nqyqbk`

## Approach

Three small changes, in increasing order of how much they matter:

1. `anomaly.ts` gains two bounds (`verifyBaselineWindow`, `minOutlierMs`), takes its baseline
   from the last N runs instead of all of them, and reports the baseline it used.
2. The detector's **input** stops being "the last 1000 events of any kind". That composition
   moves out of `cli-detect.ts`'s top level — where nothing can reach it — into a
   `detector-input.ts` that a test can call.
3. Tests that discriminate. The existing duration tests pass under every design considered in
   Stage 2, including the one the review rejected, so they are evidence of nothing here.

The statistic does not change. p95 and `durationOutlierMultiple: 4` stay exactly as they are;
Stage 2 established that changing them made the detector blunter and introduced a false
positive on an observed run.

## Correction to a Stage 2 acceptance criterion

The spec's first criterion specifies "60 runs at 60 s followed by 30 at 6 s". **That fixture
does not discriminate.** The window would then hold 21 slow and 29 fast runs, and
`sorted[47]` of 50 still lands in the slow group — the windowed p95 would be 60 s, same as the
all-time p95, and the test would pass against the unwindowed code.

The fixture must be **60 at 60 s followed by 60 at 6 s**, so the last 50 excluding the latest
are all fast. Then windowed p95 = 6 s while all-time p95 = `sorted[113]` of 119 = 60 s.
`spec.md` is amended to match; the criterion's intent is unchanged.

Worth noting how close this came to shipping as a green test that proved nothing — which is the
same failure mode as the existing tests it was written to replace.

## Scope fence

```
packages/metrics/src/anomaly.ts
packages/metrics/src/anomaly.test.ts
packages/metrics/src/detector-input.ts
packages/metrics/src/detector-input.test.ts
packages/metrics/src/cli-detect.ts
packages/metrics/src/index.ts
sdlc/012-rolling-baseline/spec.md
sdlc/012-rolling-baseline/plan.md
sdlc/012-rolling-baseline/review.md
sdlc/README.md
```

## Changes

### `packages/metrics/src/anomaly.ts`
- `BOUNDS` gains `verifyBaselineWindow: 50` and `minOutlierMs: 120_000`, each with the
  derivation in a comment — 50 because a p95 needs a sample and a count is stable under changes
  in run frequency; 120 000 because the slowest legitimate run observed is 67 537 ms.
- `DurationBaseline` interface and `formatBaseline(b): string` — the printed form lives beside
  the type it prints, and stays pure so it is testable without a CLI.
- `detectDurationOutlier` takes the window (`runs.slice(-(window + 1), -1)`), keeps the
  `>= minVerifyRuns - 1` non-null guard **after** the null filter, and returns both the anomaly
  (or null) and the baseline, so `detect` can report the baseline even when no verdict follows.
- `detect`'s `healthy` and `anomalies` results carry `durationBaseline?`.
- Firing is `latest > thresholdMs` where `thresholdMs = max(p95 * multiple, minOutlierMs)`.
  `evidence` keeps `baselineP95Ms` and gains `thresholdMs` and `windowSize`.

### `packages/metrics/src/detector-input.ts` — new
- `collectDetectorInput(store)`: one kind-scoped query for `verify_run` bounded at
  `verifyBaselineWindow + 1`, plus the existing general query for the other three detectors,
  concatenated and deduplicated on `eventId`.
- This is the actual fix. It exists as its own module for one reason: at `cli-detect.ts`'s top
  level the composition runs on import and no test can reach it.

### `packages/metrics/src/cli-detect.ts`
- Calls `collectDetectorInput(store)` instead of `store.query({ limit: 1000 })`.
- Prints `formatBaseline(...)` on both the healthy and the anomalies path.

### `packages/metrics/src/index.ts`
- Export the new module, consistent with the others.

## Tests

| Spec criterion | Test | File |
|---|---|---|
| The window is real, not incidental | `a slow era outside the window does not set the baseline` (60×60 s then 60×6 s) | `anomaly.test.ts` |
| `cli-detect` asks by kind | `a store flooded with render events still yields verify runs` (30 runs + 1 200 renders) | `detector-input.test.ts` |
| The observed false positive does not fire | `REGRESSION: 59.5s against a 5.9s p95 does not raise — a stale tree is not a hang` | `anomaly.test.ts` |
| Floor, both sides | `exactly at the floor does not fire` / `one ms above the floor fires` | `anomaly.test.ts` |
| The case this exists for still fires | existing `THE CASE THIS EXISTS FOR`, plus one against a *fast* baseline | `anomaly.test.ts` |
| One-sided | `a faster-than-baseline run never fires, at any ratio` | `anomaly.test.ts` |
| Null-duration guard, both sides | `19 non-null durations in a 50-event window gives a verdict` / `18 gives none` | `anomaly.test.ts` |
| Baseline reported when latest is null | `a null latest duration still reports the baseline` | `anomaly.test.ts` |
| `cli-detect` prints the baseline line | `formatBaseline renders the stated format` + one spawn of the real CLI against a fixture db | `anomaly.test.ts`, `detector-input.test.ts` |
| Ordering | `the window respects (receivedAt, ts), not insertion order` | `anomaly.test.ts` |
| `bun run verify` exits 0 | the gate | — |

Two notes on the existing suite, both worth stating rather than discovering later:

- The current duration tests use a uniform 30 s baseline, and 4 × 30 s = 120 s **is exactly**
  `minOutlierMs`. They therefore pass unchanged — by coincidence, not by coverage, and they
  exercise the floor not at all. Every floor test below is new.
- One spawn of the real `cli-detect` is included deliberately. Loop 005 and loop 009 both shipped
  a defect that unit tests could not see because the defect was in how the real artifact was
  invoked — which is precisely the shape of the defect this loop is fixing. A single ~300 ms
  spawn against a fixture db is a fair price.

## Verification

```
bun test packages/metrics/src/anomaly.test.ts packages/metrics/src/detector-input.test.ts
bun run verify
bun run --filter @claudewatch/metrics detect     # against the real store, for the printed line
```

## Risks

- **The window makes `(receivedAt, ts)` ordering load-bearing** in a way it was not when the
  baseline was everything. A late-arriving old event now sorts last and becomes both "the
  latest run" and a window member. Pre-existing behaviour; newly consequential; tested.
- **`detector-input` returns overlapping sets.** The kind query and the general query both
  return verify runs. Dedup on `eventId` handles it, and `detectDurationOutlier` slices its own
  window regardless — but a duplicated run would silently distort a p95, so the dedup is tested
  rather than assumed.
- **A fixture db in a test leaves a file behind.** Use a temp dir and clean up, as
  `store.test.ts` does.
- **Looks fine locally, slow in CI.** The added spawn is the only new cost; CI's own timing on
  the PR is the check.

---

**Next stage:** Build/Test — implement, then `/sdlc-review 012-rolling-baseline`.
