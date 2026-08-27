# Intent: commands.ts violates three stated rules, and one of them has no enforcement

- **ID:** 028-commands-bridge
- **Stage:** 1 — Plan
- **Status:** draft
- **Author:** loop 025's standing finding, re-recorded at 026 and 027
- **Date:** 2026-08-27

## Problem

`packages/vscode/src/commands.ts` is 47 lines. Every one of this repo's three surface-package
rules is broken inside them, and the file has no tests, so nothing has ever noticed.

### 1. It bypasses the bridge

`showDiagnostics` reaches core with `await import('@claudewatch/core')` (`:11`) and calls
`core.readCache()` and `core.formatTooltip()` directly. `core-bridge.ts`'s docstring states the
contract this breaks: surface files reach core through a bridge so that a test mocking one file's
dependency cannot silently stub another's, `mock.module` being process-wide. `commands.ts` is a
fourth core consumer standing outside that arrangement.

This is not theoretical. `extension.ts` `await import`s `commands.ts` at `:99` during `activate`,
so `showDiagnostics` is loaded inside the very test file that mocks `./extension-bridge.js` — and
because it imports `@claudewatch/core` *directly*, that mock does not cover it. Loop 025 paid for
exactly this shape once already.

### 2. It contains the tree's only production `any`

```ts
let cache: any = null;          // :13
```

`CLAUDE.md` states the stack as "TypeScript (strict), ES modules, **no `any`**". This is the only
`any` in any non-test source file in the repo.

### 3. It shadows its own module import

`:10` does `const vscode = await import('vscode')` inside a function whose module already did
`import * as vscode from 'vscode'` at `:1`. oxlint reports it (`no-shadow`) as one of the standing
12 warnings, which is to say it has been visible and ignored on every gate run since loop 001.

## The finding that makes this worth a loop rather than a patch

**The "no `any`" rule is not enforced by anything.** `tsc` does not reject an explicit `any` at any
strictness, and `typescript/no-explicit-any` is absent from `.oxlintrc.json`. Measured just now:

| config | `no-explicit-any` errors |
|---|---|
| shipped `.oxlintrc.json` | rule not enabled — **0**, gate green |
| same + `typescript/no-explicit-any: error` | **3** |

Three, not one. `commands.ts:13` plus `manifest.test.ts:14` and `call-sites.test.ts:19`, both of
which are `Record<string, any>`. **I predicted one and was wrong**, because I had grepped for
`: any` / `as any` / `<any>` and the `, any>` form matches none of them. That is the whole argument
for this loop in one sentence: a rule policed by a hand-written grep is a rule with two known
violations already past it, and no way to know how many more.

So fixing `commands.ts` alone leaves the actual defect — the gate says nothing about a rule
`CLAUDE.md` presents as a constraint — fully intact.

## Who is affected

- **The extension at runtime.** `showDiagnostics` is a shipped, user-invocable command
  (`claudewatch.diagnostics`) that reads the cache and formats a snapshot. Untested.
- **Anyone testing `extension.ts`.** `activate` loads `commands.ts`, whose core import escapes the
  bridge mock. Today it is latent only because the two commands are registered and never invoked.
- **The next contributor**, who reads "no `any`" in `CLAUDE.md` and reasonably assumes the gate
  backs it.

## What "done" means

1. `showDiagnostics` reaches core through a bridge, not `await import('@claudewatch/core')`, and
   the bridge has exactly one consumer so loop 026's guard stays satisfied.
2. No `any` remains in the tree, and `bun run verify` **fails** if one is reintroduced —
   demonstrated by seeding one and watching the gate go red.
3. The shadowed `vscode` import is gone and the standing warning count drops.
4. `showDiagnostics` and `openDashboard` have tests, closing one of loop 027's three `test.todo`s.

## Known cost, declared up front

**AMENDED after the Stage 2 spec review: the excursion is seven files, not two.** The first draft
declared two and the reviewer found four more, plus `SPEC.md`. Recording the correction here rather
than letting Stage 5 find `intent.md` and the diff in contradiction — which is exactly what loop
027 shipped.

| File | Why |
|---|---|
| `manifest.test.ts` | enabling the rule reddens it (7 typecheck errors under the fix) |
| `call-sites.test.ts` | same (13) |
| `statusbar.test.ts` | must gain `Uri` + `env.openExternal`; its "last-writer-wins" comment is false |
| `tooltip.test.ts` | same |
| `scripts/mock-topology.test.ts` | two new pairs and a new importer-set assertion |
| `extension.test.ts` | the `test.todo` this loop closes, and a docstring that lists it as a gap |
| `SPEC.md` | `§10.5` does not list `claudewatch.diagnostics` at all |

The `vscode` stub work is more than loop 027's "superset" note suggested: `mock.module` turns out to
be a per-key **composite** across files, not last-writer-wins, so a key only one stub defines can
vanish from the merged module. Measured, not read. Giving `commands.test.ts` its own complete stub
is provably insufficient.

## Not in scope

- Renaming `core-bridge.ts` to `tooltip-bridge.ts` (recorded in loop 027, still deferred).
- `BRIDGE_KEYS` never checking the bridge's real exports (loop 027).
- Any change to what `showDiagnostics` displays. Its behaviour is out of scope; only how it
  reaches core, and whether it is typed and tested, are in.

## Next stage

`/sdlc-spec` — the design question to settle is whether the three `any`s become `unknown` with
narrowing, or real types, and whether the rule lands as `error` or `warn`.
