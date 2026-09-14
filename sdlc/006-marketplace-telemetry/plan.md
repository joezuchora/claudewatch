# Plan: make the extension's telemetry publishable

- **ID:** 006-marketplace-telemetry
- **Stage:** 3 — Build
- **Status:** accepted
- **Derived from:** [`spec.md`](./spec.md)

## Approach

Extract the gate as a **pure function** of two booleans, test it directly, then wire the VS
Code host to feed it and to re-evaluate on both change events. The compliance requirement is a
boolean expression; testing it through a mocked extension host would test the mock.

## Scope fence

```
packages/vscode/src/telemetry-gate.ts
packages/vscode/src/telemetry-gate.test.ts
packages/vscode/src/extension.ts
packages/vscode/package.json
packages/vscode/README.md
SPEC.md
sdlc/006-marketplace-telemetry/plan.md
sdlc/006-marketplace-telemetry/review.md
```

`packages/core` is **not** in the fence. If it needs changing, the layering assumption in
`spec.md` is wrong and that is a finding, not a quiet edit.

## Changes

### `telemetry-gate.ts` (new)
`resolveExtensionTelemetry(globalEnabled: unknown, settingEnabled: unknown): boolean` — true
only when both are strictly `true`. Anything else, including `undefined` from an older host
or a thrown read, is false. Fails closed.

### `extension.ts`
- Compute the gate from `vscode.env.isTelemetryEnabled` and the workspace setting.
- Register `vscode.env.onDidChangeTelemetryEnabled` and
  `workspace.onDidChangeConfiguration`, both pushed to `context.subscriptions`.
- Pass the result as the override into `resolveTelemetryConfig({ enabled })`.

### `packages/vscode/package.json`
Setting gains `tags` and a `markdownDescription`. Manifest gains `keywords`, `bugs`,
`homepage`, `galleryBanner`, and `"Visualization"` in `categories`.

### `packages/vscode/README.md`
A telemetry section stating what is collected, what cannot be, that it is off by default, and
that VS Code's global switch overrides.

### `SPEC.md`
§10.6 notes the global-switch precedence; §19.1's publisher item records the proposal and that
the decision is the user's.

## Tests

| Criterion | Test |
|---|---|
| Global off + setting on ⇒ false | `telemetry-gate.test.ts` — the compliance case |
| Global on + setting on ⇒ true | same |
| Global on + setting off ⇒ false | same |
| `undefined` global ⇒ false | same |
| Non-boolean / thrown ⇒ false | same |
| Setting tagged, manifest complete | assert against the parsed manifest |
| Both disposables registered | assert `context.subscriptions` length grows by two |

## Risks

- **`extension.ts` has no tests today** (a loop 001 finding, still open). The gate lives in its
  own module precisely so the compliance logic is covered even while its caller is not.
- **A manifest assertion is brittle** if fields are reordered. Assert presence and value, never
  key order.
- **Testing `onDidChange*` needs a mocked host**, and `statusbar.test.ts` already mocks
  `vscode` process-wide (loop 003's residual finding). If wiring the assertion fights that
  mock, record it rather than contorting the test.

---

**Next stage:** Build/Test — run `/sdlc-implement 006-marketplace-telemetry`.
