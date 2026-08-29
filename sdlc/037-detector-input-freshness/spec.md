# Spec: the detector reports its input's freshness, and refuses to judge it

- **ID:** 037-detector-input-freshness
- **Stage:** 2 — Design
- **Status:** draft
- **Reads:** `sdlc/037-detector-input-freshness/intent.md`
- **Date:** 2026-08-29

## Summary

`metrics:detect` prints `healthy: 311 verify runs evaluated, no bounds breached` for a store that
stopped growing a year ago. This loop adds one line reporting **when the store last learned
anything** and **when the gate last ran** — facts, on every verdict — and **declines a staleness
threshold with the measurement that would have justified one.**

The declining is the substance. A six-hour bound would be 6× the largest gap observed in three days
and would have fired zero times, which reads like a green light. It is not one.

## The measurements

### M1 — the arrival distribution (from `intent.md`, 309 events; now 311)

```
gaps n=308  p50=3.2m p75=13.7m p90=54.2m p95=57.6m p99=60.2m max=62.0m
over 1h: 5   over 2h: 0   over 6h: 0   over 24h: 0
```

Every one of those events came from a continuously powered machine. **The distribution describes what
*working* looks like and says nothing about a machine that is off.** A gap still means *broken* or
*absent*, and what separates them — whether the series resumes — is in the future.

### M2 — the two clocks are not interchangeable, and the gap between them is large

Measured on the live store, 311 `verify_run` events:

| | |
|---|---|
| newest by `ts` | age 0.7m |
| newest by `receivedAt` | age 0.2m |
| distinct `receivedAt` vs distinct `ts` | **70 vs 311** |
| `ts` → `receivedAt` lag | **p50 41.1m, p95 170.0m, max 172.8m** |

The shipper batches, so ~4.4 events share each `receivedAt`, and an event can sit in the spool for
nearly three hours before the store hears about it. That settles the intent's second open question:
**neither clock alone is the answer, because they report different facts.**

- `receivedAt` — *when the store last learned anything.* Cannot be older than the last successful
  ship, so it is the freshness of the detector's **input**.
- `ts` — *when the gate last ran.* Can be far older than `receivedAt` when a backlog drains at once.

And the divergence is itself the signal: a large gap between them means a spool that had been
accumulating was just delivered — the shipping-outage shape loop 036 built the backlog counter for.

### M3 — `detect()` has exactly one consumer

`grep` over `packages/metrics/src/*.ts` excluding tests and `anomaly.ts` itself:
`cli-detect.ts:174` and nothing else. That settles the intent's first open question — putting
freshness on `DetectResult` costs one type change and one call site, and buys a value testable
without a subprocess. Loop 036 put `backlog` on `ShipResult` for the same reason and the Stage 5
audit recorded it as *necessary-but-unplanned*; here it is planned.

### M4 — what the detector actually receives

`collectDetectorInput` returns a **mixed-kind** set: the last 51 `verify_run`, 8 days of
`schema_drift`, 24 hours of `fetch_result`, and a general `limit: 1000` of any kind, de-duplicated.
So "the input" is not one population, and `evaluated` counts only the `verify_run` subset.

This matters: **if the statusline keeps emitting `fetch_result` while the gate stops running, an
all-kinds freshness number stays fresh while the verdict's population is stale.** That is the exact
blind spot this loop exists to remove, one level down, so the report carries both.

## Behavior

### B1 — `DetectResult` carries an `InputFreshness` on every variant

```ts
export interface InputFreshness {
  /** Age of the newest event of ANY kind by `receivedAt`: when the store last learned anything. */
  newestArrivalAgeMs: number | null;
  /** Age of the newest `verify_run` by `ts`: when the gate last ran. */
  newestRunAgeMs: number | null;
  /** Events the detector received, all kinds. */
  inputEvents: number;
}
```

`null` when the corresponding population is empty — **omitted, not guessed**, per `CLAUDE.md`. A
zero would read as "just now", which is the opposite of the truth.

All three `DetectResult` variants gain it, **including `insufficient-data`**, which is where a
pipeline that broke early lands and where the detector currently says nothing at all.

### B2 — computed inside `detect()`, from the events it was given

Not from a second store query. A separate query could disagree with `evaluated`, and two numbers
describing one run that can differ is the defect class this repo keeps finding. `detect()` already
receives `events` and `now`; freshness is derived from those and nothing else.

### B3 — one rendered line, on every verdict

```
input: 362 events, newest arrived 12s ago; newest verify run emitted 42s ago
```

Printed before the verdict for every status. Three facts, and their combinations are readable:

| Shape | Reading |
|---|---|
| both fresh | the pipeline is alive |
| both old | nothing is arriving — shipper, gate, or machine |
| arrival fresh, run old | a backlog just drained, or the gate stopped while other emitters continue |
| arrival old, run fresh | impossible; an event cannot be emitted after it arrived |

A `null` renders as `never` rather than a number: `newest verify run emitted never`.

### B4 — no threshold, no anomaly kind, no exit-code change

`AnomalyKind` is unchanged, `BOUNDS` gains nothing, and `metrics:detect` still exits 0 on `healthy`
regardless of how old the input is.

**This is the loop's central decision and M1 is its justification.** A bound would have to encode a
claim about whether someone's machine ought to be on, which is not a fact the detector has. Printing
the age lets a human apply the judgement they actually possess, at zero false-positive cost.

Same shape as loop 035's `notASymbol`: **printed, never asserted**, because a number that must move
for legitimate reasons cannot be a gate — and hiding it is worse than showing it.

## Data and types

```ts
// packages/metrics/src/anomaly.ts
export interface InputFreshness { … }
export function measureFreshness(events: readonly StoredEvent[], now: number): InputFreshness;
export function formatFreshness(f: InputFreshness): string;
```

`measureFreshness` is exported separately from `detect` so the matrix in B3 is a plain unit test
rather than four constructions of a whole `DetectResult`.

`formatFreshness` lives beside it rather than in `cli-detect`, matching `formatBaseline`
(`anomaly.ts:88`), which is already rendered by the CLI from a function the module owns.

## Backward compatibility

- `DetectResult` gains a required field on all three variants. One consumer; `bun run typecheck` is
  the proof.
- `anomaly.test.ts` constructs `DetectResult` values in assertions — those move.
- No event schema change, no store query change, no new network call, no exit-code change.
- `formatBaseline`'s line is unchanged and still prints only when a baseline exists.

## Acceptance criteria

- [ ] **A1** — `bun run verify` exits 0, CI green.
- [ ] **A2** — `measureFreshness` returns the age of the newest event by `receivedAt` across **all
      kinds**, and the newest `verify_run` by **`ts`**. Two named tests, one per clock, each with a
      population where the other clock would give a different answer — otherwise neither test can
      distinguish them.
- [ ] **A3** — the divergence case: a batch whose `receivedAt` is recent and whose `ts` values are
      hours old reports a fresh arrival and an old run. **This is M2's measured shape** (p95 lag
      170m) and the reason two numbers exist rather than one.
- [ ] **A4** — an all-`fetch_result` input reports a fresh arrival and `newestRunAgeMs === null`.
      M4's blind spot, as a test.
- [ ] **A5** — empty input yields `null` for both, and `formatFreshness` renders `never`, not `0s`.
- [ ] **A6** — `insufficient-data` carries freshness. Asserted on the result, not on the printed
      line, so it holds regardless of rendering.
- [ ] **A7** — the 365-day case from loop 036 still returns `status: 'healthy'` **and** reports an
      arrival age over 300 days. The status not changing is the point: this loop adds a fact, not a
      verdict.
- [ ] **A8** — `AnomalyKind` is unchanged and `BOUNDS` gains no key, asserted mechanically so a
      future loop cannot quietly add a staleness bound under this loop's name.
- [ ] **A9** — freshness is derived from the `events` argument: passing a set whose newest event is
      older than `now` by a known amount yields exactly that age. No store access inside `detect`.
- [ ] **A10** — mutation predictions named `file:testname` **before** the run, one per rule, each
      naming any cross-cutting suite it also trips. **Verify the named test exists before scoring a
      prediction correct** — loop 036 recorded two predictions against tests that did not exist.
- [ ] **A11** — `.oxlint-budget.json` unchanged at 8 rows / 10 warnings.
- [ ] **A12** — the plan-to-diff audit reports no file outside the fence; `fenceCheck` reports zero
      findings for this loop.

## Edge cases

- **An event with an unparseable `ts` or `receivedAt`.** `Date.parse` yields `NaN`; those events are
  excluded from the max rather than poisoning it. `anomaly.ts:131` already guards with
  `Number.isFinite` for the same reason.
- **An event from the future** (clock skew, sdlc/003). Age is negative; clamped to `0` at render, and
  the raw value is kept on the result so a test can see it. Not treated as an error — skew is a
  known condition, not a fault.
- **`now` earlier than every event.** Same as above; both ages clamp to `0`.
- **A store containing only `verify_run`.** `newestArrivalAgeMs` and `newestRunAgeMs` describe the
  same events through different clocks and can still differ, by the ship lag. That is correct, not a
  bug, and A3 covers it.
- **Very large ages.** Rendered coarsely (`3d 4h`), never as a raw millisecond count. `formatAge` in
  `agent.ts` does this for the shipper; **it is not reused** — see *Rejected alternatives*.

## Rejected alternatives

**A `source: 'sdlc'` staleness threshold.** The intent's own proposal, declined on M1. A number can
be picked; it cannot be defended, because it would assert when a machine ought to be on. Recorded
with the measurement so the next loop re-reads rather than re-derives.

**Reporting "span" (oldest to newest).** Cheap, and it distinguishes 300 runs over three days from
300 over three months. Dropped: `verifyBaselineWindow` is 50 **by count**, so the baseline's meaning
depends on the last 50 runs and not on the whole set's span, and the `insufficient-data` case that
seemed to need it is already answered by the newest age. One fewer number in a line an operator has
to read.

**Reusing `formatAge` from `packages/metrics/src/agent.ts`.** Tempting, and wrong: it is the
shipper's operator vocabulary, tuned to minutes-to-hours for a five-minute timer, and it caps at
`Nh Mm`. Detector ages are legitimately days. Sharing it would force one of the two callers to
render badly, and the duplication this repo has been bitten by (`MAX_LINE_BYTES`, the cache rule) was
duplication of a **rule**, not of a formatting preference. Recorded so the next reader does not
"fix" it.

**Putting freshness only in `cli-detect`'s rendering.** M3 shows one consumer, so the type cost is
one call site, and a value on the result is testable without a subprocess. Rendering-only would have
made A6 and A7 assertions about stdout.

**Per-kind freshness for all kinds.** `verify_run` is singled out because `evaluated` counts it and
the headline verdict rests on it. A full per-kind breakdown is separable and would put four numbers
on a line meant to be read at a glance.

---

**Next stage:** Build — run `/sdlc-plan 037-detector-input-freshness`.
