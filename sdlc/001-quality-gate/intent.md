# Intent: make the verification gate real

- **ID:** 001-quality-gate
- **Stage:** 1 — Plan
- **Status:** accepted
- **Author:** Joe Zuchora
- **Date:** 2026-08-26

## Problem

`CLAUDE.md` mandates a seven-step pre-commit pipeline. Its first four steps are
`bun run typecheck`, `bun run lint`, `bun test`, and `bun run build`.

Three of those four cannot be run:

- **`bun run typecheck` does not exist.** The root `package.json` has three scripts, none of
  them this one. CI uses `bun run tsc --noEmit` instead.
- **`bun run lint` does not exist, and no linter is installed anywhere in the repository.**
  There is no eslint, biome, prettier, or oxlint config, and no lint devDependency. The step
  is not merely unwired — there is nothing to wire.
- **`bun run build` does not exist.** Builds only work per-package via `--filter`.

The fourth is worse, because it *appears* to work:

- **`bun test` reports 128 failures out of 341.** `packages/statusline/src/main.test.ts`
  calls `mock.module('@claudewatch/core', …)` at module top level. Bun's `mock.module` is
  process-global and is never restored, so in a whole-suite run the stub replaces the real
  module for `packages/core`'s own 13 test files. CI does not catch this because it runs
  each package in a separate process (`bun test packages/core/`, `bun test packages/statusline/`,
  `bun test packages/vscode/`), and each passes in isolation.

So the repository documents a quality gate that no one can execute, and its headline test
command — the one named in both `CLAUDE.md` and `README.md` — has been failing for anyone
who ran it as documented.

`docs/audit-report.md` already flagged the missing root scripts on 2026-03-10 as a "minor DX
improvement". The test contamination was not caught at all.

## Who is affected

- **Anyone contributing, human or agent.** They are told to run a gate that errors out. An
  agent instructed to run `bun run lint` will fail, improvise, or silently skip the step.
- **Anyone running the documented `bun test`** sees a suite that looks badly broken, with no
  indication that the failures are an artifact of test isolation rather than real defects.
- **The project's own review process.** Everything downstream of this — the review passes,
  the CI audit, the whole SDLC loop — assumes a green gate it can stand on. Right now there
  is nothing underneath.

## Why now

This is the first change through the new SDLC loop, and every later stage's verification
step is written as "run `bun run verify`". If that command does not exist and cannot be
green, the loop has no foundation and every subsequent `review.md` records an unverifiable
claim. Fixing it first is not ceremony — it is the load-bearing dependency.

## What "done" means

- [ ] `bun run verify` exists, runs typecheck + lint + test + build, and exits 0 on a clean
      checkout
- [ ] `bun run typecheck`, `bun run lint`, `bun run test`, and `bun run build` each exist and
      each work standalone
- [ ] A linter is installed, configured, and reports zero errors across the existing source
- [ ] Plain `bun test` passes all 341 tests in a single process — no cross-file contamination
- [ ] CI runs the same gate a contributor runs, so the two cannot drift apart again
- [ ] `CLAUDE.md`'s pipeline section describes commands that actually exist

## Explicitly out of scope

- Changing any runtime behavior of core, statusline, or the VS Code extension. This change
  must be provably behavior-neutral; that is what makes it a safe first loop.
- Adding new test *coverage* (e.g. the untested `extension.ts` and `commands.ts`). Making
  the existing suite runnable is a separate concern from making it more complete.
- Formatting the codebase. A formatter is a much larger diff and a separate decision.
- Resolving the three informational security items in `docs/audit-report.md`.
- The 26-second runtime of the core suite. Real, but not this change.

## Open questions

- **Which linter?** Resolved in Design. Constraints: the project's stated identity is an
  all-bun toolchain with zero runtime dependencies, so weight matters.
- **How should test isolation be fixed — per-file process isolation, or removing the global
  `mock.module`?** Resolved in Design; it determines whether the fix is a config change or a
  test rewrite.

---

**Next stage:** Design — run `/sdlc-spec 001-quality-gate` to turn this into `spec.md`.
