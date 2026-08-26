# Plan: make the verification gate real

- **ID:** 001-quality-gate
- **Stage:** 3 — Build
- **Status:** accepted
- **Derived from:** [`spec.md`](./spec.md)
- **Branch:** `claude/ai-sdlc-setup-plan-nqyqbk`

> **Branch deviation, recorded deliberately.** The loop's convention is a `sdlc/<NNN>-<slug>`
> branch per change. This session is constrained to push only to
> `claude/ai-sdlc-setup-plan-nqyqbk`, so both loops land there instead. The artifact chain is
> preserved through separate commits per stage, so the sequence is still legible in history.

## Approach

Add the four missing root scripts plus a `verify` that chains them. Introduce `oxlint` and
clear whatever it finds. Fix the test contamination by giving `packages/statusline` a local
re-export module for its core imports, so its module mock can no longer reach
`packages/core`. Point CI and the documented pipeline at the same `verify` command.

Order matters: fix isolation **first**, because until `bun test` is honest, `verify` cannot be
green and nothing downstream can be trusted.

## Scope fence

```
package.json
bun.lock
.oxlintrc.json
.oxlintrc.README.md
packages/statusline/src/core-deps.ts
packages/statusline/src/main.ts
packages/statusline/src/main.test.ts
packages/vscode/src/core-bridge.ts
packages/vscode/src/statusbar.ts
packages/vscode/src/statusbar.test.ts
packages/vscode/src/tooltip.ts
packages/vscode/src/tooltip.test.ts
packages/vscode/src/extension.ts
packages/core/src/client.test.ts
packages/core/src/cooldown.test.ts
packages/core/src/credentials.test.ts
packages/core/src/types.test.ts
.github/workflows/ci.yml
CLAUDE.md
.claude/settings.json
sdlc/001-quality-gate/plan.md
sdlc/001-quality-gate/review.md
```

> **Fence amended during implementation (2026-08-26).** The original fence covered only
> `packages/statusline`. Two discoveries widened it, both recorded in `review.md`:
> `packages/vscode/src/statusbar.test.ts` turned out to be a *second* file mocking the shared
> core barrel, so the same indirection had to be applied there; and the linter's first run
> found unused imports in four `packages/core` test files. The original fence is preserved in
> git history at commit `bbeff04`.

Any lint fix required in a file outside this list is an excursion and must be recorded in
`review.md`. That is expected to happen — the linter has never run on this tree — so the
fence is deliberately tight to make the real blast radius visible rather than assumed.

## Changes

### `packages/statusline/src/deps.ts` (new)
- Re-export from `@claudewatch/core` exactly the symbols `main.ts` imports — 19 values and 4
  types. Re-exports only; no logic, no wrappers.
- Serves the spec's isolation decision: gives the test a statusline-owned mock target.

### `packages/statusline/src/main.ts`
- Change the single import source from `'@claudewatch/core'` to `'./deps.js'`. Imported
  symbols and every call site are unchanged.

### `packages/statusline/src/main.test.ts`
- Change `mock.module('@claudewatch/core', …)` to `mock.module('./deps.js', …)`.
- Real pass-through functions still come from `'@claudewatch/core'` directly, which is now
  safe: the mock no longer targets that module.
- No assertion changes. If any assertion needs changing, the refactor was not behavior-neutral
  and must stop.

### `package.json`
- Add `oxlint` devDependency.
- Add scripts: `typecheck`, `lint`, `test`, `build`, `verify`.

### `.oxlintrc.json` (new)
- Enable the `correctness` set. Ignore `dist`, `node_modules`, `scripts`.
- Any rule disabled must carry a comment stating why.

### `.github/workflows/ci.yml`
- Replace the three separate test steps and three build steps with `bun run verify`, so CI and
  contributors run the identical gate.

### `CLAUDE.md`
- Rewrite the Pre-Commit Verification Pipeline section around `bun run verify`, naming only
  commands that exist.

### `.claude/settings.json`
- Repoint the PostToolUse hook from `bun run tsc --noEmit` to `bun run typecheck`.

## Tests

This change adds no unit tests: it introduces no behavior to test. Its correctness claim is
that the existing 341 tests all pass in one process and that the gate fails when it should.
That is verified by execution, recorded in `review.md`.

| Spec criterion | Verification | Where |
|---|---|---|
| `verify` exits 0 clean | run it, capture exit code | `review.md` |
| `typecheck` / `lint` / `build` standalone | run each | `review.md` |
| `bun test` = 341 pass / 0 fail | run bare `bun test` | `review.md` |
| `verify` fails per step | seed a type error, a lint error, and a failing test in turn; observe exit code and which step reports | `review.md` |
| VS Code bundle still CJS | grep built bundle for `require` / `module.exports` | `review.md` |
| CI runs the gate | workflow diff + green run | PR |
| `CLAUDE.md` names real commands | run each command it names | `review.md` |

The negative test — that the gate actually fails — matters more than the positive one. A gate
that cannot fail is not a gate, and this repo has just spent months proving that a pipeline
nobody executed is indistinguishable from one that does not work.

## Risks

- **The linter finds a lot.** It has never run. Fixes outside the fence get recorded, and any
  genuine behavior change found is stopped and split into its own intent rather than absorbed
  here.
- **A "safe" lint autofix changes behavior.** Do not use `--fix` blindly; review every fix.
- **`deps.ts` drifts from `main.ts`'s needs.** Typecheck catches it — a missing re-export is a
  compile error, not a silent failure.
- **CI consolidation loses signal.** Splitting six steps into one makes a failure marginally
  harder to read in the Actions UI. Accepted: `verify` short-circuits and names the failing
  step, and identical-to-local is worth more than granular CI output.

---

**Next stage:** Build/Test — run `/sdlc-implement 001-quality-gate` to write the diff.
