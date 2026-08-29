# Plan: one shared `vscode` stub, and a gate step that keeps it one

- **ID:** 039-vscode-stub-model
- **Stage:** 3 — Build
- **Status:** draft
- **Derived from:** [`spec.md`](./spec.md) (revision 1 — the first draft's union model was rejected)
- **Branch:** `claude/ai-sdlc-setup-plan-nqyqbk`

## Approach

Two halves, in this order, because the second is only meaningful once the first lands.

1. **Consolidate.** A new `packages/vscode/src/vscode-stub.ts` exports a single stub object and a
   `resetVscodeStub()`. All four test files replace their inline factories with
   `mock.module('vscode', () => vscodeStub)` and call `resetVscodeStub()` in `beforeEach`. Load
   order stops mattering because there is nothing left for it to choose between.
2. **Guard.** A new `scripts/vscode-stub-cover.ts`, added to `verify` as the package script
   `vscodeStubCover`, asserts (a) exactly one `mock.module('vscode', …)` factory body exists in
   the package, and (b) it provides every `vscode` member the source uses in a value position,
   classified with the TypeScript compiler API.

### The risk the spec did not anticipate, and the design that answers it

Consolidation is not simply "hoist the object". `commands.test.ts:75-90` **mutates the resolved
module's nested properties in `beforeEach`** — replacing `window.showInformationMessage` and
`env.openExternal` with recording sinks — and restores them in `afterEach`. `statusbar.test.ts`
closes over module-level `mockItem` and `configValues`, rebuilt per test. Those work today partly
*because* each file supplies its own object and only one wins.

Point all four at one singleton and every such mutation becomes visible to every other file. A
naive consolidation therefore **converts an accidental coupling into a shared mutable global** —
worse, not better, and it would pass a coverage check happily.

So the shared module owns the reset:

- `vscodeStub` is a single exported object — the one thing `mock.module` ever returns.
- `resetVscodeStub()` restores every mutable leaf to a known value and installs a fresh status-bar
  item, returning handles the tests need (`{ item, configValues }`).
- Every test file calls it in `beforeEach`. `commands.test.ts`'s save/restore `afterEach` becomes
  unnecessary and is deleted — the reset subsumes it — but only once `A1b` proves each file still
  passes **run alone**, which is the property that would break first if the reset is incomplete.

The alternative — keep per-file objects and check per-file completeness — was rejected in
`spec.md` because it makes four identical objects. That reasoning holds, and this section is the
cost of the choice, written down rather than discovered in Stage 5.

## Scope fence

```
packages/vscode/src/vscode-stub.ts
packages/vscode/src/statusbar.test.ts
packages/vscode/src/tooltip.test.ts
packages/vscode/src/extension.test.ts
packages/vscode/src/commands.test.ts
scripts/vscode-stub-cover.ts
scripts/vscode-stub-cover.test.ts
scripts/verify.ts
scripts/env.test.ts
package.json
.oxlint-budget.json
sdlc/039-vscode-stub-model/intent.md
sdlc/039-vscode-stub-model/spec.md
sdlc/039-vscode-stub-model/plan.md
sdlc/039-vscode-stub-model/review.md
```

`scripts/env.test.ts` is fenced because `verify`'s sandbox stubs every step **by script name**;
adding a step without adding it there turns the four sandbox cases red. `verify.ts` records that
trap in its own comment and `sdlc/033` shipped it wrong once. `package.json` is fenced for the
same reason — steps are package scripts, not `scripts/*.ts` paths.

Note the `inFence` basename-tail trap from loops 033 and 035: `package.json` on the fence matches
every committed manifest. Only the root one is intended, and `review.md` states which were
actually touched.

**Explicitly not touched:** every non-test `.ts` under `packages/vscode/src` (`extension.ts`,
`commands.ts`, `statusbar.ts`, `tooltip.ts`, `core-bridge.ts`, `extension-bridge.ts`,
`telemetry-gate.ts`), `packages/vscode/src/telemetry-gate.test.ts` (it mocks nothing and its
subject never imports `vscode`), `packages/core/**`, `packages/statusline/**`, `packages/metrics/**`,
`scripts/mock-topology.ts` (loop 026 built R1/R2 against specific observations; this loop does not
edit them), `SPEC.md`, `CLAUDE.md`, `deploy/**`, and `manifest.test.ts` (it mocks nothing).

## Changes

### `packages/vscode/src/vscode-stub.ts` (new)

- Exports `vscodeStub`, one object carrying every member the source needs as a value.
- Exports `resetVscodeStub(): { item: MockStatusBarItem; configValues: Record<string, unknown> }`,
  which rebuilds the status-bar item, empties `configValues`, and restores every leaf the tests
  are known to overwrite. It is the *only* place that knows the stub's pristine shape.
- Carries the load-order finding as its docstring, with the reproduction: remove `Uri` from three
  stubs, keep it in `extension.test.ts`, and the package fails 5 tests on `v.Uri.parse` while the
  union still contains `Uri`. That is why there is one object, and it is the thing a future author
  will want to un-know.
- Not a `*.test.ts`, so `bun test` will not try to run it; it is imported, never mocked, so
  `mock-topology.ts` has nothing to say about it.

### The four `*.test.ts` files

- Replace each inline factory with `mock.module('vscode', () => vscodeStub)`.
- `beforeEach` calls `resetVscodeStub()` and uses the returned handles.
- `statusbar.test.ts` drops its local `mockItem` / `configValues` module state in favour of those.
- `commands.test.ts` drops the `restore` array and its `afterEach`; the reset replaces it. Its
  three probe docstrings are rewritten to describe the consolidated arrangement, and the two
  `showErrorMessage` claims in `statusbar.test.ts:82` and `tooltip.test.ts:33` are corrected —
  `commands.ts` reaches `showInformationMessage`, `env.openExternal` and `Uri.parse`, and
  `showErrorMessage` appears in no source file (A10, A17).
- Every existing assertion stays. A test whose behaviour changes is a finding, not an adjustment.

### `scripts/vscode-stub-cover.ts` (new)

- `requiredMembers(program)` — TypeScript compiler API, `ts.forEachChild` with `ts.isTypeNode`,
  classifying **per occurrence** and unioning, over `packages/vscode/src/**/*.ts` minus tests.
  Per-occurrence because `tooltip.ts:39` and `:40` use `MarkdownString` in both positions two lines
  apart, and a per-member classifier would drop it.
- `providedMembers(stubSource)` — top-level keys and first-level sub-keys of the shared stub. A key
  whose value is literally `undefined` or `null` does **not** count as provided (A16); that is the
  shape both of this loop's real mutations produced.
- `factoryCount(testSources)` — how many `mock.module('vscode', …)` call sites supply a factory
  body of their own. Must be exactly 1 (A15).
- `compare()` → `{ required, provided, missing, surplus }`. Missing fails and names the member and
  the source file requiring it; surplus prints and does not fail.
- CLI exits non-zero on any missing member or a factory count other than 1 (A13).

### `scripts/verify.ts`, root `package.json`, `scripts/env.test.ts`

- `vscodeStubCover` added to `STEPS` between `fenceCheck` and `test`, as a package script;
  declared in root `package.json`; added to `env.test.ts`'s sandbox `scripts` map (A12, A14).

## Tests

| Criterion | Test | File |
|---|---|---|
| A1 | `bun run verify` exits 0 | — (the gate) |
| A1b | `every vscode test file passes run alone` | `scripts/vscode-stub-cover.test.ts` |
| A2 | `a stub missing a required member fails, naming it` | `scripts/vscode-stub-cover.test.ts` |
| A3 | `the failure names the source file that requires the member` | `scripts/vscode-stub-cover.test.ts` |
| A4 | `a type-only reference is not required` | `scripts/vscode-stub-cover.test.ts` |
| A5 | `a constructed reference is required` | `scripts/vscode-stub-cover.test.ts` |
| A5b | `the same member in both positions is required` | `scripts/vscode-stub-cover.test.ts` |
| A6 | `comments and string literals contribute nothing` | `scripts/vscode-stub-cover.test.ts` |
| A7 | `a surplus member does not fail` | `scripts/vscode-stub-cover.test.ts` |
| A8 | `no stub at all fails loudly` | `scripts/vscode-stub-cover.test.ts` |
| A9 | `a bare parent does not satisfy a sub-key requirement` | `scripts/vscode-stub-cover.test.ts` |
| A10 | `the two corrected docstrings say what the code does` | `scripts/vscode-stub-cover.test.ts` |
| A12 | `verify's STEPS contains vscodeStubCover and package.json declares it` | `scripts/vscode-stub-cover.test.ts` |
| A13 | `a missing member makes the CLI exit non-zero` | `scripts/vscode-stub-cover.test.ts` |
| A14 | env sandbox cases still pass | `scripts/env.test.ts` (existing) |
| A15 | `two inline factories fail, naming both files` | `scripts/vscode-stub-cover.test.ts` |
| A16 | `a key defined as undefined is not provided` | `scripts/vscode-stub-cover.test.ts` |
| A17 | `commands.ts requires showInformationMessage and not showErrorMessage` | `scripts/vscode-stub-cover.test.ts` |
| A11 | lint budget unchanged | — (the gate) |

**A1b is the one that matters most** and is the only criterion about the consolidation rather
than the checker. It shells out to `bun test <file>` for each of the **six** vscode test files —
`commands`, `extension`, `statusbar`, `tooltip`, `manifest`, `telemetry-gate` — and asserts each
exits 0. It enumerates the directory rather than a hard-coded list, so a seventh file is covered
the day it appears; the count is asserted so an empty glob cannot pass vacuously. If `resetVscodeStub()` is incomplete, the single-file runs are where it
shows — and a suite-wide run can hide it, which is the whole history of this package.

## Verification

```
bun test scripts/vscode-stub-cover.test.ts
bun test packages/vscode/src/            # together
for f in commands extension statusbar tooltip manifest telemetry-gate; do bun test packages/vscode/src/$f.test.ts; done
bun run verify
```

Mutation predictions, written before running:

| # | Mutation | Prediction |
|---|---|---|
| M1 | Remove `Uri` from `vscode-stub.ts` | A2/A13 fail naming `Uri.parse`; `commands.test.ts` also goes red — the two now agree, which is the point |
| M2 | Add a second inline `mock.module('vscode', …)` to `tooltip.test.ts` | A15 fails, naming both files; nothing else |
| M3 | Set `Uri: undefined` in the stub | A16 fails; a key-collecting scanner without the undefined rule would pass |
| M4 | Classify per member instead of per occurrence | A5b fails, A4 and A5 still pass — the gap the first spec's disjoint fixtures would have missed |
| M5 | Drop the comment/string stripping | A6 fails, and A17 fails too, because the docstrings mention `showErrorMessage` |
| M6 | Remove `vscodeStubCover` from `STEPS` but leave the script | A12 fails; `verify` still exits 0, which is exactly why A12 exists |
| M7 | Make the CLI always `process.exit(0)` | A13 fails; A1 and A11 both still pass |
| M8 | Empty `resetVscodeStub()`'s body | A1b fails on at least one file; predicted specifically because a suite-wide run may stay green |
| M9 | Accept a bare parent key as satisfying `parent.child` | A9 fails |

## Risks

- **The consolidation is the risky half, not the checker.** Every finding in Stage 5 should be
  weighted accordingly. `A1b` and the four-file suite run are the evidence; the coverage check
  proves nothing about whether the tests still test what they did.
- **A shared singleton is a shared mutable global.** Addressed by `resetVscodeStub()`, and M8 is
  the mutation that says whether the address holds.
- **`mock.module` is process-wide and `mock.restore()` does not undo it** (`mock-topology.ts`).
  Nothing here mocks a local module, so R1/R2 stay silent — but if a future edit makes
  `vscode-stub.ts` itself a mock target, the guard should and will complain.
- **Looked fine locally, broke in CI:** the likeliest candidate is `A1b` shelling out to `bun test`
  and inheriting a different working directory. Paths are resolved from `import.meta.dir`.
- **`bun test` file ordering is not alphabetical** — measured this loop as
  `statusbar, telemetry-gate, manifest, extension, commands, tooltip`. No test may depend on it,
  and `A1b` exists partly to prove none does.

---

**Next stage:** Build/Test — run `/sdlc-implement 039-vscode-stub-model` to write the diff.
