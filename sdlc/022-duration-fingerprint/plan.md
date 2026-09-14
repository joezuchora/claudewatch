# Plan: a duration fingerprint that discriminates

- **Status:** accepted
- **Stage:** 3 — Build (planning half)
- **Reads:** `spec.md` (revised), `review-spec.md`

## Scope fence

```
packages/metrics/src/anomaly.ts
packages/metrics/src/anomaly.test.ts
sdlc/022-duration-fingerprint/{plan,review}.md
sdlc/README.md
```

Two files of code. The revised design needs no constant from `scripts/`, no new module, and no
documentation amendment — `SPEC.md` does not govern fingerprints, which the first draft got
wrong and the review corrected.

**Not touched:** `cli-detect.ts`. It reads `anomaly.fingerprint` as an opaque string for
suppression matching and for the incident draft; the shape is unchanged, so it needs no edit.
Confirmed by reading it rather than assumed.

## File-by-file

### `packages/metrics/src/anomaly.ts`

1. **Delete `magnitudeBucket`.** One call site, being replaced.
2. **Add `durationRatioBand(durationMs, thresholdMs)`**, exported so its test can reach it
   without going through `detect`.
   - `'na'` when either argument is non-finite or `thresholdMs <= 0`
   - `'1x'` for `r < 2` (including the unreachable `r < 1`, so the function is total)
   - `'2x'` for `2 ≤ r < 4`
   - `'4x'` for `4 ≤ r`
3. **Rewrite the fingerprint** at what is currently line 207:
   `verify_duration_outlier:${closedValue(latest.payload.outcome, OUTCOMES)}:${durationRatioBand(latest.durationMs, thresholdMs)}`

   `closedValue(..., OUTCOMES)` is already called four lines below for `evidence.outcome`; the
   same call moves up so both use one value rather than computing it twice.

### `packages/metrics/src/anomaly.test.ts`

Existing fixtures `baselineRuns(n)` and the `Suppression[]` construction at ~line 188 are the
right shapes and are reused. No new harness.

## Test mapping

| Criterion | Test | Mutation that must break it |
|---|---|---|
| A1 | `durationRatioBand returns each band, and na for bad input` | drop the `na` guard |
| A2 | `boundaries land in the upper band` | flip `<` to `<=` at either boundary |
| A3 | **`bands are relative, not absolute`** — 300s/150s and 3000s/1500s both `2x` | key the band off `durationMs` alone |
| A4 | `a blip and a hang get different fingerprints, through detect` | revert to `magnitudeBucket` |
| A5 | `two runs in the same band and outcome share a fingerprint` | make the band unique per run |
| A6 | `a blip's suppression does not suppress a later hang` | revert the fingerprint |
| A7 | `a matching fingerprint DOES suppress` | invert `isSuppressed` |
| A8 | **`a killed run and a slow green run differ`** | drop `outcome` from the fingerprint |
| A9 | **`all three bands reachable at p95 = 67.5s`** | key bands to an absolute floor |
| A10 | `150s vs 550s differ; 310s vs 320s match` | any of the above |
| A11 | `the other three fingerprints unchanged` | — (guard only; cannot fail) |

A9 is the one that would have caught the design defect the review found, so it is written to
compute the threshold the way `detectDurationOutlier` does rather than restating 270s.

A11 is **labelled as a guard, not evidence** — `magnitudeBucket` has one call site, so no
implementation of this change can affect the other three fingerprints. Recorded here so
`review.md` cannot later present it as coverage.

## Risks

- **A5 passes against today's code.** It is the property that must *survive*, not the change, so
  it is non-vacuous only next to A4/A10. Stated so the pairing is deliberate.
- **E5's boundary oscillation is a real regression** against `log10` and is accepted in the spec.
  No test can prove it harmless; the mitigation is that `outcome` is stable across it.
- **No anomaly has ever fired** in 116 recorded runs (median 11.1s, max 67.5s), so every test
  here is synthetic and none of this is validated against a real event.

## Out of scope, recorded

- `failedStep` in the fingerprint. Would separate a typecheck hang from a test hang; would also
  make a wandering hang file one incident per step. Decided in the spec, not deferred by accident.
- `writeSuppressions` never prunes, so dead rows accumulate. Pre-existing; queued.
- `suppressionHours` itself. A separate decision this loop does not reopen.
