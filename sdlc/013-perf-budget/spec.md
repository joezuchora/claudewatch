# Spec: a performance budget that can be failed

- **ID:** 013-perf-budget
- **Stage:** 2 — Design
- **Status:** revised after review
- **Derived from:** [`intent.md`](./intent.md)

## What the review changed

Six blocking findings. The first draft proposed a p95 budget of 100 ms grounded in "100 ms
feels instantaneous", isolated the run with an env var that does not exist, and excluded the
check from the gate on grounds its own headroom argument contradicted. What survived is the
diagnosis; almost none of the design did.

| # | Finding | What changed |
|---|---|---|
| B1 | `CLAUDEWATCH_CACHE_DIR` does not exist — `setCacheBaseDir` is in-process, and the perf script spawns a *separate* binary. Building it would have meant changing `packages/core` and adding a user-facing cache-relocation switch, which the same spec said it would not do. | Temp `HOME` sandbox, reusing `smoke.test.ts`'s `makeSandbox()` shape. No core change. |
| B2 | `SPEC.md` restates 50 ms in **three** places (§11.7, §14, §15.4), each with a *different* measurement definition. Amending only §11.7 leaves the spec contradicting itself. | All three amended; §14 and §15.4 point at §11.7 rather than restating numbers. |
| B3 | "Telemetry is not the cause" inferred from p50 while every tail bucket is monotonically worse. | Restated: not the *binding constraint*. See `intent.md`'s correction. |
| B4 | The method omitted telemetry state and spool size — the one variable loop 005's criterion pinned. And the spool lives *under* the cache dir, so isolating it silently guarantees an empty spool and measures the best case. | Telemetry state is pinned in the spawn env and named in the budget. |
| B5 | If the cache seed ever fails, `main()` falls through to `resolveCredentials()` and the script performs ~200 authenticated API calls against the user's real token — then reports a pass, because sample 1 writes a valid envelope and samples 2..200 look normal. | Sandbox `HOME` with a fixture credential, plus an asserted cache-hit check and a zero-network criterion. |
| B6 | Two acceptance criteria required a binary-path override and a budget override that the interface did not define. | `--bin` and `--budget-p50/--budget-p95` specified, discharged by committed tests. |

## The measurements

All interleaved, so drift hits each arm equally. Interleaving licenses the *differences*; the
absolute numbers still carry the container's noise, which matters below.

**Telemetry**, n=200 each:

| | p50 | p90 | p95 | p99 |
|---|---|---|---|---|
| off | 42.6 | 48.3 | 57.6 | 92.4 |
| on, 4 MB spool | 42.6 | 54.3 | 59.0 | 100.0 |

Free at p50; 1.4–7.6 ms in the tail. Not the binding constraint, not free.

**Build configuration**, n=120 each:

| build | p50 | p90 | p95 |
|---|---|---|---|
| baseline (`--compile`) | 42.7 | 52.6 | 57.2 |
| `--minify` | 42.7 | 53.8 | 57.7 |
| `--bytecode` | 41.5 | 48.1 | 56.9 |
| `--minify --bytecode` | 41.6 | 50.7 | 55.5 |

Stated correctly this time: **no build-flag difference is resolvable at p95 with n=120.** At
this density the standard error on a single p95 estimate is roughly ±3.5 ms, so a 2 ms spread is
the absence of a measurement, not a measurement of similarity. The effect that *is* resolvable
is ~1.2 ms at p50 for `--bytecode`, consistent across both bytecode arms — and not worth
changing how the shipped artifact is produced.

**Render path**, n=200 each, in an isolated `HOME`, both paths verified to produce their real
output first:

| path | p50 | p90 | p95 | p99 |
|---|---|---|---|---|
| plain (stdin closed) | 41.4 | 49.5 | 55.3 | 63.6 |
| rich (session JSON piped) | 41.7 | 51.0 | 55.0 | 79.9 |

This is the measurement that settles the diagnosis. The rich path — three lines, progress bars,
ANSI, and the path Claude Code actually invokes — does strictly more work for **0.3 ms at p50
and nothing at p95**. A cost structure where doing more work is free is a cost structure
dominated by something else, and that something else is process startup.

**Between sessions:** loop 005 measured cache-hit p95 at **48 ms**; today the same quantity on
the same claimed machine class reads **55–58 ms**. A ~20% shift between sessions, larger than
any effect measured within one.

## The budget

| Scenario | Target | Measured |
|---|---|---|
| Cache hit, **p50** | **< 50 ms** | 41.4–42.7 ms |
| Cache hit, **p95** | **< 100 ms** | 55.0–59.0 ms |

Stated as: *the compiled binary, parent-observed **spawn to exit**, `HOME` isolated to a temp
sandbox holding a fixture credential and a fresh v2 cache envelope, `CLAUDEWATCH_TELEMETRY=0`
pinned in the spawn environment, stdin closed, ≥ 200 samples after 5 discarded warm-ups, on a
developer machine or CI container.*

### p50 is the tripwire. p95 is a regression detector. They are different instruments.

p50 stays at 50 ms and is met at 41–43. A 17% regression trips it. It is the live check.

p95 at 100 ms is **not a perception claim**, and the first draft's "100 ms feels instantaneous"
argument is withdrawn — that threshold describes latency between a user's own action and visible
feedback, and the statusline renders inside an operation the user is already blocked on for
seconds. As `intent.md` says plainly: nobody is experiencing a slow statusline. There is no
perceptible latency here to budget against, so a perception-derived number would be decoration
wearing a justification.

100 ms is set as a **regression tripwire**, from the between-session variance above: p95 moves
~10 ms between sessions on this machine class, so any threshold within ~2× of a reading is a
coin flip. At 100 ms a red run means startup roughly doubled — a real change — rather than a
noisy neighbour. That is the only defensible way to set a tail number here, and it is honest
that it is loose.

**Being explicit, because the review was right to press:** a p95 budget this loose will
essentially never fire before p50 does. It is not a second tripwire; it is a documented ceiling
that makes the tail's absence-of-a-claim into a claim. If a tighter tail check is ever wanted,
the right shape is a regression rule against a committed baseline — which
`packages/metrics/src/anomaly.ts` already implements for `verify` — not a fixed threshold.

### Loop 005's criterion is **withdrawn**, not met

`sdlc/005` recorded "Cache-hit p95 < 50 ms with telemetry enabled and a 4 MB spool present" as
NOT MET at 51 ms. This change does not make the binary faster. It replaces that criterion with
one the same binary passes. The record must say **withdrawn and superseded**, in
`sdlc/005/review.md` and in the `SPEC.md` amendment, because "resolved" would read as "fixed".

### The measured interval is redefined, and that is an amendment

§11.7 says "binary start → stdout"; §15.4 says "binary startup + cache-hit response"; this spec
measures parent-observed spawn→exit, which includes fork/exec and teardown that neither phrasing
covers. Spawn→exit is the right choice — it is what the caller waits for and the only interval
an external script can observe — but silently changing what is measured, in a document whose
purpose is that two people reach the same verdict, would be the original defect one level up.
Stated as an explicit amendment.

## Behaviour: `bun run perf`

1. Creates a temp `HOME` via `mkdtempSync` holding a fixture credential (`0600`) and a fresh v2
   cache envelope, reusing the shape of `smoke.test.ts`'s `makeSandbox()`. The developer's real
   `HOME`, cache and credentials are never read or written.
2. Spawns `dist/claudewatch` with `HOME` and `CLAUDEWATCH_TELEMETRY=0` pinned, stdin closed;
   5 warm-ups then N timed runs (`--samples`, default 200), timed with `Bun.nanoseconds()`.
3. **Asserts the run was a cache hit**: the seeded `usage.json` mtime is unchanged afterwards,
   since every miss path calls `writeCache`. A measurement that silently became a fetch loop is
   not a slow measurement, it is a wrong one.
4. Prints p50/p90/p95/p99/max and one verdict line per budget.
5. Exits **0** if every evaluated budget holds, **1** on a breach, **2** if it could not measure
   — binary missing, seed failed, a sample timed out, a sample exited non-zero, or the cache-hit
   assertion failed. A missing binary must never read as a pass.

Flags: `--samples N`, `--bin PATH`, `--budget-p50 MS`, `--budget-p95 MS`, `--json`. The last four
are diagnostic affordances that exist so the failure paths can be exercised by committed tests
rather than by reasoning about them.

Every sample is bounded by a 5 s per-sample timeout and the whole run by a wall bound. `sdlc/004`
and `sdlc/005` were both statusline hangs, and `scripts/verify.ts` — the file this one mirrors —
gives every step a ceiling so "a hang is RECORDED rather than hanging the terminal forever". A
perf script for the startup path is precisely where a hang appears.

### Enforcement: p50 in the gate, p95 by hand

The first draft excluded the whole thing from `verify` because "a perf assertion on a shared
runner is a flaky gate" — while simultaneously arguing the budget was loose enough not to be
flaky. Both cannot be true, and the practical result was a budget enforced by memory, which is
the state this loop objects to.

Resolved: **`verify` runs `perf --samples 40`**. Forty samples supports a p50 comfortably and a
p95 not at all, so `evaluate` declines the tail verdict itself and prints that it declined — no
suppression flag, because a gate that says `p95: not evaluated (n<200)` is more honest than one
that silently omits the line. The full n≥200 run stays manual and its output is recorded in
`review.md` for changes touching the startup path.

**Cost, corrected in Stage 5.** This spec estimated ~1.7 s and ~30%. Measured: the gate went
5.5 s → 10.1 s, **+84%**. The estimate was not merely low, it was computed wrongly — it counted
only the new `verify` step (1.9 s, which the estimate got right) and omitted
`scripts/perf.test.ts`'s own cost inside `bun test`, where seventeen of its tests spawn the
script as a subprocess. Both the number and the accounting method were wrong, and the
plan-to-diff audit is what caught it. The precedent is `smoke.test.ts`, which already spawns the binary seven times inside
`bun test` under the header "If this file is slow, fix it. **Do not skip it.**" — written after
three defects reached the repo because no gated check ran the shipped artifact.

## Data and types

No product types change; `packages/core` is untouched. `scripts/perf.ts` alongside
`scripts/verify.ts`, with `scripts/perf.test.ts` beside it.

Percentile is **nearest-rank**, `sorted[floor(q · n)]`, imported from the existing implementation
rather than written a third time — `CLAUDE.md` says reuse before adding, and two copies already
exist (`packages/metrics/src/anomaly.ts`, `packages/metrics/src/store.ts`).

`packages/core/src/telemetry.ts`'s header and `MAX_SPOOL_BYTES` both justify the no-socket design
by citing §11.7's 50 ms budget and "~10-25ms of headroom". That is a **`SPEC.md` §12 trust
boundary** resting on a number this change moves. Both comments are re-grounded on the p50 budget
and on the architectural principle — local spool, no destination — rather than on tail-headroom
arithmetic that no longer closes.

## Edge cases

| Case | Expected behaviour |
|---|---|
| `dist/claudewatch` missing | Exit **2**, naming the build command. Never a pass. |
| A sample exits non-zero | Exit 2. A binary that fails is not a binary that is fast. |
| A sample exceeds the 5 s per-sample timeout | Exit 2, naming the sample index. |
| Cache-hit assertion fails (seeded `usage.json` mtime moved) | Exit 2. Silently measuring the fetch path is the failure B5 describes. |
| `--samples` < 30 | Refused, exit 2. |
| 30 ≤ `--samples` < 200 | Runs, evaluates **p50 only**; prints `p95: not evaluated (n<200)`. A p95 over 40 samples is the 38th order statistic wearing a percentile's name — the artifact `sdlc/012` found in the anomaly detector. |
| Budget met at p50, breached at p95 | Exit 1, both lines printed. |
| Loaded machine | May breach and exit 1. The script reports what it measured; the 2× headroom is what keeps this rare. |
| Real `HOME` cache present | Untouched — never read, never written. Asserted. |

## Acceptance criteria

- [ ] `SPEC.md` §11.7, §14 and §15.4 are all amended; §14 and §15.4 point at §11.7 rather than restating a number
- [ ] §11.7 states percentile, sample size, method, telemetry state, measured interval and machine class; and marks the cache-miss and HTTP-timeout rows **unmeasured** rather than implying they are checked
- [ ] `bun run perf` exits 0 on a freshly built binary, printing the distribution
- [ ] Exits 2 for a missing binary — via `--bin`, in a committed test
- [ ] Exits 2 for `--samples 10`; evaluates p50 only for `--samples 40`
- [ ] Exits 1 against an impossible budget — via `--budget-p50`, in a committed test, so the failing path is exercised
- [ ] **Makes zero network requests** and leaves the real `~/.cache/claudewatch/` and `~/.claude/` untouched — asserted, since the obvious implementation reads both
- [ ] `--json` emits valid JSON carrying all five percentiles and the sample count — asserted
- [ ] `verify` runs the p50 check and still exits 0; its added cost is measured and recorded
- [ ] `REVIEW.md` gains a step requiring `bun run perf` output in `review.md` for changes touching `packages/statusline/src/main.ts` startup, `packages/core/src/cache.ts`, or the build flags
- [ ] `telemetry.ts`'s two budget-citing comments are re-grounded
- [ ] `sdlc/005/review.md` records its criterion **withdrawn and superseded**, not met
- [ ] PR #16's corrected wording is quoted in `013/review.md`, so the correction survives the PR
- [ ] `bun run verify` exits 0

## Rejected alternatives

- **Adopt `--bytecode`.** ~1.2 ms at p50, nothing resolvable at p95. Not worth changing the shipped artifact.
- **p95 at 60 ms, just above measurement.** Guarantees red runs on any loaded machine; grounds the number in one container's artifact. The 48 → 57.6 between-session shift is the direct evidence against it.
- **Leave the budget and mark loop 005 "won't fix".** Leaves an unfalsifiable claim in `SPEC.md`, which is the actual defect.
- **Keep the whole check out of `verify`.** The first draft's position; it left the budget enforced by memory and rested on an argument its own headroom section contradicted.
- **Add a rich-path budget row.** Measured at 41.7/55.0 against plain's 41.4/55.3 — indistinguishable, so a second row would assert a difference the data denies. The measurement is recorded in §11.7's note instead, since "the rich path is not slower" is worth knowing.
- **A persistent daemon.** The only architecture that beats the startup floor, and wildly disproportionate to a tail on an imperceptible operation.

---

**Next stage:** Build — run `/sdlc-plan 013-perf-budget`.
