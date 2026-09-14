# packages/statusline

The Claude Code terminal status line. A **thin rendering layer** over `@claudewatch/core` —
no domain logic here.

## Rules

- Ships as a single compiled binary via `bun build --compile`. No runtime dependencies.
- Exit codes are contractual (SPEC.md §11.5): `0` success, `1` fetch failed, `2` config
  error, `3` runtime failure. Changing one is a breaking change for anyone scripting against
  it.
- CLI flags: `--version`, `--json`, `--refresh`, `--debug`.
- Session data arrives as JSON on stdin, piped from Claude Code. Validate it — it is external
  input.
- `--debug` output must never contain the access token.
- Output adapts to terminal width; degrade gracefully when width is undetectable rather than
  wrapping.

## Install script

`install/install.ts` and `install/install.sh` patch `~/.claude/settings.json`. Two known
issues are tracked in `docs/audit-report.md` and REVIEW.md: `execSync` argument interpolation
and a non-atomic settings write. If you touch this code, re-evaluate both rather than
inheriting their current verdict.
