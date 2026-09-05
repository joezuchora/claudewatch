# Plan: four tests, one docstring line, two floors

- **ID:** 041-telemetry-listener-untested
- **Stage:** 3 — Build (planning half)
- **Derived from:** [`spec.md`](./spec.md) (ACCEPTED at Stage 2, revision 3)

## Approach

Two files change and nothing else. `extension.test.ts` gains a `describe('the telemetry listener')`
with four tests, a `GAPS: 2` docstring line, a `readFileSync` import, and loses one stale comment and
one `test.todo`. `scripts/vscode-stub-cover.test.ts` gains the two new floor numbers.

Order matters only in one place: write the four tests **before** deleting the `test.todo`, so the
file is never in a state where the gap is neither covered nor recorded.

### The thing three review rounds were about

Every number and every mutation-to-criterion mapping in `spec.md` was measured by the Stage 2
reviewer in an isolated copy. **This plan does not re-derive any of them, and the implementation must
not silently "correct" one.** If a measured number comes out different at Stage 4 — `expects: 56`, the
seven mutation attributions, the `/^\s*test\.todo\(/gm` match counts — that is a finding for
`review.md`, not a number to quietly edit. Three rounds of this loop were spent on claims that were
adjusted to look right rather than run.

## Scope fence

```
packages/vscode/src/extension.test.ts
scripts/vscode-stub-cover.test.ts
sdlc/041-telemetry-listener-untested/intent.md
sdlc/041-telemetry-listener-untested/spec.md
sdlc/041-telemetry-listener-untested/plan.md
sdlc/041-telemetry-listener-untested/review.md
```

**Explicitly not touched:** `packages/vscode/src/extension.ts`, `packages/vscode/src/vscode-stub.ts`,
`packages/vscode/src/telemetry-gate.ts`, `packages/vscode/src/telemetry-gate.test.ts`,
`packages/vscode/src/commands.test.ts`, `packages/vscode/src/statusbar.test.ts`,
`packages/vscode/src/tooltip.test.ts`, `packages/vscode/src/manifest.test.ts`,
`packages/vscode/src/vscode-stub.test.ts`, `scripts/vscode-stub-cover.ts`,
`scripts/mock-topology.ts`, `scripts/mock-topology.test.ts`, `.oxlint-budget.json`

Each for a reason:

- **`extension.ts`** — the intent forbids it. This loop tests a branch that already works. A defect
  found on the way is a new intent, not a fix smuggled into a test loop.
- **`vscode-stub.ts`** — the spec rejected a permanent callback capture as shared mutable state for
  one file's benefit. The per-test override needs no stub change, and `sdlc/040` A1 already proves
  the overridden leaf is restored.
- **`telemetry-gate.ts` and its test** — the decision function is covered by seven cases. Nothing here
  changes it.
- **The five other vscode test files** — untouched, and their floors must not move.
- **`.oxlint-budget.json`** — A5 asserts it is unchanged, and the Stage 2 reviewer measured
  `/^\s*test\.todo\(/gm` and `findLast` as lint-clean. **If the budget moves, the implementation used
  a construct the spec ruled out** (`'test' + '.todo('` → `no-useless-concat`, or
  `filter().at(-1)` → `prefer-array-find`). Fixing the construct is the response; re-recording the
  budget is not.
- **`mock-topology.test.ts`** — its pinned inventory does not grow: this loop adds no
  `mock.module` call, only tests inside a file that already has two.

## Changes

### `packages/vscode/src/extension.test.ts`

**Header docstring.** Add ` * GAPS: 2` as a canonical machine-readable line. Update the prose from
three gaps to two. Keep the sentence recording that this docstring drifted before — it is the reason
A4 exists.

**Imports.** Add `readFileSync` from `fs`.

**New `describe('the telemetry listener')`, four tests**, each driving `activate(ctx)` directly (never
`start()`, which clears `calls` at line 210) and `await flush()` afterwards:

1. *is registered* — override `env.onDidChangeTelemetryEnabled` to capture the callback and return a
   `sentinel`; assert the callback is a function and `expect(ctx.subscriptions).toContain(sentinel)`.
2. *fires and reaches core* — seed `configValues['telemetry.enabled'] = true`; assert the three-row
   truth table, each row checking the last `setTelemetryConfig` argument (via `calls.findLast`, not
   `filter().at(-1)`) **and** `telemetryOverride()`.
3. *a host without the key* — two halves: with the key, record `withKey` and assert
   `toContain(sentinel)`; then dispose, `deactivate()`, reset, `delete` the leaf, re-activate, and
   assert `not.toContain(sentinel)` and `length === withKey - 1`.
4. *the docstring gap count matches the todos* — `/^ \* GAPS: (\d+)$/m` for the claim,
   `/^\s*test\.todo\(/gm` over `readFileSync(import.meta.path, 'utf-8')` for the actual, plus the
   three controls.

**Deletions.** The comment claiming the branch is "dead in this file because the `vscode` stub omits
the key", and the `test.todo('activate: the onDidChangeTelemetryEnabled listener')` beneath it.

### `scripts/vscode-stub-cover.test.ts`

`FLOORS['extension.test.ts']` → `{ pass: 24, expects: 56 }`. Nothing else.

## Tests

| Criterion | Test | What makes it discriminate |
|---|---|---|
| A1 | *is registered* | disposable **identity**, not length — a length check survives deleting the push |
| A2 | *fires and reaches core* | three rows over both ANDed inputs × two observables |
| A3 | seven mutations, Stage 4 | the evidence base; every test evidenced by at least one |
| A4 | *the docstring gap count matches the todos* | three controls, one of which is a fixture that fails against the pattern revision 2 mandated |
| A5 | `verify` + the run-alone gate | floors, budget, seven files |

## Mutations, with predictions written before the run

Transcribed from `spec.md` A3, which the Stage 2 reviewer ran. **Predictions are the reviewer's
measured results; a disagreement at Stage 4 is a finding, not a correction.**

| # | Mutation of `extension.ts` | Predicted to fail |
|---|---|---|
| 1 | delete the `subscriptions.push` wrapper | A1, and test 3's first half |
| 2 | push a decoy disposable instead | A1, and test 3's first half |
| 3 | replace the callback with `() => {}` | A2 |
| 4 | force the `typeof` guard false | A1, A2, and test 3's first half |
| 5 | drop `settingEnabled` from the AND | A2 row 3 |
| 6 | push a local value without updating `telemetryAllowed` | A2's `telemetryOverride()` half |
| 7 | delete the `typeof` guard (register unconditionally) | test 3 |

Plus four A4 probes: `GAPS: 3` beside two todos; the `GAPS:` line deleted; a **top-level** todo added;
an **indented** todo added. All four must fail A4 — the fourth is the one revision 2's pattern missed.

## Verification

1. `bun run typecheck` before `bun test` — loop 039 read a confusing `undefined` for a type error by
   running them the other way.
2. `export CLAUDEWATCH_VERIFY_METRICS=1` then `bun run verify > <file> 2>&1`, always redirected.
3. **Commit only on `exit=0`, gated on the status rather than chained after a `;`** — loop 039 pushed
   a red `lintBudget` that way.
4. No VS Code bundle check needed: no product source changes.

## Risks

- **The floors are the first thing to move if a test is written differently than specified.** `56` is
  derived per test in the spec. A mismatch means the implementation diverged from the design, and the
  right response is to find out which, not to record the new number.
- **Test 3 mutates then restores stub state mid-test** (dispose, `deactivate`, reset, delete). If the
  `afterEach` ordering matters more than expected, that is a finding about the reset, which is
  `sdlc/040`'s subject rather than this loop's.

---

**Next stage:** Build/Test — run `/sdlc-implement 041-telemetry-listener-untested`.
