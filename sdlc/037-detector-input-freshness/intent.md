# Intent: the detector should report its input's freshness, not judge it

- **ID:** 037-detector-input-freshness
- **Stage:** 1 — Plan
- **Status:** draft
- **Date:** 2026-08-29

## The problem

Loop 036 measured that `detect()` returns `status: 'healthy'` for a dataset whose newest event is
**365 days old**, and deferred the fix with its measurement named rather than declining it:

> For `source: 'sdlc'` a bound is constructible and is deferred, not declined. It needs its own
> measurement — what the timer's real arrival distribution looks like, including `Persistent=true`
> catch-up bursts.

That measurement now exists. **309 `verify_run` events over 2.95 days**, read from the live store:

```
gaps n=308  p50=3.2m  p75=13.7m  p90=54.2m  p95=57.6m  p99=60.2m  max=62.0m
gaps over 1h: 5   over 2h: 0   over 6h: 0   over 24h: 0
under 60s (catch-up bursts): 82 of 308 (26.6%)
```

The hourly loop sets a hard ceiling: **the largest gap in three days is 62 minutes.** A threshold at
six hours would be 6× the observed maximum and would have fired zero times.

## What the measurement actually settles — and what it does not

It settles that the arrival cadence is machine-generated and tight. It does **not** settle the
question loop 036 raised, and pretending otherwise would be the convenient answer:

> **Every one of those 309 events came from a machine that was continuously powered on.** The data
> describes what "working" looks like. It says nothing about a machine that is switched off, and a
> gap of any length still means either *broken* or *absent*. A threshold cannot tell them apart,
> because the thing that distinguishes them — whether the series ever resumes — is in the future.

So the honest conclusion is not the one the deferral anticipated. A `source: 'sdlc'` threshold is
constructible in the sense that a number can be picked; it is not *defensible*, because the number
would be a claim about whether someone's machine ought to be on.

## The proposal

**Report the freshness; do not judge it.**

`metrics:detect` prints `healthy: 309 verify runs evaluated, no bounds breached.` It should print the
age of the newest event alongside — a fact, not a verdict:

```
healthy: 309 verify runs evaluated, newest 3m old, spanning 2.9 days. No bounds breached.
```

An operator reading `newest 14 days old` needs no threshold to know. The tool stops having to decide
whether that is bad, which is the only part it cannot do correctly.

This is the shape loop 035 arrived at for `notASymbol` — **printed, never asserted** — and for the
same reason: a number that must move for legitimate causes cannot be a gate, but hiding it is worse
than showing it.

## Who is affected

Whoever reads the detector's output. Today that is one maintainer and the hourly loop; the
Marketplace path makes it whoever operates a metrics service for real users.

The concrete cost is the one loop 036 stated and did not fix: if shipping had broken at any point in
the last thirty-seven loops, `metrics:detect` would have reported *"healthy, no bounds breached"*
throughout, and I would have believed it. The telemetry is the evidence that the continuous loop
works — a detector that cannot see its own input drying up invalidates the claim it exists to
support.

`insufficient-data` has the same hole from the other side: below `minVerifyRuns: 20` the detector
says nothing at all, so a pipeline that broke early reports "not enough data" forever rather than
"nothing has arrived in a week".

## What "done" looks like

1. **Every `detect` verdict carries the input's freshness** — the age of the newest event and the
   span it covers — including `insufficient-data`, which is where a broken pipeline lands first.
2. **The numbers come from the events the detector actually evaluated**, not from a separate query
   that could disagree with them.
3. **No new anomaly kind, and no threshold.** Declined with the measurement above, in a form the next
   loop can re-run rather than re-derive.
4. **A test proves the freshness is reported for a stale dataset** — the 365-day case loop 036
   measured must produce a verdict a human reads as wrong, even though the status stays `healthy`.

## Open questions for Design

- **Does freshness belong on `DetectResult`, or only in `cli-detect`'s rendering?** On the result it
  is testable without a subprocess and available to any future consumer; in the renderer it stays out
  of a type three modules read. Loop 036 put `backlog` on `ShipResult` for exactly this reason and
  the audit called it necessary-but-unplanned.
- **`ts` or `receivedAt`?** `anomaly.ts:128` windows on `receivedAt` because emitter clocks skew
  (sdlc/003), but ordering uses `ts`. Freshness is about *when we learned*, which argues `receivedAt`
  — and the shipper batches, so a whole spool shares one `receivedAt`.
- **Is "span" worth printing at all?** It is cheap, and it distinguishes "300 runs in three days"
  from "300 runs in three months", which changes what a baseline means. But every extra number in a
  one-line verdict costs attention.
- **Should `insufficient-data` say how long it has been insufficient?** That is the case where the
  freshness number matters most and where there is least data to compute it from.

## Non-goals

- A staleness anomaly kind, a threshold, or an incident draft. Declined above with evidence.
- Changing `SuccessExitStatus`, or anything in `deploy/systemd/`. Loop 036's B9 stands.
- Alerting or notification of any kind.
- Touching the four existing bounds. This loop adds no verdict and changes no threshold.

---

**Next stage:** Design — run `/sdlc-spec 037-detector-input-freshness`.
