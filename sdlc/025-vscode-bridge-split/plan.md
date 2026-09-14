# Plan: the mocked module gets exactly one consumer

- **ID:** 025-vscode-bridge-split
- **Stage:** 3 — Build (planning half)
- **Status:** accepted
- **Reads:** `spec.md` (revision 2)
- **Date:** 2026-08-27

## Approach

Evidence first, because most of it is unrecoverable once the split lands.

1. **Record A3's pre-change cells.** Add A2's and A6b's assertions to the working tree *before*
   touching any import, and run the four-cell table's two pre-change runs. After the split the
   red cell cannot be reproduced without reverting.
2. **Create `statusbar-bridge.ts`** with exactly the five symbols `statusbar.ts` imports.
3. **Repoint `statusbar.ts`,** then `statusbar.test.ts`'s mock specifier and factory.
4. **Delete the orphans and the false comment** — `core-bridge.ts`'s six now-unimported exports,
   and `statusbar.test.ts`'s duplicated `classify`/`evaluate` with the false premise justifying
   them.
5. **Record A3's post-change cells** and run the mutations.

Step 1 before step 2 is the whole discipline here: three of this loop's Stage-2 criteria failed
review precisely because they were satisfiable by a run nobody pinned down.

## Scope fence

Exactly these five files, plus this loop's own artifacts.

| Path | Why |
|---|---|
| `packages/vscode/src/statusbar-bridge.ts` | **new** — the module that exists to be mocked |
| `packages/vscode/src/statusbar.ts` | one import line |
| `packages/vscode/src/statusbar.test.ts` | mock specifier + factory keys, A6b's assertion, the false comment and the duplicated domain logic it justified |
| `packages/vscode/src/tooltip.test.ts` | A2's assertion; drop the "cannot be asserted here" comment at `120-126` |
| `packages/vscode/src/core-bridge.ts` | docstring, and the six orphaned exports |

**Explicitly not touched:** `packages/core/**` (the formatter is fine), `extension.ts`,
`commands.ts` (its bridge bypass is recorded, not fixed), `tooltip.ts`, `telemetry-gate.ts`,
`manifest.test.ts`, `packages/statusline/**`, and `SPEC.md` (impact assessed as none — §8.1's
tree is illustrative and already omits `core-bridge.ts`).

## Changes

### `packages/vscode/src/statusbar-bridge.ts` *(new)*

Docstring plus `import * as core` and five const re-bindings — `classify`, `evaluate`,
`emitProcess`, `renderEvent`, `utilizationBucket`. Value re-binding, never `export … from`: a
static re-export keeps the mock linked to the original module and the contamination survives,
which loop 001 established at the cost of 127 still-failing tests.

### `packages/vscode/src/statusbar.ts`

Line 3's specifier only.

### `packages/vscode/src/statusbar.test.ts`

- `:30` mocks `'./statusbar-bridge.js'`; factory carries exactly the five keys.
- `:6-8`'s comment — "main.test.ts mocks `@claudewatch/core` globally" — is false and goes. So do
  the 16 lines of `realClassify`/`realEvaluate` it justified, replaced by a real import from
  `@claudewatch/core`. Nothing mocks that package, so the import resolves to the real thing.
- Gains A6b's assertion on `mockItem.tooltip`.

### `packages/vscode/src/tooltip.test.ts`

Gains `expect(md.value).toContain('Usage Windows')` in `'Healthy with snapshot'`. Loses the
`120-126` comment explaining why real formatter coverage could not live here.

### `packages/vscode/src/core-bridge.ts`

Docstring rewritten — it currently says it exists so `statusbar.test.ts` can mock it, which
becomes the opposite of its job. Six exports deleted: the five that move to the new bridge, plus
`emit`, which no file imports today.

## Tests

| Criterion | Where | What makes it fail |
|---|---|---|
| A2 | `tooltip.test.ts` | the tooltip resolving through a mocked bridge |
| A3 | `review.md` table | — evidence, not a test |
| A5 | inspection + A4 | a statement in the new bridge beyond the re-bindings |
| A6a | `statusbar.test.ts` factory | a sixth key, or a missing one |
| A6b | `statusbar.test.ts` | the tooltip rendering empty, throwing, or via the stub |
| A7 | `grep` | the substring `statusbar.test.ts can mock` surviving |
| A8 | `bun run typecheck` | anything still importing a deleted orphan |

## Verification

1. A3's four cells, all four runs recorded verbatim in `review.md`. The pre-change red cell is
   the only one carrying the claim; the command and argument order are fixed by spec A2.
2. `bun run verify` exits 0, lint at the standing 12.
3. Mutations, **each with its expected result predicted before running**:
   - revert `statusbar.ts` to `./core-bridge.js` → **A2 must fail** (real gap).
   - drop `formatTooltip` from `core-bridge.ts` → **typecheck must fail** (proves `tooltip.ts`
     still depends on it, i.e. that A8's deletions stopped at the right place).
   - stub `mockItem.tooltip` to `''` in the test's vscode mock → **A6b must fail**.
   - re-add a sixth key to the factory → **predicted INERT.** `mock.module` replaces the module
     wholesale and an extra key is simply unused. A6a is an explicit key-set assertion, so it
     *should* catch it; if it does not, A6a is the vacuous one and I want to know.
4. `bun test packages/vscode/src/` in isolation and inside the whole suite.
5. Stage 5: `plan-to-diff-auditor` and `security-reviewer` on the commit range, briefed not to
   write into the tree.

## Risks

- **`statusbar.test.ts` starts rendering real tooltips.** Declared in the spec, covered by A6b.
  The real `formatTooltip` was traced across every `mgr.update()` call in that file and will not
  throw — but "will not throw" is exactly the kind of claim this loop keeps finding false, so
  A6b is what actually decides it.
- **Deleting `core-bridge.ts` exports is the widest blast radius here.** `typecheck` is the
  guard, and the second mutation above is what proves the guard works.
- **`extension.ts` is fixed by construction and verified by nothing** (spec A9). Not a risk of
  this change breaking; a limit on what it demonstrates.
