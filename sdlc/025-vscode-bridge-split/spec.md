# Spec: the mocked module gets exactly one consumer

- **ID:** 025-vscode-bridge-split
- **Stage:** 2 — Design
- **Status:** draft
- **Reads:** `intent.md`
- **Date:** 2026-08-27

## What changed since the intent

The intent framed this as a tooltip problem. It is not. `./core-bridge.js` has **three**
non-test consumers and **one** mocker:

| File | Symbols imported from the bridge | Mocked by |
|---|---|---|
| `statusbar.ts:3` | `classify`, `evaluate`, `emitProcess`, `renderEvent`, `utilizationBucket` | — |
| `tooltip.ts:3` | `formatTooltip` | — |
| `extension.ts:3,20,21` | `setTelemetryConfig` + a 17-symbol block + three types | — |
| `statusbar.test.ts:30` | — | **mocks `'./core-bridge.js'`** |

So `statusbar.test.ts`'s process-wide mock contaminates **two** victims, not one. `extension.ts`
has never noticed because it has no tests — which is loop 001's other open finding, and the two
are related: the shared bridge is part of what makes `extension.ts` awkward to test.

That fact settles Q2 and invalidates one of the intent's own done-criteria, which has been
withdrawn there rather than quietly dropped.

## Answers to the intent's open questions

**Q2 — which module is the new one?** *(Taken first; it determines Q1.)*
**`statusbar.ts` gets the new module.** `core-bridge.ts` stays exactly as it is and keeps
`tooltip.ts` and `extension.ts`.

The alternative — a new `tooltip-bridge.ts` — is what loops 002 and 008 sketched, and it fixes
one victim of two. Both were built and run:

```
# baseline, today
probe importing formatTooltip from core-bridge, alone            → "ClaudeWatch … Current (5hr): 42% — resets…"
same probe with statusbar.test.ts in the same process            → "formatted: 42%"

# option A — new tooltip-bridge.ts (the recorded suggestion)
probe importing from tooltip-bridge, statusbar.test.ts in-proc   → real formatter          ✓ tooltip fixed
                                                                   extension.ts unchanged  ✗ still contaminated

# option B — new statusbar-bridge.ts (this spec)
probe importing from core-bridge, statusbar.test.ts in-proc      → real formatter          ✓ both fixed
vscode suite                                                      → 49 pass, 0 fail
bun run typecheck                                                 → clean
```

Option B also puts the oddity where the oddity is: the module that exists to be mocked is named
for the test that mocks it. Cost is the same order — one new file, plus two changed import lines
(`statusbar.ts`, and `statusbar.test.ts`'s mock specifier) instead of one.

**Q1 — how wide is the new module?** Exactly the five symbols `statusbar.ts` imports. A narrow
module states what the statusbar actually depends on, and it is the mocked surface, so keeping it
small keeps `statusbar.test.ts`'s stub honest. Note the stub at `statusbar.test.ts:30` currently
supplies **seven** keys — the five plus `formatTooltip` and `makeTestSnapshot`. Once
`formatTooltip` no longer resolves through the mocked module, the stub for it is dead weight and
comes out; that removal is the point of the change and must not be left behind.

**Q3 — what stops this recurring?** A test, and it is not invented for the occasion — it is the
property the statusline side already has and the vscode side lacks:

> Every **locally-specified** module passed to `mock.module('./X.js')` in a test file must be
> imported by **at most one** non-test file in its package.

Checked across the repo: there are exactly two local mock targets. `./core-deps.js` has one
non-test importer (`main.ts:31`) and is mocked by `main.test.ts:34` — satisfied, and that is
*why* statusline never had this bug. `./core-bridge.js` has three — violated. The rule is
therefore descriptive of the working half of the codebase, not a new invention.

The rule is deliberately scoped to local specifiers. `mock.module('vscode', …)` appears in two
test files and `vscode` is imported by four source files; that is correct and necessary, because
`vscode` is an ambient host module with no real implementation available under `bun test`.

## Behaviour

### `packages/vscode/src/statusbar-bridge.ts` *(new)*

Value re-binding, not `export … from` — a static re-export keeps the mock linked to the original
module and the contamination survives, which loop 001 established the hard way (127 tests still
failing). Re-exports only; any logic here would violate SPEC.md §8.2.

```ts
import * as core from '@claudewatch/core';
export const classify = core.classify;
export const evaluate = core.evaluate;
export const emitProcess = core.emitProcess;
export const renderEvent = core.renderEvent;
export const utilizationBucket = core.utilizationBucket;
```

### `packages/vscode/src/statusbar.ts`

Line 3's import moves from `'./core-bridge.js'` to `'./statusbar-bridge.js'`. Nothing else.

### `packages/vscode/src/statusbar.test.ts`

`:30`'s `mock.module('./core-bridge.js', …)` becomes `mock.module('./statusbar-bridge.js', …)`,
and the stub drops `formatTooltip` and `makeTestSnapshot`, which no longer belong to the mocked
module. Its assertions are untouched.

### `packages/vscode/src/tooltip.test.ts`

Gains the assertion the whole loop exists to make possible, and loses the comment at `:123`
explaining why it could not be made.

### `packages/vscode/src/core-bridge.ts`

Docstring only: it currently says extension source imports core through it "so that
`statusbar.test.ts` can mock a module that `packages/vscode` owns". After this change
`statusbar.test.ts` mocks a different module, and this one exists to *not* be mocked. Leaving
that sentence would leave the file describing the opposite of its new job.

## Edge cases

1. **`extension.ts` is fixed but unproven.** It has no tests, so nothing will assert its view is
   real. The guard test (A1) covers it structurally — `core-bridge.js` will have two non-test
   importers, which still satisfies "at most one **mocked** module per consumer" only because
   nothing mocks it. See the Risks section: the invariant as stated is about *mocked* modules,
   and `core-bridge.js` is no longer one.
2. **The stub must not be trimmed too far.** `statusbar.test.ts`'s mock replaces the module
   wholesale: any symbol `statusbar.ts` imports and the stub omits becomes `undefined` at call
   time, not a compile error. The five must match exactly.
3. **A future test could mock `./statusbar-bridge.js` from a second file** and recreate the
   problem. Nothing structural prevents it; A1 is what would catch it, and only if the second
   consumer is a source file rather than another test.

## Acceptance criteria

- **A1 — the invariant, as a test.** A test asserts that every local `mock.module('./X.js')`
  target in `packages/vscode` and `packages/statusline` has at most one non-test importer in its
  package. **It must fail on the pre-change tree** (`core-bridge.js`: 3 importers) and pass
  after. Recording both runs is the criterion; a guard that was never seen red is not a guard.
- **A2 — an assertion that fails against the stub.** `tooltip.test.ts` asserts on tooltip text
  the stub cannot produce. `toContain('42%')` is **not** it: the stub returns `formatted: 42%`,
  which contains `42%`, which is exactly why the two existing tests pass today and prove nothing.
  The assertion must reference structure only the real formatter emits — e.g. `Usage Windows` or
  `Current (5hr):`. Verified by running it against the pre-change tree, where it must fail.
- **A3 — whole-suite and single-file agree.** `bun test packages/vscode/src/tooltip.test.ts` and
  the same file inside a full `bun test` both pass **with A2's assertion present**. Today those
  two runs disagree about what `formatTooltip` is and nothing reports it.
- **A4 — `bun run verify` exits 0**, lint at the standing 12.
- **A5 — the new module is re-exports only.** No statement in `statusbar-bridge.ts` other than
  the `import * as core` and the const re-bindings (SPEC.md §8.2).
- **A6 — the dead stub entries are gone.** `statusbar.test.ts`'s mock factory contains neither
  `formatTooltip` nor `makeTestSnapshot`, and `statusbar.test.ts` still passes — proving they
  were dead rather than load-bearing.
- **A7 — the docstrings tell the truth.** `core-bridge.ts` no longer claims to exist for
  `statusbar.test.ts` to mock.

## Risks

- **A1's invariant is stated over *mocked* modules, so it goes quiet as soon as nothing mocks a
  module.** After this change `core-bridge.js` has two non-test importers and zero mockers, so
  A1 says nothing about it — correctly, but it means A1 does not protect `core-bridge.js` from
  *becoming* mocked by a future test and re-breaking `extension.ts`. It would catch that the
  moment it happened, which is the honest scope: it is a tripwire, not a prohibition.
- **The `formatTooltip` stub removal is the one behavioural change to an existing test.** If any
  statusbar assertion depended on it, A6 goes red — which is the point of stating A6 as "and
  still passes" rather than just "is removed".
- **This does not make `extension.ts` tested.** It removes one obstacle. Loop 001's finding
  stays open and is out of scope.
