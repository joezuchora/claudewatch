# Plan: tell a timeout apart from a dead network

- **ID:** 010-timeout-failure-class
- **Stage:** 3 — Build
- **Status:** implemented

## Scope fence

```
packages/core/src/types.ts
packages/core/src/client.ts
packages/core/src/cooldown.ts
packages/core/src/cooldown.test.ts
packages/core/src/call-sites.test.ts
SPEC.md
sdlc/010-timeout-failure-class/*
```

## Changes

- **`types.ts`** — `FailureClass` gains `'timeout'`. The union grows; nothing is removed, so
  persisted `lastErrorClass` values stay valid and `CACHE_VERSION` is untouched.
- **`client.ts`** — a `timedOut` flag set by the timeout callback; the `catch` reads it.
  `statusClassOf` maps it, making `StatusClass: 'timeout'` reachable.
- **`cooldown.ts`** — `shouldCooldown` accepts both classes. **The load-bearing line.**
- **`SPEC.md §7.2`** — one row splits into two.

## Tests

`cooldown.test.ts` carries the regression guard; `call-sites.test.ts` covers the client and
the telemetry payload, using a mock that honours the abort signal as a real fetch would.

## Risks

- **Silently disabling cooldown for timeouts.** The whole reason this got a design stage.
  Guarded by a direct assertion.
- **A new `FailureClass` consumer forgets the case.** TypeScript's exhaustiveness only helps
  where a switch exists; `shouldCooldown` is an equality check, which is why it needed finding
  by reading rather than by compiling.
