# Spec: tell a timeout apart from a dead network

- **ID:** 010-timeout-failure-class
- **Stage:** 2 — Design
- **Status:** accepted
- **Derived from:** [`intent.md`](./intent.md)

## Design decisions

### The abort flag, not the error message

`client.ts` already creates an `AbortController` and a `setTimeout` that calls `abort()`. The
timeout callback is the only code that knows a timeout happened — so it sets a local flag, and
the `catch` reads it.

No message parsing. Loop 007 refused that for a stated reason and this change does not
reintroduce it: `err.message` is arbitrary text from the runtime, it varies by platform and Bun
version, and it is the exact vector the telemetry allowlist exists to keep out.

```
let timedOut = false;
const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
…
catch { lastError = { failureClass: timedOut ? 'timeout' : 'serviceUnavailable', … } }
```

### `shouldCooldown` must accept both — this is the load-bearing decision

`cooldown.ts:51` is `return failureClass === 'serviceUnavailable';`. If `timeout` becomes a
separate class and that line is left alone, **timeouts silently stop entering cooldown** — the
5-minute backoff after a failing endpoint (`SPEC.md §9.4`) would apply to DNS failures and not
to the slow endpoint it was mainly designed for.

That is a behaviour regression disguised as a type change, and it is the reason this small
change gets a design stage at all.

`shouldCooldown` becomes `failureClass === 'serviceUnavailable' || failureClass === 'timeout'`,
with a test asserting a timeout still cools down.

### `SPEC.md §7.2` splits one row into two

"Service unavailable" currently reads *"Network timeout, DNS failure, API unreachable, 5xx,
429"*. Timeout moves to its own row. Recorded as an amendment; the runtime-state mapping
(§7.1) is untouched, because both classes still produce the same state.

### Both classes remain `Degraded`/`Stale` at the state layer

`state.ts` switches on `staleReason`, not `failureClass`, and gains nothing from the split.
The distinction is diagnostic, not behavioural — deliberately. A user does not need a different
status bar for a timeout; an operator reading metrics does.

## Behavior

| Situation | Before | After |
|---|---|---|
| 5s hard timeout | `serviceUnavailable`, status `null` | **`timeout`**, status `null` |
| DNS failure / connection refused | `serviceUnavailable`, status `null` | `serviceUnavailable` (unchanged) |
| 5xx, 429 | `serviceUnavailable` | unchanged |
| Cooldown after a timeout | enters cooldown | **enters cooldown** (unchanged) |
| Runtime state shown | Degraded/Stale | unchanged |
| Telemetry `statusClass` | `network` | **`timeout`** |

## Edge cases

| Case | Expected |
|---|---|
| Abort from something other than our timer | `serviceUnavailable` — the flag is only set by our own callback. |
| Timeout on attempt 1, success on attempt 2 | Success reported; `attempts: 2`. No timeout class. |
| Timeout on both attempts | `timeout`, `attempts: 2`. |
| A cached envelope holding `lastErrorClass: 'serviceUnavailable'` from before | Still valid — the union only grew. No cache version bump. |
| `shouldCooldown('timeout')` | **true.** Asserted directly. |

## Backward compatibility

- **The union grew; nothing was removed.** Existing persisted `lastErrorClass` values remain
  valid, so `CACHE_VERSION` is untouched.
- Cooldown, retry, exit codes, CLI flags, and every runtime state are unchanged.
- The only user-visible difference is the text in `--debug` and the metrics payload.

## Acceptance criteria

- [ ] A request aborted by the 5s timer reports `failureClass: 'timeout'` — tested
- [ ] A non-timeout network error still reports `serviceUnavailable` — tested
- [ ] **`shouldCooldown('timeout')` is true** — tested, the regression guard
- [ ] `shouldCooldown` unchanged for every other class — tested
- [ ] Telemetry emits `statusClass: 'timeout'` for a timed-out fetch — tested
- [ ] `SPEC.md §7.2` records the split
- [ ] `bun run verify` exits 0

## Rejected alternatives

- **Parse `err.message` for "abort"/"timeout".** Platform- and version-dependent, and it
  reintroduces the free-text dependency loop 007 refused.
- **Leave `StatusClass: 'timeout'` unreachable.** Honest but permanently misleading — an enum
  member nothing produces is a claim the code does not keep.
- **Give timeouts their own runtime state.** More UI for a distinction users cannot act on.

---

**Next stage:** Build.
