# Spec: check that the merged `vscode` stub covers what the source actually needs

- **ID:** 039-vscode-stub-model
- **Stage:** 2 — Design
- **Status:** draft
- **Derived from:** [`intent.md`](./intent.md)

## Summary

A new harness check enumerates the `vscode` members the `packages/vscode` **source** files use in
a **value** position, enumerates what the four test stubs collectively provide, and fails when
the first is not a subset of the second. It runs inside `bun run verify`. Two stale docstring
claims are corrected in the same change. No test stub is restructured and no source file changes.

## Behavior

### What the check does

A new `scripts/vscode-stub-cover.ts`, wired into `verify` after `fenceCheck`:

1. **Required set.** Scan `packages/vscode/src/*.ts`, excluding `*.test.ts`, for `vscode.<a>` and
   `vscode.<a>.<b>` references, and keep only those in a **value** position. A member is a value
   position when it is called, constructed, or read as data; it is a **type** position when it
   appears after `:` in a type annotation, in `implements`/`extends`, or inside a type-only
   import. Measured on the tree today: `ExtensionContext`, `StatusBarItem` and `Disposable` are
   type-only and must **not** be required; `MarkdownString` and `ThemeColor` appear under `new`
   and must be.
2. **Provided set.** Scan `packages/vscode/src/*.test.ts` for `mock.module('vscode', …)` factories
   and collect the top-level keys and their first-level sub-keys, unioned across files. The union
   is the right model precisely because the merge is per-key: `sdlc/028` measured it, and this
   loop re-measured it — deleting `env` from one file's stub fails **21 tests in another file**.
3. **Compare.** Every required member must appear in the provided union. A missing member is a
   failure naming the member, the source file that needs it, and the fact that no stub provides it.
4. **Report the other direction as information, not failure.** A member provided by some stub and
   required by no source file is printed as a surplus line. It does not fail: a stub may legitimately
   carry a key for a consumer that is not `vscode.*`-shaped, and turning surplus into an error would
   make the check hostile to ordinary test scaffolding.

### What the check deliberately does not do

- **It does not attribute a key to a file.** The merge is per-key across the whole package, so
  "which file provides `env`" is not a well-formed question and the check must not pretend to
  answer it. It checks the union, which is the thing that actually has to hold.
- **It does not verify behaviour of a stub member**, only presence. A stub whose
  `createStatusBarItem` returns nonsense passes; the tests that use it are what catch that.
- **It does not run the tests.** It is static, so it stays fast and cannot itself perturb the
  process-wide mock state it is reasoning about.

### The two docstring corrections

`statusbar.test.ts:82` and `tooltip.test.ts:33` both assert that
`window.showInformationMessage` and `window.showErrorMessage` are "both reached from
`commands.ts`". Measured: `commands.ts` reaches `window.showInformationMessage`,
`env.openExternal` and `Uri.parse`. **`showErrorMessage` appears in no source file at all** — only
in two stubs that define it and the two docstrings that claim it is needed. The sentence is
corrected in both places to say what the code does.

The two stubs keep their `showErrorMessage` definitions. Removing them is a separate judgement
about test scaffolding, and the new check reports them as surplus rather than requiring a
decision now.

## Data and types

```ts
export interface Member { object: string; property?: string }   // `window`, `window.createStatusBarItem`
export interface CoverageResult {
  required: Member[];      // value positions in source, sorted
  provided: Member[];      // union across stub factories, sorted
  missing: Member[];       // required minus provided — the failure set
  surplus: Member[];       // provided minus required — informational
}
export function requiredMembers(files: readonly SourceFile[]): Member[]
export function providedMembers(files: readonly SourceFile[]): Member[]
export function compare(required: readonly Member[], provided: readonly Member[]): CoverageResult
```

`SourceFile` is `{ path, text }`, matching `scripts/mock-topology.ts` so the two harness scripts
read the tree the same way. A member with no `property` is a bare top-level requirement.

## Edge cases

| Case | Expected |
|---|---|
| `vscode.ExtensionContext` in a type annotation only | **Not** required |
| `vscode.MarkdownString` under `new` | Required |
| `vscode.StatusBarAlignment.Right` | Required as `StatusBarAlignment.Right`, not bare `StatusBarAlignment` |
| A member required by source and provided by no stub | Failure, naming member and source file |
| A member provided by a stub and required by nothing | Surplus line, exit 0 |
| A source file with no `vscode.` reference at all | Contributes nothing; not an error |
| A test file with no `mock.module('vscode', …)` | Contributes nothing; not an error |
| The string `vscode.` inside a comment or docstring | **Not** required — the two docstrings this loop corrects both contain `window.showErrorMessage`, so a check that scanned comments would require the very member it is meant to report as absent |
| The string `vscode.` inside a string literal | Not required, same reason |
| No test file mocks `vscode` at all | Every required member is missing; the failure is loud rather than a silent empty-set pass |

The comment and string-literal rows are the ones most likely to make this check vacuous or
self-contradictory, so both get tests.

## Backward compatibility

- No behaviour of `packages/vscode` changes; no source file is edited.
- No stub is restructured, so no test changes what it asserts.
- `verify` gains a step. It is static text analysis over ~10 files, so its cost is comparable to
  `fenceCheck`'s.
- The check must pass on the tree **as it stands today**. If it does not, that is a finding about
  the tree, and it gets recorded in `review.md` and fixed — not accommodated by weakening the rule.

## Acceptance criteria

- [ ] **A1 — the check passes on today's tree**, or the tree is fixed. Verified by `bun run verify`.
- [ ] **A2 — it fails when a needed key is absent.** Deleting `env` from `statusbar.test.ts`'s
      stub makes the check fail **and name `env.isTelemetryEnabled` and `env.openExternal`**.
      Verified by a unit test over synthetic fixtures, so the check's own failure does not require
      mutating the real tree.
- [ ] **A3 — the failure names the source file that needs the member.** Today deleting that key
      produces 21 failures in `extension.test.ts` and points at nothing; the check must say
      `env.openExternal` is needed by `commands.ts`. Verified by asserting the message content.
- [ ] **A4 — type positions are not required.** A fixture using `vscode.ExtensionContext` only as
      an annotation produces no requirement. Verified by unit test; fails against an implementation
      that greps `vscode\.[A-Za-z]+` blindly.
- [ ] **A5 — constructors are required.** A fixture with `new vscode.ThemeColor(...)` produces the
      requirement. Verified by unit test. A4 without A5 would pass on an implementation that
      required nothing at all.
- [ ] **A6 — comments and string literals are ignored.** A fixture whose only `vscode.foo` is
      inside a `//` comment, a `/* */` block and a string literal produces no requirement.
      Verified by unit test. This is the criterion the real tree needs: the docstrings this loop
      corrects mention `showErrorMessage`, so without it the check would demand the member it
      exists to report as unneeded.
- [ ] **A7 — surplus does not fail.** A fixture providing a member nothing requires exits 0 and
      prints a surplus line. Verified by unit test.
- [ ] **A8 — an empty provided set fails loudly.** Fixtures with source requirements and no stub
      at all produce failures, not a vacuous pass. Verified by unit test.
- [ ] **A9 — sub-keys are distinguished from their parents.** Providing bare `window` does not
      satisfy a requirement for `window.createStatusBarItem`. Verified by unit test; this is the
      difference between a check and a formality.
- [ ] **A10 — the corrected docstrings say what the code does.** Both files assert
      `showInformationMessage` is reached from `commands.ts` and no longer assert `showErrorMessage`
      is. Verified by a phrase-pinning test in the style of `scripts/env.test.ts:324`.
- [ ] **A11 — the gate is green** and the `oxlint` warning set is unchanged against
      `.oxlint-budget.json`. Verified by `bun run verify`.

**Which criteria are evidence and which are fences.** A2, A3, A6 and A9 fail against a plausible
wrong implementation of this spec. A4, A5, A7, A8 fence the edges. A1, A10 and A11 are state
assertions about the tree. None of them fail against *today's* tree, because today's tree has no
check at all — this loop adds a guard rather than fixing a live defect, and saying otherwise
would overstate it.

## Rejected alternatives

- **Consolidate the four stubs into one shared module.** The obvious fix, and the queue item's own
  second suggestion. Rejected for now: it changes what four test files resolve at load time, in a
  package whose mock semantics this loop has only just pinned down, and the standing warning that
  an `extension.test.ts` without its own `./core-bridge.js` mock makes a **live authenticated
  request** means a mistake here is expensive rather than merely red. The check makes the current
  arrangement safe to keep; consolidating on top of a check is a smaller, better-evidenced change
  than consolidating instead of one. Recorded as the follow-up.
- **Make the stubs a literal superset of each other.** Measured as already true at the top level —
  all four define the same eight keys — and it is the wrong invariant anyway: what has to hold is
  that the *union* covers the *source*, not that the files agree with each other.
- **Use the TypeScript compiler API to resolve value-versus-type positions properly.** More
  correct than the syntactic rule and much heavier; the repo's other harness scripts are
  hand-rolled scanners for the same reason. If the syntactic rule produces a wrong answer on a
  real file, that is the trigger to reconsider — and A4/A5/A6 are what would catch it.
- **Fail on surplus.** Would force a decision about two `showErrorMessage` definitions that harm
  nothing, and would make the check hostile to ordinary scaffolding.
- **Extend `scripts/mock-topology.ts` instead of adding a script.** Its rules are about *local*
  specifiers and code under test; `vscode` is a bare specifier it deliberately ignores. Loop 026
  built R1 and R2 against specific observations, and editing them as a side effect of a different
  concern is how a guard stops meaning what it says.

---

**Next stage:** Build — run `/sdlc-plan 039-vscode-stub-model` to turn this into `plan.md`.
