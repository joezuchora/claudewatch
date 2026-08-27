# Spec: a duration fingerprint that discriminates

- **Status:** draft — one band removed as structurally unreachable, found by reading verify.ts's control flow rather than assuming it
- **Stage:** 2 — Design
- **Reads:** `sdlc/022-duration-fingerprint/intent.md`

## The decision

Replace `magnitudeBucket`'s `log10` with an **explicit band table keyed to this gate's own
timings**, and include the band name in the fingerprint.

```
verify_duration_outlier:elevated      120s ≤ d < 240s
verify_duration_outlier:severe        240s ≤ d < 300s
verify_duration_outlier:stepTimeout   300s ≤ d          (open-ended)
```

> **Corrected before review returned.** A first draft had a fourth band, `multiTimeout`, at
> 600s+. It is **structurally unreachable**: `scripts/verify.ts:217` breaks on the first failing
> step, so at most one step can time out in a run. The ceiling is one 300s timeout plus the fast
> steps preceding it — about 325s. Designing a band for 600s+ would have been a boundary chosen
> against a range I had not measured, which is `sdlc/013`'s error in new clothes.
>
> The top band is therefore open-ended rather than capped. Nothing is unrepresentable, and no
> number pretends to a precision the system cannot produce.

Below 120s is unreachable — `minOutlierMs` is the floor for raising the anomaly at all — so no
band exists for it. The `na` case for a non-finite or non-positive duration is kept.

### Why bands rather than a finer logarithm

Half-decade buckets (`Math.floor(log10(v) * 2) / 2`) would separate 150s from 900s and are a
one-character change. Rejected because the boundaries would land wherever the logarithm puts
them — 316s, 562s — and none of those numbers means anything here. **The interesting boundaries
in this system are 120s (the threshold), 300s (`STEP_TIMEOUT_MS`), and 600s (more than one step
timing out).** A reader seeing `stepTimeout` in a fingerprint learns something; one seeing `5.5`
has to reconstruct the arithmetic.

This is the `sdlc/015` lesson applied forward: a threshold should be a *decision*, and the way to
make it one is to name it after the thing it corresponds to.

### The numbers, and where each comes from

| Boundary | Value | Derived from |
|---|---|---|
| floor | 120s | `BOUNDS.minOutlierMs` — imported, not restated |
| `elevated`/`severe` | 240s | **2× the threshold.** The one boundary here that is a judgement rather than a constant in the system. Chosen so a run that merely doubles the alert floor is distinguishable from one approaching a step timeout. |
| `severe`/`stepTimeout` | 300s | `STEP_TIMEOUT_MS` in `scripts/verify.ts` — a run at or past this had a step killed |
| ~~`stepTimeout`/`multiTimeout`~~ | ~~600s~~ | **Removed.** Unreachable — see the correction above. |

**300s and 600s must not be hardcoded twice.** `scripts/verify.ts` owns `STEP_TIMEOUT_MS` and
`packages/metrics` must not import from `scripts/`. So the value is declared in `BOUNDS` with a
comment naming its source, and a test asserts the two agree — the same shape as `sdlc/021`'s
`MAX_LINE_BYTES` binding, and for the same reason: a duplicated constant that nothing checks is
`sdlc/015` waiting to happen.

## Behavioral contract

### `durationBand(ms: number): string`

Replaces `magnitudeBucket`. Not exported from the package's public surface — internal to
`anomaly.ts` — but exported from the module so its test can reach it.

| Input | Output |
|---|---|
| non-finite, ≤ 0 | `'na'` |
| `0 < d < 120_000` | `'belowThreshold'` |
| `120_000 ≤ d < 240_000` | `'elevated'` |
| `240_000 ≤ d < 300_000` | `'severe'` |
| `300_000 ≤ d` | `'stepTimeout'` |

`belowThreshold` is unreachable from `detectDurationOutlier` (the caller has already compared
against `minOutlierMs`), and exists so the function is **total** rather than having an implicit
gap. A closed set of four strings also keeps the fingerprint §17-safe, which the old
`String(number)` was only incidentally.

### Fingerprint

`verify_duration_outlier:${durationBand(latest.durationMs)}`

Same shape as today, so `isSuppressed`'s equality match is unchanged.

## Edge cases

| # | Case | Behavior |
|---|---|---|
| E1 | Exactly 120_000 | `elevated`. The threshold is `>`, so this is unreachable in practice, but the band table must not have a hole at its own floor. |
| E2 | Exactly 300_000 | `stepTimeout`. A step killed at exactly the ceiling is a timeout, not a near-miss. |
| E3 | `NaN`, `Infinity`, `-1`, `0` | `'na'`, as today. |
| E4 | A blip then a hang within 24h | **Different fingerprints, so the hang is NOT suppressed.** The case the loop exists for. |
| E5 | Two hangs of similar size within 24h | Same fingerprint, second suppressed. `sdlc/009`'s reason preserved. |
| E6 | A duration beyond any plausible run (e.g. 10^7 ms) | `stepTimeout`. The top band is open-ended, so there is no upper bound to get wrong — and nothing above it to leave unrepresentable. |
| E7 | **No anomaly has ever fired.** 115 recorded runs, median 11.1s, max 67.5s, none over the 120s threshold. | This change is therefore untestable against production data and is tested against synthetic events only. Stated because a reader could otherwise assume the bands were tuned to observed anomalies; they are tuned to the system's *structure* — the threshold and the step timeout — which is the only evidence available. |

## Acceptance criteria

| # | Criterion |
|---|---|
| A1 | Each band returns its documented name for a value inside it, asserted per band |
| A2 | Each boundary value lands in the **upper** band: 120_000 ⇒ `elevated`, 240_000 ⇒ `severe`, 300_000 ⇒ `stepTimeout` |
| A3 | `na` for `NaN`, `Infinity`, `-Infinity`, `0`, `-1` |
| A4 | **The motivating case**: 150s and 900s produce *different* fingerprints — and, in the same test, today's `log10` scheme is shown to produce the *same* one, so the test cannot pass against the old code |
| A5 | Two runs in the same band produce the *same* fingerprint — the suppression property that must survive |
| A6 | **A blip does not suppress a later hang**: drive `evaluate` with a 150s anomaly, record the suppression, then a 900s anomaly, and assert the second is raised rather than suppressed |
| A7 | Two similar hangs *are* suppressed, through the same `evaluate` path — A6's non-vacuous pair |
| A8 | `BOUNDS.stepTimeoutMs` equals `STEP_TIMEOUT_MS` in `scripts/verify.ts`, asserted by reading that file |
| A9 | The other three fingerprints are byte-identical to today for the same inputs |

A4 is the criterion that makes the rest non-vacuous: it pins the *change*, not just the new
behaviour. A6/A7 exercise the real `evaluate` path rather than `durationBand` alone, because the
defect is about suppression and suppression lives there.

## Risks

- **A8 reads a file from another package.** `packages/metrics` must not *import* `scripts/`, but a
  test may read it as text — the `sdlc/021` precedent where `env.test.ts` imports core while the
  gate does not. If `STEP_TIMEOUT_MS`'s declaration is reformatted, the regex breaks and the test
  goes red for the wrong reason. Acceptable: a red test naming a constant mismatch is far cheaper
  than a silent drift.
- **The reachable range is 120s–~325s**, so `severe` and `stepTimeout` are narrow and no run has
  ever entered any band. The design rests on the system's structure rather than its history,
  which is the honest basis available — but it means the band boundaries have not been validated
  against a real anomaly and cannot be until one occurs.
- **240s is the one invented number here.** It is a judgement, and this spec is where it is
  argued rather than inherited. If it proves wrong the band table is one line to change — which is
  the point of naming boundaries instead of computing them.
- **Existing `suppressions.json` entries carry old fingerprints** (`verify_duration_outlier:5`).
  After this change they match nothing, so a condition suppressed under the old scheme can raise
  once more. That is correct — the old fingerprint was meaningless — but it should be stated, not
  discovered.
