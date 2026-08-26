# Spec: stop spending a minute of every gate run asleep

- **ID:** 011-injectable-timing
- **Stage:** 2 — Design
- **Status:** accepted
- **Derived from:** [`intent.md`](./intent.md)

## Design decisions

### An optional options parameter, not a module setter

`fetchUsage(token, options?)` where `options` may carry `timeoutMs`, `retryDelayMs`, and
`maxRetries`. Defaults are the current constants, so **every existing call site is unchanged**
and production behaviour is identical.

Rejected: a module-level setter in the style of `setTelemetryConfig`. That pattern is right for
telemetry consent — it is genuinely process-wide state a surface owns — but wrong here. Timing
is a property of a *call*, not of a process, and a global setter would mean one test's
override leaking into another's expectations. This repository has already lost a day to
process-wide test state (`sdlc/001`: Bun's `mock.module` is global and non-restorable), and
introducing a second instance of that shape voluntarily would be hard to defend.

Rejected: environment variables. They cannot vary per test, and a test suite that sets
`CLAUDEWATCH_TIMEOUT_MS` globally has the same leakage problem plus an invisible dependency.

### Defaults stay exported

`DEFAULT_TIMEOUT_MS`, `DEFAULT_RETRY_DELAY_MS` and `DEFAULT_MAX_RETRIES` become exported
constants, so a test asserting production behaviour can reference the real value rather than
duplicating `5000` and drifting from it silently.

### Tests keep asserting the real contract

Overriding the delay must not weaken what the tests check. `attempts: 2` must still be
asserted, the retry must still be observed to happen, and the timeout path must still produce
`failureClass: 'timeout'`. What changes is only how long the test waits for it — the assertions
are identical.

The one test that should **keep** a real delay is the one asserting `durationMs` excludes the
retry sleep, since a near-zero delay would make that assertion pass trivially. It keeps a
meaningful — but much smaller — delay, and the spec records why.

## Behavior

| Caller | Before | After |
|---|---|---|
| `fetchUsage(token)` — every production call site | 5 s timeout, 2 s retry | **identical** |
| `fetchUsage(token, { retryDelayMs: 10 })` | not possible | 10 ms retry delay |
| `fetchUsage(token, {})` | n/a | defaults |

## Edge cases

| Case | Expected |
|---|---|
| `options` omitted | Defaults. The production path. |
| `timeoutMs: 0` or negative | Falls back to the default. A zero timeout would abort every request instantly, which is never what a caller means. |
| `retryDelayMs: 0` | **Honoured** — zero delay is a legitimate test request, unlike a zero timeout. |
| `maxRetries: 0` | Honoured; single attempt, no retry. |
| Non-numeric values | Fall back to defaults rather than producing `NaN` timers. |

## Acceptance criteria

- [ ] `fetchUsage(token)` with no options behaves exactly as before — existing tests pass unmodified
- [ ] `retryDelayMs` override is honoured, and `attempts: 2` is still asserted — tested
- [ ] `timeoutMs` override is honoured, and `failureClass: 'timeout'` still results — tested
- [ ] `timeoutMs: 0` falls back to the default; `retryDelayMs: 0` does not — tested
- [ ] Non-numeric input falls back to defaults — tested
- [ ] **The gate's test step drops materially** — measured before and after, recorded in `review.md`
- [ ] `bun run verify` exits 0

## Rejected alternatives

- **A module-level setter.** Process-wide mutable state in the network module; leaks between
  tests. This repo has one instance of that already and it cost a loop to work around.
- **Environment variables.** Cannot vary per test; invisible dependency.
- **Shortening the production constants.** Would make the gate fast by making the product
  worse.

---

**Next stage:** Build.
