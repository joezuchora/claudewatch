# Intent: stop spending a minute of every gate run asleep

- **ID:** 011-injectable-timing
- **Stage:** 1 — Plan
- **Status:** accepted
- **Date:** 2026-08-26

## Problem

`bun run verify` takes **67.5 s**, and roughly **50 s of that is `setTimeout`**.

`client.ts` declares `TIMEOUT_MS = 5000` and `RETRY_DELAY_MS = 2000` as module constants with
no injection point, so every test exercising a retry sleeps 2 s for real, and every test
exercising the timeout sleeps 5 s for real.

Measured growth of the test step:

| When | Test step |
|---|---|
| Loop 001, 341 tests | 26 s |
| Loop 009, 481 tests | 31 s |
| Loop 010 (+2 timeout tests) | 57 s |
| Now | **62 s** |

Loop 001 recorded the retry sleeps as a follow-up and they have been open ever since. Loop 010
doubled the problem and said so. This is the change that fixes both.

## Who is affected

Everyone who runs the gate, which is the loop itself, every hour, plus CI on every push. A gate
that takes over a minute is one people batch changes to avoid, and batching is how the
128-failure defect survived for months.

## Why now

It is the top of the queue, and the cost is compounding rather than static: every future test
touching retry or timeout behaviour adds seconds. Loop 010 added 26 s in a single change.

## What "done" means

- [ ] Tests can exercise retry and timeout paths without sleeping for real
- [ ] **Production timings are unchanged** — 5 s timeout, 2 s retry delay, 1 retry
- [ ] The gate's test step drops materially, measured before and after
- [ ] No existing caller changes

## Explicitly out of scope

- Changing the retry policy or timeout duration (`SPEC.md §3.1`, §9.3). This makes them
  **injectable**, not different.
- The ~44 ms process startup that dominates the p95 budget — unrelated, still queued.
- Parallelising the test suite.

## Open questions

- **Injection by parameter, module setter, or environment?** Resolved in Design. The wrong
  choice here adds global mutable state to the one module that talks to the network.

---

**Next stage:** Design.
