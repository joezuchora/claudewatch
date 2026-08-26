# Intent: the performance budget cannot be passed or failed

- **ID:** 013-perf-budget
- **Stage:** 1 — Plan
- **Status:** draft
- **Author:** carried from `sdlc/005-statusline-tty-stdin/review.md`, "Acceptance criteria not met"
- **Date:** 2026-08-26

## Problem

`SPEC.md §11.7` states one performance target:

| Scenario | Target |
|---|---|
| Cache hit (binary start → stdout) | < 50ms |

Loop 005 measured 51 ms and recorded the criterion as **not met**, noting that the honest fix
was "either a startup optimisation or a re-baselined budget, and that is its own change." It has
been carried open ever since, and it is quoted in PR #16 as an outstanding gap.

Re-measuring it turned up something more basic than the one-millisecond overshoot.

**The budget names no percentile and no measurement method.** "Cache hit < 50 ms" is not a
claim that can be checked: p50, p95 and max are 42.6 ms, 57.6 ms and 94.1 ms on the same binary
in the same run. Loop 005 chose to read it as p95 and declared a miss. Reading it as p50 makes
it pass with 15% to spare. Both readings are defensible against the text, which means the text
decides nothing — and there is no script anywhere in the repo that measures it, so every
statement about this number has been made by hand, once, and then quoted.

**Two things measured today contradict how the gap has been described since loop 005:**

1. **Telemetry is not the cause.** Loop 005's framing — 48 ms without telemetry, 51 ms with —
   implied telemetry pushed it over the line. Interleaved A/B at n=200 each, which cancels the
   slow drift a back-to-back run cannot:

   | | p50 | p90 | p95 | p99 |
   |---|---|---|---|---|
   | telemetry off | 42.6 | 48.3 | 57.6 | 92.4 |
   | telemetry on, 4 MB spool | 42.6 | 54.3 | 59.0 | 100.0 |

   p50 identical to 0.1 ms. The budget is missed at p95 with telemetry entirely disabled.

2. **Startup optimisation does not close it.** Four build configurations, interleaved so drift
   hits each equally, n=120 each:

   | build | p50 | p90 | p95 |
   |---|---|---|---|
   | baseline (`--compile`) | 42.7 | 52.6 | 57.2 |
   | `--minify` | 42.7 | 53.8 | 57.7 |
   | `--bytecode` | 41.5 | 48.1 | 56.9 |
   | `--minify --bytecode` | 41.6 | 50.7 | 55.5 |

   The spread between all four is under 2 ms. The ~40 ms floor is the Bun runtime's own process
   startup, not anything this project compiles into it. Closing a 15% p95 gap would mean not
   being a short-lived compiled binary at all — a persistent daemon — which is an architecture
   change, not a performance fix.

So the branch loop 005 left open resolves: **there is no startup optimisation available at this
altitude, and the budget as written cannot adjudicate anything anyway.**

## Who is affected

Nobody is experiencing a slow statusline — 42 ms is imperceptible in a prompt render. What is
affected is the project's ability to tell the truth about itself: an unfalsifiable budget in
`SPEC.md`, a criterion recorded "not met" on one of two equally valid readings, and a claim in
PR #16 that rests on a hand-measurement nobody can reproduce.

## Why now

The number has been quoted in three artifacts and re-derived by hand each time. Every additional
loop that cites it makes the eventual correction larger. And this is the queue's oldest item
that is actually actionable — the remaining ones are either small chores or blocked on data.

## What "done" means

- [ ] `SPEC.md §11.7` states a **percentile, a sample size, and a measurement method** for each
      target, so two people measuring the same binary reach the same verdict
- [ ] The numbers are set from measurement, with the measurement recorded — not moved to
      whatever the current run happens to produce
- [ ] A committed script measures the budget and exits non-zero on a breach, so the next claim
      about this number is reproducible rather than remembered
- [ ] The record is corrected where it is wrong: telemetry is not the cause, and loop 005's
      criterion is resolved rather than left dangling
- [ ] PR #16's body stops asserting things that are no longer true

## Explicitly out of scope

- **Adding the measurement to `bun run verify`.** ~200 spawns is ~9 s against a 5.5 s gate, in a
  project that just spent a loop cutting gate time tenfold — and a perf assertion on a shared CI
  runner is a flaky gate, which is worse than no gate. The reasoning belongs in the spec as a
  stated decision, not as an unremarked omission.
- **Changing the build flags.** `--bytecode` measured 1.2 ms better at p50 and nothing at p95;
  that is not worth a change to how the shipped artifact is produced, and adopting it on this
  evidence would be exactly the kind of unjustified move this loop exists to stop.
- **The cache-miss and HTTP-timeout targets.** They should get the same treatment, but neither
  has been measured and inventing percentiles for them would repeat the original mistake.
- **A persistent daemon.** The only architecture that would beat the startup floor, and wildly
  out of proportion to a 15 ms tail on an imperceptible operation.

## Open questions

- **What percentile should the budget name?** p50 is stable and measures the typical render;
  p95 is what a user notices when it goes wrong. Probably both, with different numbers.
- **What number, and grounded in what?** "What we measured today" is circular — a budget set to
  the current measurement can never fail. It should be grounded in what a user perceives, with
  the measurement establishing feasibility rather than the target.
- **Is a machine class part of the claim?** These numbers come from one container under unknown
  neighbour load. A budget that silently means "on my laptop" is only slightly better than one
  with no percentile.

---

**Next stage:** Design — run `/sdlc-spec 013-perf-budget` to turn this into `spec.md`.
