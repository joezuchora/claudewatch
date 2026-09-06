# Spec: a failing shipper says why, and cannot fail silently

- **ID:** 036-silent-shipping-failure
- **Stage:** 2 — Design
- **Status:** revised after review (see *Corrections*)
- **Reads:** `sdlc/036-silent-shipping-failure/intent.md`
- **Date:** 2026-08-29

## Summary

The intent found five defects in a chain ending in silent data loss. **The Stage 2 review found
three more, in the code rather than the documents, and all three are reproduced below.** They matter
more than the ones the intent found, because each defeats the fix the intent asked for:

| | |
|---|---|
| **C1** | `ship()` **throws** out of `rotate()`/prune on any filesystem error, and `cli-ship` has no `try`. The entire diagnostic surface is bypassed — in exactly the `EPERM` case `deploy/README.md:167-177` documents as reachable. |
| **C2** | The prune runs **before** the delivery loop, so the first run after an outage destroys a file the now-healthy endpoint would have taken. **One avoidable permanent loss per outage.** |
| **C3** | The `try` covers `rmSync` and the counters, not just the POST. A **successful** ship whose file deletion fails is reported as a transport failure, `shipped` is not incremented, and the file is re-sent every run forever. |

This loop fixes those, gives every retained file a reason, and stops `ship()` hanging a `oneshot`
unit indefinitely.

**What it does not fix, stated plainly rather than in a subordinate clause: after this loop,
`metrics:detect` still reports `healthy` on a store that stopped growing a year ago.** The intent
called that the point of the whole thing. It is narrowed and deferred, not solved — see
*What this loop does NOT do*.

**And this loop improves diagnosis, not detection.** A permanently failing shipper remains invisible
to every documented operator surface except one journal command, which this loop adds to the
runbook. That is worth doing and is less than the intent asked for.

## The measurement that decided the design

`ship()` calls `rotate()`, which returns `null` when the live spool is absent, empty, or not a
regular file (`agent.ts:60,63,65` — the third is sdlc/034's symlink guard). So a `.shipping` file is
created only by a run that **had events to deliver and failed to deliver them**. Measured in a
sandbox against a 404-ing endpoint:

```
--- failing, new events each run:      run 1..6  -> backlog 1..6
--- failing, NO new events (idle):     run 7..10 -> backlog 6, 6, 6, 6
--- past the cap:                      backlog pinned at 20, one file destroyed per run
```

1. **Backlog depth counts failed deliveries.**
2. **It cannot rise when the machine is off** (nothing runs) **or when nothing is being produced**
   (`rotate` returns `null`). The weekend false positive is impossible *by construction*.
3. Past the cap it pins at 20 and destroys one file per run — **while events keep arriving.** An
   idle machine past the cap destroys nothing, which the first draft's "forever" contradicted.

> **Detect the failure where it is unambiguous.** "This shipper is failing" is knowable exactly, on
> the machine, from state that survives a crash. That is what the reasons and the backlog line are
> built on.

### The three code defects, reproduced

**C1 — a thrown spool operation bypasses everything.** `rotate()`'s `renameSync` (`agent.ts:70`) sits
*outside* the `try`, which wraps only `statSync`. The prune's `rmSync` (`:154`) is unguarded.

```
ship THREW: EISDIR: illegal operation on a directory, rename '…/metrics-spool.jsonl' -> '…jsonl.42.shipping'
```

`cli-ship.ts` has exactly one `try`, and it is inside the `sameFile` helper — not around either
`ship()` call. So `console.log` at `cli-ship.ts:48` never runs: no reason line, no backlog line, no
`DATA LOST` line, and an unhandled rejection exits 1, which `SuccessExitStatus=0 1` maps to unit
success. **This is the loop's own headline scenario escaping the loop's own fix.**

**C2 — the prune destroys a file the healthy endpoint would have taken.** The cap loop (`:152-156`)
runs before the delivery loop (`:158`). Twenty backlog files, endpoint recovers, one new event:

```
RECOVERY run: {"shipped":20,"filesShipped":20,"filesRetained":0,"filesDropped":1} backlog after = 0
```

Twenty-one files were deliverable. Twenty shipped. **One was destroyed first, for no reason but
ordering.** Not a cap-size question — a one-line reorder.

**C3 — the `try` is too wide.** It opens at `:170` and covers header construction, the fetch,
`res.ok`, `rmSync(file)` and both counter increments, with the `catch` at `:188`. `rmSync` with
`force: true` swallows `ENOENT` but throws on `EACCES`/`EPERM`. So a POST that returned 200 and a
delete that failed becomes "transport failure": `shipped` never increments, the file stays, and it is
re-POSTed every five minutes forever while the operator is told the network is broken.

This repo already learned this and wrote it down — `client.ts:239-246`:

> *"The `try` covers the network call and NOTHING else. It used to wrap the retry decision too… A
> guard whose failure is indistinguishable from a flaky network is not a guard. Found by the sdlc/014
> security pass."*

The first draft of this spec reproduced the exact shape sdlc/014 removed, inside the loop whose
stated purpose is that failure causes must not be conflated.

## Behavior

### B1 — the `try` narrows to the POST alone (C3)

`doFetch` is the only statement inside it. `rmSync`, `shipped` and `filesShipped` move after, with
their own guard. Per `client.ts:239-246`, which is now cited in the code.

### B2 — `ship()` never throws; every failure has a reason

```ts
export type ShipFailure =
  | { kind: 'http'; status: number }
  | { kind: 'transport'; message: TransportMessage }
  | { kind: 'unreadable'; code: SpoolErrno }
  | { kind: 'spool'; op: 'rotate' | 'prune' | 'delete'; code: SpoolErrno };

/** Validated allowlist. An errno from the OS is not free text. */
export type SpoolErrno = 'ENOENT' | 'EACCES' | 'EPERM' | 'EISDIR' | 'ENOTDIR' | 'EROFS' | 'ENOSPC' | 'other';

/** The three a transport failure can actually be. Narrower than `SurfaceableMessage`. */
export type TransportMessage = Extract<
  SurfaceableMessage, 'Network error' | 'TLS verification failed' | 'Request timed out'
>;
```

`rotate` and the prune are wrapped; a throw becomes a `spool` failure and the run continues to report
rather than dying. `cli-ship` also wraps both `ship()` calls, because a guard that only exists one
level down is a guard that a future refactor removes.

**`kind: 'spool'` is a fourth member, not folded into `unreadable`.** Collapsing "I could not read
this file" and "I could not rename the spool" would repeat the defect this loop exists to fix, one
level up. That argument is the reason for the array in B4 too.

### B3 — `ship()` sets a request timeout

`agent.ts:174` calls `doFetch` with no `AbortController`. `bun`'s `fetch` has no default timeout, and
`Type=oneshot` defaults `TimeoutStartSec=infinity`, so **a hanging endpoint stops shipping entirely**:
the unit stays active, the timer will not re-fire, and the live spool grows to `MAX_SPOOL_BYTES`
(5 MiB) where the emitter begins dropping events into the sidecar.

Promoted from a review nit to a requirement because it is also what makes `'Request timed out'`
reachable — without it, one third of B5's mapping is dead code that A5 could not test.

### B4 — `ShipResult` carries reasons, backlog, and the age of the oldest pending file

```ts
export interface ShipResult {
  // ...unchanged...
  failures: ShipFailure[];        // one per retained file, in the order encountered
  backlog: number;                // pending files AFTER this run
  oldestPendingAtMs: number | null;
}
```

`combineResults` concatenates `failures`, sums `backlog`, and takes the **minimum** non-null
`oldestPendingAtMs`.

`oldestPendingAtMs` replaces the first draft's `~5 min of events`, which was **a guess presented as
fact** and against `CLAUDE.md`'s "missing optional fields are omitted, not guessed". The rotation
stamp *is* `Date.now()` (`agent.ts:69`), so the real age is free. With `Persistent=true` and a
suspended machine one file can hold a weekend, and the guess would have said five minutes.

**Invariant: `failures.length === filesRetained`.** Asserted, because that is the drift that makes a
merged result wrong.

### B5 — the transport mapping is imported from core, not re-implemented

`packages/core/src/client.ts:269-273` maps a thrown fetch to `'Request timed out'` /
`'TLS verification failed'` / `'Network error'`, but the logic is inline and depends on a closure
variable `timedOut` set by the abort timer at `:237`. **Extract it:**

```ts
// packages/core/src/client.ts
export function classifyFetchError(err: unknown, timedOut: boolean): TransportMessage;
```

`fetchUsage` calls it; `agent.ts` imports it. Five lines moved, no behaviour change.

The first draft proposed a second implementation in `agent.ts` plus a test asserting the two agree.
That criterion was **unsatisfiable**: `client.ts`'s version is a function of `(err, timedOut)` and the
proposed counterpart took only `err`, so "agree on the same inputs" had no meaning for the timeout
leg — and `ship()` set no timeout, so that leg could not be produced at all. It was the same shape as
loop 034's A6, which `scripts/spool-path.test.ts:17-21` documents; the first draft cited that file as
its precedent while declining the extraction that made the precedent work.

### B6 — `cli-ship` prints reasons, backlog, and a conditional loss line

```
shipped 0 events from 0 file(s); retained 20, dropped 1, skipped 0 unparseable line(s)
  retained: 20 × HTTP 404 — the service rejected the batch. Check CLAUDEWATCH_METRICS_ENDPOINT;
            it is a BASE url and /v1/events is appended.
  backlog: 20 files, oldest 1h 42m old. Cap is 20; at the cap each run deletes the oldest.
  DATA LOST: 1 spool file deleted (backlog now 20 of 20).
```

Reasons are **grouped with a count**, not printed twenty times.

**The `DATA LOST` line is conditional on the post-run backlog.** The first draft asserted its sentence
was "true whenever `filesDropped > 0`". C2's measurement shows it false in the recovery case:
`filesDropped=1` with `backlog=0`, so "the backlog has been at the cap since it filled; every further
run deletes one more" would print at the exact moment the outage cleared, both clauses false. The
standing-condition sentence appears only when `backlog === 20`.

**The endpoint is never echoed.** It can carry credentials in userinfo. Naming the variable helps
more and cannot leak. `status` is rendered only when `Number.isInteger(status) && 100 <= status <= 599`,
else `HTTP (invalid status)` — the `SPEC.md §12` precedent for `lastHttpStatus`, which is validated
"because it reached `--debug` verbatim".

### B7 — the output gains a documented reader

`deploy/README.md`'s *Operating it* section lists four commands, and its only `journalctl` targets
`claudewatch-sdlc-loop` — a different unit. `claudewatch-ship`'s journal appears in **no** documented
workflow, and `deploy/README.md:43` invokes the shipper as `… || true`, discarding its exit code.

`journalctl --user -u claudewatch-ship --since -1h` is added to that section, and
`cli-ship.ts:2`'s header comment — "Run from a timer, or by verify" — is corrected: **`verify` does
not run the shipper.** `scripts/verify.ts` has no ship step; I checked.

A reader is a precondition for B6 to have any effect at all.

### B8 — the cap of 20 is defended, not merely stated

`MAX_SPOOL_BYTES` is 5 MiB (`telemetry.ts:37`), so 20 retained files bound worst-case spool disk at
**100 MB**, and 20 five-minute intervals is 100–110 minutes of tolerated outage
(`RandomizedDelaySec=30s`). That exceeds any observed restart of the metrics service by two orders of
magnitude. **Kept at 20**, and with C2 fixed the cap no longer costs a file on recovery — which was
the only measured harm attributable to its value.

The intent asked for this to be "widened or defended". Defended.

### B9 — the exit code and the systemd unit are unchanged

`cli-ship` still exits 1 on `filesRetained > 0`; `SuccessExitStatus=0 1` stays. **Deliberate, and it
means the intent's outcome 2 is delivered to a human reader only** — a 404 and a 503 are now
distinguishable in prose, and still not machine-readable. Changing the unit's success semantics is a
deploy change with a live consequence, and a `systemctl --failed` that fires on every transient blip
is worse than one that never fires. Its own loop, with its own measurement.

## What this loop does NOT do

**No staleness bound in `anomaly.ts`.** The intent measured that `detect()` returns
`status: 'healthy'` for a dataset whose newest event is 365 days old. **That is still true after this
loop.**

The first draft declined it on the grounds that "any bound the server could apply is a guess about
user behaviour". **That is over-generalized, and the review was right to reject it.** It holds for
`source: 'product'` events from a hypothetical fleet. It does not hold for `source: 'sdlc'` events —
which is what `detect()` actually consumes, since `anomaly.ts:359` filters to `kind === 'verify_run'`
and only `scripts/verify.ts` emits that. Their cadence is produced by
`claudewatch-sdlc-loop.timer` (`OnCalendar=*-*-* *:17:00`, `Persistent=true`) — **a timer, not a
person.** A bound over a machine-generated cadence is constructible by the same argument this spec
uses for the backlog, and `Stats.newestReceivedAt` already exists and is already an operator routine
(`deploy/README.md:141`).

So the correct statement is:

- For `source: 'product'`, no bound is defensible: cadence is user behaviour, and a server cannot
  distinguish a broken client from an absent one.
- **For `source: 'sdlc'`, a bound is constructible and is deferred, not declined.** It needs its own
  measurement — what the timer's real arrival distribution looks like, including `Persistent=true`
  catch-up bursts — and `anomaly.ts`'s docstring opens with *"RELUCTANCE IS THE POINT."*

A shipping failure still cannot be reported *through* the shipping pipeline; that argument survives
and is why the local reasons are worth building first.

## Backward compatibility

- `ShipResult` gains three fields; `combineResults` and `cli-ship` both read them.
- `packages/core/src/client.ts` gains one exported function; `fetchUsage`'s behaviour is unchanged.
- Exit code unchanged, so no redeploy is required.
- `agent.test.ts:58` and `:66` currently assert only `filesRetained === 1` (and `filesShipped === 0`)
  for two different causes. `agent.ts:186` and `:189` have **byte-identical bodies**, so swapping
  them is a textual no-op no test can catch. Both tests must gain the distinguishing assertion.
- No event schema change. Nothing new reaches the wire or the store.

## Acceptance criteria

- [ ] **A1** — `bun run verify` exits 0, CI green.
- [ ] **A2** — five causes are distinguishable: HTTP 404, HTTP 503, thrown fetch, unreadable file,
      and a throwing `rotate`. **Five named tests.** Two of these assert identically today.
- [ ] **A3** — 404 and 503 differ *from each other*, not merely both `http`. That is the difference
      between "fix your config" and "wait".
- [ ] **A4** — a throwing `rotate` and a throwing prune each produce a `spool` failure, a printed
      reason line, and a non-zero exit — asserted by running `cli-ship` as a subprocess, because the
      defect is that the process dies before printing. **C1's criterion.**
- [ ] **A5** — `agent.ts` contains no transport-classification table: it imports
      `classifyFetchError` from core. Asserted behaviourally (a TLS-code error yields
      `'TLS verification failed'` from both `fetchUsage` and `ship`) **and** by a source check that
      the string `'TLS verification failed'` appears in exactly one module.
- [ ] **A6** — a POST returning 200 whose `rmSync` throws is **not** reported as `transport`; it is
      `{ kind: 'spool', op: 'delete' }`, and `shipped` still counts the events. **C3's criterion.**
- [ ] **A7** — on a recovery run with 20 pending and one new event, `filesDropped === 0` and
      `filesShipped === 21`. **C2's criterion, and it fails today** (measured: `filesDropped === 1`).
- [ ] **A8** — `combineResults` concatenates `failures`, sums `backlog`, takes the minimum non-null
      `oldestPendingAtMs`, and preserves `failures.length === filesRetained`.
- [ ] **A9** — a run with an empty spool and a non-empty backlog returns the **same** `backlog` and
      `filesRetained === 0`; a run with new events against a failing endpoint returns `backlog + 1`.
      Two named tests — the idle case is what makes the signal trustworthy.
- [ ] **A10** — `filesDropped > 0` with `backlog < 20` prints the loss line **without** the
      standing-condition sentence; with `backlog === 20` it prints both; `filesDropped === 0` prints
      neither.
- [ ] **A11** — `ship()` aborts a hung request and reports `'Request timed out'`, against a fetch
      that never resolves. Without this, B5's timeout leg is unreachable.
- [ ] **A12** — **§12, as a named test, not a review step.** `cli-ship` run as a subprocess with
      `CLAUDEWATCH_METRICS_ENDPOINT=https://USER7f3a9c:PASS2b81de@sentinel-host.invalid/x` and
      `CLAUDEWATCH_METRICS_TOKEN=TOK4d19ae`: neither sentinel, nor `sentinel-host`, nor `@`, nor
      `homedir()`, nor any `/`-prefixed path appears in stdout or stderr — on the success, 404,
      throw, unreadable and spool-throw paths. Positive precondition: assert the child really
      received the sentinels.
- [ ] **A13** — `describeFailure` renders a status only when `Number.isInteger && 100..599`.
- [ ] **A14** — mutation predictions named `file:testname` **before** the run, one per rule, each
      naming any cross-cutting suite it also trips. **Trace the early returns** — loop 035's lesson,
      and the failure paths here are ordered.
- [ ] **A15** — `.oxlint-budget.json` unchanged at 8 rows / 10 warnings.
- [ ] **A16** — the plan-to-diff audit reports no file outside the fence; `fenceCheck` reports zero
      findings for this loop.

## Edge cases

- **Two files, two reasons, one run** — the array exists for this (A8).
- **A backlog flat because nothing is produced** — reported as depth, not as an outage (A9).
- **The cap reached exactly** — `while (pending.length > MAX)` retains 20; the first deletion is on
  the run that would make it 21. The message must not claim 20 files were lost when one was.
- **`fetch` throwing a non-`Error`** — `classifyFetchError` takes `unknown` and must not assume
  `.code` or `.message`. A thrown string has neither.
- **Two rotations in the same millisecond** — `renameSync` overwrites, silently destroying the first
  run's events with `filesDropped = 0`. Reproduced by the review at a forced identical stamp;
  unreachable at a five-minute cadence, and **recorded rather than fixed** because the fix is a
  collision-resistant stamp, which changes the filename contract `pendingShippingFiles` and
  `shouldDrainLegacy` both parse.
- **An empty batch** — `parseLines` can yield zero events and `ship` still POSTs `[]`. Unchanged, but
  the reason line will now say `HTTP 4xx` if the server rejects it, which is an improvement over
  silence.
- **`unreadable` and `spool` carry an errno from an allowlist and a basename at most** — never the
  absolute path (A12).

## Rejected alternatives

**A `source: 'sdlc'` staleness bound in this loop.** Constructible; deferred with its measurement
named. See *What this loop does NOT do*. **Not** declined as impossible, which is what the first
draft said.

**A second transport-classification table in `agent.ts`.** B5. Unsatisfiable as a criterion and
institutionalises the duplication this repo has been bitten by twice.

**Emitting a telemetry event for the failure.** Cannot be reported through the pipeline that is down.

**A sidecar consecutive-failure counter.** The `.shipping` files already are that counter,
persistently and crash-safely. A second source of truth for one fact is what loop 034 spent a whole
loop unwinding.

**Changing `SuccessExitStatus`.** B9.

**Logging the endpoint.** It can carry credentials.

**Widening `SurfaceableMessage` for shipping-specific messages.** It is frozen by three mechanisms
(`typefixtures/free-text-message.expect-error.ts`, `isSurfaceableMessage`, and
`exhaustive-guard.test.ts:183-212`, which asserts the docstring's count against both the predicate
and the union) because it is load-bearing for `SPEC.md §12`'s cache-read boundary. This loop consumes
a **three-member subset** via `TransportMessage` and adds nothing. If a shipping-specific message is
ever needed, `packages/metrics` declares its own union at that point.

## Corrections to the first draft

| # | The first draft said | Correction |
|---|---|---|
| B-1 | A4 asserts `classifyTransportError` agrees with `client.ts` "against both implementations" | Unsatisfiable — `client.ts`'s mapping takes `(err, timedOut)` and depends on a closure variable, and `ship()` set no timeout so `'Request timed out'` could not be produced at all. Same shape as loop 034's A6. Now: extract `classifyFetchError` in core and import it (B5), plus set a timeout (B3). |
| B-2 | `ShipFailure` is a closed set of three | Not closed over the code: a thrown `renameSync`/`rmSync` escapes `ship()` entirely and kills the whole diagnostic surface. Reproduced. Fourth member added; both call sites wrapped. |
| B-3 | the `DATA LOST` sentence "is true whenever `filesDropped > 0`" | False in the recovery case — measured `filesDropped=1` with `backlog=0`. Now conditional on the post-run backlog. And the prune moves **after** the delivery loop, removing one permanent loss per outage. |
| M-1 | "any bound the server could apply is a guess about user behaviour" | Over-generalized. True for `source: 'product'`; false for `source: 'sdlc'`, whose cadence is a timer and which is all `detect()` consumes. Narrowed to a deferral with its measurement named. |
| M-2 | B1–B4 "surface it at the machine where it can be acted on" | The reason line goes to journald under a unit no documented workflow reads, invoked with `\|\| true`. Restated as diagnosis, not detection; B7 adds the runbook line and fixes `cli-ship.ts:2`'s stale claim that `verify` runs the shipper. |
| M-3 | the `try` scope was not specified | It covers `rmSync` and the counters, so a successful ship with a failed delete is labelled `transport` and re-sent forever. `client.ts:239-246` documents this exact lesson from the sdlc/014 pass. Narrowed to the POST (B1, A6). |
| M-4 | `backlog: 1 file, ~5 min of events` | A guess presented as fact, against CLAUDE.md's "omitted, not guessed"; the rotation stamp makes the real age free. `backlog` and `oldestPendingAtMs` move onto `ShipResult` so `cli-ship` holds no domain logic; reasons are grouped with a count. |
| M-5 | the cap of 20 stated, never defended | B8: 20 × 5 MiB bounds disk at 100 MB, and 100–110 min exceeds any observed restart. |
| M-6 | outcome 2 presented as met | Delivered to a human reader only; the machine-readable form is the deferred exit-code change (B9). |
| m-1 | `SurfaceableMessage` reused wholesale | Too wide — it admits `'Rate limited (429)'` and `` `Server error (${number})` ``, the latter colliding with `{kind:'http'}`. Narrowed to a three-member `Extract<…>`. |
| m-2 | `status` "an unbounded `number` deliberately" | Validated on render (A13), per §12's `lastHttpStatus` precedent. |
| m-3 | A6 asserts `u`, `p` and host absent | `u` and `p` are single characters and appear in the baseline line, so the test self-fails; the whole-string form is near-vacuous. Entropy-bearing sentinels (A12). |
| m-4 | A12 "a security pass confirms" | A process step, not a criterion — `REVIEW.md:41-43` mandates the pass anyway. Replaced with a named subprocess test. |
| m-6 | `failures.length === filesRetained` implied | Now asserted (A8). |
| m-7 | `unreadable` carries nothing | Carries an allowlisted errno; basename at most, never a path. |
| n-1 | `ShipFailure` in `types.ts`, `ShipResult` in `agent.ts` | Both in `types.ts`, so the plan fences one file for one concept. |
| n-3 | "one file destroyed per run, forever" | Only while events arrive; an idle machine past the cap destroys nothing. Corrected in the measurement table. |
| n-4 | `rotate` returns null when "absent or empty" | Three reasons — the third is sdlc/034's non-regular-file guard. |
| n-5 | — | Same-millisecond rotation overwrites silently. Recorded in *Edge cases*, not fixed. |
| n-6 | — | No request timeout, and `Type=oneshot` defaults `TimeoutStartSec=infinity`. Promoted from nit to requirement (B3). |

---

**Next stage:** Build — run `/sdlc-plan 036-silent-shipping-failure`.
