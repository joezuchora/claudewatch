# Review findings: actually emit the telemetry the pipeline was built for

- **ID:** 007-telemetry-call-sites
- **Stage:** 5 — Deploy

## Plan-to-diff audit

**Verdict: CLEAN.** Every changed file is inside the fence.

## Pass 1 — Bugs and logical errors

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | blocking (design) | Had core resolved its own config, a VS Code user with global telemetry off would still have been emitted for by `client`, `cache` and `normalize` — **silently voiding loop 006's guarantee for three of four kinds while it held for the fourth.** | Consent is set by the surface via `setTelemetryConfig`; core never resolves it. Default disabled, so a surface that forgets emits nothing. |
| 2 | major | `StatusClass` includes `'timeout'`, but `FailureClass` (`types.ts`) has no timeout member — a 5 s timeout and a DNS failure are indistinguishable at that layer without parsing the error message, and error messages are exactly the free text that must never reach a payload. | Both map to `'network'`. **`'timeout'` is currently unreachable from this call site** — recorded rather than faked with a message substring check. |
| 3 | major | `durationMs` naively measured across `fetchUsage` would include the 2000 ms retry sleep, making a p95 a bimodal constant rather than a latency signal. | Per-attempt elapsed time accumulated; sleep excluded. Tested: wall clock > 1900 ms while the reported duration is < 1000 ms. |

## Pass 2 — Security and vulnerabilities

No findings. No new I/O beyond the existing spool append; no network; no credential path.

**Directly tested:** a `fetch` rejection carrying `connect ECONNREFUSED 10.0.0.1:443` produces
a payload containing neither the IP nor the error text. That is the leak vector loop 003's
`spec-reviewer` identified as B3, now exercised through the real client rather than a
constructed event.

## Pass 3 — Compliance

- No `any`; ESM; no domain logic added to a surface.
- Surfaces reach telemetry through their bridge modules, preserving loop 001's isolation.
- VS Code bundle still CommonJS: 17 occurrences.
- No spec amendment needed — `SPEC.md §17` already describes this behaviour; this change makes
  it true.

## Verification evidence

```
$ bun run verify
verify: pass in 33.3s  [typecheck 1.8s  lint 0.1s  test 31.1s  build 0.2s]
VERIFY EXIT=0
```

`call-sites.test.ts`: **14 pass**. Key cases — default produces nothing; disabled suppresses
every kind; `versionMismatch` distinguishable from a cold miss; **no event on a cache hit**;
one drift with `count: 2` rather than two drifts; `attempts: 2` with the sleep excluded.

## Acceptance criteria not met

- **VS Code `render` emission is still not wired.** The extension now pushes consent into core,
  so `fetch_result`, `cache_event` and `schema_drift` emit from the extension's process — but
  there is no `render` call site in `statusbar.ts`. Three of the four criteria are met and this
  one is not. It needs a call site in the status-bar update path and, per loop 003's residual
  finding, `statusbar.test.ts` mocks the shared bridge process-wide, so asserting it will fight
  that mock. Deferred rather than half-wired.
- **The adversarial leak test was not extended to all four kinds as a single suite.** The
  network-error case above covers `fetch_result` through the real client, which is stronger
  than the constructed-event version — but `cache_event` and `schema_drift` are covered only by
  their own tests, not by the poisoned-input suite in `security.test.ts`.

## Findings deliberately not fixed

1. **`FailureClass` cannot express a timeout** — Pass 1, finding 2. Worth its own change:
   distinguishing a timeout from a DNS failure is genuinely useful operational signal, and it
   is a `types.ts` change plus a `client.ts` classification, not a telemetry change.
2. **Cache hit rate is now only computable by division** (`render` count as denominator).
   Accepted trade for not filling the spool with `hit`.
3. All prior follow-ups remain open, including the 51 ms p95 and the ~26 s of real
   `setTimeout` sleeps — now visible as `testMs` in every recorded run.

---

**Next stage:** Maintain.
