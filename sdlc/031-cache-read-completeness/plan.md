# Plan: finish the cache-read boundary

- **ID:** 031-cache-read-completeness
- **Stage:** 3 — Build (planning half)
- **Status:** draft
- **Date:** 2026-08-28

Reads `spec.md` as revised after the Stage 2 review (two BLOCKING, seven MAJOR, six MINOR, all
folded in). Implements B1–B3 against A1–A13.

**This file is the prediction record.** A2 and A5 require their values committed *before* any
implementation commit, checkable with `git log --oneline <this commit>..<impl>`. That is the
mechanism loop 030 used and this loop's draft spec dropped.

## Scope fence

**Twelve paths** — counted against the table below, which has twelve rows. Loop 028 said "nine" over
eleven, loop 029 "eight" over nine, loop 031's own spec said "seven" over a set of nine. The count
is written last, from the table.

| # | Path | Change | Criterion |
|---|---|---|---|
| 1 | `packages/core/src/closed-sets.ts` | **new leaf module** — `UNKNOWN_FETCHED_AT`, `NORMALIZATION_WARNINGS`, `STALE_REASONS`, `isStaleReason` | B1–B3 |
| 2 | `packages/core/src/cache.ts` | the four degradations; shape gate loses its `fetchedAt` clause; comments | B1, B2, B3 |
| 3 | `packages/core/src/normalize.ts` | sources its nine warning strings from row 1 | B3 |
| 4 | `packages/core/src/types.ts` | `fetchedAt`'s comment names the sentinel | A8 |
| 5 | `packages/core/src/client.ts` | `isSurfaceableMessage`'s docstring moved above the function; count seven → eight | A9 |
| 6 | `packages/core/src/snapshot.ts` | docstring says where the check runs | A10 |
| 7 | `packages/core/src/cache.test.ts` | §9.4, rich round-trip, classification-unchanged, non-string `fetchedAt` | A3, A4, A5 |
| 8 | `packages/core/src/security.test.ts` | one unit case per degraded field | A1 |
| 9 | `packages/core/src/closed-sets.test.ts` | **new** — set completeness driven through `normalize()`; hard-coded literals | A6, A7 |
| 10 | `packages/statusline/src/smoke.test.ts` | end-to-end `--debug` **and `--json`** against the compiled binary | A1 |
| 11 | `packages/core/src/exhaustive-guard.test.ts` | the docstring-count assertion | A9 |
| 12 | `SPEC.md` | §12's gap paragraph replaced; §11.4/§14's `--json` contract | A8 |

**Explicitly not touched:** `packages/metrics`, `packages/vscode` (all of it), `packages/core/src/state.ts`,
`format.ts`, `time.ts`, `telemetry.ts`, `cooldown.ts`, `main.ts`, `scripts/`, `.oxlintrc.json`,
`CLAUDE.md`, `packages/core/src/typefixtures/`.

`main.ts` is **not** edited even though `--debug` and `--json` are the surfaces this loop protects.
That is the thesis, unchanged from loop 030: validating at the boundary fixes every consumer without
touching one.

### Why row 1 is a new module, stated rather than assumed

`cache.ts` needs the warning set; `normalize.ts` produces it. A direct `cache.ts → normalize.ts`
edge would close a cycle, because `normalize.ts` imports `telemetry.ts` and `telemetry.ts:26`
imports `getCacheDir` from `cache.ts` — **measured**, not reasoned about. Loop 030 took a review NIT
for stating a cycle claim more confidently than its premise supported; a leaf module with no runtime
imports removes the question instead of re-litigating it. `state.ts` was considered and rejected:
warning strings are not a classification concern.

## Measurements recorded BEFORE the change

### A5 — classification with a poisoned `staleReason` versus `'none'`

Measured on `825ac80`, before any implementation commit. B2's entire safety argument is that these
two columns are identical.

| `isStale` | `staleReason` | `classify` | `!== 'fetchFailed'` |
|---|---|---|---|
| `false` | `'none'` | `Healthy` | `true` |
| `false` | `'POISON /home/someone'` | `Healthy` | `true` |
| `true` | `'none'` | `Stale` | `true` |
| `true` | `'POISON /home/someone'` | `Stale` | `true` |
| `true` | `'malformedResponse'` | `Degraded` | `true` |
| `true` | `'fetchFailed'` | `Stale` | `false` |

Rows 1–2 and 3–4 are the pairs that matter: poisoned and `'none'` agree. Rows 5–6 are the positive
control — the classifier does distinguish members, so the agreement above is not vacuous.

### A11 — the expectation-change budget is **zero**, measured

The spec budgeted "at most two". The measured answer is **none**, established by reading the two
tests that assert `invalidShape`:

- `cache.test.ts:287` seeds `snapshot: { nope: true }`
- `call-sites.test.ts:99` seeds `snapshot: { nope: 1 }`

Neither has `display` or `freshness`, so both still fail the shape gate after its `fetchedAt` clause
is removed, and both stay green. No test in the repository seeds a non-string `fetchedAt`
(`grep` for `fetchedAt:` in `*.test.ts`, excluding string literals, returns only ISO strings).

**If any existing expectation does change, A11 fails and it is a finding, not a fix.** Writing the
budget as a measured zero rather than a permissive two is the counter-measure to loop 029, which
budgeted three, changed seven, and self-declared six.

## Steps

**Three commits.**

### Commit 1 — the closed sets and the degradations

Rows 1, 2, 3, 4. `closed-sets.ts` first, then `normalize.ts` sourcing from it, then `cache.ts`
consuming it. One commit because `normalize.ts` reading from a constant that does not yet exist does
not compile, and because a `cache.ts` filter against an incomplete set is the BLOCKING regression the
Stage 2 review caught — the two must not be separable in history.

`NORMALIZATION_WARNINGS` includes rows 1–2 of `spec.md`'s table (`'Response is not an object'`,
`'No valid usage windows found'`), which come from `makeMalformed`'s literal-array arguments and not
from `warnings.push`. **This is the single most important line in this plan.** Omitting them ships a
filter that deletes the headline diagnostic of the malformed-response path.

### Commit 2 — the tests

Rows 7–11. Nothing in commit 1 is defended by a test that fails without it until this lands, which
is exactly the criticism the Stage 5 audit made of loop 030's commit 1 — recorded here so the same
gap is a known cost of the split rather than a discovery.

### Commit 3 — `SPEC.md`

Row 12. Separate so the amendment is reviewable as a decision rather than buried in a code diff.

## Test mapping

| # | Behaviour | Test | Criterion |
|---|---|---|---|
| T1 | `fetchedAt` free text canonicalised | `security.test.ts` | A1 |
| T2 | `staleReason` poisoned → `'none'` | `security.test.ts` | A1 |
| T3 | `isStale` non-boolean → `false` | `security.test.ts` | A1 |
| T4 | warnings filtered to the set | `security.test.ts` | A1 |
| T5 | `--debug` end to end, compiled binary | `smoke.test.ts` | A1 |
| T6 | `--json` end to end, compiled binary | `smoke.test.ts` | A1 |
| T7 | envelope **and cooldown** survive a poisoned value | `cache.test.ts` | A3 |
| T8 | rich envelope round-trips deep-equal | `cache.test.ts` | A4 |
| T9 | classification unchanged vs the table above | `cache.test.ts` | A5 |
| T10 | the set equals what `normalize()` can emit | `closed-sets.test.ts` | A6 |
| T11 | the nine strings vs **hard-coded literals** | `closed-sets.test.ts` | A7 |
| T12 | non-string `fetchedAt` keeps envelope + cooldown | `cache.test.ts` | A3 |
| T13 | the docstring's stated count equals the member count | `exhaustive-guard.test.ts` | A9 |

T5 and T6 seed **one envelope carrying four distinguishable poison strings**, one per field, and
assert on each separately — so a single-check mutation fails with a message naming which field
leaked, rather than a bare "output contained a string".

## Mutation table — predictions recorded BEFORE running

A2 requires at least one row per check and at least one inversion. Nine rows, four checks.

| # | Mutation | Predicted |
|---|---|---|
| M1 | delete B1's `fetchedAt` degradation | **3** — T1, T5, T6 |
| M2 | **invert** B1: return the input instead of the constructed string | **3** — T1, T5, T6 |
| M3 | delete B2a's `staleReason` fallback | **3** — T2, T5, T6 |
| M4 | **invert** B2a: fall back only when the value *is* a member | **4** — T2, T5, T6, and T8, whose fixture carries `'malformedResponse'` |
| M5 | delete B2b's `isStale` check | **3** — T3, T5, T6 |
| M6 | delete B3's warning filter | **3** — T4, T5, T6 |
| M7 | **invert** B3: keep only non-members | **4** — T4, T5, T6, T8 |
| M8 | drop rows 1–2 from `NORMALIZATION_WARNINGS` — **the BLOCKING regression the review caught** | **2** — T10 and T8. Deliberately *not* T4/T5/T6, which poison with a string outside the set either way |
| M9 | restore the `typeof fetchedAt !== 'string'` clause to the shape gate | **1** — T12 only |

**M8 is the row this table exists for.** If it predicts more than two failures I have misunderstood
my own tests; if it predicts fewer than two, the set is not defended and the review's BLOCKING
finding would recur silently.

## Verification

1. `export CLAUDEWATCH_VERIFY_METRICS=1` first; `bun run verify` after each commit, redirected to a
   file.
2. **A2's SHA rule**: `review.md` cites this commit and the implementation commits, so
   `git log --oneline <this>..<impl>` shows the ordering.
3. **A12 as a SORTED diff**: `oxlint 2>&1 | grep warning | sort` before and after, `diff` empty,
   count 11 both. Recorded in `review.md` as a manual step, with the note that it should be a gate
   and is queued for loop 032.
4. **Rebuild the binary between every mutation.** `smoke.test.ts`'s `beforeAll` now rebuilds on a
   stale mtime (loop 030 commit 3), so this is automatic — but both loop 030 reviewers hit the
   stale-binary confound independently, so it is written down.
5. Stage 5: `plan-to-diff-auditor` then `security-reviewer`, sequentially, briefed on the commit
   range, told not to write into the tree.

## Risks carried into implementation

- **The set is the whole game.** Every other part of this change is mechanical; a wrong
  `NORMALIZATION_WARNINGS` is a silent data-loss bug on the diagnostic path. T10 drives `normalize()`
  rather than reading it for exactly this reason, and T11 uses hard-coded literals because T10 goes
  circular once `normalize.ts` reads from the constant.
- **`TZ` in T1.** `Date.parse` uses the legacy local-time parser for date-only-plus-text input, so an
  exact-output assertion is zone-dependent (measured: `05:00:00Z` in `America/New_York`,
  `00:00:00Z` in `UTC`). T1 asserts a **shape** plus the absence of the poison, not an instant.
- **T6 must not assert the whole `--json` blob.** It serialises the entire snapshot, so a
  full-output assertion would break on any unrelated field change. Assert per-poison-string absence
  and two positive preconditions that the cache was read.
- **A4 can pass while proving nothing** if its fixture inherits `makeTestSnapshot`'s defaults, which
  are every field's degraded value. The fixture must override all four.
- **`snapshot.ts` and `client.ts` are docstring-only edits** in a fence that otherwise touches
  behaviour. Any behavioural change to either is out of scope and a fence violation.

## Next stage

`/sdlc-implement`, commit 1 first.
