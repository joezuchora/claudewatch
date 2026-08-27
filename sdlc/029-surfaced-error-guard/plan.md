# Plan: close the set of surfaceable error messages

- **ID:** 029-surfaced-error-guard
- **Stage:** 3 — Build (planning half)
- **Status:** draft
- **Date:** 2026-08-27

Reads `spec.md` as revised after the Stage 2 review (three BLOCKING, six SHOULD-FIX, all folded in).
Implements B1, B1b, B2, B3, B4 against A1–A9.

## Scope fence

Eight paths. Two are new.

| Path | Change | Criterion |
|---|---|---|
| `packages/core/src/types.ts` | `SurfaceableMessage` union; `FetchFailure.message` narrowed to it | B2 |
| `packages/core/src/client.ts` | B1 network constants; B1b `response.json()` try → `malformedResponse`; export `isSurfaceableMessage` | B1, B1b, A1 |
| `packages/core/src/snapshot.ts` | `extractLastError` gated on `isSurfaceableMessage` | B3 |
| `packages/core/src/cooldown.ts` | the `:122` comment saying `malformedResponse` "is not constructed anywhere" is now false | A9 |
| `packages/core/src/security.test.ts` | **new test**, one case, seven assertions | B4, A3 |
| `packages/core/src/typefixtures/free-text-message.expect-error.ts` | **new** — freezes the negative control | B2 |
| `packages/core/src/client.test.ts` | `:92` assertion changes | A6 |
| `packages/core/src/contract.test.ts` | `:303` and `:317` assertions change | A6 |
| `SPEC.md` | §12 gains a pointer to the enforcing test | A5 |

**Explicitly not touched:** `packages/statusline`, `packages/vscode`, `packages/metrics`,
`format.ts`, `tooltip.ts`, `normalize.ts`, `cache.ts`, `scripts/`, `.oxlintrc.json`, `CLAUDE.md`.

If the diff touches anything above, that is a finding for `review.md`. Loop 028's fence held; this
one is written to the same standard — literal paths, no globs.

## Steps

Three commits. Each must leave `bun run verify` green before the next.

**Loop 028's plan failed this and my justification was falsified in Stage 5** — I claimed two steps
were inseparable when a two-line change would have separated them. So the coupling here is stated
explicitly rather than discovered: **step 1 cannot be green alone**, because narrowing
`FetchFailure.message` (B2) makes the three existing assertions in `client.test.ts`/`contract.test.ts`
fail on *content*, and A6's edits are step 2. Steps 1 and 2 are therefore **one commit**, declared
now, not later. Step 3 is genuinely separable.

### Step 1+2 — the closed set, its consumers, and the three declared test edits

`types.ts`:

```ts
export type SurfaceableMessage =
  | 'Authentication failed (401)' | 'Rate limited (429)'
  | 'Network error' | 'Request timed out' | 'Malformed response'
  | `Server error (${number})` | `Unexpected status ${number}`;
```

`FetchFailure.message: SurfaceableMessage`.

`client.ts`:
- `:200` → `message: timedOut ? 'Request timed out' : 'Network error'`
- `:86` → `response.json()` in its own `try`, returning
  `{ ok: false, status: 200, failureClass: 'malformedResponse', message: 'Malformed response' }`
- export `isSurfaceableMessage(m: string): m is SurfaceableMessage` as an **array of exactly seven
  literal forms** (A4 requires one mutation row per form, so the shape is fixed here, not left to
  the implementer)

`snapshot.ts` — `extractLastError` gates the disk value. Note the existing guard is
`if (!envelope?.lastHttpStatus && !envelope?.lastErrorMessage) return null`, so a rejected message
with a non-null `lastHttpStatus` must still return the status. The gate replaces the message only.

`cooldown.ts:122` — the comment is now false; corrected in the same commit that falsifies it.

The three declared test edits, and **only** these three:

| File:line | Was | Becomes |
|---|---|---|
| `client.test.ts:92` | `toContain('DNS resolution failed')` | `isSurfaceableMessage(result.message)` + `toBe('Network error')` |
| `contract.test.ts:303` | `toContain('aborted')` | `toBe('Request timed out')` — but see the mock caveat below |
| `contract.test.ts:317` | `toContain('DNS')` | `toBe('Network error')` |

**Caveat on `contract.test.ts:303`:** it throws a synthetic `AbortError`, which leaves `timedOut`
false, so it will produce `'Network error'`, not `'Request timed out'`. Writing `toBe('Request timed
out')` there would be a test asserting a branch it does not reach. Either it asserts
`'Network error'`, or it is switched to `mockNeverSettles` to drive the real timeout. **Decide by
running it, and record which.** This is exactly the "fake seventh path dressed as a sixth" the spec
reviewer warned about.

### Step 3 — the guard, the fixture, and the spec pointer

`security.test.ts` gains **one test with seven assertions** (A3), driving: 401, 429, 5xx, unexpected
status, network throw, **real** timeout via `mockNeverSettles`, malformed JSON.

`typefixtures/free-text-message.expect-error.ts` freezes the compile-time negative control, following
the existing `*.expect-error.ts` convention.

`SPEC.md §12` gains the pointer (A5).

## Test mapping

| Behaviour | Test | File |
|---|---|---|
| B1 network constant | B4 assertions 5 and 6 | `security.test.ts` |
| B1b malformed JSON | B4 assertion 7 | `security.test.ts` |
| B2 producer closed by type | `free-text-message.expect-error.ts` | `typefixtures/` |
| B3 consumer gated | `extractLastError` rejects free text | `security.test.ts` |
| Four HTTP constants | B4 assertions 1–4 | `security.test.ts` |

## Mutation table — predictions recorded BEFORE running

A4 requires one row per literal form. Each predicts a **count and a named assertion**.

| # | Mutation | Predicted |
|---|---|---|
| M1 | drop `'Authentication failed (401)'` from the array | 1 — B4's 401 assertion |
| M2 | drop `'Rate limited (429)'` | 1 — B4's 429 assertion |
| M3 | drop `` `Server error (${number})` `` | 1 — B4's 5xx assertion |
| M4 | drop `` `Unexpected status ${number}` `` | 1 — B4's unexpected-status assertion |
| M5 | drop `'Network error'` | **2** — B4's network assertion AND `client.test.ts:92`, which now asserts the same string |
| M6 | drop `'Request timed out'` | 1 — B4's timeout assertion |
| M7 | drop `'Malformed response'` | 1 — B4's malformed-JSON assertion |
| M8 | revert B1b's `try` (leave `response.json()` unguarded) | 1 — B4's malformed-JSON assertion, now producing `'Network error'` |
| M9 | remove B3's gate from `extractLastError` | 1 — B3's test |
| M10 | free-text seed on the 401 constant | **typecheck fails, TS2322**, before any test runs |

M5's prediction of 2 is deliberate: if it reports 1, one of those two assertions is not doing what
its name says.

## Verification

1. `export CLAUDEWATCH_VERIFY_METRICS=1` first; `bun run verify` after each commit, redirected.
2. **A2's three arms, all pasted into `review.md`** — (a) typecheck fails `TS2322` with the exact
   seed; (b) with the union widened to `string`, exactly one extra test failure, naming B4; (c) seed
   removed, green. Arm (b) is the criterion; a `review.md` with only (a) and (c) fails it.
3. **A6 audited by count**: exactly three assertions edited. `git diff` on the two test files must
   show three changed expectations and nothing else. A fourth is a finding.
4. A9: `grep` `cooldown.ts` for the "not constructed anywhere" claim — must be gone.
5. Stage 5: `plan-to-diff-auditor` then `security-reviewer`, **sequentially**, briefed on the range,
   told not to write into the tree.

## Risks carried into implementation

- **`contract.test.ts:303` is the trap.** Its mock does not reach the timeout branch. Getting this
  wrong produces a green test asserting a branch it never enters — the exact vacuity this repo keeps
  catching. Run it before writing the expectation.
- **A6 is the criterion most likely to be quietly violated.** The natural response to a fourth red
  test is to edit it. Any fourth edit is reported, not absorbed.
- **`status: 200` on a `FetchFailure`** is novel — every other failure has a non-200 status or null.
  Check no consumer assumes `status !== 200` implies failure.

## Next stage

`/sdlc-implement`, steps 1+2 first.
