# Review findings: tell a timeout apart from a dead network

- **ID:** 010-timeout-failure-class
- **Stage:** 5 — Deploy

## Plan-to-diff audit

**Verdict: CLEAN.** All changed files inside the fence.

## Pass 1 — Bugs and logical errors

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | **blocking, found in Design** | `shouldCooldown` was `failureClass === 'serviceUnavailable'`. Splitting `timeout` out of that class would have **silently stopped timeouts entering the 5-minute cooldown** (`SPEC.md §9.4`) — the backoff that exists mainly for a slow endpoint. | Accepts both classes, with a direct regression assertion. |
| 2 | minor | The new tests read `result.failureClass` without narrowing. `FetchResult` is a discriminated union and the success variant has no such property. | Narrowed with `if (!result.ok)`. |

**Finding 1 is the reason a two-line type change earned a design stage.** It is invisible to
the compiler: `shouldCooldown` is an equality check, not a switch, so exhaustiveness analysis
has nothing to complain about. Adding a union member and running `tsc` would have come back
clean while the behaviour quietly changed.

**Finding 2 is a small illustration of the gate earning its place.** The tests *passed* under
`bun test`, which strips types. `typecheck` — the step before it — rejected them. Either step
alone would have been misleading.

## Pass 2 — Security and vulnerabilities

No findings. The distinction comes from a boolean flag set by our own timer, **not from
parsing `err.message`**. That matters beyond style: loop 007 established error text as the
leak vector (Bun's messages carry hostnames and home paths), and the obvious implementation
here — sniffing the message for "abort" — would have reintroduced exactly that dependency in
the one file that talks to the network.

## Pass 3 — Compliance

`SPEC.md §7.2` amended, as `REVIEW.md` pass 3 requires for a spec contradiction. No `any`, no
new dependency, no cache version change. `state.ts` untouched: it switches on `staleReason`,
and both classes still produce the same runtime state — the distinction is diagnostic, not
behavioural, by design.

## Verification evidence

```
$ bun run verify
verify: pass in 60.0s  [typecheck 2.2s  lint 0.1s  test 57.5s  build 0.2s]
VERIFY EXIT=0
```

| Criterion | Result |
|---|---|
| Aborted request reports `timeout` | pass |
| Plain network error still `serviceUnavailable` | pass |
| **`shouldCooldown('timeout')` is true** | pass — the regression guard |
| No other class enters cooldown | pass |
| Telemetry emits `statusClass: 'timeout'` | pass — previously unreachable |
| `SPEC.md §7.2` records the split | done |

Note the 57.5 s test step, up from ~31 s: the two timeout tests wait out the real 5-second
timeout, twice, with a retry each. That is a genuine cost this change adds to every gate run,
and it is recorded below rather than absorbed silently.

## Findings deliberately not fixed

1. **The gate is now ~26 s slower.** Real, and it compounds the pre-existing ~26 s of
   `setTimeout` sleeps in the retry tests — the follow-up open since loop 001. Both have the
   same root: `TIMEOUT_MS` and `RETRY_DELAY_MS` are module constants with no injection point.
   Making them injectable would fix ~50 s of gate time in one change. **This is now the
   highest-value performance item in the backlog**, and worth raising above the p95 work.
2. **`FailureClass` consumers are not exhaustively checked.** `shouldCooldown` was found by
   reading, not compiling. A discriminated `switch` with a `never` fallback would make the
   next addition compiler-enforced.
3. Prior follow-ups unchanged: the 51 ms p95, the vscode bridge mock, `extension.ts` untested,
   11 lint warnings.

---

**Next stage:** Maintain.
