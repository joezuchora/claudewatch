# ClaudeWatch

A personal open-source companion tool for Claude Code that shows usage window data in VS Code and terminal.

## Spec

The complete specification is in SPEC.md. Read it before making architectural decisions.

## Stack

- Language: TypeScript (strict mode)
- Runtime: Bun (workspaces, build, test, compile)
- Monorepo: bun workspaces with packages/core, packages/vscode, packages/statusline
- Statusline ships as a compiled binary via `bun build --compile`
- VS Code extension targets CommonJS via `bun build --external vscode`

## Key Commands

- `bun install` — install all workspace dependencies
- `bun test` — run all tests
- `bun run --filter @claudewatch/core build` — build core
- `bun run --filter @claudewatch/statusline build` — compile statusline binary
- `bun run --filter claudewatch-vscode build` — build VS Code extension

## Code Style

- ES modules (import/export), not CommonJS
- Strict TypeScript, no `any`
- All timestamps internal as UTC ISO strings
- No access tokens in logs, cache files, or debug output
- Atomic file writes (write to temp, rename) for cache

## Architecture Rules

- All business logic in packages/core. Surfaces are thin rendering layers.
- packages/statusline and packages/vscode must not contain domain logic.
- When in doubt about a design decision, check SPEC.md.

## Build & Bundling

- This project uses TypeScript with CommonJS module format for VS Code extensions. Always bundle as CJS (not ESM) when targeting VS Code extension host.

## Testing

- `bun test` for unit tests
- Test files live next to source files as `*.test.ts`
- Mock HTTP responses for contract tests — never hit the real API in tests
- Always run tests after making changes. Use `bun test` to verify. Ensure test isolation — avoid mock contamination across test files.

## VS Code Extension

- This is a monorepo with a CLI component and a VS Code extension. When packaging the VS Code extension, verify the .vsix includes all required assets (README, etc.) before considering the task done.

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

- When working with git, always confirm the current branch before committing. Do not assume work should go on a feature branch — ask if unsure.