# Plan: four tests, three mandatory setup steps, two files

- **ID:** 042-setting-observable-unfired
- **Stage:** 3 — Build (planning half)
- **Derived from:** [`spec.md`](./spec.md) (ACCEPTED at Stage 2, revision 2)

## Approach

Two files. `packages/vscode/src/extension.test.ts` gains a `describe` with four tests and a reworded
todo string; `scripts/vscode-stub-cover.test.ts` gains the new floor numbers. Nothing else.

### The three setup steps, restated here because getting one wrong is how this loop's spec failed twice

Every test in the new describe needs all three, and the spec's own first two drafts each shipped
missing one:

1. `resetVscodeStub()` **first**, capturing its return so `configValues` is reachable — there is no
   other accessor — and because calling it *after* the capture restores the pristine leaf and throws
   the callback away.
2. `configValues['telemetry.enabled']` seeded, **and** `vscodeStub.env.isTelemetryEnabled = true`. The
   gate ANDs both inputs against `=== true`. Omitting the global seed makes A2's second direction
   meaningless *and* makes test 4 **silently** vacuous — mutation (7) survives at 28 pass / 0 fail.
3. `calls = []` after `activate`/`flush`. `activate` calls `recomputeTelemetryGate()` itself, so an
   uncleared log already holds one entry and A3's counts are off by one.

And one ordering rule that is not a setup step: **test 4 activates before installing the throwing
`getConfiguration`**, because `new StatusBarManager` reads config at `statusbar.ts:20` during
`activate`.

### Mutations are re-run, not inherited

All seven were measured by the Stage 2 reviewer against its own implementation of these tests. They
are **predictions here**. Stage 4 runs each one itself and records what happened, including any that
miss. Someone else's evidence is not this loop's evidence.

## Scope fence

```
packages/vscode/src/extension.test.ts
scripts/vscode-stub-cover.test.ts
sdlc/042-setting-observable-unfired/intent.md
sdlc/042-setting-observable-unfired/spec.md
sdlc/042-setting-observable-unfired/plan.md
sdlc/042-setting-observable-unfired/review.md
```

**Explicitly not touched:** `packages/vscode/src/extension.ts`, `packages/vscode/src/vscode-stub.ts`,
`packages/vscode/src/statusbar.ts`, `packages/vscode/src/telemetry-gate.ts`,
`packages/vscode/src/telemetry-gate.test.ts`, `packages/vscode/src/commands.test.ts`,
`packages/vscode/src/statusbar.test.ts`, `packages/vscode/src/tooltip.test.ts`,
`packages/vscode/src/manifest.test.ts`, `packages/vscode/src/vscode-stub.test.ts`,
`scripts/vscode-stub-cover.ts`, `scripts/mock-topology.test.ts`, `.oxlint-budget.json`

Each for a reason:

- **`extension.ts`** — the branch is correct and untested. The intent forbids touching it; a defect
  found on the way is a new intent.
- **`vscode-stub.ts`** — no stub change. The per-test override is measured not to leak, for this leaf
  specifically rather than by inheritance from `sdlc/040`.
- **`statusbar.ts`** — named because test 4 depends on its constructor reading config during
  `activate`. That dependency is why the ordering rule exists; it is not licence to change it.
- **`telemetry-gate.ts` and its test** — the decision function is covered by seven cases.
- **The five other vscode test files** — untouched, floors unmoved.
- **`.oxlint-budget.json`** — if the budget moves, a construct the spec ruled out was used
  (`filter().at(-1)` → `prefer-array-find`, measured). Fix the construct.
- **`mock-topology.test.ts`** — no new `mock.module` call; its pinned inventory does not grow.

## Changes

### `packages/vscode/src/extension.test.ts`

One `describe`, four tests, each applying the three setup steps:

1. *the handler is registered* — capture box `{ cb: undefined }` so the first assertion can fail;
   assert the callback is defined and `ctx.subscriptions` contains the sentinel.
2. *an affecting event re-runs the gate, both directions* — `true → false → true`, each direction
   asserting `calls.findLast(...)` **and** `telemetryOverride()`.
3. *a different-key event does not re-run it* — from a cleared log, one call after an affecting
   event, then zero after one affecting `claudewatch.warningThresholdPct`.
4. *a failed setting read is not consent* — activate, **then** override `getConfiguration` to throw,
   then fire; both observables read `{ enabled: false }`.

The `onDidChangeConfiguration` todo is **reworded** to name the two branches still uncovered
(`refreshIntervalSeconds` → `startPolling`, thresholds → `updateThresholds`). `GAPS: 2` does not move,
because the count tracks todo **lines**.

### `scripts/vscode-stub-cover.test.ts`

`FLOORS['extension.test.ts']` → `{ pass: 28, expects: 66 }`. Nothing else.

## Tests

| Criterion | Test | What makes it discriminate |
|---|---|---|
| A1 | *is registered* | disposable identity, and a box that can be undefined |
| A2 | *both directions* | the second direction reads a value differing from activation's own log entry |
| A3 | *different-key* | a **different-key** event, not all-false — an all-false event lets a widened guard survive |
| A4 | seven mutations, Stage 4 | the evidence base, re-run rather than inherited |
| A5 | the reworded todo | `GAPS: 2` still matches, checked by `sdlc/041`'s A4 |
| A6 | `verify` + run-alone gate | floors, budget, seven files |

## Mutations, predicted (reviewer-measured, Stage 4 re-runs)

| # | Mutation of `extension.ts` | Predicted failing |
|---|---|---|
| 1 | delete `recomputeTelemetryGate()` from the branch | A2, A3, test 4 — 25 pass / 3 fail |
| 2 | drop the `affectsConfiguration` guard | A3 — 27 / 1 |
| 3 | widen the guard to also match `warningThresholdPct` | A3 — 27 / 1 |
| 4 | keep registration, drop its `subscriptions.push` | A1 — 27 / 1 |
| 5 | delete the registration statement outright | A1, A2, A3, test 4 — 24 / 4 |
| 6 | constant `setTelemetryConfig({ enabled: false })` | A2's second direction **and** `sdlc/041`'s telemetry-listener test — 26 / 2 |
| 7 | catch → `settingEnabled = true` | test 4 only — 27 / 1 |

Mutation (7) is the one whose absence is **silent** if the global seed is missed; run it deliberately
rather than assuming the seed landed.

## Verification

1. `bun run typecheck` before `bun test`.
2. `export CLAUDEWATCH_VERIFY_METRICS=1` then `bun run verify > <file> 2>&1`, always redirected.
3. **Commit only on `exit=0`, gated on the status rather than chained after a `;`**.
4. **Read edits back from the file** rather than trusting an edit tool's success message — `sdlc/041`
   committed a message claiming a fix that a failed edit block never wrote to disk.
5. No VS Code bundle check needed: no product source changes.

## Risks

- **Test 4 is the fragile one**: it depends on activation order, on the global seed, and on the stub's
  `getConfiguration` being a `mock()` whose implementation the reset reinstalls. If its floors or
  behaviour differ from the spec's numbers, that is a finding, not a number to overwrite.
- **The floors are `>=`**, so an under-prediction is invisible. 28 / 66 is derived per test and was
  independently measured at Stage 2; a mismatch means the implementation diverged from the design.

---

**Next stage:** Build/Test — run `/sdlc-implement 042-setting-observable-unfired`.
