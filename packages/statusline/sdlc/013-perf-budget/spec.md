# Spec: a performance budget that can be failed

- **ID:** 013-perf-budget
- **Stage:** 2 — Design
- **Status:** draft
- **Derived from:** [`intent.md`](./intent.md)

## Summary

`SPEC.md §11.7`'s cache-hit target gains a percentile, a sample size, a measurement method and a
machine class, and a committed `bun run perf` measures it and exits non-zero on a breach. The
number moves, but only after establishing that the alternative — optimising startup — is not
available, and only to a figure grounded in perceived latency rather than in today's reading.

## The budget

| Scenario | Target | Measured today |
|---|---|---|
| Cache hit, **p50** | **< 50 ms** | 42.6 ms |
| Cache hit, **p95** | **< 100 ms** | 57.6 ms |

Both are stated as: *the compiled binary, spawn to exit, against a warm cache and closed stdin,
over ≥ 200 samples after 5 discarded warm-up runs, on a developer machine or CI container.*

### Why p50 stays at 50 ms

It is met with 15% to spare and it is the number the original spec most plausibly meant. Leaving
it untouched is what keeps this change from reading as "the budget now equals whatever we
measured."

### Why p95 is 100 ms and not 60

100 ms is the conventional threshold below which an interaction reads as instantaneous, and the
statusline renders once per prompt inside a tool the user is already waiting on. That is a
statement about the user, and it is the only kind of statement a budget can be — a target set
to the current measurement can never fail, which is how §11.7 got into this condition.

Measured p95 is 57.6 ms, so the budget carries ~1.7× headroom. That is deliberate: these numbers
come from one container under unknown neighbour load, p99 reached 92–100 ms in the same runs, and
a budget that trips on a noisy neighbour teaches everyone to ignore it. A p95 budget set below
the observed p99 would do exactly that.

**This is a loosening, and it is worth being blunt about it.** 57.6 ms passes a 100 ms budget
that 57.6 ms was used to justify. The defence is not that the number is tight; it is that the
*floor* is not ours to move — four build configurations spread under 2 ms — and that the
alternative to a loose-but-checkable budget is the current unfalsifiable one.

### Why no machine class beyond "developer machine or CI container"

Anything narrower would need hardware this project cannot enumerate. The script prints the
measured distribution alongside its verdict, so a reader on different hardware sees the numbers
rather than only a pass.

## Behaviour: `bun run perf`

1. Seeds an isolated cache under a temp `CLAUDEWATCH_CACHE_DIR` with a fresh envelope, so the
   run is a cache hit and **the developer's real cache is never touched or overwritten**.
2. Spawns `packages/statusline/dist/claudewatch` with stdin closed, 5 warm-up then N timed runs
   (`--samples`, default 200), timing spawn→exit with `Bun.nanoseconds()`.
3. Prints p50/p90/p95/p99/max and a verdict line per budget.
4. Exits **0** if every budget holds, **1** on a breach, **2** if it cannot measure at all —
   binary missing, cache seed failed. A missing binary must not read as a pass.

`--json` emits the distribution for a future caller; nothing consumes it yet, and it exists
because the alternative when something does is re-parsing human output.

### Deliberately NOT in `bun run verify`

Stated in the spec rather than left as an unremarked omission. ~200 spawns is ~9 s against a
5.5 s gate, immediately after loop 011 cut that gate tenfold; and a perf assertion on a shared
runner is a flaky gate, which costs more trust than it buys. The cost of this decision is that
the budget is only checked when someone runs it — recorded in `REVIEW.md` as a step the Deploy
stage runs for changes touching the statusline's startup path.

## Data and types

No product types change. `packages/core` is untouched. The script is a standalone
`scripts/perf.ts`, matching `scripts/verify.ts`.

`CLAUDEWATCH_CACHE_DIR` already exists (`setCacheBaseDir`, used by the test helpers), so the
isolation needs no new mechanism.

## Edge cases

| Case | Expected behaviour |
|---|---|
| `dist/claudewatch` missing | Exit **2** with a message naming the build command. Never a pass. |
| Binary exits non-zero during measurement | Exit 2. A binary that fails is not a binary that is fast — timing its failure path would be meaningless. |
| `--samples` below 30 | Refused, exit 2. A p95 over 20 samples is the maximum wearing a percentile's clothes — the same small-sample artifact `sdlc/012` found in the anomaly detector. |
| Budget met at p50, breached at p95 | Exit 1, both lines printed. |
| Run on a loaded machine | May breach and exit 1. Correct: the script reports what it measured. The headroom is what keeps this rare. |
| Real cache present | Untouched. The temp dir is created with `mkdtempSync` and removed afterwards. |

## Acceptance criteria

- [ ] `SPEC.md §11.7` states percentile, sample size, method and machine class for the cache-hit target — and says the other two rows are unmeasured rather than implying they are checked
- [ ] `bun run perf` exits 0 on the current binary, printing the distribution
- [ ] It exits 2 with the binary absent — verified by pointing it at a missing path, not by reasoning
- [ ] It exits 2 for `--samples 10`
- [ ] It exits 1 against a deliberately impossible budget — verified by overriding the budget, so the failing path is exercised rather than assumed
- [ ] It leaves `~/.cache/claudewatch/usage.json` byte-identical — asserted, since the obvious implementation clobbers it
- [ ] `sdlc/005`'s open criterion is resolved in its own `review.md`, not silently dropped
- [ ] PR #16's body no longer asserts the stale 51 ms framing
- [ ] `bun run verify` exits 0

## Rejected alternatives

- **Adopt `--bytecode`.** 1.2 ms at p50, nothing at p95. Changing how the shipped artifact is
  produced on that evidence is the unjustified move this loop exists to stop.
- **Set p95 to 60 ms, just above measurement.** Guarantees a red run on any loaded machine, and
  grounds the number in an artifact of today's container rather than in anything a user feels.
- **Leave the budget and mark loop 005's criterion "won't fix".** Leaves an unfalsifiable claim
  in `SPEC.md`, which is the actual defect.
- **Put it in `verify`.** Covered above; the gate cost and flakiness both fail.
- **A persistent daemon to beat the startup floor.** The only thing that would work, and wildly
  disproportionate to 15 ms on an imperceptible operation.

---

**Next stage:** Build — run `/sdlc-plan 013-perf-budget`.
