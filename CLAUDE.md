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

## Testing

- `bun test` for unit tests
- Test files live next to source files as `*.test.ts`
- Mock HTTP responses for contract tests — never hit the real API in tests