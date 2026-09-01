# Spec: a reset that is complete by construction, and a gate that requires it

- **ID:** 040-stub-reset-completeness
- **Stage:** 2 — Design
- **Status:** draft
- **Derived from:** [`intent.md`](./intent.md)

## Summary

`resetVscodeStub()` stops naming leaves and starts restoring them from a snapshot taken once at
module load, so a leaf added to `vscodeStub` tomorrow is covered the day it is added.
`vscodeStubCover` gains one assertion: every file that imports `vscodeStub` also calls
`resetVscodeStub()`. `tooltip.test.ts` starts calling it. The stub's docstring stops claiming
more than the code does.

## What the measurements decided

Three, all run before this spec was written, and one of them changed its shape.

| Measured | Result | Consequence for the design |
|---|---|---|
| Replace the whole `vscodeStub` object, then read it through a module that already resolved it | consumer still sees the **old** object | Rebuilding is ruled out. The reset must restore **in place** |
| `resolved.TopLevel = x` | **throws** — readonly | Top-level leaves cannot be corrupted through the module |
| `vscodeStub.TopLevel = x` via the direct import | succeeds on the object; consumer still reads the **original** | Top-level leaves cannot be corrupted through the object either — a resolved namespace snapshots them |
| `resolved.nested.leaf = x` | succeeds, shared object sees it | **Nested leaves are the entire hazard** |

So the at-risk set is 11 nested leaves, of which the current reset restores 6. The five it does
not: `StatusBarAlignment.Right`, `Uri.parse`, `env.onDidChangeTelemetryEnabled`,
`commands.registerCommand`, `workspace.onDidChangeConfiguration`.

## Behavior

### `resetVscodeStub()`

1. **At module load, once**, capture `PRISTINE` — for every top-level key of `vscodeStub` whose
   value is a plain object, a shallow copy of that object's own enumerable properties. Top-level
   values that are not plain objects (`ThemeColor`, `MarkdownString`) are not captured: they are
   unreachable per the measurements, and capturing them would imply a restore that cannot matter.
2. **On each call**, for every captured nested key, assign the pristine value back onto the live
   nested object. Assignment, not replacement — replacing a nested object would break exactly the
   reference sharing the consumer depends on.
3. Then the two `mock()` leaves get `mockReset()` and their implementations reinstalled, because
   those close over `state` and a snapshot of the function is not enough to restore *what it does*.
4. Then `state` is rebuilt and returned, unchanged from today.

The function stops containing a list of leaf names. That list is what went stale.

### `vscodeStubCover`

One new check: every `packages/vscode/src/*.test.ts` that imports `vscodeStub` must also contain a
call to `resetVscodeStub()`. A file that imports without resetting is a failure naming the file.

Deliberately **not** checked: that the call is inside a `beforeEach`. The scanner would have to
reason about where a call sits in a test lifecycle, which is a different and much larger claim than
"the file resets at all". A file that calls it once at module scope satisfies this check and is
still wrong — recorded as a limit rather than smuggled in as coverage. (Loop 039 removed exactly
such a module-scope call after the audit found it, so this is not hypothetical.)

### `tooltip.test.ts`

Gains a `beforeEach` calling `resetVscodeStub()`. It is the only importer that does not, and its
documented reason — "depends on nothing mutable" — is a property of what it asserts today rather
than a rule.

## Data and types

```ts
/** Nested-object leaves captured at load: `{ env: { isTelemetryEnabled: false, … }, … }`. */
type Pristine = Record<string, Record<string, unknown>>;
```

No exported signature changes. `resetVscodeStub()` returns `StubState` as before; `vscodeStub`'s
shape is untouched. `scripts/vscode-stub-cover.ts` gains one exported predicate and one CLI check.

## Edge cases

| Case | Expected |
|---|---|
| A test overwrites `Uri.parse`, then the next test runs | `Uri.parse` is the pristine function again |
| A test overwrites `commands.registerCommand` | restored |
| A leaf is **added** to `vscodeStub` and no test is changed | covered by the reset automatically — this is the point |
| A leaf is **removed** from `vscodeStub` | `PRISTINE` no longer captures it; nothing to restore; no error |
| A test adds a key that was never in the stub | **not** removed by the reset. Restoring known leaves is not the same as deleting unknown ones, and pretending otherwise would be a claim the implementation does not make |
| A test replaces a whole nested object (`resolved.env = {}`) | throws — `env` is top-level and readonly. Not a case the reset must handle |
| A test file imports `vscodeStub` but never resets | `vscodeStubCover` fails, naming the file |
| A test file resets but does not import | not a failure; nothing to check |
| `manifest.test.ts` / `telemetry-gate.test.ts` — neither imports nor resets | unaffected |

## Backward compatibility

- No product source changes. No exported signature changes.
- Every existing assertion must still pass, alone and together, with the per-file counts unchanged
  from the recorded baseline: commands 5, extension 20, statusbar 29, tooltip 10, manifest 6,
  telemetry-gate 7; **77 together**.
- The three files that already reset keep working with no edit. Their `beforeEach` bodies do not
  change.
- **Risk this spec names rather than hides:** a blanket restore touches leaves nothing previously
  restored. If any current test depends on a leaf *staying* mutated across tests within its own
  file, it will now break. That would be a latent order-dependence worth surfacing, and A2 is the
  criterion that would surface it.

## Acceptance criteria

- [ ] **A1 — every reachable leaf is restored, enumerated not listed.** A test walks `vscodeStub`'s
      nested leaves, and for **each one**: records the original, overwrites it, calls
      `resetVscodeStub()`, asserts it is back. It asserts the leaf count is at least 11, so an
      enumeration that silently found nothing cannot pass. Verified by `bun test`.
- [ ] **A2 — it discriminates against today's reset.** The same test run against the current
      leaf-naming implementation fails on the five unrestored leaves. Verified by running it, with
      the failing leaf names recorded in `review.md`. A1 without A2 is not evidence.
- [ ] **A3 — a leaf added to the stub is covered without touching the reset.** A fixture object with
      a leaf the reset never named is restored. Verified by `bun test` on the snapshot helper
      directly, so the criterion does not require editing the real stub.
- [ ] **A4 — the mocks are reset AND reimplemented.** After a reset, `createStatusBarItem` has no
      recorded calls and still returns the current `state.item`. Verified by `bun test`. Restoring
      the function reference alone would satisfy a weaker version of this and leave the
      implementation pointing at a stale `state`.
- [ ] **A5 — an importer that does not reset fails the gate.** A fixture test file importing
      `vscodeStub` with no `resetVscodeStub()` call makes the CLI exit non-zero, naming the file.
      Verified by `bun test` against a fixture tree.
- [ ] **A6 — an importer that does reset passes.** The positive control; without it A5 passes for
      any reason the CLI fails. Verified by `bun test`.
- [ ] **A7 — the real tree passes.** `bun run scripts/vscode-stub-cover.ts` exits 0 once
      `tooltip.test.ts` resets, and exits **non-zero** before that change. Both recorded in
      `review.md`. Verified by running it.
- [ ] **A8 — every vscode test file still passes run alone**, all six, counts unchanged from the
      baseline. Verified by the existing `every vscode test file passes run alone`.
- [ ] **A9 — the docstring says what the code does.** `vscode-stub.ts` no longer claims the reset
      "is the only place that knows this stub's pristine shape" in a form that outruns it, and the
      claim it does make is checked against the code the way `sdlc/039`'s A17 was — not pinned as
      a phrase. Verified by `bun test`.
- [ ] **A10 — the gate is green.** `bun run verify` exits 0; the `oxlint` warning set is unchanged
      against `.oxlint-budget.json`.

**Which of these discriminate.** A2, A5, A7 fail against the tree as it stands. A1, A3, A4 fail
against a plausible wrong implementation of this spec. A6, A8, A9, A10 are fences and state
assertions. Saying which is which is the part `sdlc/039` had to be told to do.

## Rejected alternatives

- **Rebuild the whole `vscodeStub` object on reset.** The obvious structural fix, and **measured to
  not work**: a module that resolved the specifier keeps the original reference, so the consumer
  reads the pre-rebuild object. This is why the spec restores in place.
- **Keep naming leaves, just name all eleven.** Correct today and stale on the first leaf anyone
  adds — which is precisely how the current six-of-eleven arose. The bug is the enumeration, not
  its contents.
- **Freeze the stub so nothing can mutate it.** `commands.test.ts` installs recording sinks by
  mutation and has no other route to observe those calls; freezing breaks the arrangement the
  consolidation deliberately kept.
- **Give each test file its own stub object.** This is the four-factory design `sdlc/039` removed,
  and the load-order measurement says it does not work: one object is resolved per specifier no
  matter how many factories run.
- **Have the gate check the reset is inside `beforeEach`.** A meaningfully larger claim about test
  lifecycle position. Declined, and the limit is stated in Behavior rather than left for a reviewer
  to find.
- **Also restore top-level leaves.** Measured unreachable by both routes. Restoring them would be
  code whose absence nothing could detect — the definition of a guard that cannot be mutation-tested.

---

**Next stage:** Build — run `/sdlc-plan 040-stub-reset-completeness` to turn this into `plan.md`.
