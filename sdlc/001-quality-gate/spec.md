# Spec: make the verification gate real

- **ID:** 001-quality-gate
- **Stage:** 2 — Design
- **Status:** accepted
- **Derived from:** [`intent.md`](./intent.md)

## Summary

The repository gains a single command, `bun run verify`, that runs typecheck, lint, test, and
build, and exits 0 on a clean checkout. Each of its four steps is also a standalone script.
A linter is introduced. The cross-file test contamination that makes `bun test` report 128
false failures is fixed at its source. CI runs the same command a contributor runs.

No runtime behavior changes.

## Design decisions

### Linter: `oxlint`

Chosen over ESLint 9 + typescript-eslint. `oxlint` is a single binary with no plugin graph,
installs in under a second, and needs almost no configuration — which suits a project whose
stated identity (`SPEC.md §2.2`) is an all-bun toolchain with zero runtime dependencies.

**Trade-off, accepted knowingly:** oxlint has no type-aware rules. That overlap is small here
because `tsc --noEmit` already runs under `strict` with `noUncheckedIndexedAccess`-grade
settings, and it is the first step of the gate regardless. If type-aware lint rules later earn
their weight, swapping to ESLint is a contained change — the `lint` script is the only seam.

### Test isolation: a local indirection module

`packages/statusline/src/main.test.ts` calls `mock.module('@claudewatch/core', …)` at module
top level. Bun applies module mocks process-wide and **`mock.restore()` does not undo
`mock.module`** — verified directly. Bun also has no per-file process isolation flag. So the
mock cannot be scoped away by teardown; it has to stop targeting a shared module.

Three options were considered:

| Option | Verdict |
|---|---|
| Root `test` script runs each package in its own process (what CI does today) | **Rejected.** It makes `bun run test` green while leaving bare `bun test` — the command in `CLAUDE.md` and `README.md` — still red. That hides the defect again rather than fixing it, which is precisely how it survived this long. |
| Refactor `main()` to take injected dependencies | **Rejected for this change.** It is the most principled fix, but it changes a runtime signature and rewrites the plumbing of a 628-line test file. Too large for a change whose value depends on being provably behavior-neutral. |
| Route statusline's core imports through a statusline-local re-export module | **Chosen.** |

`packages/statusline/src/deps.ts` re-exports from `@claudewatch/core` exactly the symbols
`main.ts` uses. `main.ts` imports from `./deps.js`. The test mocks `./deps.js`. The mock is
then aimed at a module only statusline owns, so it cannot replace anything `packages/core`
depends on.

Verified empirically before speccing: with a statusline-local module mocked, core's suite runs
257 pass / 0 fail in 26s — the full runtime, so the tests genuinely executed rather than
short-circuiting on a stub.

**Compliance note:** `deps.ts` contains only re-export statements. It adds no domain logic to
a surface package and so does not weaken the `SPEC.md §8.2` architecture rule. A future
reviewer should reject any attempt to put logic in it.

### Root `test` script runs in one process

`bun run test` is plain `bun test`. Once isolation is fixed there is no reason to split, and
splitting would let the same class of bug hide again.

## Behavior

Five root scripts:

| Script | Runs |
|---|---|
| `typecheck` | `tsc --noEmit` |
| `lint` | `oxlint` across the workspace |
| `test` | `bun test` |
| `build` | all three package builds, core first |
| `verify` | the four above, in that order, short-circuiting on first failure |

`verify` short-circuits with `&&` so the first failure is the one reported — a contributor
sees the type error, not a wall of downstream noise.

## Data and types

None. No type, interface, or serialized format changes. `deps.ts` introduces no new types; it
re-exports existing ones.

## Edge cases

| Case | Expected behavior |
|---|---|
| A step fails | `verify` stops there and exits non-zero. Later steps do not run. |
| Lint finds pre-existing violations | Fixed in this change. Where a rule is more noise than value, it is disabled **in config with a stated reason** — never per-file, never blanket. |
| `node_modules` absent | Same failure mode as any other bun script; `bun install` is a documented prerequisite. |
| Package build order | Core builds first; statusline and vscode depend on it. |
| VS Code bundle format | Unchanged. `build` runs the same per-package commands as before, so CJS output is preserved by construction. |
| A future test mocks a shared module again | Not prevented by this change. Recorded as a residual risk below. |

## Backward compatibility

- **No runtime behavior changes.** No source file in `packages/core` or `packages/vscode` is
  touched. In `packages/statusline`, `main.ts`'s import *source* changes; the imported symbols
  and every call site are identical.
- **Exit codes, CLI flags, output formats, cache format, and the API contract are untouched.**
- The three existing CI test steps are replaced by the single gate. CI coverage strictly
  increases: it gains lint, and it gains whole-suite test isolation it never had.
- `.claude/settings.json`'s PostToolUse hook moves from `bun run tsc --noEmit` to
  `bun run typecheck` — the same command behind a name that now exists.

## Acceptance criteria

- [ ] `bun run verify` exits 0 on a clean checkout — verified by running it
- [ ] `bun run typecheck` exits 0 standalone — verified by running it
- [ ] `bun run lint` exits 0 standalone, with zero errors reported — verified by running it
- [ ] `bun run build` produces all three package outputs — verified by running it and
      checking the artifacts exist
- [ ] `bun test` (bare, single process) reports **341 pass / 0 fail** — verified by running it
- [ ] `verify` exits non-zero when any single step fails — verified by seeding a deliberate
      violation of each of typecheck, lint, and test, and observing the failure and exit code
- [ ] The VS Code bundle is still CommonJS — verified by grepping the built output for
      `require` / `module.exports`
- [ ] CI runs `bun run verify` — verified by the workflow file and a green run on the PR
- [ ] `CLAUDE.md`'s pipeline section names only commands that exist — verified by running
      each command named in it

## Residual risk

Nothing structurally prevents a future test from calling `mock.module` on a shared module and
re-breaking whole-suite isolation. The gate would now *catch* it — bare `bun test` runs in CI
— which is the meaningful improvement. Preventing it outright would need a lint rule or a
review check, and is not worth building until it happens twice.

## Rejected alternatives

- **Leaving `bun test` split by package** — see the decision table. It is the status quo that
  produced this defect.
- **Adding a formatter (prettier/biome) alongside the linter** — a much larger diff, an
  independent decision, and it would bury the behavior-neutral core of this change in
  thousands of reformatted lines.
- **Fixing the three informational security items from `docs/audit-report.md`** — real work,
  but unrelated to the gate. They stay tracked in `REVIEW.md`.
- **Making `verify` run steps in parallel** — faster, but it muddies which step failed. The
  core suite's 26s runtime is the real cost and is out of scope here.

---

**Next stage:** Build — run `/sdlc-plan 001-quality-gate` to turn this into `plan.md`.
