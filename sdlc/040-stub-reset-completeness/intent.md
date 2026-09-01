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

A test that overwrites one of those leaves it overwritten for every file that loads after it.
Nested properties of a mocked module are writable — `sdlc/028` measured that, and
`commands.test.ts` relies on it to install recording sinks.

> **Corrected in Stage 2, before speccing: it is five, not seven.** The table above counts the
> stub's leaves. It does not ask which of them a consumer can actually be made to see, and that is
> the question that decides the exposure. Measured, three routes:
>
> | Route | Result |
> |---|---|
> | `resolved.Top = x` — top-level, through the resolved module | **throws** `TypeError: Attempted to assign to readonly property` |
> | `resolved.nested.leaf = x` | succeeds, and the shared object sees it |
> | `vscodeStub.Top = x` — top-level, through the direct import | succeeds **on the object**, and the consumer still reads the ORIGINAL |
>
> The last is the one I would not have guessed. A resolved module namespace snapshots its
> top-level keys; only nested objects are shared by reference. So `ThemeColor` and `MarkdownString`
> are structurally unreachable by either route, and the at-risk set is the **nested** leaves alone:
> `StatusBarAlignment.Right`, `Uri.parse`, `env.onDidChangeTelemetryEnabled`,
> `commands.registerCommand`, `workspace.onDidChangeConfiguration`.
>
> The finding survives — five reachable leaves are unrestored, and one importer never resets — but
> "7 of 13" was a count of a list, not a measurement of a hazard, and the two are not the same
> thing. Counting is not measuring.

> **SECOND correction, from the Stage 2 review, which rejected the spec on it: the block above is
> wrong and the original "7 of 13" was right.**
>
> Every one of those three routes was measured **within a single test file**. There is a fourth,
> and it is the one this package actually executes: each test file calls
> `mock.module('vscode', () => vscodeStub)` at module scope, and a *later* such call re-runs the
> factory and re-syncs the resolved namespace's top-level exports — for consumers that resolved
> long before. Reproduced, with the mutation in the file bun loads first:
>
> ```
> [first]  its OWN consumer sees   top: PRISTINE-TOP  | nested: CORRUPT
> [second] on entry                top: CORRUPT       | nested: CORRUPT
> [second] after a plain reset     top: CORRUPT       | nested: PRISTINE-NESTED
> [second] after re-registration   top: PRISTINE-TOP  | nested: PRISTINE-NESTED
> ```
>
> Two things follow, and the second is new. **Top-level leaves are live hazards** — all 13 are at
> risk, `ThemeColor` and `MarkdownString` included. And **restoring a top-level leaf by assignment
> is inert**: the reset must re-register the factory, or it fixes the object while every consumer
> goes on reading the corrupted namespace.
>
> Note the shape of the failure the first block would have shipped: the mutating file sees nothing
> wrong, and the corruption surfaces in the next file. That is verbatim the thing this intent says
> the loop exists to remove.
>
> **This is a correction to a correction, and the middle one was the wrong direction.** I measured
> one file and generalised to a package. Then I wrote "measured unreachable" into a spec's
> rejected-alternatives list, where it would have been the sentence a future author read instead of
> measuring — the failure this loop is chartered to fix, reproduced inside the artifact that fixes
> it. "Counting is not measuring" was the right lesson drawn from the wrong measurement.

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

1. ~~**Can the reset be made complete *structurally* by rebuilding the object?**~~ **Answered: no.**
   Measured — a consumer that has resolved the module keeps the original reference, so replacing
   the object leaves it reading the old one (`after REBUILD, consumer sees: MUTATED`). The reset
   must restore leaves **in place**. That does not force a hand-maintained list: a snapshot taken
   once at module load, walked and reapplied, is complete by construction and covers a leaf added
   tomorrow.
2. **Should `tooltip.test.ts` reset, or stop importing?** It needs `MarkdownString` from the stub.
   If the reset is cheap and complete, calling it is the consistent answer; if question 1 lands
   badly, "imports but does not reset" may be a legitimate documented category rather than a gap.

Both are Stage 2's to settle with measurements, not mine to guess here.

---

**Next stage:** Design — run `/sdlc-spec 040-stub-reset-completeness` to turn this into `spec.md`.
