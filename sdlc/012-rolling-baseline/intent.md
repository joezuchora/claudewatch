# Intent: the anomaly detector's baseline never moves

- **ID:** 012-rolling-baseline
- **Stage:** 1 — Plan
- **Status:** amended — see the correction below
- **Author:** the metrics pipeline, read after loop 011 shipped
- **Date:** 2026-08-26

## Correction, 2026-08-26 (Design stage)

**Two of the numbers below are wrong, and the spec-reviewer caught both.** They are left in
place rather than edited away, because an intent that quietly acquires the right answer is
worthless as a record of how the answer was reached.

1. **"until the pre-011 runs age out of the 90-day retention window" / "for the next three
   months" is wrong by about two orders of magnitude.** `percentile` indexes
   `sorted[floor(0.95·n)]`, so five slow runs stop occupying the p95 index once
   `floor(0.95·n) ≤ n−6` — first true at **n = 101**, i.e. about 82 more runs. At the rate this
   gate is now run that is a couple of hours, not three months. The desensitisation is real;
   the urgency was invented.

2. **"a hang makes the following hang harder to see" holds only at n ≤ 20.** At n = 21 the p95
   index stops being the maximum index, so a single hang no longer touches the threshold. The
   ratchet needs hangs to be ≥5% of the sample to exist at all.

What survived the review, and what the loop is now actually about, is in `spec.md`. It is a
different and larger defect than the one described below, found by reading the code path that
feeds the detector rather than the detector itself.

## Problem

`detectDurationOutlier` in `packages/metrics/src/anomaly.ts` builds its baseline from
`runs.slice(0, -1)` — *every* retained `verify_run`, not a recent window. It then fires when the
latest run exceeds 4× that baseline's p95.

That was fine while the gate's duration was stationary. Loop 011 took `bun run verify` from
~60 s to ~5.5 s, and the store now reads:

```
{"verify":{"runs":20,"passRate":0.9,"p50DurationMs":5959,"p95DurationMs":67537,...}}
```

p50 is 6 s. p95 is 67.5 s. The trip wire sits at 4 × 67.5 s ≈ **270 s**, and because the
baseline is all-time rather than rolling, it will stay there until the pre-011 runs age out of
the 90-day retention window.

So for the next three months the detector will miss a 100 s verify run — a **17× regression**
against the gate's actual behaviour — while reporting `healthy`. The instrument did not get
sharper when the thing it measures got faster; it got blunter, silently.

This generalises past this one incident: **any** step change in a measured quantity
desensitises the detector for a full retention period, in the direction of missing things. A
monitor that quietly loses sensitivity is worse than one that is obviously broken, because
`healthy` still gets printed.

## Who is affected

Only this project, today — the detector is not deployed anywhere but here. But it is the
component the whole Maintain stage rests on, and the still-undiagnosed 550 s verify hang is
exactly the class of event it exists to catch. It happens to be large enough to still fire
(550 / 67.5 = 8.1×), which is luck, not design.

## Why now

Because the desensitisation is live right now, and because the evidence is sitting in the
store where it can be reasoned about concretely rather than hypothetically. Waiting means the
first thing the detector misses is discovered by its consequences.

There is also a sharper reason: I wrote a prediction about this in `sdlc/README.md` — that the
detector's baseline was rolling and would re-anchor on its own — and it was wrong on two
counts. It was corrected by *running* the detector rather than re-reading it. That is the
fourth time in this project the real artifact has contradicted a confident reading of the code,
and it argues for doing this now while the instinct is fresh.

## What "done" means

- [ ] The detector's baseline reflects recent behaviour, so a step change re-anchors it within
      a bounded and stated number of runs rather than a retention period
- [ ] A regression that is large relative to the *current* normal is detected, even when the
      history contains much slower runs
- [ ] A gate that gets *faster* still never fires the detector — the rule stays one-sided
- [ ] The transition itself does not produce a false positive: the runs immediately after a
      step change must not be flagged simply because the window is mixed
- [ ] Whatever window is chosen is stated in `BOUNDS` with the reasoning, alongside the
      existing bounds, and tested from **both** sides as loop 009 established

## Explicitly out of scope

- The other three detectors (pass rate, drift spike, fetch failure rate). Pass rate is already
  windowed at 10; the other two should be *examined* for the same defect, but changing them is
  separate work with separate evidence.
- Retention policy. 90 days is a storage decision, not a detection one, and conflating them is
  how a monitoring change turns into a data-loss change.
- The 550 s hang itself. Still blocked on data. This makes the instrument better; it does not
  explain the event.
- Wiring `metrics:detect` into the hourly systemd loop. That was already deferred pending
  observation, and shipping an unwatched detector whose sensitivity is under active change
  would be the wrong order.

## Open questions

- **Window by count or by time?** A count (say, the last 50 runs) is simple and matches
  `passRateWindow`. A time window matches how a person thinks about "recently". They diverge
  badly when run frequency changes — which, note, loop 011 also just changed.
- **Does a mixed window need a guard?** During the transition the window holds both 60 s and
  6 s runs, so its p95 is high and its p50 low. That is the *safe* direction for a one-sided
  rule, but it should be a stated conclusion rather than an accident.
- **Should a step change be detected in its own right?** "The baseline moved by 10×" is
  arguably a finding worth surfacing, not just a state to absorb. It is also how a monitor
  starts crying wolf. Design should settle this, not Build.

---

**Next stage:** Design — run `/sdlc-spec 012-rolling-baseline` to turn this into `spec.md`.
