# Spec: the mocked module gets exactly one consumer

- **ID:** 025-vscode-bridge-split
- **Stage:** 2 — Design
- **Status:** accepted (revision 2, after the Stage 2 review)
- **Reads:** `intent.md`
- **Date:** 2026-08-27

## What changed since the intent

The intent framed this as a tooltip problem. It is not. `./core-bridge.js` has **three**
non-test consumers and **one** mocker:

| File | Symbols imported from the bridge | Mocked by |
|---|---|---|
| `statusbar.ts:3` | `classify`, `evaluate`, `emitProcess`, `renderEvent`, `utilizationBucket` | — |
| `tooltip.ts:3` | `formatTooltip` | — |
| `extension.ts:3` + the block at `4-20` | `setTelemetryConfig` + **15** further symbols | — |
| `extension.ts:21` | three **types** — `import type`, erased at compile time, so `mock.module` cannot touch them and they are irrelevant here | — |
| `commands.ts:11` | **none — bypasses the bridge**: `const core = await import('@claudewatch/core')`, then `core.readCache()` and `core.formatTooltip()` | — |
| `statusbar.test.ts:30` | — | **mocks `'./core-bridge.js'`** |

*Revision 2 corrections.* Revision 1 said "a 17-symbol block". It is 15 — counted, not estimated.
That is the inherited-number failure **reproduced inside the document written to indict it**, which
is the third loop running (022, 024, now 025) that this pattern has survived being written down.
Revision 1 also presented the table as an exhaustive survey and missed `commands.ts` entirely: it
is a fourth consumer of core in this package, it takes a *dynamic* import, and it violates
`core-bridge.ts`'s own stated contract ("extension source imports the core API through this
module rather than directly"). Fixing `commands.ts` is **out of scope** — recorded, not silently
inherited.

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
probe importing from core-bridge, statusbar.test.ts in-proc      → real formatter   MEASURED
vscode suite                                                      → 49 pass, 0 fail  MEASURED
bun run typecheck                                                 → clean            MEASURED
extension.ts's view of core                                       → real             INFERRED, see below
```

**Revision 1 rendered that last line as a measured `✓` in the same monospace block as the probe.
It is not measured, and today it is not measurable.** No test file in `packages/vscode` imports
`extension.ts` (verified: zero references across all four `*.test.ts`), so `statusbar.test.ts`'s
mock never reaches it in any currently-reachable execution; and `mock.module` does not exist in
the VS Code extension host, so at production runtime `extension.ts` has always had the real core.
`extension.ts` is contaminated in **zero** executions today, under option A and option B alike.
The two options are empirically indistinguishable *at present*.

So Q2 is decided on a **pre-emptive** argument, not an observed difference: loop 001's
`extension.ts`-has-no-tests finding is open, and when it is closed those tests will import a
bridge that nothing mocks — under option B. Under option A they would import the mocked one and
hit this wall on day one. That plus naming the module for the test that mocks it is the case.
Presenting an inference as a measurement is precisely this repo's recorded failure, and revision
1 did it in the document arguing against doing it.

Option B also puts the oddity where the oddity is: the module that exists to be mocked is named
for the test that mocks it. Cost is the same order — one new file, plus two changed import lines
(`statusbar.ts`, and `statusbar.test.ts`'s mock specifier) instead of one.

**Q1 — how wide is the new module?** Exactly the five symbols `statusbar.ts` imports. A narrow
module states what the statusbar actually depends on, and it is the mocked surface, so keeping it
small keeps `statusbar.test.ts`'s stub honest. Note the stub at `statusbar.test.ts:30` currently
supplies **seven** keys — the five plus `formatTooltip` and `makeTestSnapshot`. Once
`formatTooltip` no longer resolves through the mocked module, the stub for it is dead weight and
comes out; that removal is the point of the change and must not be left behind.

**Q3 — what stops this recurring?** *(Revision 2: deferred to its own loop.)*

Revision 1 answered this with a repo-wide static-analysis test — "every locally-specified
`mock.module('./X.js')` target must have at most one non-test importer". The Stage 2 review took
it apart, correctly, on four counts:

- **It passes vacuously if its scanner matches nothing.** A multiline `mock.module(`, double
  quotes, or a hoisted specifier empties the target set and the loop body never runs. "Recorded
  failing on the pre-change tree" is an authoring-day observation, not a property.
- **Scoping it to `'./…'` specifiers exempts the worst case.** Bare specifiers are not only
  `vscode`; they include `@claudewatch/core`, whose mocking is the 127-test failure loop 001
  exists to prevent. The rule would wave through the broad recurrence and catch only the narrow
  one — so "a test stops this recurring" was false for the case that matters most.
- **It counts direct importers**, while the real path here is transitive
  (`statusbar.ts → tooltip.ts → core-bridge.ts`). A future `mock.module('./tooltip.js')` would
  satisfy it while stubbing the tooltip for everything downstream.
- **It never entered the intent's done-list.** It is the largest work item in the loop and the
  only new test *infrastructure*, and it arrived under the heading of "answering an open
  question" — scope that showed up without a decision.

It is a good idea with its own design problems, so it gets its own loop rather than riding along
with a three-file change. **Deferred to loop 026**, recorded in `review.md` and in the Routine
queue. This loop's honest answer to Q3 is the intent's original one: *nothing structural prevents
recurrence; the split removes today's instance and does not immunise against tomorrow's.*

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
and the stub's factory carries **exactly the five keys `statusbar.ts` imports**.

**This changes what `statusbar.test.ts` exercises, and revision 1 did not say so.** `statusbar.ts:4`
imports `buildTooltip` from `./tooltip.js`, which imports `formatTooltip` from `./core-bridge.js`.
Once the mock moves to `statusbar-bridge.js`, `core-bridge.js` is unmocked in that process, so
**every `mgr.update()` in `statusbar.test.ts` renders its tooltip through the real formatter**
instead of the `formatted: N%` stub. Revision 1 claimed "its assertions are untouched" — the
assertion *text* is, the subject under test is not, and the intent lists "let it use the real
formatter" as out of scope. That outcome arrives here anyway, through the transitive import.
It is accepted rather than avoided (the alternative is stubbing `tooltip.js` too, which is worse),
and it is declared, tested by A6b, and reconciled in `intent.md`'s scope fence.

Two further corrections. `makeTestSnapshot` is **not** and never was a `core-bridge.ts` export —
`statusbar.test.ts:2` imports it straight from `@claudewatch/core/test-helpers`, so its presence
in the stub was always inert and removing it proves nothing. And `statusbar.test.ts:6-8` says
"main.test.ts mocks `@claudewatch/core` globally", which is **false** — nothing in this repo mocks
`@claudewatch/core` (verified: the only mock targets are `./core-deps.js`, `./core-bridge.js`, and
`vscode`). That false comment is the sole stated justification for the 16 lines of reimplemented
`classify`/`evaluate` at `:9-24` — domain logic in a surface package, against SPEC.md §8.2 and
CLAUDE.md. Since nothing mocks the package, those become
`import { classify, evaluate } from '@claudewatch/core'` and the duplicates are deleted.

### `packages/vscode/src/tooltip.test.ts`

Gains the assertion the whole loop exists to make possible, and loses the comment at `:123`
explaining why it could not be made.

### `packages/vscode/src/core-bridge.ts`

Docstring only: it currently says extension source imports core through it "so that
`statusbar.test.ts` can mock a module that `packages/vscode` owns". After this change
`statusbar.test.ts` mocks a different module, and this one exists to *not* be mocked. Leaving
that sentence would leave the file describing the opposite of its new job.

## Edge cases

1. **`extension.ts` is fixed by construction and verified by nothing.** It has no tests, no test
   file imports it, and this loop adds no criterion that inspects it. Revision 1 claimed "the
   guard test (A1) covers it structurally" and then contradicted itself two sections later in
   Risks; the Risks reading was the correct one, and with the guard now deferred to loop 026 the
   question is moot. Stated plainly here so no reviewer mistakes it for covered: **nothing in
   this loop proves `extension.ts`'s view of core is real.** Loop 001's finding is the only path
   to that.
2. **The stub must not be trimmed too far.** `statusbar.test.ts`'s mock replaces the module
   wholesale: any symbol `statusbar.ts` imports and the stub omits becomes `undefined` at call
   time, not a compile error. The five must match exactly.
3. **A future test could mock `./statusbar-bridge.js` from a second file** and recreate the
   problem. Nothing structural prevents it; A1 is what would catch it, and only if the second
   consumer is a source file rather than another test.

## Acceptance criteria

Revision 1 had seven; four could pass while the property they named was false. Rewritten.

- **A1 — *(withdrawn; deferred to loop 026.)*** The mock-topology guard. See Q3.
- **A2 — an assertion the stub cannot satisfy.** `tooltip.test.ts`'s `'Healthy with snapshot'`
  test gains, verbatim:
  ```ts
  expect(md.value).toContain('Usage Windows');
  ```
  `format.ts:373` emits that line and `:376` emits `Current (5hr): 42%`; the stub at
  `statusbar.test.ts:33` emits only `formatted: 42%`, which contains neither. The existing
  `toContain('42%')` assertions match **both**, which is why they have never proven anything.

  **The red run must be recorded, and it must be this command:**
  ```
  bun test packages/vscode/src/statusbar.test.ts packages/vscode/src/tooltip.test.ts
  ```
  on the **pre-change** tree, expecting 1 fail with actual `"formatted: 42%"`. Order matters:
  `tooltip.test.ts` **alone** on the pre-change tree uses the real formatter and this assertion
  **passes**. Revision 1 said only "run it against the pre-change tree, where it must fail" —
  which the trivially-green run also satisfies, and no later reader could tell which was done.
- **A3 — the four-cell table, filled in `review.md`.** Not "both runs pass", which is satisfied
  by any green run and would survive reverting the whole change:

  | | single file | with `statusbar.test.ts` first |
  |---|---|---|
  | pre-change | pass | **fail** ← the only cell carrying the claim |
  | post-change | pass | pass |
- **A4 — `bun run verify` exits 0**, lint at the standing 12.
- **A5 — the new module is re-exports only.** No executable statement in `statusbar-bridge.ts`
  other than the namespace import and the five const re-bindings; a docstring is required
  (SPEC.md §8.2).
- **A6a — the stub's key set is exactly the five `statusbar.ts` imports.** Assert the sorted key
  set, not the absence of two names. Revision 1's A6 asserted removing `formatTooltip` and
  `makeTestSnapshot` "proves they were dead" — `makeTestSnapshot` was never a bridge export, and
  `formatTooltip` is not dead at all.
- **A6b — the transitive switch is observed, not accidental.** `statusbar.test.ts` gains one
  assertion on the healthy case:
  ```ts
  expect((mockItem.tooltip as MockMarkdownString).value).toContain('Usage Windows');
  ```
  **No assertion in `statusbar.test.ts` reads `mockItem.tooltip` today** — all 26 tests, checked.
  So the tooltip could become the empty string, or the real formatter could throw and be
  swallowed, and every revision-1 criterion stayed green. This is the criterion that makes the
  declared behaviour change real rather than merely announced.
- **A7 — the docstrings tell the truth, in both files.** `core-bridge.ts` must not contain the
  substring `statusbar.test.ts can mock`, and must say instead that it serves the consumers
  nothing mocks. `statusbar.test.ts:6-8`'s claim that `main.test.ts` mocks `@claudewatch/core`
  is false and goes, along with the 16 lines of duplicated `classify`/`evaluate` it justifies.
- **A8 — `core-bridge.ts` keeps no orphans.** After the split, `classify`, `evaluate`,
  `emitProcess`, `renderEvent`, `utilizationBucket` would be exported by both bridges and
  imported from `core-bridge` by nobody — exactly the "import from whichever bridge you happen to
  type" hazard the intent's Q1 raised, which revision 1 answered for the new module only. They
  are deleted. (`emit` is already imported by nobody today; it goes too, or the spec says why
  not.)
- **A9 — `extension.ts` is NOT verified.** Recorded as a criterion so it cannot be mistaken for
  covered: this loop proves nothing about `extension.ts`'s view of core.
- **SPEC.md impact: none.** §8.1's directory tree is illustrative and already omits
  `core-bridge.ts` and `telemetry-gate.ts`, so adding `statusbar-bridge.ts` contradicts nothing;
  §8.2 is satisfied by A5 and improved by A7's deletion of duplicated domain logic. Stated
  because REVIEW.md:89-90 makes an unstated SPEC contradiction blocking.

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
