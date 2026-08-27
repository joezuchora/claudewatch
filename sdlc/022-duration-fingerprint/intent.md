# Intent: the duration fingerprint cannot tell two hangs apart

- **Status:** accepted
- **Stage:** 1 — Plan
- **Date:** 2026-08-27
- **Source:** `sdlc/012-rolling-baseline` left this open. The queue described it as
  *"`magnitudeBucket` spans a decade: a 150s blip and a 900s hang share a fingerprint and a 24h
  suppression."* Measuring it first showed that is **understated**.

## The problem, measured rather than assumed

`magnitudeBucket` is `Math.floor(Math.log10(ms))`. Against the range this detector can actually
reach:

| duration | bucket |
|---|---|
| 120s — the threshold, the smallest anomaly that can fire | 5 |
| 150s | 5 |
| 300s — a single step hitting `STEP_TIMEOUT_MS` | 5 |
| 900s | 5 |
| 999s | 5 |
| 1000s+ — needs several steps each near-timeout | 6 |

`minOutlierMs` is 120,000 and `STEP_TIMEOUT_MS` is 300,000, so a realistic hang is one timed-out
step plus four normal ones — around 320s. **Every anomaly the detector can raise in practice
carries the fingerprint `verify_duration_outlier:5`.**

So the bucket is not coarse. It is, across the reachable range, **a constant**.

## Why that matters

`suppressionHours` is 24 and `isSuppressed` matches on fingerprint equality. Therefore:

- The first duration anomaly of any magnitude suppresses **every** duration anomaly for 24 hours.
- A 150s blip at 09:00 silently swallows a 900s hang at 09:30.
- The intermittent gate hang — the open investigation this detector was built to serve — is
  exactly the event most likely to be suppressed by an earlier, smaller one.

The suppression itself is right: `sdlc/009` added it so a persistent condition does not file an
incident every hour. The fingerprint is what fails to discriminate.

## Who is affected

The hourly loop, and therefore the hang investigation. Not the shipped product — `anomaly.ts` is
in `packages/metrics`, which never runs in a shipped artifact.

## What "done" means

- Two duration anomalies that a human would call **different events** get different fingerprints.
- Two that a human would call **the same condition recurring** still share one, so `sdlc/009`'s
  reason for suppression survives.
- The boundary between those two cases is a stated decision, not a side effect of `log10`.
- Existing suppression behaviour for the other three anomaly kinds is untouched.
- The change is visible in a test that fails against today's code — not a refactor that reads
  better and behaves identically.

## Explicitly not in scope

- `suppressionHours` itself. 24h is a separate decision and this loop does not reopen it.
- The other three fingerprints (`verify_pass_rate`, `schema_drift_spike`, `fetch_failure_rate`).
  They use different schemes and none of them is a near-constant; changing them here would put
  four decisions behind one fence.
- The hang investigation. This makes a hang *reportable* when a blip preceded it; it does not
  explain one.
