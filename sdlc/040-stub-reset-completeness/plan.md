# Plan: snapshot the stub, register implementations by identity, make the gate require the reset

- **ID:** 040-stub-reset-completeness
- **Stage:** 3 — Build (planning half)
- **Derived from:** [`spec.md`](./spec.md) (ACCEPTED at Stage 2, revision 2)

## Approach

Three separable pieces, in this order, because each later one depends on the earlier one existing:

1. **`vscode-stub.ts`** gains a load-time snapshot, an identity-keyed implementation registry, and a
   `resetVscodeStub()` that walks and re-registers. Four new exports, all for the tests.
2. **`vscode-stub.test.ts`** (new) carries the criteria that are about the reset itself.
3. **`vscode-stub-cover.ts`** gains the reset check; **`vscode-stub-cover.test.ts`** carries the
   criteria that are about the gate, and its run-alone test grows a count floor.

`tooltip.test.ts` picks up its `beforeEach` last, because until step 3 lands there is no gate
demanding it and the change is inert without step 1's re-registration.

### The one thing that must not be got wrong

`impls` is keyed by the **mock object**, not by a path string. The Stage 2 review measured what a
string key costs: a bijective permutation of two paths leaves every path registered exactly once, so
a missing-registration check never fires and the two implementations swap at the first reset —
correct before the first `beforeEach` and wrong after it. There is no test that can catch a
permutation, because there is no wrong state to observe until the reset runs. With the object as the
key the arrangement is not expressible. **A future simplification of `Map<object, …>` to
`Map<string, …>` is a regression, and this paragraph is the reason.**

## Scope fence

```
packages/vscode/src/vscode-stub.ts
packages/vscode/src/vscode-stub.test.ts
packages/vscode/src/tooltip.test.ts
scripts/vscode-stub-cover.ts
scripts/vscode-stub-cover.test.ts
.oxlint-budget.json
sdlc/040-stub-reset-completeness/intent.md
sdlc/040-stub-reset-completeness/spec.md
sdlc/040-stub-reset-completeness/plan.md
sdlc/040-stub-reset-completeness/review.md
```

**Explicitly not touched:** `scripts/mock-topology.test.ts`, `scripts/verify.ts`, `package.json`,
`scripts/env.test.ts`, `scripts/fence-check.test.ts`, `packages/vscode/src/extension.ts`,
`packages/vscode/src/statusbar.ts`, `packages/vscode/src/tooltip.ts`,
`packages/vscode/src/commands.ts`, `packages/vscode/src/commands.test.ts`,
`packages/vscode/src/extension.test.ts`, `packages/vscode/src/statusbar.test.ts`

Each for a stated reason:

- **`scripts/mock-topology.test.ts`.** Its pinned inventory of eight `(test file, specifier)` pairs
  would grow if `vscode-stub.test.ts` contained a literal `mock.module('vscode', …)` — `findMocks`
  is a text scan and cannot tell a call from the same characters in a string. A11's fixture text is
  **assembled** the way `scripts/vscode-stub-cover.test.ts:37`'s `factorySrc` already does, so the
  inventory does not grow. Padding it would record a falsehood: this file mocks nothing. Loop 039
  faced the identical choice and made the same call. **If the inventory turns red, the fixture text
  is wrong — do not edit the inventory.**
- **`scripts/verify.ts`, root `package.json`, `scripts/env.test.ts`, `scripts/fence-check.test.ts`.**
  No new verify step: `vscodeStubCover` was wired in by loop 039 and is only gaining a check. The
  loop-033 trap (steps are package scripts, not paths) and the sandbox's stub-by-script-name are
  therefore not in play.
- **Any product source under `packages/vscode/src/`** — `extension.ts`, `statusbar.ts`,
  `tooltip.ts`, `commands.ts` and the three bridges. The intent forbids it. A product defect found
  on the way is recorded in `review.md`, not fixed here.
- **`packages/vscode/src/{commands,extension,statusbar}.test.ts`.** They already reset in
  `beforeEach` and satisfy the new check unchanged. If any needs an edit, that is a finding about
  the design, not a fence amendment to wave through.

Note the `inFence` basename-tail trap from loops 033 and 035: a bare filename on this fence matches
that basename anywhere in the tree. Every entry above is a full path for that reason.

## Changes

### `packages/vscode/src/vscode-stub.ts`

New, above `vscodeStub`:

```ts
const impls = new Map<object, (...args: never[]) => unknown>();
function stubMock<F extends (...args: never[]) => unknown>(impl: F): ReturnType<typeof mock<F>> {
  const m = mock(impl);
  impls.set(m, impl);
  return m;
}
```

`window.createStatusBarItem` and `workspace.getConfiguration` are built with `stubMock(…)` instead
of `mock(…)`. Their bodies are unchanged and still read `state` at call time, so a rebuilt `state`
is picked up with no re-registration.

New, below `vscodeStub`, exported and labelled as test-facing:

- `captureLeaves(obj)` — recursive. Descends into plain objects (`v.constructor === Object`);
  functions, classes, primitives, `null` and `undefined` captured by value or reference. **Throws,
  naming the path, on any other object-valued leaf** (array, `Map`, `Date`, class instance,
  `Object.create(null)`) rather than capturing it by reference, which would make the snapshot the
  live value. Guard `null` **before** reaching for `.constructor` — `typeof null === 'object'`, so a
  naive implementation raises a TypeError instead of the named throw.
- `restoreLeaves(obj, pristine, impls)` — walk-and-assign at every level, never replacing a nested
  object. At a mock leaf (`typeof v === 'function' && 'mockReset' in v`): `mockReset()`, then
  `mockImplementation(impls.get(v))`, **throwing and naming the walked path** when the lookup misses.
- `pristineLeafPaths()` — the leaf paths the snapshot holds, for A9.
- `type Pristine = Record<string, unknown>`.

`const PRISTINE = captureLeaves(vscodeStub)` runs at module load, once. `resetVscodeStub()` becomes:
rebuild `state`, `restoreLeaves(vscodeStub, PRISTINE, impls)`, `mock.module('vscode', () => vscodeStub)`,
return `state`.

Two docstrings are rewritten: the module docstring's "it is the only place that knows this stub's
pristine shape" (now true, and stated as the snapshot equality rather than a leaf count), and
`resetVscodeStub`'s "Restores the two leaves tests overwrite" (stale by four before this change).

### `packages/vscode/src/vscode-stub.test.ts` (new)

Seventh test file in the package. Imports `vscodeStub` and therefore **calls `resetVscodeStub()` in
its own `beforeEach`**, satisfying the gate it is testing. A1/A3/A4/A9/A13 are in-process; A11
spawns. A11 resolves the stub to copy via `import.meta.dir`, **not** an absolute repo path, so that
A2's temp copy exercises the reverted stub rather than the checked-in one.

### `packages/vscode/src/tooltip.test.ts`

Gains `beforeEach(() => { resetVscodeStub(); })` and drops lines 6-7's "This file depends on nothing
mutable in it, so it needs no reset. (sdlc/039)".

### `scripts/vscode-stub-cover.ts`

One exported predicate — a `ts.CallExpression` whose callee is the identifier bound by an import
from `./vscode-stub.js` (aliases included), with an enclosing function that is an argument to a call
named `beforeEach` — and one CLI check over `tests`: a file that imports `vscodeStub` without such a
call fails, naming the file. Reuse `accessParent` for the climb; it already unwraps
`As`/`Paren`/`NonNull`.

### `scripts/vscode-stub-cover.test.ts`

`every vscode test file passes run alone` parses **stderr** (bun writes the summary there) for
`pass`/`fail`/`skip`, asserting `fail === 0`, `skip === 0`, `pass >= floor[file]`, and **failing by
name when a file has no recorded floor**. An absent `skip` line means zero. `files.length` floor
goes `6` → `7`. Plus A5/A6/A12 fixtures from one builder.

## Tests

| Criterion | Where | What makes it discriminate |
|---|---|---|
| A1 | `vscode-stub.test.ts` › restores every leaf | asserts the sentinel write changed the value; `toBe` identity; `>= 13` leaves |
| A2 | Stage 5 manual, recorded in `review.md` | run against a copy with only the reset body reverted |
| A3 | `vscode-stub.test.ts` › capture/restore fixtures | four fixtures: one-deep, two-deep, mock-with-override, array |
| A4 | `vscode-stub.test.ts` › both mocks | `createStatusBarItem` returns the **new** `state.item`; `getConfiguration` reads the **new** `configValues`; a pre-reset override does not survive |
| A5 / A6 | `vscode-stub-cover.test.ts` | one builder, one line different; A5 asserts the reset check's own stderr text |
| A7 | Stage 5 manual, recorded in `review.md` | CLI against a temp copy with tooltip's reset removed |
| A8 | `vscode-stub-cover.test.ts` › run alone | floor map with a **missing-entry failure**; stderr; `>= 7` |
| A9 | `vscode-stub.test.ts` › docstrings | `pristineLeafPaths()` vs `providedMembers()` under the dotted-boundary prefix rule; regexes with positive controls |
| A10 | `bun run verify` | — |
| A11 | `vscode-stub.test.ts` › cross-file | asserts `2 pass` / `0 fail` / `Ran 2 tests across 2 files` on **stderr**, not exit status |
| A12 | `vscode-stub-cover.test.ts` | comment-only and string-literal fixtures |
| A13 | `vscode-stub.test.ts` | unregistered mock throws at first reset; uncoverable container throws at **capture**, i.e. module load |

**Verified before writing the plan, so the plan does not rest on reading:** the capture rule refuses
nothing in today's stub (13 leaves, 0 refused); `providedMembers()`'s 19 members reduce to exactly
those same 13 under the prefix rule; `mockReset()` preserves object identity; `'mockReset' in v` is
true for a bun mock and false for a plain function and a class.

## Mutations, with the prediction written before the run

| # | Mutation | Predicted |
|---|---|---|
| M1 | delete step 3's `mock.module` re-registration | **A11 fails** on the top-level leaf; A1 still passes — the in-file round-trip cannot see it |
| M2 | revert `resetVscodeStub`'s body to the six-leaf list | A1 fails naming the seven (this is A2) |
| M3 | make `captureLeaves` one-deep | A3's two-deep fixture fails; A1 still passes (today's stub is one-deep) |
| M4 | drop `mockImplementation` reinstall, keep `mockReset()` | A4 fails on **both** mock leaves |
| M5 | accept a `resetVscodeStub()` call anywhere, not only in a `beforeEach` | the module-scope fixture passes when it must fail |
| M6 | delete the container throw from `captureLeaves` | A13's array fixture fails |
| M7 | delete the unregistered-mock throw from `restoreLeaves` | A13's raw-`mock()` fixture fails |
| M8 | make the floor lookup default to `0` for an unknown file | A8's missing-floor fixture passes when it must fail |
| M9 | assert only exit status in A11 | A11's dropped-filter fixture passes with one file's coverage |

M1, M5, M8 and M9 are the ones whose absence would be **silent** — each removes a guard while every
existing assertion stays green. Inspect what each mutation actually did before believing its result:
loop 026 produced two mutations that read inert and were real gaps.

## Verification

1. `bun run typecheck` before `bun test` — loop 039 ran them the other way after a rename and read a
   confusing `undefined` instead of a type error.
2. `export CLAUDEWATCH_VERIFY_METRICS=1` then `bun run verify > <file> 2>&1`, always redirected.
3. **Commit only on `exit=0`, gated on the status rather than chained after a `;`** — loop 039
   pushed a red `lintBudget` that way.
4. `.oxlint-budget.json` is on the fence in case the warning set moves; the failure output is the
   corrected file.
5. No VS Code bundle check needed: no `packages/vscode/src/*.ts` product source changes.

## Risks

- **A11 is a subprocess test inside a suite that already spawns.** The consolidation suite runs in
  ~2s against a 120s timeout, so there is headroom, but A11 adds a nested `bun test` to a file that
  `every vscode test file passes run alone` itself spawns. If the wall clock moves materially, that
  is a finding for `review.md`, not something to absorb silently.
- **The gate now applies to the file that tests it.** `vscode-stub.test.ts` must reset in
  `beforeEach` while also calling the reset explicitly inside test bodies. Those do not conflict, but
  a test that needs the *un*-reset state must construct it, not rely on the absence of the hook.
- **`.oxlint-budget.json` moving.** New files usually add warnings; the budget is compared in both
  directions and there is no `--write`.

---

**Next stage:** Build/Test — run `/sdlc-implement 040-stub-reset-completeness`.
