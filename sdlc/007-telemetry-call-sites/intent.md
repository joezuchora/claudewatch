# Intent: actually emit the telemetry the pipeline was built for

- **ID:** 007-telemetry-call-sites
- **Stage:** 1 — Plan
- **Status:** accepted
- **Date:** 2026-08-26
- **Source:** the three unmet acceptance criteria in
  [`003`'s review](../003-metrics-telemetry/review.md), now unblocked by
  [`006`](../006-marketplace-telemetry/review.md)

## Problem

Loop 003 built the emitter, the payload builders, the spool, the shipping agent, the metrics
service and the dashboard — and wired exactly **one** of four event kinds. `render` emits from
the statusline. `fetch_result`, `cache_event` and `schema_drift` do not emit from anywhere,
and the VS Code surface emits nothing at all.

So the pipeline currently observes one thing: that a render happened. It cannot answer the
questions it was built to answer — is the endpoint failing, is the cache thrashing, has the
response schema drifted, is the extension healthy. `003`'s review recorded this honestly as
three unmet criteria rather than claiming completion; this is the change that closes them.

Wiring was deliberately deferred until `006` landed the VS Code consent gate, because wiring
first would have shipped a Marketplace guideline violation.

## Who is affected

- **Anyone running the metrics service**, who currently sees render counts and nothing that
  would explain a bad experience.
- **The endpoint-drift problem specifically.** `SPEC.md §3.1` calls the usage endpoint
  undocumented and best-effort. When its shape drifts, the current signal is a user noticing a
  blank status line. `schema_drift` exists to make that visible; it is not wired.
- **The Marketplace goal.** "Product telemetry as a first-class use case" is not true of a
  pipeline that emits one event kind.

## Why now

It is the top open item, its blocker cleared, and every hour the loop runs without it is an
hour of data not collected on a system whose one known intermittent defect — the `verify`
hang — has not recurred since instrumentation and may need volume to catch.

## What "done" means

- [ ] A failed fetch is visible in the metrics service, with its status class and attempt count
- [ ] A cache version mismatch is distinguishable there from a cold miss
- [ ] A normalization warning produces a `schema_drift` event, once per fetch, categorised
- [ ] The VS Code extension emits `render`, and **only** when both consent switches allow it
- [ ] Turning off VS Code's global telemetry stops all four kinds, not just `render`
- [ ] A user with telemetry off sees no behaviour change and no filesystem access

## Explicitly out of scope

- Anomaly detection and control bounds — the next loop.
- The p95 budget overrun recorded in `005`'s review (51 ms against 50 ms).
- New event kinds beyond the four `003` specified.

## Open questions

- **How does a `packages/core` module know the telemetry config?** `client.ts` and `cache.ts`
  are deep in core with no access to VS Code's consent state, and `006` established that the
  extension's gate must win. If core modules resolve their own config, the extension's gate is
  bypassed and `006`'s compliance guarantee is void. Resolved in Design — this is the whole
  design problem of this change.
- **Does `cache_event` on every render produce useful data or just volume?** Resolved in
  Design.

---

**Next stage:** Design — run `/sdlc-spec 007-telemetry-call-sites`.
