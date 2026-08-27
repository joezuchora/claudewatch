# Spec: route commands.ts through a bridge, and make the gate enforce "no any"

- **ID:** 028-commands-bridge
- **Stage:** 2 — Design
- **Status:** draft
- **Date:** 2026-08-27

Reads `intent.md`. Two changes that look separate and are not: `commands.ts` holds the tree's only
production `any`, and the reason it survived is that nothing checks. Fixing the instance without
fixing the check leaves the defect.

## Measurements this spec is built on

Taken before writing it, not asserted from reading:

| Question | Measured |
|---|---|
| `no-explicit-any` errors under the shipped config | **0** (rule not enabled; gate green) |
| ...with `typescript/no-explicit-any: "error"` | **3** |
| Where | `commands.ts:13`, `manifest.test.ts:14`, `call-sites.test.ts:19` |
| Typecheck errors from a mechanical `any`→`unknown` swap | **20** (13 in `call-sites.test.ts`, 7 in `manifest.test.ts`) |
| Standing lint warnings | **12**, exit 0 |

**Two predictions were made and both were wrong.** I predicted 1 `any` and there were 3 — the two
I missed are `Record<string, any>`, which the obvious grep (`: any`, `as any`, `<any>`) cannot see.
I then predicted the swap would break `manifest.test.ts` and spare `call-sites.test.ts`; it broke
both, and `call-sites.test.ts` worse. Recorded because the second wrong prediction is what
established that this loop's excursion is real work rather than two word-swaps.

## Behaviour

### B1 — `commands.ts` reaches core through a bridge

New `packages/vscode/src/commands-bridge.ts`, value re-binding (never `export … from`, which keeps
a mock linked to the original module — sdlc/001), exporting exactly what `commands.ts` uses:
`readCache`, `formatTooltip`, and the `CacheEnvelope` type.

`commands.ts` replaces `await import('@claudewatch/core')` with a static
`import { readCache, formatTooltip } from './commands-bridge.js'`.

`commands-bridge.ts` must have **exactly one importer** (`commands.ts`), which is what makes it
safe for `commands.test.ts` to mock under loop 026's R1 rule. A second importer is the defect that
rule exists to catch, and this loop must not create one.

### B2 — the shadowed `vscode` import is removed

`showDiagnostics` drops its inner `const vscode = await import('vscode')` and uses the module-level
`import * as vscode from 'vscode'`. `showDiagnostics` stays `async` — it is registered as a command
and its signature is observable — but nothing inside it awaits any more.

### B3 — no `any` anywhere, by type rather than by suppression

- `commands.ts:13` → `CacheEnvelope | null`, the actual return type of `readCache()`. Not
  `unknown`: the type is known and naming it is the point.
- `call-sites.test.ts` → a local interface for the spool event shape the file asserts on
  (`kind`, `payload`, and the fields the 13 errors name).
- `manifest.test.ts` → a local interface for the manifest slice it asserts on.

No `eslint-disable`, no `@ts-expect-error`, no `as` cast standing in for a type. A suppression
would satisfy the rule and defeat it.

### B4 — the gate enforces the rule

`.oxlintrc.json` gains `"typescript/no-explicit-any": "error"`. **`error`, not `warn`**: the repo
already carries 12 standing warnings that nobody acts on, so a warning here would be indistinguishable
from the status quo it is meant to change. `CLAUDE.md` states the rule as a constraint; the gate
should agree with `CLAUDE.md` or `CLAUDE.md` should stop saying it.

### B5 — the two commands get tests

`commands.test.ts` mocks `./commands-bridge.js` and the `vscode` module, and covers:
- `showDiagnostics` with a cache present → formats the snapshot, shows a modal.
- `showDiagnostics` with no cache → the "No cache or snapshot found." path.
- `showDiagnostics` when `readCache` throws → the `catch` at `:22`, message included.
- `openDashboard` → opens the dashboard URL via `env.openExternal`.

This closes loop 027's third `test.todo` and forces the `vscode` stubs to gain `Uri`,
`window.showInformationMessage` and `env.openExternal` — recorded in loop 027 as missing, and
mislabelled there as a "superset".

## Edge cases

- **`showDiagnostics` prints `__filename`.** Under CJS bundling that is the bundle path — the
  diagnostic's whole purpose. It must not become `import.meta.url`; the tests assert a string is
  present, not its value, because the value differs between a bundled and an unbundled run.
- **The `catch` at `:22` is the only error path** and it swallows everything, including a
  `formatTooltip` throw, not just `readCache`. The tests cover the `readCache` throw; the
  `formatTooltip` throw is the same arm and is not separately asserted. Stated so it is not later
  claimed as covered.
- **`vscode.window.showInformationMessage(msg, { modal: true })`** — the modal flag is part of the
  contract (a non-modal message truncates). Asserted.
- **Enabling the rule affects `scripts/` too.** Measured: no `any` there today, so no new errors.

## Acceptance criteria

Each is mechanically checkable and names the command.

- **A1** — `.oxlintrc.json` contains `"typescript/no-explicit-any": "error"`, and
  `bunx oxlint packages scripts` exits 0 with **0** errors.
- **A2** — **the rule can fail the gate.** Seed `let x: any = 1;` into a source file; `bun run verify`
  exits non-zero and names the rule. Remove it; the gate returns to green. Both halves demonstrated
  and recorded in `review.md` — a rule that cannot redden the gate is the defect this loop exists to
  fix, so asserting only the green half would reproduce it.
- **A3** — `grep -rn "any" packages/*/src scripts --include=*.ts` finds no type-position `any`.
  Checked by the linter, not the grep — the grep is what failed in Stage 1.
- **A4** — `commands.ts` contains no `@claudewatch/core` import:
  `grep -c "@claudewatch/core" packages/vscode/src/commands.ts` is 0.
- **A5** — `commands-bridge.ts` has exactly one importer, and `bun test scripts` (loop 026's guard)
  passes with its real-tree pair assertions updated to include `commands.test.ts` →
  `./commands-bridge.js`.
- **A6** — the `no-shadow` warning at `commands.ts:10` is gone and the standing warning count drops
  **12 → 11**. Asserted as an exact number, not "fewer".
- **A7** — `commands.test.ts` exists, covers the four cases in B5, and loop 027's
  `test.todo('commands.ts: openDashboard and showDiagnostics')` is **deleted**, not left beside the
  tests that now cover it.
- **A8** — every mutation in the plan's mutation table produces its predicted failure count.
- **A9** — the built VS Code bundle is still CJS (`require`/`module.exports` present, no top-level
  ESM markers). `bun run verify` does not check this.

## Risks

- **The excursion is 20 typecheck errors across two files this loop has no other reason to open.**
  Declared in `intent.md` and sized here. If the typed shapes turn out to need more than local
  interfaces, that is a finding for `review.md`, not a reason to reach for `unknown` plus casts.
- **`commands-bridge.ts` is the fourth bridge module.** Four bridges for one small package is a
  smell, and the honest reading is that the pattern is compensating for `mock.module` being
  process-wide. Recorded, not solved here.
- **A2 is the criterion most likely to be shipped as nothing** — loop 021 shipped one, loop 027
  shipped another. It requires seeding a violation and watching the gate go red. If that is not
  actually run, `review.md` says so.

## Next stage

`/sdlc-plan`, after the spec review.
