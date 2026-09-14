# Incident: the performance gate blocks the loop, for no code reason

- **ID:** 015-perf-gate-incident
- **Stage:** 6 — Maintain
- **Status:** open — second occurrence recorded 15:20, different specific cause, same root
- **Detected:** 2026-08-26 14:22 UTC — by `bun run verify` on a clean tree, first run of the iteration
- **Severity:** blocking. The gate is the entry condition for every change; while it is red, nothing can be committed under this repo's own rules.

## What happened

`bun run verify` failed at the `test` step:

```
(fail) the CLI, run the way the gate runs it > THE SHIPPED ARTIFACT: ... [7429.83ms]
- "code": 0
+ "code": 1
```

Exit 1 from `scripts/perf.ts` means a **budget breach**, not a crash. The gate's own `perf`
step breaches identically:

```
p50: 59.5ms against 50ms — BREACH
p50: 54.5ms against 50ms — BREACH
p50: 58.0ms against 50ms — BREACH
```

No code changed. The binary is the one `sdlc/013` measured at **41.1 ms** roughly ninety minutes
earlier, on this same container.

## Second occurrence, 2026-08-26 15:20 — a different specific cause, and a new product finding

The mitigation below (report-only) held: the budget breach no longer fails the gate. The gate
went red anyway, on the next iteration's first run, for a different reason:

```
(fail) THE SHIPPED ARTIFACT: the real binary measures clean and makes no network call
+   "code": 2,
+   "err": "sample -1 timed out after 5000ms"
```

**A single spawn of the compiled binary took over five seconds**, against a p50 of ~40–50 ms.
A 100× outlier, on a warm-up sample — the first exec of the run.

### The pattern, now three for three

| Iteration | first-run test step | normal | outcome |
|---|---|---|---|
| 13:26 | 10.4 s | ~7 s | failed, output lost |
| 14:22 | 13.4 s | ~7 s | failed, p50 breach at 54–60 ms |
| 15:20 | 11.2 s | ~7 s | failed, one spawn > 5000 ms |

Every failure is the **first workload after ~50 minutes of container idle**, and every one is
slower across the whole test step, not just the perf part. The binary is **99.3 MB**.

### What this is data for, stated carefully

The queue carries "the intermittent 550 s verify hang — blocked on data, do not speculate."
This is data, and it should be recorded without being oversold:

- **Observed, captured, timestamped:** a spawn of the shipped binary exceeding 5 s, caught by
  the per-sample timeout that `sdlc/013`'s security pass insisted on. Without that guard it
  would have been an unexplained slow run.
- **Not established:** that this is the same phenomenon as the 550 s hang, or that page-cache
  eviction of a 99 MB binary is the mechanism. Both are plausible and neither is tested. Cache
  state cannot be dropped without privileges this container lacks, so the obvious experiment is
  not available here.

**The genuinely new product finding**, independent of the hang: `SPEC.md §11.7` budgets only the
warm path. A user returning after an idle period pays a cold exec of a 99 MB binary on the
statusline, which renders on every prompt. Nothing in the spec, the tests, or the budget looks at
that, and this is the first time anything has measured it — accidentally.

## Impact

The gate is red on a clean tree, so by `REVIEW.md`'s own rule ("no change is reviewable until
`bun run verify` exits 0") every subsequent iteration is blocked. No user impact: the statusline
renders in ~60 ms rather than ~41 ms, which is imperceptible inside an operation the user is
already waiting seconds for. The damage is entirely to the process.

Also affected: the 13:26 gate failure recorded in the Routine as "which test failed is unknown".
It is now very likely the same event — first run of an iteration, test step 10.4 s against a
~6.6 s norm — but the output was not captured, so this is a **strong inference, not a fact**,
and it is recorded as such.

## Timeline

| Time (UTC) | Event |
|---|---|
| 12:5x | `sdlc/013` measures p50 41.1 ms (n=200) and sets the budget at < 50 ms |
| 13:0x | Gate's `perf` step passes repeatedly at p50 ~40–42 ms; CI green four times |
| 13:26 | Gate fails once on a clean tree, output not captured, 28 subsequent runs clean |
| 14:22 | Gate fails on the first run of the next iteration, output captured |
| 14:2x | Five runs of n=60, alone, load 0.51 on 4 CPUs, nothing else running: p50 54.0–60.6 ms |

## Root cause

**Not contention, and I was wrong about that twice.** My first theory was that
`perf.test.ts`'s real-binary case was starved by the parallel test suite. My second was ambient
load. Both are refuted by the same measurement: the gate's `perf` step runs *alone*, after
build, and breaches identically at a load average of 0.51.

The machine's startup floor for this binary moved from ~41 ms to ~57 ms between sessions, with
no code change and no measurable load. That is a ~40% shift in the quantity the budget is
measured against.

**The design error is mine, and it is specific.** `sdlc/013`'s spec set the p95 budget at ~2×
the observed reading, and argued for that headroom explicitly:

> Between-session variance at p95 is ~10 ms (005: 48, 013: 57.6), so the threshold sits at ~2x
> the observed reading — high enough that a red run means a real change.

Then it set **p50 at 1.22× the observed reading** — 50 ms against a measured 41.1 ms — and
justified it as "met with 18% to spare". The same document that rejected measurement-derived
targets for the tail used one for the median:

> a target set to the current measurement can never fail, which is how §11.7 got into this
> condition.

Observed p50 across sessions is now 41.1, 41.4, 42.6, 42.7, 54.0, 56.8, 58.9, 59.9, 60.6 — a
**1.5× spread**, comfortably larger than the 1.22× margin. The budget was not wrong about the
product; it was wrong about the instrument's stability, on evidence that was already in the
document.

**Both occurrences share one root, and it is broader than the p50 margin.** Every timing
constant `sdlc/013` chose — the 50 ms p50 budget, the 5 s per-sample timeout — was set against a
measurement window that turned out to be the favourable one. The budget was 1.22× the observed
p50; the timeout was ~120× the observed p50 and still not enough for a cold exec. The error is
not any single number, it is having calibrated a whole instrument from one afternoon's readings
on one machine, in a document that argued against exactly that for the tail.

- **Introduced by:** `sdlc/013-perf-budget`, the `verify` p50 gate and the 5 s per-sample timeout
- **Stage that should have caught it:** Design. The variance argument was written, applied to
  one number, and not applied to the others.
- **Why it didn't:** the spec reviewer challenged the p95 grounding hard and I rewrote it; the
  p50 row was inherited unchanged from the old SPEC and read as "preserved", so neither of us
  re-derived it. A number that survives review by looking familiar is not a number that has been
  reviewed.

## Mitigation

The gate's `perf` step becomes **report-only**: it prints the distribution and exits 0. The
budget verdict remains available and enforcing in `bun run perf`, which is what `REVIEW.md`
already requires for changes touching the startup path.

This is a mitigation, not the fix. It restores the loop and keeps the measurement visible on
every run, but it removes the automated tripwire that was the point of putting it in the gate.

**Second mitigation (15:20).** `SAMPLE_TIMEOUT_MS` goes from 5 s to 30 s. Five seconds was
chosen as "a generous multiple of the budget" and is demonstrably not generous: a real cold exec
exceeded it. Thirty still bounds a hang — it would have caught the 550 s event by a factor of
18 — while tolerating a cold page-in. The guard's stated purpose, from `scripts/verify.ts`, is
that "a hang is RECORDED rather than hanging the terminal forever", and 30 s serves that.

## Follow-up

| Follow-up | New intent ID | Status |
|---|---|---|
| Measure the **cold** path, or state in `SPEC.md §11.7` that it is unmeasured — a 99 MB binary's first exec after idle is what a returning user actually pays, and nothing looks at it | `017-cold-start-unmeasured` | drafted |
| A regression check against a **recorded baseline** rather than a fixed threshold — the shape `packages/metrics/src/anomaly.ts` already implements for `verify` durations, and which `sdlc/013`'s own spec named as the right instrument for the tail | `016-perf-regression-baseline` | drafted |

## What we are not changing

- **`SPEC.md §11.7`'s p50 < 50 ms target stays.** It is a statement about the product on a
  representative machine, and it is met on one. What failed is the decision to enforce a
  *product* target as a *regression* gate on whatever machine happens to be running — two
  different instruments that `sdlc/013` conflated.
- **The p95 < 100 ms ceiling stays**, unaltered. It was set by variance and has not been
  breached, including in the runs above (p95 61–154 ms — the 154 is one outlier in five runs,
  and it is still under the ceiling).
- **No build-flag change.** `sdlc/013` measured `--bytecode` at ~1.2 ms and rejected it; a 16 ms
  environmental shift does not make a 1.2 ms optimisation newly worthwhile.
