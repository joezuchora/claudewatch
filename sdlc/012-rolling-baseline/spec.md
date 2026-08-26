# Spec: give the duration detector a window it actually controls

- **ID:** 012-rolling-baseline
- **Stage:** 2 — Design
- **Status:** revised after review — see "What the review changed"
- **Derived from:** [`intent.md`](./intent.md)

## What the review changed

The first draft of this spec proposed replacing p95-of-all-history with median-of-a-50-run
window at an 8× multiple. The `spec-reviewer` returned four blocking findings and the design
did not survive them. Recording that here, because the corrections are more useful than the
proposal was:

- **The regime table was cohorted by value, not by time** — I sorted runs into "fast" and
  "slow" buckets *by their duration* and then reported that within-bucket spread was small.
  That is circular. Cohorted honestly by `ts`, the post-011 window (n = 14) has median 5 936 ms
  and max **59 483 ms** — a spread of **10.02×**, not the 1.43× the draft claimed. The 59 s run
  is a passing, 4-step, non-timeout `verify` at 10:30:54, sitting between fast runs on both
  sides. It is one of my own before/after measurements, run on a stashed pre-011 tree.
- **So the proposed 8× multiple would have fired on it.** At a 5 959 ms median the wire sits at
  47.7 s, and the store contains a legitimate 59.5 s run. Against this module's standing rule —
  a false positive costs more than a miss — that is disqualifying.
- **The proposal was also *blunter* than the code it replaced.** At steady state with ~101 fast
  runs, the current rule gives 4 × p95 ≈ 33 s; the proposal gives 8 × median ≈ 48 s. The draft
  never compared the two rules at any sample size other than today's.
- **Two of the intent's premises were wrong**, corrected in the note at the top of `intent.md`.

**The statistic is therefore not changing.** p95 and the 4× multiple stay exactly as they are.

## The defect that is actually worth fixing

It is not in `anomaly.ts` at all. It is one line up the call chain, in `cli-detect.ts:171`:

```ts
const events = store.query({ limit: 1000 });
```

No `kind` filter — though `store.query` supports one — ordered `received_at DESC` and capped at
1000 by `store.ts`. **The detector's entire input is the most recent 1000 events of any kind.**

Three consequences, none of them visible from reading `anomaly.ts`:

1. **The baseline was never "all-time".** It is already windowed — by an accidental, undeclared
   quantity. `runs.slice(0, -1)` looks unbounded; it is bounded by whatever share of 1000
   recent events happens to be `verify_run`.
2. **The window shrinks as the product succeeds.** Loops 003, 007 and 008 wired `render`,
   `fetch_result`, `cache_event` and `schema_drift`. Today the store is 20 events, all
   `verify_run`, so the cap is invisible. One `render` per statusline invocation makes 1000
   events *minutes* of ordinary use — at which point the detector sees a handful of verify runs,
   or none, and reports `insufficient-data` in perpetuity while the store holds thousands.
3. **It fails in the silent direction.** `insufficient-data` and a truncated baseline both look
   like the system working. This is the intent's actual complaint — an instrument that loses
   sensitivity without saying so — just located somewhere other than where the intent looked.

## Behavior

### 1. The window becomes explicit and kind-scoped

`cli-detect` asks for verify runs *as verify runs*:

```ts
store.query({ kind: 'verify_run', limit: BOUNDS.verifyBaselineWindow + 1 })
```

concatenated with the existing general query (which still feeds the drift and fetch detectors)
and deduplicated on `eventId`. `detectDurationOutlier` then takes the last
`verifyBaselineWindow` runs, **excluding the latest**, in the existing `(receivedAt, ts)`
ordering — which becomes load-bearing here in a way it was not when the baseline was
everything, so it is stated rather than assumed.

`verifyBaselineWindow: 50`. Bounded, stated, and by run count rather than by time: a time
window's sample size depends on how often the gate happens to be run, and loop 011 just changed
that by 10×.

### 2. An absolute floor, as a deliberate desensitisation

`minOutlierMs: 120_000`. No verify run under two minutes is called an anomaly, whatever the
ratio.

This is derived, not chosen. The slowest legitimate run in the store is 67 537 ms; 120 s leaves
~1.8× above it. It removes a false positive the **current** code already has latently: once the
pre-011 runs wash out, 4 × p95 ≈ 33 s, and the next stale-tree `verify` at 59 s would raise a
high-severity incident about nothing.

It also repairs a contradiction with `sdlc/009-anomaly-detection/spec.md`, whose guard 2 says a
single breach never raises **except** for the hang detector, "where one event of the right
magnitude is the signal". At a 33 s wire, one event is not of the right magnitude. At 120 s it
is: the event this detector exists for was 550 s.

Being explicit: this reduces sensitivity on purpose, unlike the accidental reduction the loop is
fixing.

### 3. The instrument reports its own sensitivity

```ts
export interface DurationBaseline {
  windowSize: number;    // BOUNDS.verifyBaselineWindow — the configured bound
  samples: number;       // non-null durations the window actually held
  p95Ms: number;
  thresholdMs: number;   // max(p95 * multiple, minOutlierMs)
}
```

Reported on `healthy` and `anomalies` whenever a p95 could be computed — **including** when the
latest run's duration is `null` and no verdict follows, since that is exactly when a reader
needs it. Printed by `cli-detect` as a single line of stated format:

```
baseline: p95 8268ms over 19 runs (window 50), threshold 120000ms
```

Had this line existed, this loop would have been a five-second observation instead of a
discovery.

### 4. The window must contain real durations

The current `baseline.length < BOUNDS.minVerifyRuns - 1` guard runs *after* the `d !== null`
filter, so it guarantees ≥19 real numbers. `minVerifyRuns` counts `verify_run` **events**, not
events with durations. Under a fixed 50-run window that guard must be kept and stated, or a
window of 50 events with 48 nulls yields a p95 over two samples and an authoritative-looking
`samples: 2`.

## Data and types

- `BOUNDS` gains `verifyBaselineWindow: 50` and `minOutlierMs: 120_000`.
  `durationOutlierMultiple` stays **4** and still applies to p95.
- `DetectResult`'s `healthy` and `anomalies` variants gain `durationBaseline?: DurationBaseline`
  — optional, because `insufficient-data` has none, and the project rule is that a missing
  optional field is omitted rather than guessed.
- `evidence` keeps `baselineP95Ms` (no rename — the statistic did not change) and gains
  `thresholdMs` and `windowSize`. Evidence goes verbatim into an incident record.
- `evidence.multiple` stays `latest / p95`. When the floor binds, that ratio can read 5× beside
  a `thresholdMs` the run only just exceeded, so both fields are present and the incident
  template shows them together.
- Firing is `latest.durationMs > thresholdMs` — strictly greater, matching the current
  `multiple <= bound → null`.
- No stored schema change. Read-side only; `schema_version` untouched.

## Edge cases

| Case | Expected behavior |
|---|---|
| Fewer than `minVerifyRuns` runs | `insufficient-data`, unchanged. No baseline. |
| Window larger than available runs | Use what exists; the `minVerifyRuns` floor still applies. |
| Window holds 50 events but only 18 non-null durations | No verdict, and `durationBaseline` is **not** reported — there is no honest p95 to report. |
| Latest run faster than baseline | Never fires. The rule stays one-sided. |
| Latest `durationMs === null` | No verdict, but `durationBaseline` **is** reported. |
| p95 resolves to 0 or negative | No verdict. A zero baseline makes every ratio infinite. |
| Latest exceeds `4 × p95` but is under 120 s | Does not fire. This is the observed 59.5 s stale-tree case. |
| Latest is exactly `thresholdMs` | Does not fire. Strictly greater. |
| A slow run enters the window | p95 of 50 is `sorted[47]`, so three such runs are needed to move it. The ratchet is bounded by the window, not eliminated — stated, not claimed away. |
| A late-arriving old event | Sorts last by `receivedAt` and becomes "the latest run". Pre-existing behaviour of the `(receivedAt, ts)` ordering, unchanged and now tested. |

## Backward compatibility

- Stored data untouched; every existing event stays valid.
- `detect()`'s signature is unchanged and the new result field is optional, so existing callers
  compile unmodified.
- **The existing duration tests pass unchanged — and that is the problem, not the reassurance.**
  They are parameterised on `BOUNDS.durationOutlierMultiple` and use a uniform 30 s baseline
  where median, p95 and max coincide. The current suite provides no evidence either way about
  this change, so every criterion below names a test that discriminates.

## What was examined and deliberately not changed

The claim "the other three detectors do not have this defect" is narrowed to what was actually
checked: **none of them uses an unbounded or accidental baseline.** `detectPassRate` windows 10
runs; `detectDriftSpike` compares 24 h against the prior 7 days; `detectFetchFailures` is a
24 h window.

Two observations found while checking, both out of scope per `intent.md`, both recorded so they
are not rediscovered:

- All three filter with `within()`, which uses `receivedAt` — a **batch ingest stamp**. The live
  store shows 60 minutes of skew (batch `receivedAt 10:21:22` carries `ts 09:21:16`). A spool
  that fails to ship for two days and then ships at once makes two days of history "within
  24 h".
- `detectDriftSpike` has a desensitisation of the same *class* as the one this loop fixes: a
  single drift event six days ago sets `baseline.length > 0` and blinds the spike detector for
  a week.

## Acceptance criteria

Each names a test that fails if the behaviour is absent — the first draft's criteria did not,
and two of them were satisfiable by the alternative this spec rejects.

- [ ] **The window is real, not incidental**: 60 runs at 60 s followed by 30 at 6 s. All-time
      p95 is in the 60 s regime; the last-50 p95 is in the 6 s regime. Assert
      `durationBaseline.p95Ms` is in the 6 s regime and `samples === 50`. Fails if
      `runs.slice(0, -1)` is kept.
- [ ] **`cli-detect` asks for verify runs by kind**: a fixture db holding 30 verify runs plus
      1 200 `render` events yields a verdict, not `insufficient-data`. Fails against the
      current `store.query({ limit: 1000 })`.
- [ ] **The observed false positive does not fire**: 59 483 ms against a 5 959 ms p95 —
      a 10× ratio, under the floor — does not raise.
- [ ] **The floor is tested from both sides**: exactly 120 000 ms does not fire; 120 001 ms with
      a sufficient ratio does.
- [ ] **The case this exists for still fires**: 550 s against a fast baseline raises.
- [ ] **One-sided**: a latest run faster than the baseline never fires, at any ratio.
- [ ] **Null-duration guard, both sides**: 19 non-null durations in a 50-event window gives a
      verdict; 18 gives none and reports no baseline.
- [ ] **Baseline is reported when the latest duration is null** — the case a reader most needs.
- [ ] **`cli-detect` prints the baseline line** in the stated format, asserted against a fixture
      db via `CLAUDEWATCH_METRICS_DB`, not against the machine-local store.
- [ ] **Ordering**: a batch whose `receivedAt` order differs from its `ts` order selects the
      right latest run and the right window, mirroring `anomaly.test.ts:225-273`.
- [ ] `bun run verify` exits 0.

## Rejected alternatives

- **Median at an 8× multiple** (this spec's own first draft). Fires on an observed legitimate
  59.5 s run, and is ~1.5× blunter than the current rule at steady state. Rejected on the
  reviewer's arithmetic, not on taste.
- **Raising `minVerifyRuns` to 21 so p95 is never the maximum.** True, and it would remove the
  small-sample artifact — but it changes when the detector starts working at all, which is a
  different decision with different evidence. Reporting `samples` lets a reader see the
  artifact instead; visibility before tuning.
- **Shorten retention so old runs age out.** Fixes a detection problem by deleting evidence.
- **Detect the step change itself as an anomaly.** A gate getting faster raising an incident is
  how a monitor starts crying wolf. `durationBaseline` gives a human the same information
  without demanding anyone act on it.
- **Aligning `verifyBaselineWindow` with `passRateWindow: 10`.** Would keep the two detectors
  looking at the same history, but 10 runs is far too small a sample for a p95.

## Open, and deliberately not settled here

`magnitudeBucket` is `floor(log10(ms))`, so bucket `'5'` spans 100 s–1000 s: a 150 s blip and a
900 s hang share a fingerprint and `suppressionHours: 24`. The 120 s floor keeps firings inside
that one bucket, so this is not made worse by this change — but it is not made better either,
and a suppressed 900 s hang is a real miss. Recorded for its own loop rather than folded in
here.

---

**Next stage:** Build — run `/sdlc-plan 012-rolling-baseline` to turn this into `plan.md`.
