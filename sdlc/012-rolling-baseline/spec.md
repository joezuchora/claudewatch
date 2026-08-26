# Spec: a baseline that reflects the gate as it is now

- **ID:** 012-rolling-baseline
- **Stage:** 2 — Design
- **Status:** draft
- **Derived from:** [`intent.md`](./intent.md)

## Summary

`detectDurationOutlier` will compare the latest verify run against the **median of a bounded
window of recent runs**, rather than against the p95 of all retained history. A step change in
the gate's duration will re-anchor the detector as soon as it is the majority of the window,
instead of persisting for the 90-day retention period.

## Two defects, not one

The intent named the all-time baseline. Reading the real store surfaced a second, and it is
the worse of the two.

**Defect 1 — the baseline never moves.** `runs.slice(0, -1)` is every retained run.

**Defect 2 — at these sample sizes, p95 *is* the maximum.** `percentile` indexes
`sorted[floor(0.95 * n)]`. With the 19-sample baseline that `minVerifyRuns: 20` guarantees,
that is `sorted[18]` — the largest element. The store confirms it directly:

```
min 2132  p50 5959  p90 59965  p95 67537  max 67537
                                  ^^^^^      ^^^^^  identical
```

So the trip wire is "4× the slowest run we have ever seen." That is a **ratchet**: every slow
run raises the bar for detecting the next one, and a hang makes the following hang harder to
see. A detector that becomes less sensitive each time it nearly fires is worse than the
all-time window on its own, and fixing only Defect 1 would leave it in place.

## The statistic

**Median of the window, not p95.** Two reasons, both load-bearing:

1. **It is robust.** A hang cannot move the median, so the ratchet disappears. p95 over a small
   window is definitionally the extreme value it is supposed to be measuring against.
2. **It re-anchors on 50% turnover, not 95%.** With 15 of the current 20 runs post-011, the
   median is already 5 959 ms while the p95 is still 67 537 ms. The median has effectively
   re-anchored; the p95 has not moved at all. That difference *is* the intent's complaint.

## The multiple, derived from data rather than chosen

`4× p95` and a multiple of the median are not comparable numbers, so the multiple must change
with the statistic. Observed within-regime spread, from the 20 runs in the store:

| Regime | n | median | max | max ÷ median |
|---|---|---|---|---|
| post-011 (fast gate) | 15 | 5 798 ms | 8 268 ms | **1.43×** |
| pre-011 (slow gate) | 5 | 59 500 ms | 67 537 ms | **1.13×** |

Normal variation stays within ~1.5× of the median in both regimes. **`durationOutlierMultiple:
8`** leaves roughly 5.5× of headroom above the worst normal run observed — comfortable, given
this detector's standing rule that a false positive costs more than a miss.

At today's median that sets the trip wire at ~48 s. The undiagnosed 550 s hang is 92× and fires
easily. A return to the pre-011 60 s gate also fires — correctly, because at the current
baseline that *is* a 10× regression, and it stops firing once the median absorbs it.

## The window

**By count (`verifyBaselineWindow: 50`), not by time.** A time window's sample size depends on
how often someone happens to run the gate — and loop 011 just changed that by an order of
magnitude, which is precisely the wrong thing for a window to be sensitive to. A count also
matches the existing `passRateWindow: 10`.

Fifty is bounded and stated, which is what the intent asked for. Because the statistic is the
median, full turnover is not required: the detector re-anchors once the new regime is the
majority of the window.

## An absolute floor

**`minOutlierMs: 20_000`.** No run under 20 s is called an anomaly, whatever the ratio. If the
gate ever reaches a 2 s median, `8×` would put the wire at 16 s, and raising an incident record
because a gate took 20 s would be absurd by any standard this project has ever held. Twenty
seconds is deliberately far below any plausible hang — the event this detector exists for was
550 s.

This is a *deliberate* reduction in sensitivity, unlike the accidental one this loop is fixing.
Recorded as such rather than slipped in.

## Making the sensitivity visible

The intent's real complaint is not that the threshold was wrong — it is that it was wrong
**silently**, while `healthy` kept printing. So `detect` will report the baseline it used:

```ts
export interface DurationBaseline {
  samples: number;      // how many runs the window actually held
  medianMs: number;
  thresholdMs: number;  // max(median * multiple, minOutlierMs)
}
```

carried on the `healthy` and `anomalies` results and printed by `cli-detect`. A future reader
sees what the instrument is currently able to detect, instead of having to derive it from the
code and the store. Had this existed, this loop would have been a five-second observation
rather than a discovery.

## Data and types

- `BOUNDS` gains `verifyBaselineWindow` and `minOutlierMs`; `durationOutlierMultiple` changes
  from 4 to 8 and now applies to the median.
- `DetectResult`'s `healthy` and `anomalies` variants gain `durationBaseline?:
  DurationBaseline` — **optional**, because `insufficient-data` has no baseline and the project
  rule is that a missing optional field is omitted, not guessed.
- The anomaly's `evidence` replaces `baselineP95Ms` with `baselineMedianMs` and gains
  `thresholdMs` and `windowSize`. Evidence goes into an incident record verbatim, so a stale
  field name would mislead whoever reads it.
- No stored schema change. This is all read-side; `schema_version` is untouched.

## Edge cases

| Case | Expected behavior |
|---|---|
| Fewer than `minVerifyRuns` runs | `insufficient-data`, unchanged. No baseline reported. |
| Window larger than available runs | Use what exists. The `minVerifyRuns` floor already guarantees enough. |
| Latest run is *faster* than the baseline | Never fires. The rule stays one-sided — a gate getting faster is good news, not an incident. |
| Mixed window during a transition | The median sits between the regimes, so the threshold is *higher* than the new normal warrants. Blunt, never a false positive — the safe direction, and now a stated conclusion rather than an accident. |
| Latest run has `durationMs === null` | No verdict from this detector, unchanged. |
| Median resolves to 0 or negative | No verdict. A zero baseline makes every ratio infinite. |
| Latest exceeds the multiple but is under `minOutlierMs` | Does not fire. |
| Some runs in the window failed | Included. The median is robust: a minority of fast failures barely moves it, and excluding them would shrink the sample for no measurable gain. See rejected alternatives. |

## Backward compatibility

- **Stored data is untouched.** Read-side only; every existing event stays valid.
- **`detect()`'s signature is unchanged**, and the added result field is optional, so
  `cli-detect` and the tests compile without modification before they are updated to use it.
- **The other three detectors are unchanged.** They were examined for the same defect and do
  not have it: `detectPassRate` is windowed at 10 runs, `detectDriftSpike` compares 24 h
  against the prior 7 days, `detectFetchFailures` is a 24 h window. The all-time baseline was
  unique to the duration rule. Examined, stated, and left alone.

## Acceptance criteria

- [ ] A window of runs at ~6 s with a much slower run in the *distant* history does not push the threshold up — verified by a test whose history contains a 67 s run outside the window
- [ ] A latest run at 10× the recent median fires — tested
- [ ] A latest run at 10× the median but under `minOutlierMs` does **not** fire — tested
- [ ] A latest run *faster* than the baseline never fires, at any ratio — tested
- [ ] A mixed transition window produces a threshold above the new normal and does not fire — tested
- [ ] A single slow run in the window does **not** raise the threshold materially (the ratchet is gone) — tested by comparing thresholds with and without it
- [ ] `detect` reports `durationBaseline` on `healthy` and `anomalies`, and `cli-detect` prints it — verified by running it against the real store
- [ ] Every new bound is tested from **both** sides, per the rule loop 009 set
- [ ] `bun run verify` exits 0

## Rejected alternatives

- **Keep p95, enlarge the window until p95 ≠ max.** Needs ~100 samples before p95 has two runs
  above it, and even then it tracks the extreme. It treats the symptom of Defect 2 while
  leaving the ratchet's mechanism intact.
- **A time-based window (last 7 days).** Sample size becomes a function of how often the gate
  is run, which loop 011 just changed by 10×. A window should not be sensitive to that.
- **Mean instead of median.** One 550 s hang in fifty 6 s runs moves the mean by 18%, so the
  ratchet survives in a weaker form. The whole point of choosing the statistic deliberately is
  to pick one a hang cannot move.
- **Exclude failed runs from the baseline.** Examined, not adopted. It is the right instinct
  for a *mean*; for a median a minority of fast failures shifts the centre negligibly, and it
  costs sample size for no measurable gain. Revisit if the pass rate ever falls far enough that
  failures are the majority — at which point `detectPassRate` is already firing.
- **Detect the step change itself as an anomaly.** "The baseline moved 10×" is real
  information, but a gate getting faster raising an incident is exactly how a monitor starts
  crying wolf. Reporting `durationBaseline` gives a human the same information without
  demanding anyone act on it.
- **Shorten retention so old runs age out.** Fixes the symptom by deleting evidence, and turns
  a detection change into a data-loss change.

---

**Next stage:** Build — run `/sdlc-plan 012-rolling-baseline` to turn this into `plan.md`.
