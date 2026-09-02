# Spec: a reset that is complete by construction, and a gate that requires it

- **ID:** 040-stub-reset-completeness
- **Stage:** 2 — Design
- **Status:** revision 2 — draft REJECTED on scoping, revision 1 REJECTED on two claims it made
  about its own design
- **Derived from:** [`intent.md`](./intent.md)

## Summary

`resetVscodeStub()` stops naming leaves and starts restoring them from a snapshot taken once at
module load, so a leaf added to `vscodeStub` tomorrow is covered the day it is added — with the one
class of leaf that a snapshot cannot cover (a `mock()`'s implementation) registered at its
construction site and keyed by the mock's own identity, so there is no name to get wrong, and a
reset that throws on any leaf it cannot cover. `vscodeStubCover` gains one assertion: every file
that imports `vscodeStub` also calls `resetVscodeStub()` from inside a `beforeEach`. `tooltip.test.ts` starts
calling it. Three stale docstrings stop claiming more than the code does.

## What the measurements decided

Every row below was run. The first draft was rejected on this section for measuring three routes
inside a single test file and concluding that top-level leaves are unreachable; revision 1 was
rejected for two rows that were reasoned rather than run. Rows 10-13 are what forced revision 2;
row 14 is a compatibility measurement the spec had been deferring to `review.md`.

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
| `constructor === Object` on a class instance, a `Map`, an array | **false** for all three | The recursion's rule excludes shapes it would then capture by reference. Step 1 **throws** on them |
| Two `stubMock` path strings swapped (each still registered once) | no throw; the two implementations **swap** at the first reset | A string key is permutable. Key by the mock's **identity** |
| `bun test <a> <nonexistent>` | **exit 0**, `Ran 1 test across 1 file` | A bare argument is a *filter*; one that matches nothing is dropped. A11 must assert counts, not status |
| `./`-prefixed paths, one nonexistent | **exit 0**, still 1 file | The documented path form does **not** fix it |
| Re-registering `mock.module` 70 times, consumer module-level counter | consumer evaluated **once**, counter 1→2→3 | Re-registration does not re-evaluate dependents. This is why the three existing resetters survive |

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

   **Anything the recursion cannot cover makes the capture throw, naming the path.** An object-valued
   leaf that is neither a plain object nor a function — an array, a `Map`, a class *instance* — would
   be captured by reference, which means the snapshot IS the live value and corrupts with it: the
   same failure the recursion exists to prevent, one container up. `constructor === Object` is
   exclusionary and the excluded set is not empty (measured: `false` for a class instance, a `Map`
   and an array), so the exclusion is a refusal rather than a silence. If a future stub needs one of
   those shapes, extending the capture is that change's work, and the throw is what will tell it so.
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
5. **Implementations are registered at the construction site, keyed by the mock's own identity.**
   `mockReset()` drops the implementation, so something has to put it back, and a snapshot cannot read
   it out of a bun mock. The stub therefore builds its mock leaves through one helper:

   ```ts
   function stubMock<F extends (...args: never[]) => unknown>(impl: F): ReturnType<typeof mock<F>>
   ```

   which creates the mock and records `impls.set(theMock, impl)` in a `Map<object, …>`. The reset
   walks to a mock leaf, resets it, and reinstalls `impls.get(thatSameLeaf)`. The implementations
   close over the module-level `state` variable and read it when called, so a rebuilt `state` is
   picked up with no re-registration.

   **Keyed by identity, not by a path string, and that is the whole point.** Revision 1 had
   `stubMock(path, impl)`, and the review found the hole: a *bijective permutation* of two path
   strings — the copy-paste where the second string is edited to another real path rather than left
   duplicated — leaves every path registered exactly once, so a missing-registration check never
   fires, and the two implementations silently swap at the first reset. Correct before the first
   `beforeEach` and wrong after it, which is the worst debugging shape there is. With the mock itself
   as the key there is no name to permute; the arrangement is not expressible.

   **A mock leaf with no registration makes the reset throw, naming the path the walk found it at.**
   The path in that message is derived from the walk rather than from a hand-written string, so it
   names the offending leaf rather than an innocent one. A `mock()` written directly into the stub
   literal fails every test in the package on the first `beforeEach`.
6. `state` is rebuilt and returned, unchanged from today.

**One limit.** A leaf that is not writable (a getter) makes the walk throw partway, so the reset is
non-atomic: earlier keys are restored, later ones are not. Loud rather than silent.

**One thing the reset deliberately does not do**, with its compensating controls: it does not
**delete** keys a test *adds*. Two existing checks cover that
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
/** Recursive capture. Plain objects only; functions and classes by reference; THROWS on any other
 *  object-valued leaf (array, Map, class instance) rather than capturing it by reference. */
export function captureLeaves(obj: Record<string, unknown>): Pristine;
/** Walk-and-assign restore. Throws, naming the walked path, on a mock leaf absent from `impls`. */
export function restoreLeaves(obj: Record<string, unknown>, pristine: Pristine, impls: Map<object, (...a: never[]) => unknown>): void;
/** The leaf paths the reset restores, compared in A9 against an independent AST oracle. */
export function pristineLeafPaths(): string[];
```

`impls` is keyed by `object` — the mock function itself — not by a path string. That type is the
design decision from Behavior step 5, written where a reader will hit it.

`resetVscodeStub()`'s own signature is unchanged; it returns `StubState` as before. `vscodeStub`'s
shape is unchanged — only how its two `mock()` leaves are constructed. No product source changes.
`scripts/vscode-stub-cover.ts` gains one exported predicate and one CLI check.

## Edge cases

| Case | Expected |
|---|---|
| A test overwrites `Uri.parse`, then the next test runs | `Uri.parse` is the pristine function again |
| A test overwrites `MarkdownString` (top-level), then the **next file** runs | pristine — this is the case re-registration exists for |
| A test overwrites `commands.registerCommand` | restored |
| A **plain-object-reachable** leaf is added to `vscodeStub` and no test is changed | covered by the reset automatically — this is the point, stated with the qualifier the first two drafts left off |
| A **two-deep** leaf is added (`workspace.fs.readFile`) | covered; the capture recurses |
| A **`mock()` leaf** is added through `stubMock` | covered; history cleared, implementation reinstalled |
| A `mock()` leaf is added **without** `stubMock` | the reset **throws** on the first `beforeEach`, naming the path the walk found it at |
| A `mock()` leaf is registered under the **wrong name** | not expressible — the registry is keyed by the mock's identity. Revision 1 keyed it by a path string and this row claimed a throw that measurement showed does not happen |
| A leaf is added under an **array, `Map` or class instance** | `captureLeaves` **throws**, naming the path. Not covered, and not silently so — capturing it by reference would make the snapshot the live value |
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
- **Risk:** a blanket restore touches leaves nothing previously
  restored. If any current test depends on a leaf *staying* mutated across tests within its own file,
  it will now break. That would be a latent order-dependence worth surfacing, and A2 is the criterion
  that would surface it.
- **The new test file breaks a pinned inventory unless its fixture text is assembled.**
  `scripts/mock-topology.test.ts:383` pins the exact set of eight `(test file, specifier)` pairs found
  in the real tree, and `findMocks` is a comment-stripped **text** scan that cannot tell a real call
  from the same characters inside a fixture string. A11's fixtures must contain
  `mock.module('vscode', …)`, so writing that literally into `packages/vscode/src/vscode-stub.test.ts`
  adds a ninth pair and turns `bun test` — and therefore A10 — red. **Resolution: assemble it**, as
  `scripts/vscode-stub-cover.test.ts:37`'s `factorySrc` already does (`mock.${'module'}(…)`) and for
  the same recorded reason. The pinned list is not edited; the guard is not weakened.
- **Cost of re-registering, measured rather than deferred.** 70 `mock.module` calls: **10.9 ms and
  22.7 ms** on two independent runs. The two disagree by 2x and neither reproduces the other, so no
  winner is picked — both are ≈0.1% of the 20s test step, and the conclusion does not depend on which
  is right.
- **The axis that could have broken the three existing resetters, and did not.** Re-registration does
  **not** re-evaluate dependent modules: a consumer's module body printed once across three
  `beforeEach` re-registrations while its module-level counter kept incrementing (1, 2, 3). Revision 1
  asserted "the three files that already reset keep working with no edit" without identifying the axis
  on which that could have been false.

## Acceptance criteria

- [ ] **A1 — every reachable leaf is restored, enumerated not listed.** `vscode-stub.test.ts` ›
      *"restores every leaf of vscodeStub"* walks `vscodeStub`'s leaves recursively, and for **each
      one**: records the original, writes a sentinel, **asserts the write changed the value** (so a
      sentinel that happens to equal the original — `env.isTelemetryEnabled` is `false` — cannot pass
      vacuously), calls `resetVscodeStub()`, and asserts identity with `toBe` against the recorded
      original rather than inequality against the sentinel. It asserts the walk found **at least 13**
      leaves, so an enumeration that silently found nothing cannot pass. Verified by `bun test`.
- [ ] **A2 — it discriminates against today's reset.** A **Stage 5 manual check**, not a test in the
      suite. Copy `vscode-stub.ts` and `vscode-stub.test.ts` to a temp dir and revert **only the body
      of `resetVscodeStub()`** to its six-leaf form — `git show 3b523ac:packages/vscode/src/vscode-stub.ts`
      names the base explicitly, and the new exports (`captureLeaves`, `restoreLeaves`,
      `pristineLeafPaths`, `stubMock`) must be kept or the test file does not import. Revision 1 said
      "revert the stub" and pinned `HEAD`, which produces a module error rather than a leaf report and
      compares the file with itself once committed. Run `bun test ./vscode-stub.test.ts` there; the
      failure output must name all **seven** unrestored leaves — `StatusBarAlignment.Right`,
      `ThemeColor`, `MarkdownString`, `Uri.parse`, `env.onDidChangeTelemetryEnabled`,
      `commands.registerCommand`, `workspace.onDidChangeConfiguration` — and no others. Command and
      output recorded in `review.md`.
- [ ] **A3 — the snapshot covers what it claims, and says so where it does not.** `vscode-stub.test.ts`
      exercises `captureLeaves`/`restoreLeaves` against three fixture objects, so the criterion does not
      require editing the real stub: **(a)** a one-deep plain leaf — restored; **(b)** a **two-deep**
      leaf — restored, which is the case a shallow capture fails and the case that made B3 blocking;
      **(c)** a `mock()` leaf with an **overridden implementation and a non-zero call count** —
      registered through `stubMock`, its history is cleared and the original implementation is back;
      **not** registered, `restoreLeaves` throws and the assertion is on the thrown path name; and
      **(d)** an array-valued leaf, where `captureLeaves` throws rather than capturing the live array.
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
      `every vscode test file passes run alone` is extended to parse each run's output and assert
      `fail === 0`, `skip === 0`, and `pass >=` a recorded per-file floor. Today it asserts only the
      exit status, and a `.test.ts` containing no tests at all exits 0 — so a dropped `describe`, or a
      `test.skip` slipped in to make a leaf restore pass, is currently invisible. Three things this
      criterion must state rather than leave to the implementer:
      **(a)** a test file with **no recorded floor is a failure naming the file** — otherwise the floor
      map is itself a hand-maintained list with a silent default, which is the defect class this whole
      loop exists to delete, reintroduced in the criterion that detects it;
      **(b)** bun prints no `skip` line at all when nothing is skipped (measured on all six current
      files), so an absent line means zero and a parser requiring all three fails on every file today;
      **(c)** the file-count assertion at `scripts/vscode-stub-cover.test.ts:52` becomes **`>= 7`**.
      **What it buys and what it does not:** a floor catches deletion and skipping. It does **not**
      catch a test that still runs with its assertions gutted — `pass` is unchanged. Bun also prints
      `N expect() calls`; flooring that too would move the bar from "the test still exists" to "the
      test still asserts something", and is worth doing in the same pass.
      *This deliberately weakens the intent's done-item, which says counts "unchanged from the recorded
      baseline". An equality reddens on every added test and would be edited away within two loops; a
      floor reddens only on the defect. The relaxation is the criterion's, and named here so it is a
      decision rather than a drift.* Now **seven** files. Verified by `bun test`.
- [ ] **A9 — three docstrings say what the code does, checked against an INDEPENDENT oracle.**
      `pristineLeafPaths()` is compared not against another walk of its own making — that assertion is
      `A === A` and holds for any broken walker — but against `providedMembers()` from
      `scripts/vscode-stub-cover.ts`, which derives the stub's members by an AST parse, already exists,
      and is already tested. The two are related by a stated rule: **a leaf path is a member of
      `providedMembers()` that is not a prefix of any other member**, which drops the six container
      names and leaves 13. Assert set equality under that derivation, and assert the set is non-empty.
      *Known limit:* `providedMembers()` descends one level, so if a two-deep leaf is ever added the
      two sets disagree and A9 goes red until the oracle is extended. That is loop 039's gate
      limitation surfacing, not something this loop introduces, and a red test is the right way for it
      to surface. Extending `providedMembers()` is outside this fence.
      The **docstring** half is a regex that must *not* match a count claim
      (`/restores the (two|six|seven|thirteen|\d+) leaves/i`) plus a phrase pin on the removed claim
      ("it is the only place that knows this stub's pristine shape") — each shipping with a **positive
      control** proving the pattern matches the text the claim actually had, because this repo already
      knows a bare `not.toContain` is green forever after a typo. Scope is three sites, not one:
      `vscode-stub.ts`'s module docstring, `resetVscodeStub`'s own docstring (*"Restores the two leaves
      tests overwrite"* — stale by four before this change and by eleven after it), and
      `tooltip.test.ts:6-7` (*"This file depends on nothing mutable in it, so it needs no reset"*),
      which is the sentence a future author reads.
- [ ] **A10 — the gate is green.** `bun run verify` exits 0; the `oxlint` warning set is unchanged
      against `.oxlint-budget.json`.
- [ ] **A11 — corruption does not cross a file boundary.** Two fixture test files in a temp tree,
      installing a verbatim copy of the real `vscode-stub.ts` and sharing **one** consumer module that
      does `import * as vscode` — shared rather than one each, because that is the hazard: an importer
      that resolved the specifier long before the mutation. Both files have the **same shape**: a
      `beforeEach` calling `resetVscodeStub()`, then one test that asserts the **consumer** reads
      pristine values for one top-level and one nested leaf and then mutates both through the direct
      import. Symmetric, so the criterion does not depend on bun's file order — which is stable but is
      **not argument order** (measured across five runs).
      **Exit status alone is not the check, and this is the finding that rejected revision 1.** A bare
      argument to `bun test` is a *filter*, not a path: `bun test <a> <nonexistent>` exits **0** and
      reports `Ran 1 test across 1 file`, and the `./`-prefixed form the CLI's own hint recommends does
      the same. A typo'd fixture name would leave only the file that asserts pristine before anything
      has mutated, and A11 — the one criterion the whole rejection was about — would report green with
      zero cross-file coverage. So assert **`2 pass`, `0 fail`, `0 skip`, and `Ran 2 tests across 2
      files`**, not the status.
      **And a recorded negative, not an asserted one.** The same fixture pair against a stub copy with
      step 3's re-registration deleted must exit non-zero on the top-level leaf; command and output in
      `review.md`, the way A2 and A7 already require. Revision 1 asserted this discrimination in prose
      in a loop whose thesis is that a claim in an artifact is not a measurement.
- [ ] **A12 — a commented-out call does not satisfy the gate.** A fixture whose only occurrence of
      `resetVscodeStub()` is inside a comment, and a second whose only occurrence is inside a string
      literal, both fail. Verified by `bun test`.
- [ ] **A13 — an unregistered mock leaf, and an uncoverable container, both fail loudly.** Two
      fixtures: a raw `mock()` in a stub literal, and a leaf under an array or class instance. Each
      must throw on the **first reset**, naming the path the walk found it at — not on the first test
      that happens to depend on it. This is the criterion that keeps step 5's registry from becoming
      the list this loop exists to delete, and step 1's exclusion from becoming a silence.

**Which of these discriminate.** A2, A5, A7, A12 fail against the tree as it stands. A1, A3, A4, A11,
A13 fail against a plausible wrong implementation of this spec — A11 against the first draft of this
one, and A13's second fixture against revision 1's. A6, A8, A9, A10 are fences, controls and state
assertions.

## Rejected alternatives

- **Rebuild the whole `vscodeStub` object on reset.** The obvious structural fix, and **measured to not
  work**: a module that resolved the specifier keeps the original reference, so the consumer reads the
  pre-rebuild object. This is why the spec restores in place.
- **Keep naming leaves, just name all thirteen.** Correct today and stale on the first leaf anyone adds
  — which is precisely how the current six-of-thirteen arose. The bug is the enumeration, not its
  contents.
- **Keep the implementation registry as a separate list keyed by leaf path.** Rejected twice, for two
  different reasons. As a list kept elsewhere it re-creates the defect at a smaller size:
  hand-maintained, silently stale. And keyed by a **path string** even at the construction site — the
  shape revision 1 shipped — a bijective permutation of two paths leaves every path registered once,
  fires no missing-registration throw, and swaps the two implementations at the first reset. Keying by
  the mock's identity costs the same few lines and makes the arrangement unexpressible.
- **Freeze the stub so nothing can mutate it.** `commands.test.ts` installs recording sinks by mutation
  and has no other route to observe those calls; freezing breaks the arrangement the consolidation
  deliberately kept.
- **Give each test file its own stub object.** This is the four-factory design `sdlc/039` removed, and
  the load-order measurement says it does not work: one object is resolved per specifier no matter how
  many factories run.
- **Two positions the first draft took, both refuted by measurement rather than declined:** that the
  gate need not check for an enclosing `beforeEach` (a gate satisfiable at module scope certifies the
  arrangement 039 deleted by hand), and that top-level leaves need no restoring (a later `mock.module`
  re-syncs top-level exports, so all 13 are live hazards and a plain assignment restore is inert).
- **Asserting A11 on exit status.** Measured unsafe: a `bun test` argument that matches no file is
  silently dropped, so a mistyped fixture reduces the run to its vacuous half and still exits 0.

---

**Next stage:** Build — run `/sdlc-plan 040-stub-reset-completeness` to turn this into `plan.md`.
