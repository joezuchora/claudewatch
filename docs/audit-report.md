# Codebase Audit Report

**Date:** 2026-03-10
**Branch:** `claude/fix-claudewatch-install-7KQ4k`

## Test Coverage

**Overall: 98.89% lines** (up from 96.27%)

### Files Improved

| File | Before | After |
|------|--------|-------|
| `credentials.ts` | 11.90% | 96.88% |
| `statusbar.ts` | 97.22% | 100% |

### Tests Created/Modified

- `packages/core/src/credentials.test.ts` — rewrote with 13 integration tests using real temp files
- `packages/statusline/src/main.test.ts` — added 2 tests for cooldown/cache paths
- `packages/vscode/src/statusbar.test.ts` — added `updateThresholds` test

### Manual Attention Needed

- `format.ts` (92.50%) — progressive truncation branches only reachable on long-date locales
- `main.ts` (94.58%) — stdin reading, rich output path, and top-level error handler
- `tooltip.test.ts` (88.54%) — mock factory bodies in test infrastructure, not real gaps

## Security Review

**No critical issues found.**

### Security Controls Verified

- No hardcoded secrets or token leakage
- Atomic cache writes with restrictive permissions (dir `0o700`, file `0o600`)
- Symlink protection on credential file via `lstatSync`
- TLS enforced (hardcoded `https://`)
- No prototype pollution, command injection, or unsafe eval
- Zero third-party runtime dependencies

### Low/Informational Findings

- `install.ts` uses `execSync` with string interpolation — values are hardcoded, risk negligible
- `install.ts` settings write is not atomic — by-design (config file, not cache)
- `JSON.parse` with `as` assertions — structural checks follow, adequate protection
- `types.ts` has `[key: string]: unknown` on `RawUsageResponse` — `normalize` strips unknowns

## Build & Config Health

### Issues Fixed

1. **Missing `typescript` devDependency** — CI type-check step would always fail. Added `typescript@^5.7.0` to root devDependencies.
2. **`codeql.yml` using `actions/checkout@v4`** — all other workflows use `@v6`. Updated for consistency.
3. **CI missing statusline build step** — added between core and vscode builds.

### Manual Attention Needed

- `security.test.ts` has fragile Windows path resolution (CI runs Ubuntu, not blocking)
- Root `package.json` has no convenience `test`/`build` scripts (minor DX improvement)

### Configuration Verified

- `tsconfig.json`: strict mode enabled, correct module/resolution settings
- Bundler configs: all three packages correct (core ESM, statusline compiled, vscode CJS)
- Workspace references: correct `workspace:*` declarations
- Release workflow: current action versions, matrix builds, checksums
