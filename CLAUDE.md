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

Before committing any changes, run the full pipeline and fix any issues:

1. `bun run typecheck` — fix all type errors
2. `bun run lint` — fix all lint issues
3. `bun test` — ensure all tests pass
4. `bun run build` — verify the build succeeds
5. If this is a VS Code extension change, verify the output is CommonJS-compatible by checking the bundle for `require`/`module.exports` patterns
6. Only after all steps pass, create the commit. If any step fails, fix the issue and re-run the full pipeline.
7. Show a summary of what was fixed.

## Git Workflow

- Always confirm the current branch before committing.
- Feature branches are named for their change: `sdlc/<NNN>-<slug>`.
- Never commit directly to `main`.
