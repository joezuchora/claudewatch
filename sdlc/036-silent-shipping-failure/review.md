# Review: a failing shipper says why, and cannot fail silently

- **ID:** 036-silent-shipping-failure
- **Stage:** 5 — Deploy
- **Reads:** the diff `2ddc914..96d3235`, `plan.md`, `REVIEW.md`
- **Date:** 2026-08-29

## Summary

Shipped. Both reviewers returned; neither returned clean.

The intent found five defects. **The Stage 2 review found three more in the code, the Stage 5 audit
found three tests that could not fail plus a real counter bug, and the security pass found an OAuth
token going out on the wire — through a hole this loop's own change had widened.** Every one was
reproduced before it was accepted.

| Stage | Found | Outcome |
|---|---|---|
| 2 — spec review | 3 blocking, 6 major, 7 minor, 6 nits | C1/C2/C3 became the loop's substance; A4 was unsatisfiable |
| 5 — plan-to-diff | 3 mutation-proven dead tests, 1 counter bug, 2 false entries in my own mutation record | all fixed or recorded |
| 5 — security | 1 major with a working exploit, 5 minor, 1 outside the diff | major fixed and mutation-verified |

**The honest headline: I widened a credential-exfiltration window while fixing a data-loss bug, and
did not notice.** C2's prune reorder removed the truncation that capped how many files were read per
directory enumeration. That is the second consecutive loop where a correct-looking change opened a
path to `~/.claude/.credentials.json`, and the second where only the security pass caught it.

## Commits

| Commit | What |
|---|---|
| `b38f3c8` | intent |
| `10414d4` | spec |
| `0409d86` | spec revision after the Stage 2 review |
| `2ddc914` | plan |
| `ad51611` | implementation |
| `0fcf9fc` | plan-to-diff remediation |
| `96d3235` | security remediation |

## Pass 1 — Bugs and logical errors

### The three defects the Stage 2 review found, all reproduced

**C1 — `ship()` threw, and the whole diagnostic surface was bypassed.** `rotate()`'s `renameSync`
sat outside a `try` that wrapped only `statSync`; `cli-ship`'s only `try` was inside a helper.
Reproduced as `EISDIR`: no reason line, no backlog line, no `DATA LOST`, and an unhandled rejection
exiting 1 — which `SuccessExitStatus=0 1` maps to unit success. **The loop's headline failure
escaping the loop's own fix**, in exactly the read-only-spool configuration `deploy/README.md`
documents as reachable.

**C2 — the prune destroyed a file the healthy endpoint would have taken.** Measured: 21 deliverable
files, endpoint recovered, `shipped=20, filesDropped=1`. One permanent avoidable loss per outage,
caused by ordering alone. After the reorder: `shipped=21, filesDropped=0`.

**C3 — the `try` covered `rmSync` and the counters.** A 200 whose delete failed was reported as a
transport failure, `shipped` never incremented, and the file was re-sent every five minutes forever.
`client.ts:239-246` already records this exact lesson from the sdlc/014 pass. **Writing the lesson
down did not confer immunity** — the first draft reproduced the shape inside the loop whose stated
purpose is that failure causes must not be conflated.

### One fix subsumed another

The review found the `DATA LOST` sentence false in the recovery case (`filesDropped=1, backlog=0`)
and the obvious remedy was a conditional. C2's reorder then removed that case: measured, 25 pending
against a failing endpoint gives `dropped=5, backlog=20`; 45 against a healthy one gives
`shipped=45, dropped=0`. The conditional's other branch became unreachable, so it was deleted rather
than kept as documentation — **and replaced with `dropCanOnlyHappenAtTheCap`, an asserted invariant
with a falsifiability test**, so the wording rests on a check rather than on my reading of the
ordering.

### Three tests that could not fail — the Stage 5 audit, all mutation-proven

1. **The `DATA LOST` guard could be inverted to `>= 0`** — every clean run screaming data loss — and
   all nine `cli-ship` tests stayed green. The line goes to stderr; nothing read stderr. A10 leg 3
   was simply absent.
2. **A5's source check was single-quote-specific and read one file.** A double-quoted copy passed; a
   second table in `cli-ship.ts` was invisible.
3. **The prune's catch branch was executed by no test at all** — proved by the M3 mutation removing
   *both* wrappers while only the rotate test failed.

All three re-verified by re-running the same mutations after the fix.

### A counter that double-counted, and an invariant satisfied by the bug

A prune failure called `retain()`, incrementing `filesRetained` for a file the delivery loop had
already counted: **21 files that all 404 plus one failed prune gave `filesRetained = 22` for 21
files.** `failures.length === filesRetained` did not catch it, because the buggy code incremented
both sides together.

> **An invariant that the bug satisfies is not an invariant.** The equality was chosen because it
> sounded strong. The true relation is `>=` — a prune failure legitimately records a reason for a
> file already counted — and the weaker, true version catches what the stronger, false one could not.

## Pass 2 — Security and vulnerabilities

### F1 (MAJOR, fixed) — a TOCTOU put the OAuth token on the wire

`pendingShippingFiles` lstats at **enumeration**; the delivery loop reads later. Reproduced end to
end, with a sandbox stand-in for the credential file:

```
POST bodies: [ "[{\"eventId\":\"a\"}]",
               "[{\"claudeAiOauth\":{\"accessToken\":\"sk-ant-oat01-SENTINEL\"}}]" ]
LEAKED: true
```

Two regular files, both passing loop 034's filter; the second swapped for a symlink while the first
POST is in flight. The token went out in a body carrying the `Authorization` header.

**This loop widened it and therefore owned it.** Loop 034 hardened the enumeration and left the read
by path. C2's reorder removed the truncation that capped `pending` at 20 before any read, so an
arbitrarily large set is now read one file at a time after a single enumeration — minutes of race at
a 10s timeout, not seconds. The diff also touches the exact read line.

Fixed at the descriptor, not the path: `O_RDONLY|O_NOFOLLOW`, `fstat` the **open file**, require a
regular file owned by this uid, then read from the fd. A second `lstat` would only have been a second
racy check. `readImpl` still replaces the read itself (`readFileSync` accepts a descriptor) so the
test seam cannot skip the guard. Windows has no `O_NOFOLLOW`; the flag degrades to `0` and fstat plus
ownership carry it there, **with the residual exposure stated rather than papered over**.

Verified: `LEAKED: false`, one body, and the swapped file reported as `{kind:'unreadable',
code:'ELOOP'}`. Two mutations confirm the guard is load-bearing — reverting to a path read fails the
regression test, and dropping `O_NOFOLLOW` alone fails two.

### F2–F6 (MINOR, all fixed)

- **`res.status` was stored raw** and validated only at render, while the file's own docblock quotes
  SPEC.md §12's *"validated where it enters"*. Clamped at construction; the render check stays as the
  second guard.
- **`formatAge(NaN)` rendered `"NaNh NaNm"`.** Unreachable today; fixed as defence in depth.
- **`pendingShippingFiles` sorted lexically while the age report took a numeric min**, so "oldest"
  named two different files. Attacker-reachable: a planted `…jsonl.9.shipping` sorts after every
  13-digit stamp and survives every prune while genuine spool files are deleted. Now one function.
- **A planted `…jsonl.0.shipping` made the run print `oldest 496662h 11m old`** — falsifying the very
  diagnostic this loop exists to add. Stamps outside a plausible window now render `unknown age`.
- **`shipSafely` fabricated `op:'rotate'` and `filesRetained:1` for any escape**, so a crash *after* a
  successful delivery printed "could not rotate a spool file". The same defect this loop removes, one
  level up. Now `op:'unknown'` with a zero count, and the exit code reads `failures.length`.

### Cleared, and stated as cleared

The token reaches only the `Authorization` header — not `ShipResult`, not any `console.*`, not argv,
not any file; `shipSafely` prints `e.name` only, and every escapable throw is a builtin whose name is
a fixed identifier. The endpoint reaches only the fetch URL; the 404 hint names the **variable**, not
its value. **The diagnostic strings need no `scrubControls` and that is structural, not lucky**:
every interpolated value is a number computed in-process or a repo literal, and the reviewer verified
the closure is compiler-enforced (a fifth `ShipFailure` variant fails `describeFailure` under
`strict`). `client.ts` untouched at its URL and 5s timeout; no TLS flag, no new write, no new
`execSync`. `cli-ship.test.ts` was verified to inherit no proxy env and to point only at closed
loopback.

## Pass 3 — Compliance

| Rule | Verdict |
|---|---|
| Domain logic in `packages/core` | The one core change is an extraction *into* core, which is the direction the rule wants. |
| Surfaces stay thin | N/A — no surface touched. |
| No `any` | Clean. Injected seams are typed `typeof rmSync` / `typeof readFileSync`. |
| ESM, strict TS | Clean. |
| UTC ISO internally | Unchanged; `oldestPendingAtMs` is an internal epoch number, never displayed raw. |
| VS Code bundle CJS | N/A — `packages/vscode` untouched. |
| Reuse before adding | `classifyFetchError` extracted rather than duplicated; `TransportMessage` is an `Extract<>` of an existing union. |

## Acceptance criteria

| # | Verdict |
|---|---|
| A1 | **MET** — verify 16.8s, CI green on every pushed commit |
| A2 | **MET** — five causes distinguishable. Four tests, not the five the plan named; 404 and 503 share one test, which is also A3. Form differs from the plan, substance does not. |
| A3 | **MET** |
| A4 | **PARTIAL — and this is the one to read.** The in-process half is met for both `rotate` and `prune`. **The subprocess half is UNMET.** A throwing `rotate` is not reachable from outside the process here: the gate runs as root so mode bits deny nothing, and the rotation stamp is `Date.now()`, which a test cannot inject from outside. The in-process test covers C1's root cause; `shipSafely`'s outer catch is exercised by no test. |
| A5 | **MET** — widened after the audit to be quote-agnostic across every non-test file in the package |
| A6 | **MET** |
| A7 | **MET** |
| A8 | **MET**, with the invariant corrected from `===` to `>=` |
| A9 | **MET** |
| A10 | **MET** — leg 1 removed by the design change (documented above), legs 2 and 3 asserted; leg 3 was absent until the audit |
| A11 | **MET** — and the mutation fails by hanging, which is the right mode |
| A12 | **MET** — strengthened after the audit; per-case preconditions replace one that passed trivially |
| A13 | **MET** |
| A14 | **PARTIAL — two entries in my own record were false.** See below. |
| A15 | **MET** — 8 rows / 10 warnings, unchanged |
| A16 | **MET** — no file outside the fence; `fenceCheck` reports zero findings for this loop |

## The mutation record, in full

Thirteen mutations. M1–M8 were predicted in `plan.md` before the run; M9–M13 were run after the
reviewers, to verify their findings were actually closed.

| # | Mutation | Predicted | Actual | Verdict |
|---|---|---|---|---|
| M1 | prune back before the delivery loop | A7 only | A7 + the cap invariant | under-predicted (the invariant post-dates the prediction) |
| M1′ | *first attempt* | — | 3 failures, A7 **not** among them | **BOTCHED** — it disabled the prune rather than moving it. Redone. |
| M2 | widen the `try` over `rmSync` | A6 only | A6 only | exact |
| M3 | remove the rotate wrapper | A4 subprocess, "non-zero exit, no reason line" | the **in-process** test, by throw | **RECORDED CORRECT, WAS NOT.** The named test does not exist, so the mode could not be observed; the commit silently restated it. |
| M4 | remove the `AbortController` | A11, by hanging | A11, timed out at 5000ms | exact, mode included |
| M5 | hardcode the transport message | 2 | 3 (A11 too — one line serves two tests) | under-predicted |
| M6 | make the loss line unconditional | A10's `backlog<20` case | **no-op against the shipped tree** | **RECORDED CORRECT, WAS UNVERIFIABLE.** Run against an intermediate build whose test was later deleted. |
| M7 | drop the status range check | A13 only | A13 only | exact |
| M8 | drop `retain` on the unreadable path | 2 | 1 → widened test → 2 | **over-predicted.** The invariant was narrower than its name. The mutation found the gap; that is not the prediction being right. |
| M9 | invert the `DATA LOST` guard | — | 1 (previously 0) | audit gap, closed |
| M10 | double-quoted TLS literal in `agent.ts` | — | 1 (previously 0) | audit gap, closed |
| M11 | remove the prune wrapper alone | — | 1 (previously 0) | audit gap, closed |
| M12 | revert `readSpoolFile` to a path read | — | 1 | security fix is load-bearing |
| M13 | drop `O_NOFOLLOW` only | — | 2 | `fstat` alone is not enough |

**Eight predictions: four exact, two under (safe), one over, one botched — and two records that
described code I had not shipped.** The M3 and M6 entries are the important ones: both were *written
as correct*, and only the audit caught them. A mutation record is a claim like any other.

## Recorded, not fixed

- **A4's subprocess half.** The mechanism is stated above. `shipSafely`'s catch is now, by design,
  unreachable through any normal path — `ship()` guards rotate, read, fetch, delete and prune — so it
  is a defence-in-depth boundary whose only justification is a future refactor reintroducing a throw.
  That is a defensible exception to "delete a branch no test can distinguish", and it is stated
  rather than left looking tested.
- **`deploy/install-nuc.sh:45-53`** writes the metrics bearer token with `> "$ENV_FILE"` and chmods
  600 afterwards, leaving a brief world-readable window. Outside the diff; `umask 077` or
  `install -m 600 /dev/null` closes it.
- **`pendingShippingFiles` swallows a `readdir` error and returns `[]`.** A vanishing spool directory
  therefore reports `backlog: 0`. The `DATA LOST` line now states the backlog it measured rather than
  asserting the cap, so the message is no longer falsified by it — but the underlying "I could not
  tell" printed as "zero" remains, and it is the same shape as the defect this loop exists to remove.
- **`combineResults` sums two capped spools**, so the backlog line can read 40 while the cap is 20 per
  spool. The wording now says "per spool"; the number is still a sum.
- **The `source: 'sdlc'` staleness bound.** `metrics:detect` still reports `healthy` on a store that
  stopped growing a year ago. Deferred with its measurement named, not declined — see `spec.md`.
- **`SuccessExitStatus=0 1`.** B9. A permanent failure is now distinguishable in prose but still not
  machine-readable.
- **Same-millisecond rotation overwrites silently.** The fix changes a filename contract two other
  functions parse.
- **The at-rest disk bound is 21 files, not 20**, because the prune now runs last.

---

**Next stage:** Maintain — the retrospective lands in `sdlc/README.md`. No incident: nothing shipped
broken, and the credential path was closed before merge.
