# Review findings: a performance budget that can be failed

- **ID:** 013-perf-budget
- **Stage:** 5 — Deploy
- **Reviewed against:** [`plan.md`](./plan.md) and [`/REVIEW.md`](../../REVIEW.md)
- **PR:** #16

## The measurement

```
$ bun run perf --samples 200
n=200  p50=41.1  p90=47.2  p95=52.3  p99=58.7  max=89.8
  p50: 41.1ms against 50ms — ok
  p95: 52.3ms against 100ms — ok
```

`SPEC.md §11.7` now states a percentile, a sample size, a method, the telemetry state, the
measured interval and a machine class, and `bun run verify` runs the p50 half. The budget can
be failed, which it could not before.

## What this loop did NOT do

Make the binary faster. Not one byte. `sdlc/005`'s criterion is recorded **withdrawn and
superseded** in its own `review.md`, in those words, because "we replaced the criterion" and
"we fixed the problem" are different claims.

## Plan-to-diff audit

Verdict: **excursions recorded**. Fence intact — eleven explicit paths, no globs, nothing
outside it. The findings were about what the tests proved, and they were serious.

| # | Finding | Resolution |
|---|---|---|
| A1 | **Four mutations survived the entire suite.** Deleting `HOME: home` from the child env, deleting `CLAUDEWATCH_TELEMETRY: '0'`, setting `WARMUP` to 0, and removing the per-sample timeout guard each left 15/15 green. The isolation test only proved perf did not *write* into the inherited HOME — which `mkdtempSync` makes true by construction — and an `exit 0` stub cannot reveal what environment it was handed. | **Fixed.** A recording stub now logs the `HOME` and `CLAUDEWATCH_TELEMETRY` it actually received, one line per invocation. All four mutations now fail. Asking the child is the difference between testing the claim and testing around it. |
| A2 | `sdlc/README.md` was in the fence and never touched, and still said the gate takes 5.5 s. | **Fixed.** |
| A3 | No committed test touched the real binary — I had deleted it as duplicate of the gate's own step, but the gate runs `--p50-only`, the one mode that does not exercise the full verdict path. | **Fixed twice over.** `--p50-only` is gone entirely (at n=40 `evaluate` declines p95 and *says so*, which is better than suppressing the line), and the real-binary test is restored at n=30. |
| A4 | The spec's zero-network criterion was asserted nowhere. | **Fixed by construction, and stated as such.** The sandbox credential would 401 immediately, so any run reaching the fetch path exits non-zero and is reported as exit 2. A clean exit 0 across 30 real-binary samples *is* the evidence no request left the machine. |
| A5 | The `~30%` gate-cost estimate was stale in three places. | **Fixed, and the accounting corrected** — see below. |
| A6 | `SPEC.md`'s HTTP-timeout row said "enforced in code", a stronger claim than anything measures. | **Fixed** to "unmeasured", with what *is* asserted named. |
| A7 | `REVIEW.md`'s mandatory-perf trigger list gained a fourth entry (`telemetry.ts`'s emit path) beyond the three approved. | **Kept**, recorded as a deliberate widening: telemetry writes on the measured path, so a change there is exactly when the full measurement is wanted. |
| A8 | `perf.ts` deep-imports `../packages/metrics/src/anomaly.js` rather than `@claudewatch/metrics` as planned. | **Prose corrected, code kept.** The root package declares no workspace dependency and the specifier does not resolve from `scripts/`. Adding one to satisfy a sentence would be the tail wagging the dog. |

### The gate cost, and a wrong estimate

The spec said ~1.7 s and ~30%. **Measured: 5.5 s → 10.1 s, +84%.**

The estimate was not just low, it was computed wrongly. It counted the new `verify` step — 1.9 s,
which it got right — and omitted `scripts/perf.test.ts`'s own cost inside `bun test`, where
seventeen tests spawn the script as a subprocess. I trimmed what duplication I could find
(1.5 s), and the rest is real. Recording the method error as well as the number, because the
number will be re-estimated one day and the method is what would repeat.

## Pass 1 — Bugs and logical errors

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | major | **CI red on `e9080dd`, and it was my test, not the budget.** The isolation test asserted the ambient HOME stayed *entirely* empty. `bun run` creates `$HOME/.bun` when `BUN_INSTALL` is not redirected — true on the runner, false here — so it passed locally and failed on CI. The assertion was a claim about bun, not about `perf.ts`. | **Fixed** and narrowed to the property meant: no `.claude`, no `.cache/claudewatch`. Verified it still has teeth by pointing `perf.ts` at the ambient HOME. |
| 2 | major | **`expect(childEnv(log)).toHaveLength(WARMUP + 30)` could not detect `WARMUP` changing** — the constant moves both sides of the assertion. Same tautology the audit caught in `expect(GENERAL_LIMIT).toBe(1000)` last loop. | **Fixed.** `WARMUP` is pinned to its literal separately, which is what makes the spec's "5 discarded warm-ups" a claim rather than a description. |
| 3 | major | **CI red again on `da35774`, and again it was ambient state making a test lie.** `THE SHIPPED ARTIFACT` failed in 14.86 ms — far too fast for 35 spawns. `verify` runs `test` **before** `build`, and `dist/` is gitignored, so on a fresh checkout the shipped artifact does not exist when that file runs. It passed locally only because a binary was sitting there from an earlier build. | **Fixed** — a `beforeAll` that builds if absent, exactly as `smoke.test.ts` does. Verified by deleting `dist/claudewatch` and re-running both the file and the whole gate. Note the shape: the *previous* CI failure was also ambient state (`$HOME/.bun` existing on the runner and not here). Two consecutive red runs, both from something present on one machine and not the other. |
| 4 | **major** | **A docs-only commit went red, and it was a real product defect.** `MetricsStore` set no SQLite busy timeout, so `PRAGMA journal_mode = WAL` failed instantly with `SQLITE_BUSY` whenever another connection held a lock. The shipped deployment is exactly that shape: `claudewatch-metrics.service` holds the database open continuously while the hourly loop ships into it and `metrics:detect` reads it — so `metrics:detect` would simply die at random on the NUC. Not a test flake; the test merely reproduced production. | **Fixed** — `PRAGMA busy_timeout` before any other pragma, with a regression test that reproduces the CI error exactly. |
| 5 | minor | **My first attempt at that regression test passed with the fix removed.** It created the database through `MetricsStore`, which already sets WAL — after which `PRAGMA journal_mode = WAL` is a no-op that never blocks. The test looked right and proved nothing. | **Fixed** by isolating the reproduction first, outside the suite: the database must be in the *default* journal mode **and** another process must hold a write lock. Both conditions are now in the test, with the reason, and mutation confirms it fails without the pragma. |
| 6 | minor | The `sleep 5` timeout stub left an orphan process the runner had to reap (`Terminate orphan process: pid (2588) (sleep)`). `Bun.spawnSync`'s timeout kills the shell, not the `sleep` it forked. | Fixed with `exec sleep 5`, so the shell is replaced and the timeout kills the real process. |
| 7 | minor | A lint **error** (unused `readdirSync`) reached a commit — `verify` catches it, but I pushed before re-running the full gate after that edit. | Fixed; three new warnings of mine fixed too, so the count is back to exactly 12, unchanged by this loop. |

### Mutation results, after the fixes

| Mutation | Caught by |
|---|---|
| drop `HOME` pinning | 3 tests |
| drop `USERPROFILE` pinning | 1 |
| drop `CLAUDEWATCH_TELEMETRY: '0'` | 1 |
| `WARMUP` 5 → 1 | 1 |
| drop the per-sample timeout guard | 1 |
| `perf.ts` uses the ambient HOME | 1 |
| `<= 50` → `< 50` at the budget boundary | 1 |

## Pass 2 — Security and vulnerabilities

Nine findings. Two **major**, and the first is the most serious thing this loop produced.

| # | Severity | Finding | Resolution |
|---|---|---|---|
| S1 | **major** | **The sandbox was enforced by `HOME` alone.** `os.homedir()` follows `HOME` on POSIX and **`USERPROFILE` on Windows** — a supported build target (`build:windows`, a Windows installer, Windows in the extension README). On a Windows machine `bun run verify` would have run the compiled binary 45× against the developer's **real** `.credentials.json` and **real** cache; and if that cache were absent or stale, sample 1 would be a live authenticated fetch with their real token followed by a real `writeCache`. The mtime guard would have checked an untouched *sandbox* file and reported **pass**. The exact failure the header comment claims to guard was the one that survived, on a platform I never ran. | **Fixed.** `USERPROFILE`, `HOMEDRIVE` and `HOMEPATH` are pinned alongside `HOME`, and tested. |
| S2 | major | **The cache-hit guard was negative and post-hoc.** It could only detect "the sandbox file was rewritten" — indistinguishable from "the child used a different HOME and never looked at the sandbox" — and it fired only *after* all N spawns, i.e. after up to 200 network attempts rather than before the first. `stdout: 'ignore'` discarded the one piece of evidence that would settle it. | **Fixed with a positive assertion.** Warm-up 0 runs with stdout piped and must contain a seeded sentinel percentage, *before* the timed loop. That proves the child read this cache, on every platform, and closes S1 independently. It also makes fixture drift loud: a future `CACHE_VERSION` bump breaks here instead of silently becoming N live fetches. |
| S3 | minor | `writeFileSync` then `chmodSync` leaves a `0644` window; the sandbox dirs were `0755` against the product's own `0700`. | **Fixed** — modes at creation, asserted in a test. |
| S4 | minor | `makeSandbox()` ran outside the `try`, so a throw after `mkdtempSync` leaked the directory; no signal handler, so Ctrl-C during a ~90 s run left one behind. | **Fixed** — sandbox created inside the `try`, `SIGINT`/`SIGTERM` handlers registered before it exists. |
| S5 | minor | The `rewriter` test stub is a live clobber payload whose safety rested entirely on `perf.ts` pinning HOME. If that regressed, it would overwrite the developer's real cache and still pass. | **Fixed** — the stub refuses to run outside a `cw-perf-*` sandbox, turning that regression into a loud exit 9. |
| S6 | informational | The seeded envelope is a hand-copied, already-drifted variant of `smoke.test.ts`'s. | **Not hoisted; mitigated.** `makeTestEnvelope` is `version: 1` and the cache requires 2, so it does not fit as-is. The sentinel probe makes drift fail loudly, which is what the finding was actually protecting against. Hoisting a shared seed is recorded as follow-up. |
| S7–S9 | informational | `--bin` as a new execute-from-argv surface (cleared: array-form spawn, no shell, operator's own privileges); the deep cross-package import (Pass 3 note); `as Record<string,string>` on `process.env` and test-only `JSON.parse` (neither crosses a trust boundary). | Recorded, no change. |

**The `telemetry.ts` re-grounding was reviewed and strengthens the argument.** It previously made
the security property a *consequence* of a 50 ms budget with "~10-25 ms of headroom". It now
leads with the architecture — a product with no destination has none to be redirected or
intercepted — with timing demoted to corroboration. That removes a dependency where widening the
budget would have silently dissolved a `SPEC.md §12` rationale.

Standing invariants re-checked and cleared: token never in logs, errors, debug output, argv or
the cache; committed fixtures self-evidently fake (`NOT-REAL`, asserted); TLS and endpoint
untouched (`client.ts` unmodified); no new network call; command execution array-form only.

## Pass 3 — Compliance

| # | Finding | Resolution |
|---|---|---|
| 1 | No product logic changed. `packages/core` is comment-only; `packages/metrics` gains one `export`. | Pass. |
| 2 | No `any`. | Pass. |
| 3 | Lint warnings back to 12, unchanged by this loop. | Pass. |
| 4 | The deep relative import crosses a package boundary — recorded (A8), not resolvable without a root workspace dependency. | Recorded. |

## Verification evidence

```
$ bun run verify
verify: pass in 10.1s  [typecheck 2.0s  lint 0.1s  test 5.9s  build 0.1s  perf 1.9s]
$ echo $?
0
```

- [x] `bun run verify` exits 0
- [x] CI green on the PR head commit — `929f7e2`, `verify` success in 19 s, after two red runs both caused by ambient state (Pass 1 #1 and #3)
- [x] Every acceptance criterion in `spec.md` is checked off, except those recorded below

## Findings deliberately not fixed

- **S6** — hoisting one shared cache-seed helper into `test-helpers.ts` so `smoke.test.ts` and
  `perf.ts` cannot drift apart. `makeTestEnvelope` is `version: 1` and the cache requires 2, so
  it does not fit without changing it. Its risk is mitigated by the sentinel probe.
- **The cache-miss and HTTP-timeout budgets remain unmeasured**, and §11.7 now says so rather
  than implying otherwise.
- **PR #16's body is stale** — it describes loops 001–006 and lists as unmet things loops
  007/008/013 have closed. Not corrected here; it is one edit and it belongs to whichever
  iteration next has room. Recorded so it is not mistaken for current.

## What this loop says about the loop

**Three CI failures this loop, and the third was the valuable one.** The first two were mine and
ambient (`$HOME/.bun` on the runner; a built binary here). The third went red on a **docs-only
commit** — code byte-identical to a green run — which is precisely what distinguishes a
load-dependent race from a regression, and it surfaced a genuine product defect: no SQLite busy
timeout, in a deployment where three processes share one database. CI found a NUC bug by being
slower and busier than my container.

**Two consecutive CI failures, both ambient state.** First `$HOME/.bun`, which exists on the
runner and not here; then a built binary, which existed here and not on a fresh checkout. Both
tests passed locally for reasons that had nothing to do with what they were testing. The gate
cannot catch this class on the machine that created the state — only a clean checkout can, which
is the argument for CI running the identical command rather than a weaker one, and the argument
against ever reading a local green as proof.

**I asserted a broader property than the one I meant, four times in one session.** Twice a *cap*
where the design gives a *floor* (`sdlc/012`), once an empty directory where the claim was "no
state of ours", once `WARMUP + n` against the constant that defines it. Every one failed
immediately and honestly — but the repetition is the finding, not the individual slips. The
common shape: I reach for the assertion that is easiest to write about the situation in front of
me, rather than the one that would fail if the code were wrong. Mutation testing is what caught
three of the four, and it should be the default for any guard whose absence would be silent.

**The Windows finding is the one worth carrying.** It was invisible to every test, every review
pass I ran myself, and the entire CI matrix — because CI is Linux and so am I. `os.homedir()`
reading a different variable on a platform I never execute is exactly the class of defect that
no amount of local care finds, and it would have run a user's real credentials through a
benchmark loop. It was found by a reviewer asking "is that claim true on every supported
platform?" — which is a question, not a technique.

---

**Next stage:** Maintain — nothing to do until production says otherwise.
