# ClaudeWatch

A personal open-source companion tool for Claude Code that shows usage window data in VS Code
and terminal.

## Spec

The complete specification is in SPEC.md. Read it before making architectural decisions.
It is the source of truth for the domain; when this file and SPEC.md disagree, SPEC.md wins.

## Development loop

This repo follows an AI-native SDLC. Work moves through six stages, each ending by committing
an artifact that the next stage reads:

```
intent.md → spec.md → plan.md → diff + tests → review.md → incident.md
```

Artifacts live in `sdlc/<NNN>-<slug>/`. Run the stage skills in order: `/sdlc-intent`,
`/sdlc-spec`, `/sdlc-plan`, `/sdlc-implement`, `/sdlc-review`, and `/sdlc-incident` when
something ships broken. See CONTRIBUTING.md for the full walkthrough and REVIEW.md for the
review policy every change is held to.

Small, obvious fixes (a typo, a broken link) may skip the loop. Anything that changes
behavior does not.

## Stack

- TypeScript (strict), ES modules, no `any`
- Bun for everything: workspaces, build, test, `--compile`
- Monorepo: `packages/core`, `packages/statusline`, `packages/vscode`

Package-specific rules live in each package's own `CLAUDE.md`.

## Key Commands

- `bun install` — install all workspace dependencies
- `bun test` — run all tests
- `bun run --filter @claudewatch/core build` — build core
- `bun run --filter @claudewatch/statusline build` — compile statusline binary
- `bun run --filter claudewatch-vscode build` — build VS Code extension

## Code Style

- All timestamps internal as UTC ISO strings; convert to local only at display
- No access tokens in logs, cache files, debug output, or process arguments
- Atomic file writes (write to temp, rename) for cache
- Missing optional fields are omitted, not guessed

## Architecture Rules

- All business logic in `packages/core`. Surfaces are thin rendering layers.
- `packages/statusline` and `packages/vscode` must not contain domain logic.
- Reuse before adding — check `packages/core/src/` and `test-helpers.ts` first.
- When in doubt about a design decision, check SPEC.md.

## Testing

- Test files live next to source files as `*.test.ts`
- Mock HTTP responses for contract tests — never hit the real API in tests
- Keep tests isolated; mock state must not leak across test files
- Every behavior ships with its check, in the same commit

## Pre-Commit Verification Pipeline

Before committing, run the gate and fix anything it reports:

```bash
bun run verify
```

That runs `typecheck` -> `lint` -> `test` -> `build`, stopping at the first failure. Each step
is also available on its own (`bun run typecheck`, `bun run lint`, `bun run test`,
`bun run build`) when you want to iterate on one.

CI runs this exact command, so a green `verify` locally means a green CI.

Two things it does not check for you:

1. **VS Code bundle format.** For extension changes, confirm the built bundle is still
   CommonJS by grepping it for `require` / `module.exports`. An ESM bundle builds fine and
   then fails at activation.
2. **Whether the change matches its plan.** That is the plan-to-diff audit in Stage 5.

Only commit once `verify` exits 0. If it fails, fix and re-run the whole thing — a partial
pass is a fail.

## Git Workflow

- Always confirm the current branch before committing.
- Feature branches are named for their change: `sdlc/<NNN>-<slug>`.
- Never commit directly to `main`.
