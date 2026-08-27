# Plan: commands.ts through a bridge, and a "no any" rule the gate can fail

- **ID:** 028-commands-bridge
- **Stage:** 3 — Build (planning half)
- **Status:** draft
- **Date:** 2026-08-27

Reads `spec.md` as revised after the Stage 2 review. Implements B1–B5b against A1–A11.

## Scope fence

Nine paths. Two are new; seven are the excursion `intent.md` declares, which was resized from two
after the spec review found four more plus `SPEC.md`.

| Path | Change | In fence because |
|---|---|---|
| `packages/vscode/src/commands-bridge.ts` | **new** | B1 — the module `commands.test.ts` mocks |
| `packages/vscode/src/commands.test.ts` | **new** | B5 — the tests |
| `packages/vscode/src/commands.ts` | bridge import; drop shadowed `vscode`; type `cache` | B1, B2, B3 |
| `.oxlintrc.json` | `"typescript/no-explicit-any": "error"` | B4 |
| `packages/vscode/src/manifest.test.ts` | `Manifest` interface, declaration annotation | B3 — **excursion** |
| `packages/core/src/call-sites.test.ts` | `SpoolEvent` interface, declaration annotation | B3 — **excursion** |
| `packages/vscode/src/statusbar.test.ts` | `Uri` + `env.openExternal`; fix `:71` comment | B5a, B5b — **excursion** |
| `packages/vscode/src/tooltip.test.ts` | same | B5a, B5b — **excursion** |
| `scripts/mock-topology.test.ts` | two new pairs at A1(a); one importer set at A1(b) | A5 — **excursion** |
| `packages/vscode/src/extension.test.ts` | delete `:482` todo; fix `:36-38` docstring | A7 — **excursion** |
| `SPEC.md` | `§10.5` gains `ClaudeWatch: Diagnostics` | A11 — **excursion** |

**Explicitly not touched:** `packages/statusline`, `packages/metrics`, `packages/core/src` other
than `call-sites.test.ts`, `extension.ts`, `tooltip.ts`, `statusbar.ts`, `core-bridge.ts`,
`extension-bridge.ts`, `statusbar-bridge.ts`, `telemetry-gate.ts`, `scripts/mock-topology.ts`
(the analyzer itself — only its test changes), `CLAUDE.md`.

If the diff touches anything above, that is a finding for `review.md`, not a silent widening.
Loop 027 shipped a `plan.md` that denied an excursion present in the same commit; this fence is
written to make that impossible to repeat by accident.

## Steps

Four steps. **Each must leave `bun run verify` green before the next begins, and each is its own
commit.** Loop 027's plan required this and then landed everything in one commit; that is a
process deviation this loop is explicitly trying not to repeat, and `review.md` will state
whether it held.

### Step 1 — the bridge and the typed `commands.ts` (B1, B2, B3-partial)

`commands-bridge.ts`, new, value re-binding only:

```ts
import * as core from '@claudewatch/core';
export const readCache = core.readCache;
export const formatTooltip = core.formatTooltip;
export type { CacheEnvelope } from '@claudewatch/core';
```

`commands.ts`:
- `import { readCache, formatTooltip } from './commands-bridge.js';` and
  `import type { CacheEnvelope } from './commands-bridge.js';`
- delete `const vscode = await import('vscode')` (`:10`) and `await import('@claudewatch/core')` (`:11`)
- `let cache: CacheEnvelope | null = null;`
- `showDiagnostics` stays `async` (registered as a command; signature is observable)
- **`if (cache && cache.snapshot)` is retained verbatim** despite the second clause being
  unreachable once typed — deleting it changes displayed output, which `intent.md` scopes out

Gate must be green here. No test yet asserts any of it; that is Step 3's job, and saying so is the
point of splitting the steps.

### Step 2 — the rule and the typed shapes (B3, B4)

`.oxlintrc.json` gains `"typescript/no-explicit-any": "error"`.

`manifest.test.ts` — a `Manifest` interface whose asserted fields are **required**, attached by
declaration annotation:

```ts
const manifest: Manifest = JSON.parse(readFileSync(...));
```

Not `as`. `JSON.parse` returns `any`, so an annotation needs no operator. Optional fields would
reintroduce 6 `TS18048`s because `expect(setting).toBeDefined()` does not narrow for `tsc`.

`call-sites.test.ts` — **one flat `SpoolEvent` interface** with optional payload fields, not a
discriminated union; a union forces narrowing at all 13 assertion sites.

Gate green: 0 lint errors, 0 typecheck errors.

### Step 3 — the tests and the stubs (B5, B5a, B5b)

`commands.test.ts`: mocks `./commands-bridge.js` and `vscode`, and **installs its capture sinks by
mutating the resolved module inside each test** rather than trusting its own factory to survive the
merge —

```ts
(await import('vscode')).window.showInformationMessage = capture;
```

— because B5a measured that a file-local factory is not sufficient: `mock.module('vscode')` is a
per-key composite across files and a key only one stub defines can vanish.

`statusbar.test.ts` and `tooltip.test.ts` gain `Uri: { parse }` and `env.openExternal`, and their
`:71`/`:22` "last-writer-wins" sentence is replaced with the measured behaviour. Their `:80`/`:31`
"the moment extension.test.ts's third `test.todo` becomes a test, this breaks" is now the thing
that happened, so it is rewritten rather than left as a prophecy about the past.

`extension.test.ts`: delete the `:482` todo; update the `:36-38` NOT COVERED docstring. Note it
lists three gaps while the file has **four** todos — the `onDidChangeTelemetryEnabled` one was added
without updating it. Fix the count while here.

### Step 4 — the guard, the spec, and the criteria evidence (A5, A11, A2)

`mock-topology.test.ts` — A1(a) gains two pairs (`commands.test.ts` mocks `vscode` too, not only
the bridge); A1(b) gains
`expect(findImporters(files, './commands-bridge.js', 'packages/vscode/src')).toEqual(['packages/vscode/src/commands.ts'])`.

`SPEC.md §10.5` gains one line for `ClaudeWatch: Diagnostics`.

Then run A2's three arms and paste all three into `review.md`.

## Test mapping

| Behaviour | Test | File |
|---|---|---|
| B1 — no direct core import | A4 grep, plus A5's importer set | `mock-topology.test.ts` |
| B2 — no shadowed import | A6 warning diff | (lint) |
| B3 — typed, no `any` | A1 + A3 | (lint) |
| B4 — rule can fail the gate | **A2 three arms** | (manual, recorded) |
| B5 cache present | `showDiagnostics` formats + `{ modal: true }` | `commands.test.ts` |
| B5 no cache | "No cache or snapshot found." via `cache === null` | `commands.test.ts` |
| B5 `readCache` throws | catch arm, message included | `commands.test.ts` |
| B5 redaction | no `sk-ant-` and no credential path in output | `commands.test.ts` |
| B5 `openDashboard` | `env.openExternal` receives the dashboard URL | `commands.test.ts` |
| B5a stub composite | A10 — package run AND single-file run both pass | `commands.test.ts` |

## Mutation table — predictions recorded BEFORE running

A8 requires at least one per B1–B5 including the two named. Each prediction is a **count and a
named test**; "some tests fail" is not a prediction.

| # | Mutation | Predicted |
|---|---|---|
| M1 | revert `commands.ts` to `await import('@claudewatch/core')` | A4's grep fails; A5's importer set fails. Runtime tests still **pass** — the bridge mock is bypassed but real core works. Predicting tests-still-green here is the point: it shows A4/A5 are the only things guarding B1. |
| M2 | delete `{ modal: true }` from `showInformationMessage` | exactly 1 — the cache-present case |
| M3 | delete the `catch` block in `showDiagnostics` | exactly 2 — the throw case and the redaction case (both drive a throw) |
| M4 | change `'No cache or snapshot found.'` to another string | exactly 1 — the no-cache case |
| M5 | `openDashboard` opens a different URL | exactly 1 — the `openDashboard` case |
| M6 | remove `Uri` from `statusbar.test.ts` **and** `tooltip.test.ts` | ≥1 in the **package** run, 0 in the single-file run. This is A10's whole reason for naming both. |
| M7 | remove `"typescript/no-explicit-any"` from `.oxlintrc.json` with the A2 seed present | lint exits **0** — A2 arm (b) |
| M8 | restore `let cache: any` | lint exits 1 with exactly one `no-explicit-any` at that line |

Any mutation whose actual count differs from its prediction gets investigated before the number is
believed, and both numbers go in `review.md`. Loop 027's single wrong prediction found a real
fixture defect; the five right ones taught nothing.

## Verification

1. `export CLAUDEWATCH_VERIFY_METRICS=1` first, then `bun run verify` after **each** step, output
   redirected to a file.
2. A2's three arms, all pasted into `review.md`. Arm (b) is the criterion; (a) and (c) alone fail it.
3. `bun test packages/vscode/src/commands.test.ts` alone **and** `bun test packages/vscode` — A10.
4. The A6 warning **diff**, not just the count: exactly one line removed, none added.
5. CJS check on the built bundle — `bun run verify` does not do it.
6. Stage 5: `plan-to-diff-auditor` and `security-reviewer`, briefed on the commit range, told not to
   write into the tree, run **sequentially** so neither finds the tree dirty mid-audit.

## Risks carried into implementation

- **A2 is still the criterion most likely to be shipped as nothing**, even after being rewritten to
  close the null-experiment hole. It is manual. If arm (b) is not actually run, `review.md` says so
  rather than implying it passed.
- **M1 predicts tests stay green.** If they go red instead, that is more interesting than the
  prediction being right, and means something reaches the bridge that this plan has not identified.
- **The four-step commit discipline is the thing most likely to slip**, because it is the one
  requirement with no automated check. `review.md` records whether it held.

## Next stage

`/sdlc-implement`, Step 1 first.
