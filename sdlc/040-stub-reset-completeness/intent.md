# Intent: the reset the shared stub rests on covers less than half of it

- **ID:** 040-stub-reset-completeness
- **Stage:** 1 — Plan
- **Status:** accepted
- **Author:** the SDLC loop, from `sdlc/039`'s recorded-and-not-fixed list (S-5)
- **Date:** 2026-09-01

## Problem

Loop 039 replaced four per-file `mock.module('vscode', …)` factories with one shared
`vscodeStub`. One shared object is one shared **mutable** object, so the loop introduced
`resetVscodeStub()` and made it the thing that keeps per-test state from becoming per-run state.
`vscode-stub.ts` says so in its own docstring:

> Every test file calls it in `beforeEach`; **it is the only place that knows this stub's pristine
> shape.**

Both halves of that sentence are false, and measuring rather than re-reading the loop's own note is
what showed it.

**The reset restores 6 of the stub's 13 leaves.** Enumerated from the AST rather than by eye:

| Restored | Not restored |
|---|---|
| `env.isTelemetryEnabled` | `StatusBarAlignment.Right` |
| `env.openExternal` | `ThemeColor` |
| `window.createStatusBarItem` | `MarkdownString` |
| `window.showInformationMessage` | `Uri.parse` |
| `window.showErrorMessage` | `env.onDidChangeTelemetryEnabled` |
| `workspace.getConfiguration` | `commands.registerCommand` |
| | `workspace.onDidChangeConfiguration` |

A test that overwrites any of the seven on the right leaves it overwritten for every file that
loads after it. Nested properties of a mocked module are writable — `sdlc/028` measured that, and
`commands.test.ts` relies on it to install recording sinks.

**And one of the four importing files never calls it.** Measured across the package:

| File | imports `vscodeStub` | calls `resetVscodeStub()` |
|---|---|---|
| `commands.test.ts` | yes | yes |
| `extension.test.ts` | yes | yes |
| `statusbar.test.ts` | yes | yes |
| **`tooltip.test.ts`** | **yes** | **no** |

`tooltip.test.ts` is documented as safe because it "depends on nothing mutable", which is true of
what it asserts today. It is not a property of the arrangement; it is a property of one file's
current contents, restated as if it were a rule.

Neither fact is exploitable right now — `sdlc/039`'s security pass traced every `vscode.*` value
use in the source and found no un-reset leaf that gates a network call or a filesystem path. That
is the same standing the whole mock-topology problem had before it cost four loops.

## Who is affected

Nobody today, and saying otherwise would be inventing urgency. Every test passes alone and
together; the un-reset leaves are inert given what the current tests assert.

Who it will affect is specific and predictable: the next person to add a test to
`packages/vscode` that stubs `Uri.parse` or `commands.registerCommand` to observe a call. Their
test will pass. A test in a file that loads afterwards will fail, or worse, pass for the wrong
reason — and the failure will point at the wrong file, which is exactly the shape `sdlc/039` was
opened to remove and the shape `sdlc/025` paid four loops for.

## Why now

Because the guard that would catch it already exists and is one assertion short. `sdlc/039` built
`vscodeStubCover` and wired it into `verify`; it checks that every `vscode` factory is the shared
one and that the stub covers what the source uses. It does not check that the stub's users reset
it. Adding that is small *now* and stops being small once someone writes the test above.

There is also a documentation reason. A docstring that claims to be "the only place that knows the
pristine shape" while knowing 6 of 13 leaves is worse than no docstring: it is the sentence a
future author will read instead of checking.

## What "done" means

- [ ] `resetVscodeStub()` restores **every** mutable leaf of `vscodeStub`, demonstrated by a check
      that enumerates the stub and fails when a leaf is unrestored — not by a list I maintain by hand
- [ ] Overwriting any restorable leaf in one test does not affect the next test, demonstrated for
      at least one leaf that is unrestored today
- [ ] Every file importing `vscodeStub` calls `resetVscodeStub()`, enforced by `vscodeStubCover`
      rather than by convention
- [ ] `tooltip.test.ts` either resets or stops importing the stub
- [ ] `vscode-stub.ts`'s docstring says what the reset actually does
- [ ] Every `packages/vscode/src/*.test.ts` still passes **run alone** as well as together, with the
      per-file counts unchanged from the recorded baseline
- [ ] `bun run verify` exits 0

## Explicitly out of scope

- **Any change to `packages/vscode/src/*.ts` that is not a test or the stub.** No product source
  file changes. A product defect found on the way is recorded, not fixed here.
- **The `onDidChangeTelemetryEnabled` subscription test** — `sdlc/039`'s other residual, a behaviour
  test for `extension.ts` and a different subject.
- **`scripts/mock-topology.ts`'s rules.** Untouched, as in `sdlc/039`.
- **Making the stub immutable** (freezing it, or handing each file its own copy). A materially
  different design, and one the load-order measurement in `sdlc/039` says would not work — bun
  resolves one object per specifier regardless of how many factories run.
- **The Marketplace rename and publishing.** The user's call, both.

## Open questions

1. **Can the reset be made complete *structurally* rather than by enumeration?** Rebuilding the
   whole `vscodeStub` object on each reset would be complete by construction — but the object
   identity is what `mock.module` returned, and replacing it may not propagate to modules that
   already resolved it. That is measurable, and Stage 2 must measure it rather than assume either
   way. If it does propagate, the fix is much smaller than a leaf-by-leaf restore.
2. **Should `tooltip.test.ts` reset, or stop importing?** It needs `MarkdownString` from the stub.
   If the reset is cheap and complete, calling it is the consistent answer; if question 1 lands
   badly, "imports but does not reset" may be a legitimate documented category rather than a gap.

Both are Stage 2's to settle with measurements, not mine to guess here.

---

**Next stage:** Design — run `/sdlc-spec 040-stub-reset-completeness` to turn this into `spec.md`.
