# Plan: validate `lastErrorMessage` where it enters

- **ID:** 030-cache-read-validation
- **Stage:** 3 — Build (planning half)
- **Status:** draft
- **Date:** 2026-08-28

Reads `spec.md` as revised after the Stage 2 review (three BLOCKING, eight MAJOR, all folded in).
Implements B1–B4 against A1–A10.

## Scope fence

Nine paths — counted against the table, not asserted. Loop 028 said "nine" over eleven rows and
loop 029 said "eight" over nine; both were caught by the same auditor. This says **nine** and the
table below has **nine** rows.

| Path | Change | Criterion |
|---|---|---|
| `packages/core/src/cache.ts` | B1's validation branch; the "Two fields" comment → three; `makeCacheEnvelope`'s param narrowed | B1, B2, A5 |
| `packages/core/src/types.ts` | `CacheEnvelope.lastErrorMessage` narrowed; `:145`'s inaccurate claim corrected | B2, A5 |
| `packages/core/src/cooldown.ts` | `enterCooldown`'s `errorMessage` param narrowed | B2 |
| `packages/core/src/format.ts` | `LastErrorInfo.message` narrowed | B2 |
| `packages/core/src/security.test.ts` | B1's test (free text off disk is nulled) | A1, A2 |
| `packages/statusline/src/smoke.test.ts` | the `--debug` end-to-end case | A4 |
| `SPEC.md` | §12's "cache-read boundary" claim becomes true | A5 |
| `sdlc/029-surfaced-error-guard/review.md` | all nine "What is NOT done" bullets marked | A9 |
| `packages/core/src/typefixtures/` + `exhaustive-guard.test.ts` | **conditional** — see below | A3 |

**Explicitly not touched:** `packages/metrics`, `packages/vscode/src` (all of it), `snapshot.ts`,
`client.ts`, `normalize.ts`, `main.ts` (B1 makes the `--debug` sites correct **without editing
them** — that is the whole thesis), `scripts/`, `.oxlintrc.json`, `CLAUDE.md`.

**On the conditional row:** `spec.md` A3 offers a typefixture as the stronger alternative to a grep.
The plan takes the grep as primary (it is what A3 now specifies) and adds the fixture **only if the
grep proves weak in practice**. If the fixture lands, `exhaustive-guard.test.ts`'s count assertion
must go 5 → 6 — loop 029 hit exactly that and declared it late. Declared here, in advance.

## Steps

**Two commits. B1 and B2 are ONE commit — A10 requires it.**

The spec's Risks section explains why in concrete terms: B2 alone changes zero runtime behaviour and
fails zero tests, but leaves `extractLastError`'s ternary redundant *by the declared type* while
still load-bearing *at runtime* — so a later cleanup deletes it and free text flows to `format.ts:405`.
Loop 029's plan left an ordering requirement as prose and it was not met; A10 makes this one checkable.

### Commit 1 — B1 + B2 together, with A5's comment corrections

`cache.ts`, after the `lastErrorClass` branch:

```ts
if (parsed.lastErrorMessage !== null && !isSurfaceableMessage(parsed.lastErrorMessage)) {
  parsed = { ...parsed, lastErrorMessage: null };
}
```

Import `isSurfaceableMessage` from `./client.js` — mirroring the existing
`import { isFailureClass } from './cooldown.js'`. No cycle: `client.ts` does not import `cache.ts`.

Narrowed in the same commit: `CacheEnvelope.lastErrorMessage`, `makeCacheEnvelope`'s param,
`enterCooldown`'s `errorMessage`, `LastErrorInfo.message`. Measured: **0** typecheck errors when all
four move together; **2** if the interface moves alone.

Comment corrections (A5): `cache.ts`'s "Two fields" → three, naming them and noting the two idioms;
`types.ts:145` and `SPEC.md §12` stop claiming the predicate already runs at the cache-read boundary
— B1 makes that sentence true rather than amending it.

`CACHE_VERSION` stays **2**.

### Commit 2 — the tests, and 029's gap list

`security.test.ts`: B1's own test. Writes a cache file with free text into a sandbox `HOME`, reads it
back through `readCacheResult`, asserts `lastErrorMessage === null` and `lastHttpStatus` survives.

`smoke.test.ts`: A4's end-to-end case, against the **compiled binary** with `seedSandboxHome`. Safe
by two independent mechanisms — the seed's credential is deliberately expired, and `--debug` without
`--refresh` returns at `main.ts:203-206` before `resolveCredentials` and before any fetch. The
existing file already imports `seedSandboxHome` and spawns the binary, so this is a new `test(...)`
in an established harness, not new machinery.

`sdlc/029/review.md`: all **nine** "What is NOT done" bullets marked `CLOSED by 030` / `OPEN` /
`DEFERRED — <reason>`.

## Test mapping

| Behaviour | Test | Criterion |
|---|---|---|
| B1 nulls free text off disk | `security.test.ts`, new case | A1, A2 |
| B1 keeps a valid member | same case, positive precondition | A1 |
| B1 preserves `lastHttpStatus` | same case | A1 |
| B1 covers `--debug` end to end | `smoke.test.ts`, new case | A4 |
| B2 narrows four types | `bun run typecheck` + A3's grep | A3 |
| B3's gate stays non-vacuous | loop 029's existing test, unchanged | A6 |

## Mutation table — predictions recorded BEFORE running

A8 requires **at least three rows for B1**; a one-row table cannot satisfy it.

| # | Mutation | Predicted |
|---|---|---|
| M1 | delete B1's `if` block entirely | **2** — `security.test.ts`'s new case and `smoke.test.ts`'s `--debug` case |
| M2 | invert the condition (`isSurfaceableMessage(...)` without `!`) | **2** — the same two; a valid member is nulled and free text survives |
| M3 | replace the predicate call with `true` (i.e. `!true` → never nulls) | **2** — identical to M1 in effect |
| M4 | delete `extractLastError`'s gate | **1** — loop 029's existing test, which constructs in memory. Verified by the Stage 2 reviewer under B1+B2 |
| M5 | widen `CacheEnvelope.lastErrorMessage` back to `string \| null` | **typecheck stays 0**, no test fails — this is the point of A3, and why the grep must work |
| M6 | seed the `--debug` case with a cache MISS instead of a hit | **1** — A4's `cacheAgeSec` precondition, which exists because `printDebug` omits the key entirely on a miss |

**M5 predicts no failure.** That is deliberate and is the finding, not an oversight: nothing but A3
catches a widening, which is exactly why A3's first draft — a grep that could not fail — was a
BLOCKING defect rather than a nit.

## Verification

1. `export CLAUDEWATCH_VERIFY_METRICS=1` first; `bun run verify` after each commit, redirected.
2. **A2's two halves in `review.md`** — branch removed, named test red; restored, green.
3. **A7 as a SORTED diff**: `oxlint 2>&1 | grep warning | sort` before and after, `diff` empty,
   `wc -l` = 11 both. oxlint's output order is nondeterministic across runs on an identical tree
   (measured at Stage 2), so an unsorted diff fails spuriously.
4. **A10**: `git log -p` shows `cache.ts`'s branch and `types.ts`'s narrowing in one diff.
5. **A9**: all nine bullets marked; an unmarked bullet fails it.
6. Stage 5: `plan-to-diff-auditor` then `security-reviewer`, sequentially, briefed on the range, told
   not to write into the tree.

## Risks carried into implementation

- **A4's seed override needs its own `as never`** once B2 narrows `Partial<CacheEnvelope>`. That is
  the **second** load-bearing `as never` in this loop; both look like smells and neither may be
  "tidied".
- **A4 can go green while proving nothing** if the seeded envelope is rejected as
  `versionMismatch`/`invalidShape`/`corruptJson` — hence the `cacheAgeSec` and `lastHttpStatus`
  preconditions in the same assertion.
- **A2 is the criterion most likely to ship as nothing.** It always is.
- **M5's green is easy to misread as success.** `review.md` must record it as the gap A3 exists for.

## Next stage

`/sdlc-implement`, commit 1 first.
