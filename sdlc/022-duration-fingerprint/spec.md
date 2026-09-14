# Spec: a duration fingerprint that discriminates

- **Status:** revised — the first draft's band table was anchored to the wrong constants and
  asserted causes the number cannot show
- **Stage:** 2 — Design
- **Reads:** `intent.md`
- **Review:** `review-spec.md`

## The decision

```
verify_duration_outlier:${outcome}:${ratioBand}
```

- **`outcome`** — `pass` | `fail` | `timeout` | `unknown`, already on the payload and already
  normalized through `closedValue(..., OUTCOMES)` at `anomaly.ts:223`.
- **`ratioBand`** — `1x` | `2x` | `4x`, from `durationMs / thresholdMs`, where `thresholdMs` is
  the value the detector *already computed to decide this was an anomaly at all*.

| ratio | band |
|---|---|
| `1 ≤ r < 2` | `1x` |
| `2 ≤ r < 4` | `2x` |
| `4 ≤ r` | `4x` |

`r < 1` is unreachable — the anomaly only exists because `durationMs > thresholdMs` — and maps
to `1x` so the function is total.

## Why the first draft was wrong

It proposed absolute bands at 120s / 240s / 300s / 600s named `elevated`, `severe`,
`stepTimeout`, `multiTimeout`. Four separate things were wrong with that, and they are recorded
because each is a distinct mistake:

**1. It classified a total using per-step constants.** `latest.durationMs` is `totalMs` — the sum
of up to five steps (`verify.ts:224`). `STEP_TIMEOUT_MS` bounds *one* step. Five passing steps at
62s total 310s and exit 0; the draft labelled that run `stepTimeout` and nothing was killed. The
implication only runs one way: a killed step forces total ≥ 300s, but total ≥ 300s implies
nothing about any step. The draft's whole claimed advantage over a logarithm was that a reader
"learns something" from the name — and what they'd learn is false exactly when the machine is
uniformly slow rather than hung, which is the condition `sdlc/015` documented.

**2. The bands were anchored to a floor that moves.** The trigger is
`max(p95 * durationOutlierMultiple, minOutlierMs)`, not `minOutlierMs`. At the observed p95 of
67.5s the real floor is **270s**, so the draft's `elevated` band [120, 240) would be **empty** —
and at p95 = 75s, `severe` empties too. `sdlc/012` made the baseline rolling precisely so it
would move, and it moves most during exactly the slow periods when duration anomalies fire. The
draft's fingerprint would have degraded back toward a constant under the conditions it was built
for.

**3. `STEP_TIMEOUT_MS` is not a constant and cannot be imported.** It is
`Number(process.env.CLAUDEWATCH_VERIFY_TIMEOUT_MS ?? 300_000)` (`verify.ts:59`) — configurable,
unexported, and in a module that runs the entire gate at import. The draft's A8 was
unimplementable, and binding to `300_000` would have bound to a default while the real ceiling
differed.

**4. It asserted an architecture rule that does not exist.** *"`packages/metrics` must not import
from `scripts/`"* — there is no such rule. The rule that exists runs the **other way**:
`scripts/verify.ts` must not import `packages/core`, for a specific reason
(`config.ts:36-39`). And `scripts/env.test.ts:7` imports from `packages/` freely. Presenting an
invented constraint as an inherited one is the `sdlc/015` failure mode this spec had itself
named two paragraphs earlier.

**The revised design needs none of those constants.** A ratio against the detector's own
threshold cannot be emptied by a moving baseline, needs no knowledge of step timeouts, and
crosses no package boundary.

## Why `outcome` carries most of the weight

The intent's bar is *"two anomalies a human would call different events get different
fingerprints."* The band table alone still collides on the pairs that matter most:

| A | B | Same band? |
|---|---|---|
| A run killed at the ceiling (`timeout`, exit 124) | A run that passed in 310s (`pass`, exit 0) | Yes — dead gate and green gate, one fingerprint |
| A `typecheck` hang (~300s) | A `test` hang (~315s) | Yes |

`outcome` is a fact recorded by `verify.ts:135`, not an inference from a sum. Putting it first in
the fingerprint separates *the gate was killed* from *the box was slow* — which is what "different
events" actually means here — and costs one field.

**`failedStep` is deliberately not included.** It would separate the typecheck/test hang pair, and
`sdlc/009`'s suppression exists so a recurring condition files one incident rather than twelve; a
hang that wanders between steps would then file one per step. That is a real trade and this is the
place it is decided rather than discovered. Recorded as an open question, not a settled one.

## Behavioral contract

### `durationRatioBand(durationMs: number, thresholdMs: number): string`

Exported from `anomaly.ts` so its test can reach it.

| Condition | Result |
|---|---|
| either argument non-finite, or `thresholdMs <= 0` | `'na'` |
| `r < 2` (including `r < 1`) | `'1x'` |
| `2 ≤ r < 4` | `'2x'` |
| `4 ≤ r` | `'4x'` |

### Fingerprint

`verify_duration_outlier:${closedValue(payload.outcome, OUTCOMES)}:${durationRatioBand(durationMs, thresholdMs)}`

Both components are members of closed sets, so the fingerprint remains a bounded string —
worth having, though **not** for the reason the draft gave. Fingerprints go to a machine-local
`suppressions.json` and to incident drafts; neither is telemetry, so `SPEC.md` §17 does not
govern them. The draft claimed it did. It does not.

## Edge cases

| # | Case | Behavior |
|---|---|---|
| E1 | `r` exactly 2 or 4 | Upper band. |
| E2 | `thresholdMs` is 0 or negative | `'na'`. Unreachable — `detectDurationOutlier` returns early when `p95 <= 0` — kept for totality. |
| E3 | A blip (`r≈1.1`, `pass`) then a hang (`r≈4`, `timeout`) within 24h | **Different on both components.** The case the loop exists for. |
| E4 | The same hang recurring at `r` 4.1 then 4.3 | Same fingerprint, second suppressed. `sdlc/009` preserved. |
| E5 | **A recurring condition straddling a boundary** — `r` oscillating 1.9 / 2.1 / 1.95 | **Alternates fingerprints and files roughly every other hour.** This is a real regression against `log10`, whose only boundary sat outside the reachable range. Accepted knowingly: `outcome` is stable across such oscillation, so the pair still collapses to two fingerprints rather than twelve, and a ratio boundary is far from the distribution's mass in a way an absolute one is not. Recorded so it is a decision. |
| E6 | No anomaly has ever fired | 115 recorded runs, median 11.1s, max 67.5s, none over threshold. Tested against synthetic events only; the bands are tuned to the detector's own structure, not to observed anomalies, because there are none. |

## Acceptance criteria

| # | Criterion |
|---|---|
| A1 | `durationRatioBand` returns each band for a value inside it, and `'na'` for non-finite or non-positive `thresholdMs` |
| A2 | Boundaries land in the upper band: `r = 2` ⇒ `2x`, `r = 4` ⇒ `4x` |
| A3 | **Bands are unaffected by the absolute duration.** 300s against a 150s threshold and 3000s against a 1500s threshold both give `2x` — the property the draft's absolute bands could not have |
| A4 | **The motivating case, through `detect`**: with a fixed baseline, a 150s `pass` and a 900s `timeout` latest produce **different** fingerprints |
| A5 | **The suppression property, through `detect`**: two latests in the same band with the same outcome produce the **same** fingerprint |
| A6 | **A blip does not suppress a later hang**: run `detect`, capture the blip's fingerprint, then call `detect` again with the hang and `[{fingerprint: captured, raisedAt: hoursAgo(1)}]`; assert `status === 'anomalies'` and `suppressed` is empty |
| A7 | **A7's non-vacuous pair**: the same construction with a *matching* fingerprint yields `suppressed` non-empty |
| A8 | **A killed run and a slow-but-green run of similar duration get different fingerprints** — the collision `outcome` exists to break |
| A9 | **Band reachability survives a moved baseline.** At p95 = 67.5s (threshold 270s), all three bands remain reachable, asserted by computing them — the defect that killed the draft's design |
| A10 | For a fixed baseline, `detect` gives different fingerprints for 150_000 and 550_000, and the **same** for 310_000 and 320_000 — fails against today's code, against an unwired band function, and against a constant |
| A11 | The other three fingerprints are unchanged (regression guard only — `magnitudeBucket` has one call site, so this cannot fail; kept, and labelled, as a guard rather than evidence) |

A10 is the standing guard. A4 proves the change happened; A10 keeps proving it.

## Risks

- **E5's oscillation is the known cost.** Stated above rather than discovered later.
- **`failedStep` is omitted deliberately**, and that decision may prove wrong for the hang
  investigation. It is one field to add if so.
- **Existing `suppressions.json` rows carry `verify_duration_outlier:5`** and will match nothing.
  Impact is bounded and small: `isSuppressed` already ignores rows older than 24h, so at most one
  duplicate incident draft, on one machine, once. (`writeSuppressions` never prunes, so dead rows
  accumulate — pre-existing, out of scope, queued.)
- **No anomaly has ever fired**, so none of this is validated against a real event and cannot be
  until one occurs.
