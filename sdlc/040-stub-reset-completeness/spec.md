# Spec: a reset that is complete by construction, and a gate that requires it

- **ID:** 040-stub-reset-completeness
- **Stage:** 2 — Design
- **Status:** revision 1 — first draft REJECTED by the Stage 2 review on its scoping
- **Derived from:** [`intent.md`](./intent.md)

## Summary

`resetVscodeStub()` stops naming leaves and starts restoring them from a snapshot taken once at
module load, so a leaf added to `vscodeStub` tomorrow is covered the day it is added — with the one
class of leaf that a snapshot cannot cover (a `mock()`'s implementation) registered at its
construction site rather than in a list kept somewhere else, and a reset that throws by name if that
registration is ever missing. `vscodeStubCover` gains one assertion: every file that imports
`vscodeStub` also calls `resetVscodeStub()` from inside a `beforeEach`. `tooltip.test.ts` starts
calling it. Three stale docstrings stop claiming more than the code does.

## What the measurements decided

The first draft was **rejected** on this section. It measured three routes, all **within a single
test file**, and concluded that top-level leaves are unreachable. They are not, and the route it
missed is the one this package executes on every run.

| Measured | Result | Consequence for the design |
|---|---|---|
| Replace the whole `vscodeStub` object, read it through a module that already resolved it | consumer still sees the **old** object | Rebuilding ruled out. Restore **in place** |
| `resolved.TopLevel = x` | **throws** — readonly | Not a route |
| `vscodeStub.TopLevel = x` via the direct import, read **in the same file** | succeeds on the object; that file's consumer reads the **original** | Misleading in isolation — see the next row |
| …then read in the **next test file**, which makes its own `mock.module('vscode', …)` call | **CORRUPT** | **A later registration re-syncs top-level exports.** Every test file makes one, so top-level leaves are live hazards |
| `resolved.nested.leaf = x` | succeeds, shared object sees it | Nested leaves are hazards too |
| Plain assignment restore of a corrupted top-level leaf | consumer **still CORRUPT** | Assignment alone is **inert** for top-level |
| …followed by `mock.module('vscode', () => vscodeStub)` | consumer **PRISTINE** | **The reset must re-register** |
| Snapshot-restore of a `mock()` leaf by reference | overridden implementation and call count both **survive** | A snapshot cannot cover a mock's implementation — see step 5 |
| Shallow capture of a nested object, then mutate two deep | the snapshot holds the **live** object and corrupts with it | The capture must **recurse** |

So the at-risk set is all **13 leaves**, of which the current reset restores 6. The seven it does
not: `StatusBarAlignment.Right`, `ThemeColor`, `MarkdownString`, `Uri.parse`,
`env.onDidChangeTelemetryEnabled`, `commands.registerCommand`, `workspace.onDidChangeConfiguration`.

The failure shape is worth stating because it is the loop's whole subject: **the mutating file sees
nothing wrong.** Its own consumer still reads pristine top-level values. The next file pays.

## Behavior

### `resetVscodeStub()`

1. **At module load, once**, capture `PRISTINE` — a **recursive** copy of `vscodeStub`. Recursion
   descends into plain objects only (`v.constructor === Object`); functions, classes and primitives
   are captured by reference or value. `MockThemeColor` must come back as the *same* constructor or
   `instanceof` assertions break. A shallow copy would store the live nested object and the snapshot
   would corrupt itself along with the stub — measured, last row above — and the real `vscode` API is
   deeply nested (`workspace.fs`, `env.clipboard`), so this is not hypothetical for a stub that grows.
2. **On each call**, walk `PRISTINE` and assign every captured value back onto the live object at the
   same path. Assignment, not replacement, at every level — replacing a nested object breaks the
   reference sharing consumers depend on. Assignment also re-adds a leaf a test *deleted*, which the
   first draft neither claimed nor noticed it got for free.
3. **Re-register**: `mock.module('vscode', () => vscodeStub)`, after the walk. Without this, restoring
   a top-level leaf is **inert** — measured. This is the step the first draft did not have, because it
   did not believe top-level leaves needed restoring at all.
4. `mock()` leaves are detected **structurally** — `typeof v === 'function' && 'mockReset' in v` — and
   `mockReset()` is called on each, so a mock added tomorrow has its call history *and* any
   `mockImplementation` override dropped without anyone naming it. `mockReset`, not `mockClear`:
   measured on bun 1.3.11, `mockClear()` preserves an overridden implementation.
5. **Implementations are registered at the construction site, not in a separate list.** `mockReset()`
   drops the implementation, so something has to put it back, and a snapshot cannot read it out of a
   bun mock. The stub therefore builds its mock leaves through one helper:

   ```ts
   function stubMock<F extends (...args: never[]) => unknown>(path: string, impl: F): ReturnType<typeof mock<F>>
   ```

   which records `path -> impl` as it creates the mock. The reset walks to a mock leaf at path `P`,
   resets it, and reinstalls `impls.get(P)`. The implementations close over the module-level `state`
   variable and read it when called, so a rebuilt `state` is picked up with no re-registration.

   **If a mock leaf is found at a path with no registration, the reset throws, naming the path.** That
   is the difference between this and the six-of-thirteen list it replaces: the old list went stale in
   silence, this one cannot. A `mock()` written directly into the stub literal, or a `stubMock` whose
   path string disagrees with where it was assigned, fails every test in the package on the first
   `beforeEach` with the offending path in the message.
6. `state` is rebuilt and returned, unchanged from today.

**One limit, stated rather than left to a reviewer.** A leaf that is not writable (a getter) makes the
walk throw partway, so the reset is non-atomic: earlier keys are restored, later ones are not. Loud
rather than silent, and one sentence here rather than a discovery later.

**One thing the reset deliberately does not do**, with its compensating controls named rather than
left as a bare declination: it does not **delete** keys a test *adds*. Two existing checks cover that
case from opposite sides — a leaked added key makes the adding file's neighbours pass in-suite and
fail run-alone, which `every vscode test file passes run alone` catches; and a source file that starts
*depending* on such a key fails `vscodeStubCover` statically, because the key is not in the
`vscodeStub` literal the coverage walker reads.

### `vscodeStubCover`

One new check: every `packages/vscode/src/*.test.ts` that imports `vscodeStub` must also call
`resetVscodeStub()` **from inside a `beforeEach`**. A file that imports without resetting, or that
resets only at module scope, is a failure naming the file.

The predicate is **AST**, not text: a `ts.CallExpression` whose callee is the identifier bound by an
import from `./vscode-stub.js`, including under an alias (`import { resetVscodeStub as r }`), with an
enclosing function that is an argument to a call named `beforeEach`. A `resetVscodeStub()` inside a
comment or a string literal does not count — the same rule the script's own docstring already states
for the coverage walker, and the same one its "comments and string literals contribute nothing" test
already asserts. A1 of that pair is criterion A12 below.

The first draft declined the `beforeEach` half, arguing it was "a different and much larger claim" —
and then cited, in its own parenthetical, loop 039 having to delete a module-scope call by hand. The
review was right that the parenthetical argues against the decision it is attached to: a gate
satisfiable by a module-scope call certifies as safe the exact arrangement 039 had to remove, and this
loop's premise is that a documented convention did not hold. Walking up to an enclosing `beforeEach` is
the same shape as the existing `accessParent` helper.

### `tooltip.test.ts`

Gains a `beforeEach` calling `resetVscodeStub()`, and its stale comment goes with it.

Under the first draft this change would have been **inert** for the one thing the file actually uses:
`MarkdownString` is top-level, the draft did not restore top-level leaves, and without re-registration
a restore would not have reached `tooltip.ts` anyway. It would have satisfied the new gate and bought
nothing — a test named for a guard it does not exercise, in the loop that exists to remove those. With
steps 2 and 3 above it is real.

## Data and types

The new tests live in **`packages/vscode/src/vscode-stub.test.ts`**, next to their subject as this
repo's convention requires. Three consequences, all of which this spec carries rather than discovers:
the package has **seven** test files, not six; the run-alone baseline and total change accordingly (see
Backward compatibility); and the new gate check applies to the file itself, which therefore calls
`resetVscodeStub()` in a `beforeEach` like every other importer. Its cross-file criterion (A11) spawns
`bun test` over a temp fixture tree rather than adding fixture files to `packages/vscode/src`.

`vscode-stub.ts` gains three exports, all for the tests and labelled as such:

```ts
/** Leaves captured at load. Recursive: `{ env: { isTelemetryEnabled: false, … }, … }`. */
export type Pristine = Record<string, unknown>;
/** Recursive capture. Descends into plain objects only; functions and classes by reference. */
export function captureLeaves(obj: Record<string, unknown>): Pristine;
/** Walk-and-assign restore. Throws, naming the path, on a mock leaf with no registered impl. */
export function restoreLeaves(obj: Record<string, unknown>, pristine: Pristine, impls: Map<string, (...a: never[]) => unknown>): void;
/** The leaf paths the reset restores, for the docstring-equality check (A9). */
export function pristineLeafPaths(): string[];
```

`resetVscodeStub()`'s own signature is unchanged; it returns `StubState` as before. `vscodeStub`'s
shape is unchanged — only how its two `mock()` leaves are constructed. No product source changes.
`scripts/vscode-stub-cover.ts` gains one exported predicate and one CLI check.

## Edge cases

| Case | Expected |
|---|---|
| A test overwrites `Uri.parse`, then the next test runs | `Uri.parse` is the pristine function again |
| A test overwrites `MarkdownString` (top-level), then the **next file** runs | pristine — this is the case re-registration exists for |
| A test overwrites `commands.registerCommand` | restored |
| A leaf is **added** to `vscodeStub` and no test is changed | covered by the reset automatically — this is the point |
| A **two-deep** leaf is added (`workspace.fs.readFile`) | covered; the capture recurses |
| A **`mock()` leaf** is added through `stubMock` | covered; history cleared, implementation reinstalled |
| A `mock()` leaf is added **without** `stubMock`, or with a wrong path | the reset **throws** on the first `beforeEach`, naming the path. Not silent, which the list it replaces was |
| A leaf is **removed** from `vscodeStub` | `PRISTINE` no longer captures it; nothing to restore; no error |
| A test **deletes** a leaf | re-added by the walk. Free, and now claimed |
| A test adds a key that was never in the stub | **not** removed by the reset; two compensating controls named in Behavior |
| A test replaces a whole nested object (`resolved.env = {}`) | throws — `env` is top-level and readonly. Not a case the reset must handle |
| A non-writable (getter) leaf is added | the walk throws partway; the reset is non-atomic and says so |
| A test file imports `vscodeStub` but never resets | `vscodeStubCover` fails, naming the file |
| A test file's only `resetVscodeStub()` is in a comment or a string | fails — the predicate is AST |
| A test file resets only at module scope, not in `beforeEach` | fails — this is the arrangement 039 removed by hand |
| `vscode-stub.test.ts` itself | imports and resets in `beforeEach`; passes its own gate |
| A test file resets but does not import | not a failure; nothing to check |
| `manifest.test.ts` / `telemetry-gate.test.ts` — neither imports nor resets | unaffected |

## Backward compatibility

- No product source changes. No changed exported signature; three added exports.
- The six existing vscode test files keep their counts: commands 5, extension 20, statusbar 29,
  tooltip 10, manifest 6, telemetry-gate 7 — **77 together**. The seventh file adds its own count on
  top; the total after the change is recorded in `review.md` rather than guessed here.
- The three files that already reset keep working with no edit. Their `beforeEach` bodies do not change.
- **`scripts/vscode-stub-cover.test.ts`'s own fixtures are the callers most likely to break, and do
  not.** Three of them write a `thing.test.ts` whose body is `mock.module('vscode', () => vscodeStub);`
  — a *reference* to `vscodeStub` with no import and no reset. Under the import-binding predicate they
  are not importers and the new check does not apply. Under a text predicate all three would start
  failing, which is a second reason the predicate is AST.
- **Risk this spec names rather than hides (1):** a blanket restore touches leaves nothing previously
  restored. If any current test depends on a leaf *staying* mutated across tests within its own file,
  it will now break. That would be a latent order-dependence worth surfacing, and A2 is the criterion
  that would surface it.
- **Risk this spec names rather than hides (2):** the reset now calls `mock.module` once per
  `beforeEach` — roughly seventy times per package run. The measured cost is recorded in `review.md`;
  if it is not negligible, that is a finding, not a silence.

## Acceptance criteria

- [ ] **A1 — every reachable leaf is restored, enumerated not listed.** `vscode-stub.test.ts` ›
      *"restores every leaf of vscodeStub"* walks `vscodeStub`'s leaves recursively, and for **each
      one**: records the original, writes a sentinel, **asserts the write changed the value** (so a
      sentinel that happens to equal the original — `env.isTelemetryEnabled` is `false` — cannot pass
      vacuously), calls `resetVscodeStub()`, and asserts identity with `toBe` against the recorded
      original rather than inequality against the sentinel. It asserts the walk found **at least 13**
      leaves, so an enumeration that silently found nothing cannot pass. Verified by `bun test`.
- [ ] **A2 — it discriminates against today's reset.** Copy `vscode-stub.ts` and `vscode-stub.test.ts`
      to a temp dir, revert the stub to its pre-change body (`git show HEAD:…`), and run `bun test
      vscode-stub.test.ts` there. The failure output must name all **seven** unrestored leaves —
      `StatusBarAlignment.Right`, `ThemeColor`, `MarkdownString`, `Uri.parse`,
      `env.onDidChangeTelemetryEnabled`, `commands.registerCommand`, `workspace.onDidChangeConfiguration`
      — and no others. Command and output recorded in `review.md`.
- [ ] **A3 — the snapshot covers what it claims, and says so where it does not.** `vscode-stub.test.ts`
      exercises `captureLeaves`/`restoreLeaves` against three fixture objects, so the criterion does not
      require editing the real stub: **(a)** a one-deep plain leaf — restored; **(b)** a **two-deep**
      leaf — restored, which is the case a shallow capture fails and the case that made B3 blocking;
      **(c)** a `mock()` leaf with an **overridden implementation and a non-zero call count** —
      registered through `stubMock`, its history is cleared and the original implementation is back;
      **not** registered, `restoreLeaves` throws and the assertion is on the thrown path name.
- [ ] **A4 — both mock leaves are reset AND reimplemented.** After a reset: `createStatusBarItem` has
      no recorded calls and still returns the **current** `state.item`; and `getConfiguration('x')
      .get(k, d)` reads the **new** `state.configValues`, asserted by setting a key on the state the
      reset returned and reading it back. A `mockImplementation` override installed before the reset
      does not survive it. Restoring the function reference alone satisfies a weaker version of this
      and leaves both implementations pointing at a stale `state`. Verified by `bun test`.
- [ ] **A5 — an importer that does not reset fails the gate.** `vscode-stub-cover.test.ts` builds a
      fixture tree with one builder and asserts the CLI exits non-zero **and that stderr contains the
      reset check's own message text**, naming the file — not merely that the status is non-zero, since
      the CLI has four other independent failure paths.
- [ ] **A6 — an importer that does reset, in a `beforeEach`, passes.** The positive control, from the
      **same builder as A5, differing in exactly one line** — the `resetVscodeStub()` call. Without it
      A5 passes for any reason the CLI fails. Verified by `bun test`.
- [ ] **A7 — the real tree passes, and would not have.** `bun run vscodeStubCover` exits 0 on the
      checked-in tree once `tooltip.test.ts` resets. Negative: copy `packages/vscode/src` to a temp dir,
      delete `tooltip.test.ts`'s reset, run `bun run scripts/vscode-stub-cover.ts <temp dir>` — exits
      non-zero and names `tooltip.test.ts`. Both commands and outputs recorded in `review.md`.
- [ ] **A8 — every vscode test file still passes run alone, and still runs the tests it used to.**
      `every vscode test file passes run alone` is extended to parse `pass`/`fail`/`skip` from each
      run's output and assert `fail === 0`, `skip === 0`, and `pass >= ` a recorded per-file floor.
      Today it asserts only the exit status, and a `.test.ts` containing no tests at all exits 0 — so a
      dropped `describe` or a `test.skip` slipped in to make a leaf restore pass is currently invisible.
      A floor rather than an equality so that adding tests never reddens it while deleting them does.
      Now **seven** files. Verified by `bun test`.
- [ ] **A9 — three docstrings say what the code does, checked mechanically.** A test asserts
      `pristineLeafPaths()` equals the leaf-path set a walker finds in `vscodeStub`, asserts the union
      is non-empty, and asserts `vscode-stub.ts`'s module docstring states **that equality** rather than
      a leaf count. The phrase pin on the removed claim ("it is the only place that knows this stub's
      pristine shape") is a secondary check only, and ships with a **positive control** proving the
      pattern matches the text the claim actually had — this repo already knows a bare
      `not.toContain` is green forever after a typo. Scope is three sites, not one:
      `vscode-stub.ts`'s module docstring, `resetVscodeStub`'s own docstring (*"Restores the two leaves
      tests overwrite"* — stale by four before this change and by eleven after it), and
      `tooltip.test.ts:6-7` (*"This file depends on nothing mutable in it, so it needs no reset"*),
      which is the sentence a future author reads.
- [ ] **A10 — the gate is green.** `bun run verify` exits 0; the `oxlint` warning set is unchanged
      against `.oxlint-budget.json`.
- [ ] **A11 — corruption does not cross a file boundary.** Two fixture test files in a temp tree, each
      installing a verbatim copy of the real `vscode-stub.ts`, each importing a consumer module that
      does `import * as vscode`. Both files have the **same shape**: a `beforeEach` calling
      `resetVscodeStub()`, then one test that asserts the **consumer** reads pristine values for one
      top-level and one nested leaf and then mutates both through the direct import. Symmetric, so the
      criterion does not depend on bun's file order, which is not argument order. Run `bun test <f1>
      <f2>`; assert exit 0. Without the re-registration of step 3 this fails on the top-level leaf;
      without the nested restore it fails on the nested one. This is the intent's second done-item, and
      the axis on which the first draft's central error lived: every other criterion is a within-test,
      on-the-object round-trip, true by construction for nested leaves and silent about consumers.
- [ ] **A12 — a commented-out call does not satisfy the gate.** A fixture whose only occurrence of
      `resetVscodeStub()` is inside a comment, and a second whose only occurrence is inside a string
      literal, both fail. Verified by `bun test`.
- [ ] **A13 — an unregistered mock leaf fails loudly.** Covered by A3(c)'s third fixture, stated
      separately because it is the criterion that keeps step 5's registry from becoming the list this
      loop exists to delete: the failure must name the leaf path, and it must happen on the first
      reset rather than on the first test that depends on the implementation.

**Which of these discriminate.** A2, A5, A7, A12 fail against the tree as it stands. A1, A3, A4, A11,
A13 fail against a plausible wrong implementation of this spec — A11 against the first draft of this
one. A6, A8, A9, A10 are fences, controls and state assertions.

*(The line "A1 without A2 is not evidence" was cut from A2's body: it is review policy, not a
criterion, and belongs in `REVIEW.md`. Adding it there is a harness change and is recorded as a
follow-up rather than smuggled into this fence — the split loop 033 was opened to protect.)*

## Rejected alternatives

- **Rebuild the whole `vscodeStub` object on reset.** The obvious structural fix, and **measured to not
  work**: a module that resolved the specifier keeps the original reference, so the consumer reads the
  pre-rebuild object. This is why the spec restores in place.
- **Keep naming leaves, just name all thirteen.** Correct today and stale on the first leaf anyone adds
  — which is precisely how the current six-of-thirteen arose. The bug is the enumeration, not its
  contents.
- **Keep the implementation registry as a separate list keyed by leaf path.** The first revision's
  answer to the mock problem, and it re-creates the defect at a smaller size: a list somewhere else,
  hand-maintained, silently stale. Registering at the construction site plus a reset that throws on an
  unregistered mock leaf costs the same few lines and cannot go quiet.
- **Freeze the stub so nothing can mutate it.** `commands.test.ts` installs recording sinks by mutation
  and has no other route to observe those calls; freezing breaks the arrangement the consolidation
  deliberately kept.
- **Give each test file its own stub object.** This is the four-factory design `sdlc/039` removed, and
  the load-order measurement says it does not work: one object is resolved per specifier no matter how
  many factories run.
- **Declining to check that the reset sits in a `beforeEach`.** The first draft's position. Rejected on
  its own parenthetical: a gate satisfiable at module scope certifies the arrangement 039 deleted by
  hand, and this loop exists because a documented convention did not hold.
- **Declining to restore top-level leaves.** The first draft's position, on a measurement taken inside
  one file and generalised to a package. Refuted by the two-file reproduction: a later `mock.module`
  re-syncs top-level exports, so all 13 leaves are live hazards and a plain assignment restore of one
  is inert.

---

**Next stage:** Build — run `/sdlc-plan 040-stub-reset-completeness` to turn this into `plan.md`.
