# Spec: the detector reports its input's freshness, and says what it cannot judge

- **ID:** 037-detector-input-freshness
- **Stage:** 2 — Design
- **Status:** revised after review (see *Corrections*)
- **Reads:** `sdlc/037-detector-input-freshness/intent.md`
- **Date:** 2026-08-29

## Summary

`metrics:detect` prints `healthy: 311 verify runs evaluated, no bounds breached` for a store that
stopped growing a year ago. This loop adds a line reporting **when the store last learned anything**
and **when the gate last ran**, on every verdict.

**The first draft's central argument was wrong, and how it was wrong is the useful part.** It
declined a staleness bound on a gap distribution it called "the arrival distribution" — measured on
the wrong column. The real arrival distribution is 19× coarser at the median, and the claimed 6×
headroom is **2.08×**. The decline still stands, but on a different and narrower argument.

## The measurements

Taken 2026-08-29 against `/root/.local/share/claudewatch-metrics/metrics.db`, **311 events, all
`kind='verify_run'`, span 3.00 days.** Re-runnable by `scripts/arrival-dist.ts` (A13).

### M1 — two gap distributions, not one

```
ts-gaps          n=310  p50= 3.2m p75=13.7m p90= 54.9m p95= 57.6m p99= 60.2m max= 62.0m  >1h= 5 >2h=0
receivedAt-gaps  n= 69  p50=60.0m p75=60.7m p90= 64.5m p95=117.4m p99=172.9m max=172.9m  >1h=34 >2h=1
```

**The first draft published the `ts` row under the heading "the arrival distribution".** Every
window in this module filters on `receivedAt` (`anomaly.ts:128-132`), so a staleness bound would be
evaluated on the arrival clock — the one row that was not measured. Against arrivals, six hours is
**2.08× the observed maximum**, and there is one gap over two hours, not zero.

### M2 — the measured host has no systemd, so the arrival cadence is an artifact

The first draft cited a `ts→receivedAt` lag of p50 41.1m / p95 170.0m / max 172.8m as evidence that
"the shipper batches". It reproduces exactly. **It is also not what `claudewatch-ship.timer`
describes** (`OnUnitActiveSec=5min`), and the arrival p50 gap is **60.0m** — locked to the hourly
SDLC routine, not to a five-minute shipper.

`ls /run/systemd/system` on this host: **absent.** There is no shipper timer here. The spool is
delivered once an hour, by hand, when the routine fires.

> **So M2 measures this container's manual cadence, not a deployment's.** The first draft adopted it
> as a design premise and wrote "an event can sit in the spool for nearly three hours" as though that
> were the product's behaviour. On a NUC with the unit enabled, the expected lag is under six
> minutes.

What survives: **311 events share only 70 distinct `receivedAt` values.** Batching is real and
`receivedAt` genuinely cannot order events within a batch — that is `anomaly.ts:352`'s existing
reason for the `(receivedAt, ts)` sort. The two-clock design rests on that, not on the 170m number.

### M3 — `detect()` has one runtime consumer

`cli-detect.ts:174`, and nothing else. No dynamic import; `dashboard.ts` and `server.ts` do not
touch it. Two things the first draft missed: `index.ts:6` re-exports `anomaly.js` wholesale (inert —
the package is `"private": true` with no workspace importers), and `detector-input.test.ts:47` is a
second *test* caller.

### M4 — what `detect` receives is a code reading, not a measurement

`collectDetectorInput` returns a mixed-kind set: 51 `verify_run`, 8 days of `schema_drift`, 24 hours
of `fetch_result`, plus a general `limit: 1000`, de-duplicated on `eventId`.

**The live store contains zero `schema_drift` and zero `fetch_result` — it is 100% `verify_run`.**
The mixed-kind blind spot below is architecturally real and empirically unobserved. Labelled so, so
A4's fixture is not mistaken for a reproduction.

### M5 — the sample line, produced by running the code

```
input: 311 events, newest arrived 14m ago; newest verify run arrived 14m ago, emitted 14m ago
```

The first draft's illustration said `362 events`. That is **51 + 311** — the *undeduplicated* sum of
two queries, computed by hand, and unreachable because `detector-input.ts:63-69` dedupes on
`eventId`. The same class of error as M1: a number derived by arithmetic instead of by the code path.

All three ages coincide today because the store is single-kind and was shipped minutes ago. They
diverge exactly when something is wrong, which is the point.

## Behavior

### B1 — three ages, because two would differ for two reasons

```ts
export interface InputFreshness {
  /** Newest event of ANY kind by `receivedAt` — when the store last learned anything. */
  newestArrivalAgeMs: number | null;
  /** Newest `verify_run` by `receivedAt` — when the store last learned about a GATE RUN. */
  newestRunArrivalAgeMs: number | null;
  /** Newest `verify_run` by `ts` — when the gate last STARTED. */
  newestRunEmittedAgeMs: number | null;
}
```

The first draft shipped two numbers that varied along **two axes at once** — clock *and* population —
so a difference could not be attributed to either. It said so itself and accepted it, two lines after
declaring that "two numbers describing one run that can differ is the defect class this repo keeps
finding". Three fields decompose it:

| Shape | Reading |
|---|---|
| all three fresh | the pipeline is alive |
| all three old | nothing is arriving — shipper, gate, or machine |
| arrival fresh, **run**-arrival old | other emitters live, the gate stopped |
| run-arrival fresh, run-**emitted** old | a backlog just drained: events made in the past, delivered now |
| run-arrival old, run-emitted fresh | emitter clock skew (sdlc/003), or a hand-built event |

**The last row is possible, not impossible.** The first draft called it impossible and then, twelve
lines later, documented clock skew as an edge case. `store.ts:238` takes `ts` verbatim off the wire
with no range check and no comparison against `receivedAt`, and `within()`'s own comment cites skew
as the reason windows use `receivedAt`. Ruled out as causes: re-ingestion (`INSERT OR IGNORE` on the
unique `event_id` preserves the original `received_at`) and prune (deletes on `received_at`, never
rewrites it).

`inputEvents` is **dropped.** `GENERAL_LIMIT` is 1000 and `store.query` clamps every limit to 1000,
so in a `verify_run`-dominated store the number pins at 1000 permanently — about seven days away at
the current 104 events/day. A number that stops varying, printed next to numbers that do, reads as a
store size and is not one.

`null` when the population is empty **or every member's timestamp is unparseable** — `Date.parse`
yields `NaN` and those events are excluded from the max rather than poisoning it, matching
`anomaly.ts:131`'s existing `Number.isFinite` guard.

### B2 — computed inside `detect()`, from the events it was given

Not a second store query. `detect()` already receives `events` and `now`; freshness derives from
those and nothing else, so it cannot disagree with `evaluated`.

### B3 — one rendered line, above the `insufficient-data` exit

`cli-detect.ts:176-180` returns and exits **before** `formatBaseline` and the suppression lines, so
the new line must be printed above line 176 or `insufficient-data` — the case where a broken pipeline
lands first — will not carry it. Order: freshness, then `baseline:`, then `suppressed`, then the
verdict.

**Unit ladder, pinned so A5 and A7 are mechanical:**

| Age | Renders |
|---|---|
| `null` | `never` |
| negative (skew) | clamped to `0s` |
| `< 60s` | `Ns` |
| `< 60m` | `Nm` |
| `< 24h` | `Nh Mm` |
| `>= 24h` | `Nd Mh` |

### B4 — no threshold, and the reason is not the one the first draft gave

`AnomalyKind` and `BOUNDS` are unchanged; `metrics:detect` still exits 0 on `healthy` however old
the input is.

**The first draft's argument was: a gap means *broken* or *absent*, and what separates them is in the
future.** That is true of a **prospective** bound ("nothing for 6h → fire now") and false of a
**retrospective** one, and the review was right to reject it as the same over-generalization loop
036's reviewer rejected.

**A retrospective hole detector is constructible, and the two clocks are exactly what decide it:**

- **Machine off.** Nothing is emitted during the hole. `Persistent=true` + `OnBootSec=5min` fire one
  catch-up run within five minutes of boot. **The hole contains zero `ts` values.**
- **Shipper broken, machine on.** Events keep being emitted and spooled. On recovery a batch lands
  whose `ts` values *span* the hole, all sharing one `receivedAt`. **The hole is filled with `ts`
  values.**

> **A hole in `receivedAt` that is filled with `ts` values is a shipping outage. A hole in both is an
> absence.** That is decidable, in the past tense, from data the store already has — and it is the
> strongest argument for shipping two clocks rather than one.

It is still not built here, for a reason that is about evidence rather than principle: **every
arrival-clock number I have measures a container with no systemd, shipping once an hour by hand
(M2).** A threshold set from that data would be a fabricated baseline for a deployment it does not
describe. `anomaly.ts:4` opens *"RELUCTANCE IS THE POINT"*, and inventing a bound from the wrong
host is not reluctance.

And the first draft inverted its own evidence: *"would have fired zero times, which reads like a
green light. It is not one."* **Zero false positives on known-good data is the precondition for
shipping a bound in this module, not a reason to decline one.** The real objections are semantic and
evidentiary, and they are the ones stated above.

**Deferred specifically**, so loop 036's *"deferred, not declined"* is finally answered: a
retrospective hole detector over `receivedAt`, discriminated by `ts` occupancy, thresholded from a
host where `claudewatch-ship.timer` is actually enabled.

## Data and types

```ts
// packages/metrics/src/anomaly.ts
export interface InputFreshness { … }
export function measureFreshness(events: readonly StoredEvent[], now: number): InputFreshness;
export function formatFreshness(f: InputFreshness): string;

// exported so A8 can pin it as a value rather than grep a type
export const ANOMALY_KINDS = [
  'verify_duration_outlier', 'verify_pass_rate', 'schema_drift_spike', 'fetch_failure_rate',
] as const;
export type AnomalyKind = typeof ANOMALY_KINDS[number];
```

`formatFreshness` sits beside `formatBaseline` (`anomaly.ts:88`), which the CLI already renders from
a function this module owns.

## Backward compatibility

- **No consumer constructs a `DetectResult`.** The type appears twice, both inside `anomaly.ts` — the
  declaration and `detect`'s return type. `anomaly.test.ts` narrows on `.status` and reads fields.
  The first draft claimed the tests construct them; they do not. So adding a field is
  source-compatible by inspection, and `typecheck` only covers `detect`'s own three return sites.
- `AnomalyKind` changes from a hand-written union to `typeof ANOMALY_KINDS[number]` — **identical
  members**, and A8 is what proves it.
- `detector-input.test.ts:47` is a second `detect` caller; it asserts on `.status` and is unaffected.
- No event schema change, no store query change, no exit-code change, no new network call.

## Acceptance criteria

- [ ] **A1** — `bun run verify` exits 0, CI green.
- [ ] **A2** — `measureFreshness` returns each of the three ages, with a population where the other
      two would give a different answer. Three named tests.
- [ ] **A3** — the drained-backlog shape: one `receivedAt`, `ts` values spanning hours → run-arrival
      fresh, run-emitted old. **This is the discriminator B4 rests on**, so it is a test, not prose.
- [ ] **A4** — an all-`fetch_result` input reports a fresh arrival and `null` for both run ages. M4's
      blind spot; the fixture is **synthetic** — the live store has never held one.
- [ ] **A5** — empty input yields `null` for all three and renders `never`, not `0s`. Every ladder
      boundary in B3 has an assertion.
- [ ] **A6** — `insufficient-data` carries freshness, asserted on the result; and the rendered line
      appears **before** `cli-detect.ts`'s early exit, asserted by running the CLI.
- [ ] **A7** — the 365-day case returns `status: 'healthy'` **and** reports an arrival age over 300
      days rendered as `Nd Mh`. The status not changing is the point. The fixture is synthetic:
      `RETENTION_DAYS = 90` makes 365 days unreachable in a real store.
- [ ] **A8** — `ANOMALY_KINDS` equals the four current members and `Object.keys(BOUNDS).toSorted()`
      equals its current list, both against literals. A change-detector in both directions, like
      `.oxlint-budget.json` — **not a source grep**, which is the vacuous form
      `sdlc/014`'s review already recorded.
- [ ] **A9** — a population whose newest event is a known age from `now` yields exactly that age.
      (The first draft's second half — "no store access inside `detect`" — is dropped: `anomaly.ts`
      imports only `type { StoredEvent }`, so it is true by construction and assertable only by grep.)
- [ ] **A10** — mutation predictions named `file:testname` **before** the run. **Verify each named
      test exists before scoring a prediction correct** — loop 036 recorded two predictions against
      tests that did not exist.
- [ ] **A11** — `.oxlint-budget.json` unchanged at 8 rows / 10 warnings. Note `anomaly.test.ts`
      carries one row (`oxc(no-map-spread)`), so extending its fixtures is budget-relevant.
- [ ] **A12** — the plan-to-diff audit reports no file outside the fence; `fenceCheck` reports zero
      findings for this loop.
- [ ] **A13** — `scripts/arrival-dist.ts <dbPath>` prints the gap distribution on **both** clocks and
      the kind census, committed with this loop, and M1/M4's numbers are its output. **This is what
      makes "declined with a measurement" durable** — the intent asked for a form the next loop can
      re-run, and the first draft delivered a pasted table.

## Edge cases

- **`RETENTION_DAYS = 90`.** `prune()` deletes on `received_at` and `server.ts:147` calls it at
  service start, so after a 90-day outage the next restart empties the store and this loop's headline
  degrades from `newest arrived 91d 0h ago` to `never` — from *"shipping died three months ago"* to
  *"nothing has ever arrived"*, with `detect` flipping to `insufficient-data`. **Accepted, not
  fixed**, and named because the number self-destructs in the worst case the loop was opened for.
- **An event from the future.** Age is negative; clamped to `0s` at render, raw on the result so a
  test can see it. Skew is a known condition (sdlc/003), not a fault.
- **Cross-host skew.** `receivedAt` is stamped by the store host, `now` by the detector host. Same box
  today; `intent.md` anticipates a hosted service where they differ, and `newestArrivalAgeMs` would
  then carry host-to-host skew. Recorded.
- **`ts` is stamped at gate *start*.** `scripts/verify.ts:199-200` captures it at module top level,
  before the steps run. `newestRunEmittedAgeMs` is age-since-start, which for the 550s-hang case
  differs from age-since-finish by nine minutes.
- **`evaluated` is window-dependent**, varying with how much other-kind traffic crowds the
  1000-event general window. Same root as the dropped `inputEvents`.
- **`healthy` here is not SPEC.md §7.1's `Healthy`.** The product state requires *fresh* data
  (SPEC.md:331) and has a distinct `Stale`; the detector's `healthy` deliberately excludes freshness
  and still will. Different domains, no amendment — but an operator who has read §7 may expect
  otherwise.

## Rejected alternatives

**A prospective staleness threshold.** B4. Declined on the corrected arrival distribution (2.08×
headroom, one gap over two hours) and on M2's finding that the measured host is not a deployment.

**Reporting "span".** `verifyBaselineWindow` is 50 **by count**, so the baseline's meaning does not
depend on the whole set's span, and `insufficient-data` is already answered by the newest age.

**Reusing `formatAge` from `agent.ts`.** It is the shipper's vocabulary, tuned to a five-minute timer,
with **no day unit** — a 365-day age renders `8760h 0m`. (It does not "cap", as the first draft said;
it renders unbounded hours.) Detector ages are legitimately days. The duplication this repo has been
bitten by was duplication of a **rule**; this is a formatting preference.

**Rendering-only, without touching `DetectResult`.** M3 shows one consumer, so the type cost is one
call site, and A6/A7 become assertions about stdout otherwise.

## Corrections to the first draft

| # | The first draft said | Correction |
|---|---|---|
| B-1 | "M1 — the arrival distribution", 6× headroom | It was the **`ts`** distribution. Arrivals are p50 60.0m, max 172.9m, one gap over 2h. Six hours is **2.08×**. The loop's central decision was made on the wrong column. |
| B-2 | "arrival old, run fresh — impossible" | Contradicted by its own skew edge case twelve lines later, and by `store.ts:238` taking `ts` verbatim with no range check. |
| B-3 | declined a threshold because broken-vs-absent "is in the future" | True of a prospective bound, false of a retrospective one. The retrospective form is constructible and its discriminator is named. Re-declined on evidence — the measured host has no systemd — not on principle. Also: zero firings on known-good data is the **precondition** for a bound here, not a reason against one. |
| M-1 | two ages | They varied by clock **and** population, so a difference had two causes. Three ages now decompose it. |
| M-2 | "the shipper batches… nearly three hours" | `claudewatch-ship.timer` is 5 minutes and this host has no systemd. The 60m arrival cadence is the SDLC routine. A measurement artifact adopted as a premise. |
| M-3 | `inputEvents` on the line | Pins at `GENERAL_LIMIT = 1000` within ~7 days. Dropped. |
| M-4 | "declined with the measurement above" | No re-runnable form. A13 adds the script. |
| M-5 | "`anomaly.test.ts` constructs `DetectResult` values" | It does not. The type appears only inside `anomaly.ts`. |
| M-6 | sample line `362 events` | 51 + 311 undeduplicated, computed by hand. The real value is **311**, produced by running the code. |
| M-7 | "rendered coarsely (`3d 4h`)" | Unspecified ladder under two exact-string criteria. Pinned in B3. |
| M-8 | A8 "asserted mechanically" | A type union is erased at runtime; the only options were a source grep or a `tsc` fixture harness. Replaced with a pinned `ANOMALY_KINDS` value. |
| M-9 | A9 "no store access inside `detect`" | Vacuous — `anomaly.ts` imports one type. Dropped; the non-vacuous half kept. |
| M-10 | silent on `RETENTION_DAYS` | Added to Edge cases: the number self-destructs after 90 days, in the worst case the loop exists for. |
| minor | M4 presented as measured | It is a code reading; the store is 100% `verify_run`. |
| minor | "printed for every status" | `cli-detect.ts:176` exits before the render sites; placement is now specified. |
| nit | `formatAge` "caps at `Nh Mm`" | It does not cap; it renders unbounded hours. |
| nit | p90 54.2m over 308 gaps | 54.9m over 310. Restamped with the date and event count. |

---

**Next stage:** Build — run `/sdlc-plan 037-detector-input-freshness`.
