# Spec: a failing shipper says why, and says it is failing

- **ID:** 036-silent-shipping-failure
- **Stage:** 2 — Design
- **Status:** draft
- **Reads:** `sdlc/036-silent-shipping-failure/intent.md`
- **Date:** 2026-08-29

## Summary

The intent found five defects in a chain ending in silent data loss. This loop fixes the first
three and **declines the fifth with a reason**, because measurement changed what the right answer is.

The intent's hardest open question was: *what staleness bound survives a laptop being off for the
weekend?* The answer is that it should not be a staleness bound at all. **A shipping failure is
unambiguous locally and ambiguous globally**, so it is detected locally.

## The measurement that decided the design

`ship()` calls `rotate()`, which returns `null` when the live spool is absent or empty. So a
`.shipping` file is created only by a run that **had events to deliver and failed to deliver them**.
Measured in a sandbox against a 404-ing endpoint:

```
--- shipper running and FAILING, new events each run:
  run 1: retained=1 dropped=0 backlog=1
  ...
  run 6: retained=6 dropped=0 backlog=6
--- shipper running and failing, but NO new events (machine idle):
  run 7: retained=6 dropped=0 backlog=6
  run 8: retained=6 dropped=0 backlog=6
  run 9: retained=6 dropped=0 backlog=6
  run 10: retained=6 dropped=0 backlog=6
--- past the cap:
  run 25: retained=20 DROPPED=1 backlog=20   (and every run after, forever)
```

Three properties fall out, and together they are the design:

1. **Backlog depth counts failed deliveries.** One file per failing run that had something to send.
2. **It cannot rise when the machine is off** — nothing runs — **or when nothing is being produced**
   — `rotate` returns `null`. The weekend false positive the intent worried about is impossible
   *by construction*, not by a tuned threshold.
3. **Past the cap it pins at 20 and destroys exactly one file per run, indefinitely.** The per-run
   number is 1, which reads as trivial in a journal line; a week at five-minute intervals is
   **2,016 destroyed files**. The number understates the harm every time it is printed.

> **Detect the failure where it is unambiguous.** "The shipper is failing" is knowable exactly, on
> the machine, from state that persists across crashes. "The store stopped growing" is not knowable
> at all — the server cannot distinguish a broken client from an absent one. Building the second is
> how a detector earns a reputation for crying wolf, and `anomaly.ts`'s own docstring opens with
> *"RELUCTANCE IS THE POINT."*

## Behavior

### B1 — a retained file records why it was retained

`ship()` has three paths that increment `filesRetained` and record nothing. Each gains a reason,
drawn from a **closed set**:

```ts
export type ShipFailure =
  | { kind: 'http'; status: number }
  | { kind: 'transport'; message: SurfaceableMessage }
  | { kind: 'unreadable' };
```

`SurfaceableMessage` is **reused from `packages/core`, not reinvented**. `client.ts:270-273` already
maps a thrown fetch to `'Request timed out'` / `'TLS verification failed'` / `'Network error'` behind
a closed set, and `packages/core/src/index.ts` already exports it. Two vocabularies for "why did an
HTTP call fail" in one repo is how they drift.

The reuse is justified by shape, not by boundary. `SurfaceableMessage` exists for SPEC.md §12's
product surface — what may be shown in a statusline. An operator's own journal is a different
boundary with a laxer rule. A closed set is still right here, and one already exists.

`status` is an unbounded `number` deliberately, matching `` `Server error (${number})` `` in the same
closed set: 404 and 503 must be distinguishable, which is the whole point.

### B2 — `ShipResult` carries the reasons, and `combineResults` merges them

```ts
export interface ShipResult {
  // ...unchanged fields...
  failures: ShipFailure[];   // one per retained file, in the order encountered
}
```

An array, not a single value: two files can fail for two different reasons in one run, and collapsing
them would repeat the defect this loop exists to fix, one level up. `combineResults` concatenates.

### B3 — `cli-ship` prints the reason and the backlog

```
shipped 0 events from 0 file(s); retained 1, dropped 0, skipped 0 unparseable line(s)
  retained: HTTP 404 — the service rejected the batch. Check CLAUDEWATCH_METRICS_ENDPOINT;
            it is a BASE url and /v1/events is appended.
  backlog: 1 file, ~5 min of events. 20 is the cap, after which the oldest is deleted per run.
```

**The endpoint is never echoed.** It can carry credentials in userinfo (`https://user:pass@host`),
and SPEC.md §12 forbids a token reaching any output. The operator configured it and can read it back
from their own environment; naming the *variable* is enough and is what actually helps.

The 404 hint is specific because that is the failure I actually hit, and the base-vs-path confusion
is the single most likely misconfiguration.

### B4 — a drop is loud, and cumulative

`filesDropped > 0` means events that exist nowhere else were destroyed. It currently prints as
`dropped 1` inside a comma-separated list.

```
  DATA LOST: 1 spool file deleted — the backlog has been at the 20-file cap since it filled.
             Every further run deletes one more.
```

No new state is stored to count cumulative loss; the sentence states the standing condition, which is
true whenever `filesDropped > 0` and does not require remembering anything across runs.

### B5 — a distinguishable failure is not yet a different exit code

`cli-ship` keeps exiting 1 on `filesRetained > 0`, and
`deploy/systemd/claudewatch-ship.service` keeps `SuccessExitStatus=0 1`. **Out of scope, deliberately.**

A permanent failure now being *distinguishable* is a precondition for treating it differently, not a
licence to. Changing the unit's success semantics is a deploy change with a live consequence — a
`systemctl --failed` that starts reporting on every transient blip is worse than one that reports
nothing — and it deserves its own loop with its own measurement. Recorded, not silently kept.

## What this loop does NOT do

**No staleness anomaly kind in `anomaly.ts`.** The intent measured that `detect()` returns
`status: 'healthy'` for a dataset whose newest event is 365 days old, and that is still true after
this loop. Declined with a reason rather than deferred:

- The server cannot distinguish a broken client from an absent one, so any bound it could apply is a
  guess about user behaviour.
- The signal that *is* unambiguous — a running shipper that is failing — is local, and B1–B4 surface
  it at the machine where it can be acted on.
- A shipping failure fundamentally **cannot be reported through the shipping pipeline**. Any
  server-side detection of "the pipeline is down" arrives, at best, after it recovers.

If a server-side bound is still wanted, it is a different loop with a different question: *what does
this deployment expect, and who is meant to act on it?* That question has no answer for a
single-machine deployment, which is what exists today.

## Data and types

```ts
// packages/metrics/src/types.ts
export type ShipFailure =
  | { kind: 'http'; status: number }
  | { kind: 'transport'; message: SurfaceableMessage }
  | { kind: 'unreadable' };

// packages/metrics/src/agent.ts
export function describeFailure(f: ShipFailure): string;   // the operator-facing line
export function classifyTransportError(e: unknown): SurfaceableMessage;
```

`classifyTransportError` mirrors `client.ts:270-273`'s mapping. It is a separate function rather than
an import because `client.ts`'s version is entangled with retry state and `AbortController` timing;
extracting a shared one is a refactor of product code that this harness-shaped loop should not carry.
**That duplication is the kind this repo has been bitten by** (`MAX_LINE_BYTES`, the cache-dir rule),
so it ships with a test asserting the two agree on the same inputs — the `scripts/spool-path.test.ts`
remedy.

## Backward compatibility

- `ShipResult` gains a field. `combineResults` and `cli-ship` both read it; both are in scope.
- The exit code is unchanged, so the systemd unit needs no edit and no redeploy.
- `agent.test.ts:58` and `:66` currently assert only `filesRetained === 1` for two different causes.
  Both must gain the assertion that distinguishes them — that is A2, and it is the criterion that
  proves the defect is actually fixed rather than merely described.
- No event schema change. Nothing new reaches the wire or the store.

## Acceptance criteria

- [ ] **A1** — `bun run verify` exits 0, CI green.
- [ ] **A2** — the three causes are distinguishable: an HTTP 404, an HTTP 503, a thrown fetch, and an
      unreadable file each produce a different `ShipFailure`. **Four named tests.** Today two of these
      assert identically, which is why the defect survived.
- [ ] **A3** — a 404 and a 503 are distinguishable *from each other*, not merely both `http`. The
      status is the difference between "fix your config" and "wait".
- [ ] **A4** — `classifyTransportError` agrees with `client.ts`'s mapping on timeout, TLS failure and
      generic network error, asserted against both implementations rather than against a copy of the
      table.
- [ ] **A5** — `combineResults` concatenates `failures` and does not collapse two different reasons
      into one.
- [ ] **A6** — the endpoint string never appears in any output, asserted with an endpoint containing
      userinfo (`https://u:p@host/x`) and a check that neither `u`, `p`, nor the host is present.
- [ ] **A7** — the backlog line reports the depth measured from the filesystem, and a run with no new
      events does not raise it. The idle case is the one that makes the signal trustworthy.
- [ ] **A8** — `filesDropped > 0` produces the `DATA LOST` line; `filesDropped === 0` does not.
- [ ] **A9** — mutation predictions named `file:testname` **before** the run, one per rule, each
      naming any cross-cutting suite it also trips. Loop 035's lesson applies directly: **trace the
      early returns**, because the three failure paths are ordered and a mutation in a later one
      cannot reach a test whose input is caught earlier.
- [ ] **A10** — `.oxlint-budget.json` unchanged at 8 rows / 10 warnings.
- [ ] **A11** — the plan-to-diff audit reports no file outside the fence; `fenceCheck` reports zero
      findings for this loop.
- [ ] **A12** — a security pass confirms no token, no endpoint, no absolute path and no home
      directory reaches stdout, stderr, or any file.

## Edge cases

- **A batch that is partly unreadable** — `parseLines` already skips torn lines and counts them
  separately; a file that reads but parses to zero events still POSTs an empty array today. Not
  changed here, and not a new behaviour; recorded because the reason line will now say `HTTP 4xx` for
  it if the server rejects an empty batch.
- **Two files, two different reasons, one run** — the array shape exists for this. Asserted by A5.
- **A backlog that is flat because nothing is being produced** — reported as the depth, not as an
  outage. This is the measured idle case and the reason the signal has no false-positive mode.
- **The cap reached exactly** — `while (pending.length > MAX)` retains 20 and drops the excess, so
  the first deletion is on the run that would make it 21. The message must not claim 20 files were
  lost when one was.
- **`fetch` throwing a non-`Error`** — `classifyTransportError` takes `unknown` and must not assume
  `.code` or `.message` exists. `client.ts` reads `code`; a thrown string has none.

## Rejected alternatives

**A staleness bound in `anomaly.ts`.** See *What this loop does NOT do*. Measured, declined, with the
question a future loop would have to answer.

**Emitting a telemetry event for the failure.** A shipping failure cannot be reported through the
shipping pipeline. It would arrive only after recovery, which is when it is least useful.

**Storing a consecutive-failure counter in a sidecar file.** The `.shipping` files already are that
counter, persistently and crash-safely. A second source of truth for the same fact is what loop 034
spent a whole loop unwinding.

**Changing `SuccessExitStatus`.** B5. A deploy change with a live consequence, and a precondition
was only just met.

**Logging the endpoint to help the operator.** It can carry credentials. Naming the environment
variable is as useful and cannot leak.

---

**Next stage:** Build — run `/sdlc-plan 036-silent-shipping-failure`.
