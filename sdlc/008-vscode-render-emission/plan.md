# Plan: the extension should report its own renders

- **ID:** 008-vscode-render-emission
- **Stage:** 3 — Build
- **Status:** implemented

## Scope fence

```
packages/vscode/src/statusbar.ts
packages/vscode/src/statusbar.test.ts
packages/vscode/src/core-bridge.ts
sdlc/008-vscode-render-emission/*
```

## Changes

- `core-bridge.ts` — expose `emitProcess`.
- `statusbar.ts` — emit one `render` at the end of `update()`, after the item is painted, so
  telemetry can never delay what the user sees.
- `statusbar.test.ts` — the bridge mock supplies `emitProcess` as a recording stub.

## Tests

Four cases in `statusbar.test.ts`: one event per render; three renders give three events; the
initializing path gives none; a degraded snapshot emits with a null bucket.

## Risks

- **The bridge mock must stay in sync** with what `statusbar.ts` imports, or tests fail with a
  confusing undefined-is-not-a-function. Accepted: that failure is loud and immediate.
