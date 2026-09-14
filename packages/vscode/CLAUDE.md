# packages/vscode

The VS Code / Cursor extension. A **thin rendering layer** over `@claudewatch/core` — no
domain logic here.

## Bundling

- The extension host **cannot load ESM**. Always bundle as CommonJS:
  `bun build --format cjs --external vscode`.
- After building, verify the output actually is CJS by checking the bundle for `require` /
  `module.exports`. This is step 5 of the pre-commit pipeline and it is not optional — an ESM
  bundle fails at activation, not at build time.
- `vscode` is always external. Never bundle it.

## Packaging

`bun run --filter claudewatch-vscode package` produces the `.vsix`. Before considering a
packaging change done, verify the `.vsix` contains all required assets — README, LICENSE, and
the icon. `.vscodeignore` governs what ships.

`engines.vscode` must stay aligned with the `@types/vscode` version or packaging fails.

## Rules

- Polling enforces a 30s minimum interval (SPEC.md §19.1).
- Status bar colors follow the threshold table in SPEC.md §10.3.
- Every runtime state in SPEC.md §7 needs a defined presentation, including the degraded and
  unauthenticated ones.
