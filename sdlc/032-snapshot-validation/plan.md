# Plan: validate the whole snapshot, not four fields of it

- **ID:** 032-snapshot-validation
- **Stage:** 3 — Build (planning half)
- **Status:** draft
- **Date:** 2026-08-28

Reads `spec.md` as revised after its Stage 2 review (five BLOCKING, seven MAJOR, seven MINOR).

**This file is the prediction record.** A6 requires each mutation to name the specific
`file:testname` it expects to fail, and requires this commit's SHA to precede every implementation
commit so `git log --oneline <this>..<impl>` proves the ordering.

## Scope fence

**Fourteen paths** — counted from the table, which has fourteen rows, written after the table.

| # | Path | Change | Criterion |
|---|---|---|---|
| 1 | `packages/core/src/sanitize-snapshot.ts` | **new** — `sanitizeSnapshot`, `SANITIZED_FIELDS` | B1, B1b, A11 |
| 2 | `packages/core/src/closed-sets.ts` | `USAGE_ENDPOINT_STATES`, `AUTH_STATES`, `PRIMARY_WINDOWS`, `ISO_CURRENCY_RE` moved in, `MAX_DISABLED_REASON` | B1, B2 |
| 3 | `packages/core/src/cache.ts` | call `sanitizeSnapshot`; validate `lastHttpStatus` | B1, B4 |
| 4 | `packages/core/src/normalize.ts` | import `ISO_CURRENCY_RE` from row 2 instead of declaring it | B1 |
| 5 | `packages/core/src/telemetry.ts` | `PayloadLeaf`; `renderEvent` narrows; the stale comment | B3 |
| 6 | `packages/core/src/sanitize-snapshot.test.ts` | **new** — per-field rules, coherence, `SANITIZED_FIELDS` reflection | A2, A3, A11 |
| 7 | `packages/core/src/cache.test.ts` | round-trip, §9.4, enterprise throw | A3, A5, A10 |
| 8 | `packages/core/src/security.test.ts` | the 26-marker unit case | A1 |
| 9 | `packages/core/src/telemetry.test.ts` | the one expectation the payload narrowing breaks | A7 |
| 10 | `packages/statusline/src/smoke.test.ts` | `--debug` and `--json` e2e, reusing `poisonedButFresh()` | A1 |
| 11 | `packages/core/src/exhaustive-guard.test.ts` | assert the new typefixture | A4, A7 |
| 12 | `packages/core/src/typefixtures/payload-string.expect-error.ts` | **new** | A7 |
| 13 | `SPEC.md` | §12 gap rewritten, §17, §11.4, §14 | A8 |
| 14 | `packages/core/src/test-helpers.ts` | a rich fixture builder for A3 | A3 |

**Explicitly not touched:** `packages/metrics`, all of `packages/vscode`, `state.ts`, `format.ts`,
`time.ts`, `cooldown.ts`, `client.ts`, `snapshot.ts`, `main.ts`, `scripts/`, `.oxlintrc.json`,
`CLAUDE.md`, `packages/core/src/types.ts`.

**`types.ts` is deliberately excluded**, which decides review finding m-4: `authState` is spelled
twice (inline at `types.ts:30`, and as `AuthState` at `:118`), and the guards must therefore anchor
to **indexed access** — `UsageSnapshot['authState']`, `UsageSnapshot['source']['usageEndpoint']`,
`UsageSnapshot['display']['primaryWindow']` — not to the named types. Anchoring to `AuthState` would
miss a member added to the inline spelling. Collapsing the duplication is the cleaner fix and is a
`types.ts` edit with its own blast radius; recorded as an open item rather than smuggled in.

`main.ts` is **not** edited, again. Validating at the boundary fixes every consumer.

## Measurements recorded BEFORE the change

All taken on `9e79e76`, before any implementation commit.

### The payload narrowing is cheap, and it works

`spec.md` left this as its one open risk and required `plan.md` to measure it. Two probes:

| probe | result |
|---|---|
| narrow `MetricEvent.payload` to a complete `PayloadLeaf`, narrow `makeEvent`'s param | **2 errors**, both structural (`makeEvent`'s own signature, one test) — **not** per-call-site churn |
| then add `newFreeText?: string` to `renderEvent` and pass it into the payload | **rejected**: `Type 'string' is not assignable to type 'PayloadLeaf'` |

So **A7 is achievable and `intent.md`'s outcome 5 can be delivered.** It does not get cut.

Every string-valued payload leaf, enumerated by reading all four event builders:

| leaf | current type | closed already? |
|---|---|---|
| `surface` | `Surface` | yes |
| `statusClass` | `StatusClass` | yes |
| `outcome` | `CacheOutcome` | yes |
| `category` | `WarningCategory` | yes |
| `runtimeState` | **`string`** | no — B3 narrows |
| `tier` | **`string`** | no — B3 narrows |

Four of six were already unions. `PayloadLeaf = number | boolean | null | Surface | StatusClass |
CacheOutcome | WarningCategory | RuntimeState | AccountTier`. My first probe used a deliberately
incomplete union and produced 11 errors; **that number is not the cost of the change**, it is the
cost of an incomplete union, and it is recorded here so it cannot be mistaken for one later.

### `renderEvent`'s two-parameter narrowing: 0 call-site errors

Re-confirmed on this commit. (First probe reported 2; both were `TS2304 Cannot find name` — missing
imports, a different failure. Recorded in `spec.md`.)

### A9's zero is inherited, and Stage 4 must re-take it

`spec.md` records **854 pass, 0 fail, identical to baseline** from the Stage 2 reviewer's prototype
of this design. **That is someone else's measurement of a prototype, not of this implementation.**
Stage 4 re-runs it and records its own number; if it is not zero, A9 fails and it is a finding. The
distinction matters because loop 031's review found a commit citing evidence that could not support
its own conclusion.

## Steps

**Four commits.**

1. **The sets and the sanitiser** — rows 1, 2, 4. `closed-sets.ts` first, then `sanitize-snapshot.ts`
   against it, then `normalize.ts` sourcing `ISO_CURRENCY_RE` from row 2. No behaviour change yet:
   `sanitizeSnapshot` exists and nothing calls it.
2. **Wire it in** — rows 3, 5. `cache.ts` calls it, `lastHttpStatus` gets its check, `telemetry.ts`
   narrows. This is the commit that changes behaviour, and it lands with no test defending it —
   a known cost of the split, recorded here rather than discovered in the audit as it was in 031.
3. **The tests** — rows 6–12, 14.
4. **`SPEC.md`** — row 13, separate so the amendment reads as a decision.

## Test mapping

| # | Behaviour | Test | Criterion |
|---|---|---|---|
| T1 | 26 markers, none survive | `security.test.ts` → `'no value off a cache file survives unvalidated'` | A1 |
| T2 | `--debug` e2e | `smoke.test.ts` → `'T2 — --debug, 26 poisons'` | A1 |
| T3 | `--json` e2e, `poisonedButFresh()` | `smoke.test.ts` → `'T3 — --json, 26 poisons'` | A1 |
| T4 | unknown keys at all five levels | `sanitize-snapshot.test.ts` → `'unknown keys are dropped at every level'` | A2 |
| T5 | rich round-trip `toStrictEqual` | `cache.test.ts` → `'a rich envelope round-trips strictly'` | A3 |
| T6 | **every fixture leaf differs from its degraded value** | `cache.test.ts` → `'the round-trip fixture is not vacuous'` | A3 |
| T7 | closed sets exhaustive | `sanitize-snapshot.test.ts` → `'every closed set covers its union'` | A4 |
| T8 | §9.4 preserved | `cache.test.ts` → `'a poisoned snapshot keeps the envelope and the cooldown'` | A5 |
| T9 | payload rejects `string` | `exhaustive-guard.test.ts` → `'a string payload leaf fails typecheck'` | A7 |
| T10 | enterprise throw is gone | `cache.test.ts` → `'a poisoned enterprise.utilizationPct no longer throws'` | A10 |
| T11 | `SANITIZED_FIELDS` reflection | `sanitize-snapshot.test.ts` → `'every UsageSnapshot key has a rule'` | A11 |
| T12 | coherence: `enterprise: null` forces `tier`/`display` | `sanitize-snapshot.test.ts` → `'a nulled enterprise forces tier and display to unknown'` | B1b |
| T13 | coherence: nulled window pct forces `primaryWindow` | `sanitize-snapshot.test.ts` → `'a nulled primary window degrades primaryWindow'` | B1b |
| T14 | `lastHttpStatus` validated | `security.test.ts` → `'a non-integer lastHttpStatus is nulled'` | B4 |

T2 and T3 seed **one envelope carrying 26 distinguishable markers** and assert per marker, so a
single-rule mutation names the field that leaked.

## Mutation table — predictions recorded BEFORE running

A6 requires a named failing test per row, not a count. Ten rows.

| # | Mutation | Predicted failures (named) |
|---|---|---|
| M1 | `sanitizeSnapshot` returns its input unchanged | T1, T2, T3, T4, T12, T13, T14 is unaffected — **6** |
| M2 | drop the `usageEndpoint` rule | T1, T2, T3 — **3** |
| M3 | drop the `authState` rule | T1, T2, T3 — **3** |
| M4 | drop the `primaryWindow` rule | T1, T2, T3 — **3** |
| M5 | drop the window `resetsAt` canonicalisation | T1, T2, T3 — **3** |
| M6 | drop the enterprise numeric checks | T1, T2, T3, **T10** — **4** |
| M7 | drop `currency`'s check | T1, T2, T3 — **3**. **Not T5**: the fixture must carry `'EUR'` for T5 to catch it, which is exactly what T6 exists to enforce |
| M8 | delete both coherence rules (B1b) | T12, T13 — **2** |
| M9 | drop `lastHttpStatus`'s check | T14, T2 — **2** (`--json` serialises the snapshot, not the envelope, so **not T3**) |
| M10 | widen `PayloadLeaf` back to include `string` | T9 — **1** |

**M7 and M9 are the rows this table exists for.** M7 predicts the round-trip does *not* catch a
dropped `currency` unless T6 forces a non-default fixture — the vacuity the Stage 2 review
demonstrated. M9 predicts an asymmetry between the two e2e legs that would look like a bug if it
were not predicted: `lastHttpStatus` is an envelope field, and `--json` never serialises the
envelope.

Predicting against the tests **as written** is A6's requirement; these names are the contract, and
any failure whose name is not on this list is a miss to be recorded, not reconciled.

## Risks

- **A whitelist fails by dropping, not leaking.** T5+T6 are the only net. T6 is not optional.
- **`test-helpers.ts` is in the fence for a rich fixture.** Every existing default is a degraded
  value, so a helper that merely spreads `makeTestSnapshot` reproduces the vacuity.
- **`ISO_CURRENCY_RE` cannot be imported from `normalize.ts`** — it is module-private and the edge
  would close the `cache → normalize → telemetry → cache` cycle `closed-sets.ts` exists to avoid.
  It moves; `normalize.ts` imports it back.
- **Commit 2 changes behaviour with no test.** Stated, not discovered.
- **`disabledReason`'s redact-then-bound is the weakest rule** and the reviewer said so. It is not
  a closed set and cannot be.

## Verification

1. `export CLAUDEWATCH_VERIFY_METRICS=1` first; `bun run verify` after each commit, redirected.
2. A6's SHA rule: `review.md` cites this commit and the four implementation commits.
3. A12 as a sorted **set** comparison, line numbers stripped.
4. Rebuild between mutations is automatic (`smoke.test.ts`'s `beforeAll` rebuilds on stale mtime).
5. Stage 5: `plan-to-diff-auditor`, then `security-reviewer`, sequentially, on a clean tree.

## Next stage

`/sdlc-implement`, commit 1 first.
