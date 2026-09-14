# Review: a duration fingerprint that discriminates

- **Status:** accepted
- **Stage:** 5 — Deploy
- **Gate:** `bun run verify` green in 12.0s, 745 tests across 32 files, lint at the standing 12

## What shipped

`magnitudeBucket` → `outcome` + `durationRatioBand(durationMs, thresholdMs)`. Two files,
inside the fence. The fingerprint shape is unchanged, so `cli-detect.ts` needed no edit —
confirmed by reading it, not assumed.

## The finding that explains why this survived nine loops

**All 42 existing anomaly tests passed against the new fingerprint.**

That is not a compatibility win; it is the diagnosis. Every one of them captures the fingerprint
*dynamically* — `first.anomalies[0].fingerprint` — and asserts the round trip. *"A fingerprint
suppresses itself"* is true of a **constant**. Nothing ever asserted that two different
conditions produce two different fingerprints, so the defect was invisible to a green suite for
nine loops.

The lesson generalizes past this file: **a test that captures a value and feeds it back can only
prove the pipe is connected, never that the value means anything.**

## Mutation log

| # | Mutation | Caught by |
|---|---|---|
| V1 | revert to `magnitudeBucket` | A4, A8 |
| V2 | drop `outcome` from the fingerprint | A8, and the literal-fingerprint test |
| V3 | **key the band to an absolute duration** — the exact defect that killed the draft design | A3, A9 |
| V4 | remove the `na` guard | A1 |
| V5 | boundaries flipped to the lower band | A2, A3 |
| V6 | band returns a constant | A1, A2 |

## Findings from the Stage 2 review

Recorded in full in `review-spec.md`. The verdict was **revise** and the design was replaced,
not adjusted. Two findings are worth repeating here because they were mine to catch:

- **The band table classified a total using per-step constants.** Five passing steps at 62s total
  310s and exit 0, and the draft would have labelled that a step timeout with nothing killed.
- **The bands were anchored to a floor that moves.** At the slowest legitimate run on record the
  real threshold is 270s, so the draft's lowest band would have been *empty* — the fingerprint
  collapsing back to a constant under exactly the conditions it was built for. **A9 is written to
  catch precisely this**, computing the threshold the way `detectDurationOutlier` does rather
  than restating 270_000.

And one that is uncomfortable: the draft **named the `sdlc/015` failure mode in one paragraph and
committed it two paragraphs later**, asserting an architecture rule (`packages/metrics` must not
import from `scripts/`) that does not exist. Writing a lesson down does not confer immunity to it.

## Decisions taken, not deferred

- **`failedStep` is excluded from the fingerprint.** It would separate a typecheck hang from a
  test hang — genuinely useful for the open hang investigation — but a hang that wanders between
  steps would then file one incident per step, which is what `sdlc/009`'s suppression exists to
  prevent. One field to add if the trade proves wrong.
- **Boundary oscillation is a real regression against `log10`.** A recurring condition whose ratio
  straddles 2× will alternate fingerprints and file roughly every other hour. `log10`'s only
  boundary sat outside the reachable range and so never did this. Accepted because `outcome` is
  stable across the oscillation, collapsing the worst case from twelve fingerprints to two.

## What this change does not do

- **Nothing here is validated against a real anomaly.** 116 recorded runs, median 11.1s, max
  67.5s — none has ever crossed the threshold. Every test is synthetic, and the bands are tuned to
  the detector's *structure* rather than to observed events, because there are none.
- **It does not explain the intermittent hang.** It makes a hang *reportable* when a blip preceded
  it. That is all.
- **`writeSuppressions` still never prunes**, so dead `verify_duration_outlier:5` rows accumulate
  forever. Pre-existing, out of this fence, queued.
- **Existing suppression rows match nothing** after this change. Bounded and small: `isSuppressed`
  already ignores rows older than 24h, so at most one duplicate incident draft, on one machine,
  once.

## A test bug of my own

A7 asserted `status === 'anomalies'` when a fully-suppressed result is `'healthy'`, so a false
ternary returned an empty list and the test read like a code failure. The existing suppression
test three describes above had the right shape all along.
