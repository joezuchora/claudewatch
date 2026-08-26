# Plan: a performance budget that can be failed

- **ID:** 013-perf-budget
- **Stage:** 3 — Build
- **Status:** draft
- **Derived from:** [`spec.md`](./spec.md)
- **Branch:** `claude/ai-sdlc-setup-plan-nqyqbk`

## Approach

One new script and its tests, three `SPEC.md` amendments, and four small corrections to records
that cite the number being changed. No product code changes: `packages/core`,
`packages/statusline` and `packages/vscode` are untouched apart from two comments in
`telemetry.ts` whose stated rationale rests on the old figure.

The script's hard part is not timing — it is *not measuring the wrong thing*. Three of the
spec's blocking findings were about the measurement silently degrading into something else: a
fetch loop against real credentials, an empty spool, a p95 over 40 samples. Each gets a
mechanical guard rather than a comment.

## Scope fence

```
scripts/perf.ts
scripts/perf.test.ts
scripts/verify.ts
package.json
SPEC.md
REVIEW.md
packages/core/src/telemetry.ts
packages/metrics/src/anomaly.ts
sdlc/005-statusline-tty-stdin/review.md
sdlc/013-perf-budget/spec.md
sdlc/013-perf-budget/plan.md
sdlc/013-perf-budget/review.md
sdlc/README.md
```

## Changes

### `scripts/perf.ts` — new
- `makeSandbox()`: temp `HOME` via `mkdtempSync` with a `0600` fixture credential and a fresh v2
  cache envelope. Deliberately the same shape as `packages/statusline/src/smoke.test.ts`'s
  helper rather than a new mechanism — the spec's first draft invented one that did not exist.
- `measure()`: 5 warm-ups then N timed spawns, `HOME` and `CLAUDEWATCH_TELEMETRY=0` pinned in the
  child env, stdin closed, each sample bounded at 5 s.
- Guards, each returning exit 2: missing binary, non-zero sample exit, sample timeout, and the
  **cache-hit assertion** — the seeded `usage.json` mtime must be unchanged, since every miss
  path calls `writeCache`.
- `evaluate()`: pure, exported. Takes the sorted samples and the budgets, returns the verdicts.
  Pure so the pass/fail logic is testable without spawning anything, which is what makes the
  `--samples 40` and impossible-budget criteria cheap to discharge.
- Percentile is imported from `@claudewatch/metrics`, not written a third time. **Amended in
  Stage 3:** that required adding one `export` keyword to `anomaly.ts`, so it joins the fence.
  `store.ts`'s duplicate copy is left alone — pre-existing, out of scope, recorded in `review.md`
  rather than silently absorbed.
- Flags: `--samples`, `--bin`, `--budget-p50`, `--budget-p95`, `--p50-only`, `--json`.

### `scripts/perf.test.ts` — new
Discharges every criterion the spec says must be exercised rather than reasoned about.

### `scripts/verify.ts`
- A fifth step, `perf`, running `perf --samples 40 --p50-only`. Placed **after** `build`, since
  it needs the binary the build step produces — the one ordering constraint in the gate.

### `package.json`
- `"perf": "bun run scripts/perf.ts"`.

### `SPEC.md`
- §11.7: the cache-hit row gains percentile, sample size, method, telemetry state, measured
  interval and machine class; the other two rows are marked **unmeasured**; a note records the
  rich-path measurement and the spawn→exit redefinition.
- §14 and §15.4: stop restating a number, point at §11.7.

### `REVIEW.md`
- A step requiring `bun run perf` output in `review.md` for changes touching the statusline's
  startup path, `cache.ts`, or the build flags. Without this the full p95 run is enforced by
  memory, which is the state this loop objects to.

### `packages/core/src/telemetry.ts`
- The header and `MAX_SPOOL_BYTES` comments re-grounded on the p50 budget and the architectural
  principle. Comments only — this is a `SPEC.md` §12 trust-boundary rationale citing a number
  this change moves, and a stale security argument is worse than none.

### `sdlc/005-statusline-tty-stdin/review.md`
- Its criterion recorded **withdrawn and superseded**, not met.

### `sdlc/README.md`
- The retrospective entry.

## Tests

| Spec criterion | Test | File |
|---|---|---|
| Exits 0 on a freshly built binary | `a real run against the built binary exits 0` | `perf.test.ts` |
| Exits 2 for a missing binary | `a missing binary exits 2, never 0` | `perf.test.ts` |
| Exits 2 for `--samples 10` | `--samples below the floor is refused` | `perf.test.ts` |
| p50 only for `--samples 40` | `40 samples evaluates p50 and declines p95` | `perf.test.ts` |
| Exits 1 on an impossible budget | `an impossible p50 budget exits 1` | `perf.test.ts` |
| Zero network; real `HOME` untouched | `the run reads neither the real cache nor the real credentials` | `perf.test.ts` |
| `--json` carries all five percentiles | `--json emits valid JSON with every percentile` | `perf.test.ts` |
| `verify` still exits 0, cost measured | the gate; cost recorded in `review.md` | — |

`evaluate()` being pure means the budget-verdict cases cost nothing; only three tests spawn.

## Verification

```
bun run --filter @claudewatch/statusline build
bun run perf                    # full n=200, output recorded in review.md
bun test scripts/perf.test.ts
bun run verify
```

## Risks

- **The gate grows ~30%.** Stated in the spec, measured here. If it lands worse than ~2 s the
  right response is fewer samples, not dropping the check.
- **A loaded CI runner reddens the p50 gate.** 41–43 ms against 50 is 17% of headroom, which is
  the tightest thing this loop adds. If CI proves marginal, the honest fix is a CI-specific
  sample count or budget, recorded — not quietly widening the number the whole loop exists to
  make meaningful.
- **The cache-hit assertion is the load-bearing guard.** If mtime granularity ever hides a
  rewrite, the script would silently measure the fetch path. Tested by deleting the seed and
  asserting exit 2.
- **Ordering in `verify`.** `perf` after `build` is required; a future reordering breaks it in a
  way typecheck cannot see. Called out in the step's own comment.

---

**Next stage:** Build/Test — implement, then `/sdlc-review 013-perf-budget`.
