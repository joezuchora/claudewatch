# Plan: drive the extension's refresh through what ships

- **ID:** 027-extension-tests
- **Stage:** 3 — Build (planning half)
- **Status:** accepted
- **Reads:** `spec.md` (revision 2)
- **Date:** 2026-08-27

## Approach

Order matters, because two steps are unrecoverable once later ones land.

1. **Widen the two existing `vscode` stubs first**, and confirm the package suite is still green.
   This is inert on its own and it is what makes step 4 possible at all — without it `activate`
   throws in a whole-package run.
2. **Split the bridge**: new `extension-bridge.ts`, repoint `extension.ts`, trim `core-bridge.ts`.
   Update the two `mock-topology.test.ts` assertions in the same step, since the split changes what
   they pin.
3. **Change `:90` to `() => doRefresh(true)`** — the one permitted production change, named in the
   spec so it cannot be slipped in.
4. **Write the tests**, isolated `HOME` first, before any branch case. The `HOME` guard is what
   makes a wrong branch safe rather than expensive.

Steps 1 and 2 are separately verifiable and must each leave the gate green before the next.

## Scope fence

| Path | Why |
|---|---|
| `packages/vscode/src/extension-bridge.ts` | **new** — the module `extension.test.ts` mocks |
| `packages/vscode/src/extension.ts` | import specifiers; `:90` returns the promise |
| `packages/vscode/src/core-bridge.ts` | drops the sixteen symbols only `extension.ts` used; docstring |
| `packages/vscode/src/extension.test.ts` | **new** — the tests |
| `packages/vscode/src/tooltip.test.ts` | `vscode` stub gains `env` + `commands` |
| `packages/vscode/src/statusbar.test.ts` | same |
| `scripts/mock-topology.test.ts` | the pairs assertion at `:348` and the importer set at `:367` |

**Explicitly not touched:** all of `packages/core`, `packages/statusline`, `packages/metrics`,
`commands.ts`, `tooltip.ts`, `statusbar.ts`, `telemetry-gate.ts`, `manifest.test.ts`, `SPEC.md`,
`scripts/mock-topology.ts` (the analyzer itself — only its test's pinned values change).

## Changes

### `tooltip.test.ts`, `statusbar.test.ts`

Each `mock.module('vscode', …)` factory gains `env: { isTelemetryEnabled: false }` and
`commands: { registerCommand: () => ({ dispose() {} }) }`, so whichever stub wins the process-wide
race is a superset of all three files' needs.

### `extension-bridge.ts` *(new)*

Value re-binding of the sixteen symbols plus the three types. Same construction and same rationale
as the other bridges (`export … from` keeps the mock linked to the original — loop 001).

### `extension.ts`

- Two value-import statements and the type-import line move to `'./extension-bridge.js'`.
- `:90` becomes `() => doRefresh(true)`.

### `core-bridge.ts`

Drops the sixteen; keeps `formatTooltip` and the types `tooltip.ts` needs. Docstring names its
single consumer and states plainly that it is the unmocked residue — which is the honest answer to
the intent's Q3, since it is *not* named for its consumer.

### `extension.test.ts` *(new)*

Isolated `HOME` (expired credential), a superset `vscode` stub, an `extension-bridge` mock whose
key set is asserted, `ctx.subscriptions` disposed then `deactivate()` in `afterEach`, and a bounded
`settle()` helper that polls the mock's call log until stable.

### `scripts/mock-topology.test.ts`

`:348` gains the two `extension.test.ts` pairs; `:367`'s `core-bridge.js` importer set goes from
two to one.

## Tests

| Criterion | Case | Expect |
|---|---|---|
| A1 | real tree, both assertions | exact match |
| A3 | dedupe, fresh cache, cooldown write, cooldown **suppression**, `authState: 'missing'`, empty token with valid state, invalid, fetch ok, fetch fail × {presentation, cached/none, cooldown y/n} | each red when its arm is broken |
| A4 | `HOME` isolation + throwing `fetchUsage`, one returning case | no live request possible |
| A5 | `setInterval` handle captured; `clearInterval` called with it | red if `:132` deleted |
| A6 | bounded `settle()` before each assertion | no arithmetic on call counts |
| A9 | bridge-mock key set | red on a missing or surplus key |
| A10 | telemetry config asserted `{enabled:false}` | nothing reaches `~/.cache/claudewatch` |

## Verification

1. `bun test packages/vscode` **and** `bun test` from the root — the distinction that caught
   revision 1's single-file probe.
2. `bun run verify` exits 0; loop 026's guard green with no allowlist entry.
3. Mutations, each predicted before running:
   - delete `extension.ts:132` → **A5 red**.
   - revert `:90` to the discarding form → **predicted: the fetch cases hang or time out**, not a
     clean assertion failure. If they pass, `settle()` is not actually waiting and A6 is theatre.
   - remove one key from the bridge mock → **A9 red**, and *not* a silent pass into the `:252`
     catch.
   - break the cooldown suppression guard → **the suppression case red, the write case still
     green** (they are different arms; if both go red the two cases are testing one thing).
4. A branch-coverage read of `extension.ts:152-268`; anything uncovered goes in A8 with a
   `test.todo`.
5. Stage 5: `plan-to-diff-auditor` and `security-reviewer` on the commit range, **not run
   concurrently with each other over the same files** (loop 026's auditor found the tree dirty
   mid-audit).

## Risks

- **Seven files, three of them existing tests.** The largest fence in this project so far. Steps 1
  and 2 are staged separately so a failure localises.
- **The `:252` catch absorbs mistakes.** Every case must reach its own branch, not the catch. The
  spec's B4 finding is that this already fooled one prototype; the A9 key-set assertion is the
  structural defence, and the mutation above is the check on it.
- **`settle()` is a polling helper with a timeout** — the shape most likely to be flaky under CI
  load. It must fail loudly on timeout rather than proceeding, and the timeout must be generous
  (loop 005's smoke tests learned this at 5s versus 20s).
- **The bridge split lands unverified.** `typecheck` and the existing suite are the only guards
  until the tests exist, which is why both halves are in one loop.
