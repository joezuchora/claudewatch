# Intent: a permanent shipping failure is invisible at every layer

- **ID:** 036-silent-shipping-failure
- **Stage:** 1 — Plan
- **Status:** draft
- **Date:** 2026-08-29

## The problem

During loop 035's Stage 5 I ran the telemetry round trip by hand and pointed
`CLAUDEWATCH_METRICS_ENDPOINT` at `http://127.0.0.1:8787/v1/events`. That is wrong — the variable is
a **base** URL and `ship()` appends `/v1/events` itself — so every POST got a 404. What the shipper
told me was:

```
shipped 0 events from 0 file(s); retained 1, dropped 0, skipped 0 unparseable line(s)
```

No status code. No URL. Nothing distinguishing a permanent misconfiguration from a service that
happens to be down for thirty seconds. I only found the cause by reading `agent.ts`.

**That is not one defect. It is five, in a chain, and the chain ends in silent data loss while the
monitoring reports healthy.**

## Measured, layer by layer

### 1. `ship()` collapses three causes into one observable

`packages/metrics/src/agent.ts` has three paths that all do `result.filesRetained++` and nothing
else:

| Line | Cause | What is recorded |
|---|---|---|
| `:163` | `readFileSync` throws — file vanished, EACCES, ENOTDIR | `filesRetained++` |
| `:186` | HTTP non-2xx — 404, 401, 413, 500, 503 | `filesRetained++` |
| `:189` | `fetch` throws — DNS, connection refused, TLS failure, timeout | `filesRetained++` |

The response object is in scope at `:186` and `res.status` is discarded. The error is in scope at
`:189` and is not even bound.

**No test could fail if two of these branches were swapped.** `agent.test.ts:58` uses `failFetch`
and `agent.test.ts:66` uses `throwFetch`, and both assert exactly `filesRetained === 1`. Two tests,
two different causes, one indistinguishable assertion.

### 2. `cli-ship` prints no reason

The message above is the whole diagnostic surface. A permanent 404 and a transient 503 print
identically, so the operator cannot tell *fix your config* from *wait*.

### 3. systemd does not mark the unit failed

`deploy/systemd/claudewatch-ship.service`:

```
# A failed ship is not an error worth alerting on — the agent retains the spool and retries.
SuccessExitStatus=0 1
```

`cli-ship` exits 1 when `filesRetained > 0`, so this maps every shipping failure to unit success.
`systemctl --failed` stays empty. **The reasoning is right for a transient failure and wrong for a
permanent one**, and nothing in the system distinguishes them — which is defect 1 again, one layer up.

### 4. The data is gone in about a hundred minutes

`claudewatch-ship.timer` fires `OnUnitActiveSec=5min`. Each run rotates the live spool into a new
`.shipping` file, so a failing shipper accumulates one per run. `MAX_RETAINED_SHIPPING_FILES = 20`,
and `ship()` deletes oldest-first past that cap.

**Twenty runs is 100 minutes. The 21st run begins permanently deleting events that exist nowhere
else.** `filesDropped` *is* printed, so the deletion is visible in the journal — but by then it has
already happened, and the unit still exits success.

### 5. The detector reports healthy on a dataset that stopped growing — measured

This is the one that makes the rest matter. `packages/metrics/src/anomaly.ts` has four bounds
(`verify_duration_outlier`, `verify_pass_rate`, `schema_drift_spike`, `fetch_failure_rate`). Every
one is a property of the events that **arrived**. There is no bound on events that did not.

Measured against `detect()` directly — 60 healthy `verify_run` events, varying only how far in the
past they sit:

```
last event   0 days before now -> status=healthy
last event   1 days before now -> status=healthy
last event   7 days before now -> status=healthy
last event  30 days before now -> status=healthy
last event 365 days before now -> status=healthy
```

**A dataset whose most recent event is a year old is reported healthy.** `detect()` already takes
`now` and `within(e, now, hours)` already exists for the 24-hour windows, so the capability is
present and simply unused for this.

> **The monitoring cannot detect its own blindness. Silence is indistinguishable from health.**
> Loop 009 built this detector to catch a gate that had gone bad. It cannot catch a gate whose
> results stopped arriving — which is the failure mode that hides every other one.

## Who is affected

Today: one maintainer, one NUC, and the agents running this loop. The telemetry is the evidence that
the continuous loop works at all, so a pipeline that fails silently does not merely lose data — it
invalidates the claim the data exists to support. If shipping had broken at any point in the last
thirty loops, `metrics:detect` would have reported "healthy, no bounds breached" throughout, and I
would have believed it.

Longer term this is the product-telemetry path for the VS Code extension. A Marketplace user's
client failing to ship, silently, with the server reporting healthy, is the same bug with a worse
blast radius.

## What "done" looks like

1. **A failed ship says why.** Status code for an HTTP rejection, error class for a transport
   failure, distinguishable from a read error — and a test that fails if any two are conflated.
   Subject to SPEC.md §12: never the token, and the endpoint must not be echoed if it can carry
   credentials in userinfo.
2. **A permanent failure is distinguishable from a transient one** by something other than a human
   reading source.
3. **Staleness is an anomaly kind.** The detector reports when the newest event is older than it
   should be, rather than evaluating a frozen dataset forever. The bound has to survive the obvious
   objection — a laptop that is simply switched off for a weekend must not raise an incident — so
   "older than N hours" alone is probably not it.
4. **The 100-minute window is stated, and either widened or defended.** Twenty files at five-minute
   intervals may be the right cap; if so it should say so, and the drop should be loud.

## Open questions for Design

- **Is staleness one anomaly or two?** "The shipper is failing" (local, knowable from the spool) and
  "the store stopped growing" (server-side, knowable from the DB) are different observations with
  different fixes. Collapsing them would repeat defect 1 at a higher level.
- **What is the right idle bound?** The detector's own docstring says *reluctance is the point* and a
  false positive costs more than a miss. A staleness rule that fires every Monday morning gets
  switched off, and then it protects nothing.
- **Does the fix belong in `ship()`, in `cli-ship`, or in both?** `ship()` returning a structured
  reason is the honest shape, but it widens `ShipResult`, which `combineResults` and `cli-ship`
  both read.
- **Should `SuccessExitStatus=0 1` change?** Probably not for a transient failure. But if a permanent
  one becomes distinguishable, the unit could stop treating it as success — which is a deploy change,
  not a code change, and may belong in a separate loop.

## Non-goals

- Alerting, paging, or any notification transport. Nothing here needs a channel that does not exist.
- Retrying with backoff. The five-minute timer already is the retry.
- Changing the at-least-once guarantee.

---

**Next stage:** Design — run `/sdlc-spec 036-silent-shipping-failure`.
