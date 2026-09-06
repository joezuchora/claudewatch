# Incident: a test with a one-millisecond budget

- **ID:** 019-ttl-boundary-flake
- **Stage:** 6 — Maintain
- **Status:** open
- **Detected:** 2026-08-26 17:18 UTC — `bun run verify` on a clean tree, first run of the iteration
- **Severity:** blocking while red; no product defect.

## What happened

```
(fail) cache > isCacheFresh > returns true for snapshot at exactly TTL boundary minus 1ms
Expected: true
Received: false
```

The test:

```ts
const justUnder = new Date(Date.now() - 59_999).toISOString();
const snapshot  = makeTestSnapshot({ fetchedAt: justUnder });
const envelope  = makeCacheEnvelope(snapshot);
expect(isCacheFresh(envelope, 60)).toBe(true);      // asserts age < 60_000
```

`isCacheFresh` recomputes `Date.now()` at the assertion. The age it sees is
`59_999 + (elapsed since the first Date.now())`. **The test therefore gives itself a one
millisecond budget** to do an ISO round-trip and two object constructions. On an unloaded
machine that is comfortable; on this container's first workload after idle it is not.

Fourth consecutive first-run-of-iteration failure, and the fourth *different* test — the
common factor is a slow resume, not any one assertion.

## Impact

None on the product. `isCacheFresh` is correct; the test measures the machine.

The cost is the loop: a red gate blocks every change under `REVIEW.md`'s own rule, and this is
the third time this afternoon the iteration's first act has been to fix its own gate.

## Root cause

An assertion whose margin is smaller than the work it does before asserting.

A sweep for siblings found **exactly one**. Every other age-based test has 60–300 s of slack:

| test | offset | threshold | margin |
|---|---|---|---|
| `returns false for snapshot older than TTL` | 120 s | 60 s | 60 s |
| `5-minute-old cache is still fresh` | 300 s | 600 s | 300 s |
| `11-minute-old cache is stale` | 660 s | 600 s | 60 s |
| **`at exactly TTL boundary minus 1ms`** | **59.999 s** | **60 s** | **1 ms** |

So this is bounded, not systemic — which is worth stating, because "the suite is full of flaky
timing tests" would have been the easy and wrong conclusion.

- **Introduced by:** `sdlc/001`, with the original cache tests
- **Stage that should have caught it:** Design. `sdlc/001`'s own review records two flaky tests
  of the *same family* — probabilistic assertions that were lucky on a fast machine — and the
  lesson written there was "measure the failure rate rather than re-running". That lesson was
  applied to the two tests that had already failed, and not swept for siblings.
- **Why it didn't:** the test reads as a *deterministic* boundary check. `59_999` looks like an
  exact input, and the elapsed-time term is invisible unless you notice that `isCacheFresh`
  calls `Date.now()` itself.

## Fix

`isCacheFresh` takes `now` as a defaulted third parameter — the same shape `sdlc/011` used for
`fetchUsage`'s timings, and for the same reason: **time is a property of a call, not of the
process**. Every existing call site passes one or two arguments and is unchanged.

The boundary can then be tested exactly, from **both** sides — which the old test could not do
at all, because it could only ever assert the side that had slack:

```
59_999 ms against a 60 s TTL → fresh
60_000 ms against a 60 s TTL → stale     (the boundary is `<`, not `<=`)
```

A separate test keeps the ambient default honest, with a margin measured in minutes rather than
milliseconds.

## Follow-up

| Follow-up | New intent ID | Status |
|---|---|---|
| None. The sweep found no siblings, and the fix makes the boundary testable rather than merely non-flaky. | — | — |

## What we are not changing

- **The other age-based tests.** They have 60–300 s of margin and inject nothing. Rewriting them
  to pass an explicit clock would be churn for no defect.
- **`Date.now()` inside `isCacheFresh`'s default.** Ambient time is right for the *product*; it
  is only wrong for an assertion that needs to be exact.
