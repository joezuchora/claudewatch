# Spec: route commands.ts through a bridge, and make the gate enforce "no any"

- **ID:** 028-commands-bridge
- **Stage:** 2 — Design
- **Status:** revised after spec review (see "Spec review" at the end)
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

`commands-bridge.ts` must have **exactly one importer** (`commands.ts`), so loop 026's R1 rule stays
green and a second importer — the defect that rule exists to catch — is not created.

REVISED: an earlier draft said one importer "is what makes it safe to mock". That is contradicted by
the guard it cites. `scripts/mock-topology.ts:25-27` says in as many words: *"A module with exactly
one non-test importer P still contaminates every test that reaches it through P; measured, and out
of scope. Do not read 'exactly one consumer' as safety."* `extension.ts` imports `./commands.js`
both statically (`:23`) and dynamically (`:99`), so `extension.test.ts` reaches
`commands-bridge.ts` through `commands.ts` — the row that table labels LEAKS.

The reviewer probed for a live leak in both file orders and **could not reproduce one** for this
topology, while confirming the mechanism still fires on a synthetic pair on bun 1.3.11. So: not a
verified defect, but a verified-unsound justification. The honest rationale is narrower — the bridge
removes a direct `@claudewatch/core` import from a surface file (the sdlc/001 hazard, and what A4
checks) and keeps R1 green. It does not make mocking safe.

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

REVISED with the reviewer's mechanism, which makes that rule satisfiable rather than aspirational.
`JSON.parse` returns `any`, so the shape attaches by **declaration annotation** — `const manifest:
Manifest = JSON.parse(...)` — which needs no operator at all. Verified by the reviewer end to end:
0 typecheck errors, 0 lint errors, 478 pass.

Two details that are decisions, not consequences:

- `call-sites.test.ts` gets **one flat interface with optional payload fields**, not a discriminated
  union. A union would force narrowing at all 13 assertion sites.
- The 20-error figure is the cost of the *mechanical swap*, not of the *prescribed fix*. Writing
  `manifest.test.ts`'s interface the natural way — optional fields mirroring `package.json` — yields
  6 fresh `TS18048` errors, because `expect(setting).toBeDefined()` does not narrow for `tsc`. The
  asserted fields are therefore declared **required**.

`commands.ts:17`'s `if (cache && cache.snapshot)` becomes provably dead once `cache` is typed:
`CacheEnvelope.snapshot` is non-nullable, so the second clause can never be false. **It is retained
unchanged.** B5's no-cache case reaches that branch via `cache === null` only. Deleting it would
change what `showDiagnostics` displays, which `intent.md` puts out of scope.

### B4 — the gate enforces the rule

`.oxlintrc.json` gains `"typescript/no-explicit-any": "error"`. **`error`, not `warn`**: the repo
already carries 12 standing warnings that nobody acts on, so a warning here would be indistinguishable
from the status quo it is meant to change. `CLAUDE.md` states the rule as a constraint; the gate
should agree with `CLAUDE.md` or `CLAUDE.md` should stop saying it.

### B5 — the two commands get tests

`commands.test.ts` mocks `./commands-bridge.js` and the `vscode` module, and covers:
- `showDiagnostics` with a cache present → formats the snapshot, shows a modal (`{ modal: true }`
  asserted; a non-modal message truncates).
- `showDiagnostics` with no cache → the "No cache or snapshot found." path.
- `showDiagnostics` when `readCache` throws → the `catch` at `:22`, message included.
- `showDiagnostics` when `readCache` throws an error whose message embeds a fake `sk-ant-` token →
  the rendered string contains neither the token nor a credential-file path. `SPEC.md §12` requires
  redaction from surfaced errors and forbids tokens in "debug output"; `showDiagnostics` **is** the
  debug-output surface, and this is the only time it will get tests.
- `openDashboard` → opens the dashboard URL via `env.openExternal`.

#### B5a — giving `commands.test.ts` its own complete stub is NOT sufficient

REVISED after the spec review, which measured this and I then reproduced independently.
`mock.module('vscode', …)` across several files does **not** produce last-writer-wins, and does not
produce a union either. It produces a **per-key composite**, and a key defined by only one file can
vanish. Probe in a whole-package run:

```
PROBE top-level keys: ["MarkdownString","StatusBarAlignment","ThemeColor","commands","env","window","workspace"]
PROBE has Uri: false                          <- extension.test.ts's stub defines Uri
PROBE window keys: ["createStatusBarItem"]    <- statusbar/tooltip's stub, NOT extension.test.ts's
PROBE env keys: ["isTelemetryEnabled"]
```

`window` came from one stub while `Uri` — defined by another — is absent from the merged module
entirely. So a `commands.test.ts` that is green alone goes red in a package run:

```
bun test packages/vscode/src/commands.test.ts   ->  passes
bun test packages/vscode                        ->  TypeError: undefined is not an object
                                                    (evaluating 'vscode.Uri.parse')
```

Two consequences the original B5 hid behind the word "forces":

1. **`statusbar.test.ts` and `tooltip.test.ts` must BOTH gain `Uri` and `env.openExternal`.** Named
   here; added to the declared excursion below.
2. **`commands.test.ts` must not depend on which stub's key wins.** It installs its capture sinks by
   mutating the resolved module inside each test —
   `(await import('vscode')).window.showInformationMessage = …` — rather than trusting its own
   factory to survive the merge. Stated as a mechanism because "give it a complete stub" is
   measured-false.

#### B5b — the "last-writer-wins" comments are wrong and are corrected here

`statusbar.test.ts` and `tooltip.test.ts` both state `mock.module('vscode')` is
"process-wide and last-writer-wins". The probe above falsifies it: `Uri` was defined and did not
survive. Loop 027 rewrote those comments and left that clause intact — the measured facts in them
(`env` → 16 failures, `onDidChangeConfiguration` → 0) remain true, but the stated *mechanism* does
not. This loop opens both files anyway, so it corrects them.

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

- **A1** — `.oxlintrc.json` contains `"typescript/no-explicit-any": "error"`, and **`bun run lint`**
  exits 0 with **0** errors. Names the command CI actually runs (`"lint": "oxlint"`, no path
  arguments), not a hand-written path-scoped invocation that could diverge from it.
- **A2** — **the rule can fail the gate, and it is the rule doing it.** REVISED: the original
  wording was a null experiment. Seed `let _x: any = 1;` (underscore-prefixed) into
  `packages/vscode/src/commands.ts`, then run three arms and paste all three into `review.md`:
  - **(a)** rule present → `bun run verify` exits non-zero, and the ONLY diagnostic at that line is
    `typescript(no-explicit-any)`.
  - **(b)** seed still present, **only** `"typescript/no-explicit-any"` removed from
    `.oxlintrc.json` → `bun run lint` exits **0**.
  - **(c)** seed removed, rule restored → `bun run verify` exits 0.

  **Arm (b) is the criterion.** Without it, A2 is satisfied by a rule that shipped in loop 001.
  Measured: the originally-specified seed `let x: any = 1;` (no underscore) also trips
  `eslint(no-unused-vars)`, which `correctness: "error"` already enables, so the gate goes red with
  `no-explicit-any` **deleted**:

  | seed | rule ON | rule OFF |
  |---|---|---|
  | `let x: any = 1;` | exit 1, 2 diagnostics | **exit 1** — `no-unused-vars` |
  | `let _x: any = 1;` | exit 1, 1 diagnostic (`no-explicit-any`) | **exit 0** |

  A `review.md` showing only (a) and (c) fails this criterion. This is the third loop in a row to
  produce a criterion of this shape, and the first to catch it before implementation.
- **A3** — REVISED. The original was a manual eyeball dressed as a command: that grep returns 67
  hits today, all prose, with no exit code separating pass from fail — and it re-enshrined the very
  method `intent.md` identifies as the defect. Replaced with a redundant cross-check that has an
  exit code: `grep -rqE '(: *any\b|<any>|as any|, *any *>)' packages/*/src scripts --include=*.ts`
  exits **1** (no match). Explicitly secondary to A1; the linter is the gate.
- **A4** — `commands.ts` contains no `@claudewatch/core` import:
  `grep -c "@claudewatch/core" packages/vscode/src/commands.ts` is 0.
- **A5** — REVISED, because the original was satisfiable by a suite that never checks the property.
  Loop 026's guard gains **two** pairs, not one — `commands.test.ts` mocks `vscode` as well:
  `['packages/vscode/src/commands.test.ts', './commands-bridge.js']` and
  `['packages/vscode/src/commands.test.ts', 'vscode']`. And because A1(b)'s importer-set assertion
  pins nothing about the new bridge, it must gain a line:
  `expect(findImporters(files, './commands-bridge.js', 'packages/vscode/src')).toEqual(['packages/vscode/src/commands.ts'])`.
  Without it, "exactly one importer" is asserted by no test — the hole loop 026 wrote A1(b) to close,
  reopened for the new bridge.
- **A6** — the warning count drops **12 → 11**, AND the before/after warning lists differ by exactly
  one removed line, `commands.ts:10:9 eslint(no-shadow)`, with **no added lines**. The count alone is
  not enough: a `commands.test.ts` written with a nested helper would trip
  `unicorn(consistent-function-scoping)` — which already fires twice in this repo — and A6 would read
  12 → 12 with the shadow fix landed correctly. A warning introduced by this loop's own new files is
  a finding, not a reason to relax the number.
- **A7** — `commands.test.ts` exists, covers the cases in B5, and loop 027's
  `test.todo('commands.ts: openDashboard and showDiagnostics')` is **deleted**, not left beside the
  tests that now cover it. EXTENDED: deleting it falsifies three docstrings that must be updated in
  the same commit — `extension.test.ts:36-38` ("NOT COVERED … and `commands.ts`. There is a
  `test.todo` per gap"), and the identical notes at `statusbar.test.ts` and `tooltip.test.ts` that
  say "the moment extension.test.ts's third `test.todo` becomes a test, this breaks". That sentence
  describes exactly the hazard A10 is about, so leaving it stale is not cosmetic. This repo has an
  explicit memory of docstrings asserting what the code does not have; shipping a newly-false one
  while fixing another would be a regression against it.
- **A8** — every mutation in the plan's mutation table produces its predicted failure count. The
  table must cover at least one mutation per B1–B5, including one that deletes the `{ modal: true }`
  argument and one that reverts `commands.ts` to `await import('@claudewatch/core')`.
- **A9** — the built VS Code bundle is still CJS. Copy-pasteable, not described:
  `grep -c "module.exports\|require(" packages/vscode/dist/extension.js` is > 0 and
  `grep -cE "^export |^import " packages/vscode/dist/extension.js` is **0**. `bun run verify` does
  not check this.
- **A10** — NEW, from the spec review. **Both** `bun test packages/vscode/src/commands.test.ts` alone
  and `bun test packages/vscode` pass. Both, explicitly: the single-file run is green today while the
  package run is red, so a criterion naming only one cannot see this class of failure at all.
- **A11** — NEW. `SPEC.md §10.5` lists `claudewatch.diagnostics`. See the amendment note below.

## Risks

- **The excursion is SIX files, not two.** Resized after the spec review. `manifest.test.ts` and
  `call-sites.test.ts` (the `any` fix, declared in `intent.md`), plus `statusbar.test.ts` and
  `tooltip.test.ts` (B5a's `Uri`/`env.openExternal`, and B5b's wrong comment), plus
  `scripts/mock-topology.test.ts` (A5) and `extension.test.ts` (A7's docstring and todo). The first
  draft declared two and the reviewer found four more — the same under-declaration loop 027 shipped,
  caught one stage earlier this time.
- **`commands-bridge.ts` is the fourth bridge module, and three of B5's five cases do not need it.**
  The alternative the first draft never named: `setupTestCacheDir()` + `writeCache(...)` from
  `test-helpers.ts` covers cache-present, no-cache and `openDashboard` with no new bridge and no
  fourth process-wide mock. Only the throw case needs the mock — and `readCacheResult`
  (`cache.ts:75-153`) is engineered so it cannot throw: `readFileSync` and `JSON.parse` are both in
  `try`, non-object results are guarded, version and shape mismatches return rather than throw.
  **Decision: keep the bridge**, because A4 — no direct `@claudewatch/core` import in a surface file
  — is the original queue item and is worth doing on its own. But the throw-arm test is a unit test
  of an arm production cannot currently reach, and `review.md` must say so rather than let a later
  reader count it as coverage of a real failure mode.
- **A2 is the criterion most likely to be shipped as nothing** — loop 021 shipped one, loop 027
  shipped another. It requires seeding a violation and watching the gate go red. If that is not
  actually run, `review.md` says so.


## Spec amendment: an undocumented third command

`SPEC.md §10.5` lists exactly two commands — Refresh Now and Open Usage Dashboard. `§8.4` likewise.
`claudewatch.diagnostics` appears in neither, though it is registered and shipped.

The drift predates this loop. But this loop is where that command acquires a test suite, a dedicated
bridge module, and criterion-backed behaviour — the point at which it becomes load-bearing. `CLAUDE.md`
is explicit that "when this file and SPEC.md disagree, SPEC.md wins", so silence is the one option not
available. **This loop adds the one-line `§10.5` entry** rather than opening a follow-up, and counts
`SPEC.md` in the declared excursion (seven files).

## Spec review

Run at Stage 2 against `2b359f3..bf25c45`. Returned **two BLOCKING**, seven SHOULD-FIX, three
ADVISORY, three NIT. All are incorporated above. Two were independently re-measured by me before
acting, because both invalidate something I had written:

1. **A2 was a null experiment** — the prescribed seed `let x: any = 1;` also trips `no-unused-vars`,
   already `error` since loop 001, so the gate went red with `no-explicit-any` deleted. Reproduced
   exactly. The spec had flagged this shape as its own biggest risk one section earlier and then
   committed it.
2. **`mock.module` is a per-key composite, not last-writer-wins.** Reproduced with a probe: `Uri`
   is absent from the merged module though a stub defines it, and `window` resolves to a different
   stub's. This falsifies a comment in two files that loop 027 rewrote and left intact.

The reviewer also verified the whole spec was implementable — building the bridge, the tests and both
typed shapes to get 0 lint errors, 11 warnings, 478 pass, CJS bundle — which is what makes the
findings about *criteria that prove nothing* rather than about feasibility.

Every measurement in this spec's opening table was independently reproduced by the reviewer and
matched exactly.

## Next stage

`/sdlc-plan`. The plan must carry the seven-file fence declared above, and a mutation table meeting
A8.
