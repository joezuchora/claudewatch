# Intent: the extension should report its own renders

- **ID:** 008-vscode-render-emission
- **Stage:** 1 — Plan
- **Status:** accepted
- **Date:** 2026-08-26
- **Source:** the one unmet criterion in [`007`'s review](../007-telemetry-call-sites/review.md)

## Problem

After loop 007, three of four telemetry kinds emit from both surfaces. `render` emits from the
statusline and **not from the VS Code extension** — so the metrics service can see that the
extension fetched, cached and drifted, but not that it ever displayed anything.

That makes the extension's health half-legible: a run of `fetch_result` failures with no
`render` events is indistinguishable from an extension that was never activated.

## Who is affected

Anyone reading the dashboard for VS Code health, and the Marketplace goal — "product telemetry
as a first-class use case" is weaker when the flagship surface omits the one event that says
the product was in front of a user.

## Why now

Last item of the 003 → 007 sequence, and its blocker (loop 006's consent gate, then loop 007's
process-level config) is cleared. Leaving one of four kinds unwired is the kind of almost-done
that quietly becomes permanent.

## What "done" means

- [ ] A status-bar render emits exactly one `render` event
- [ ] It carries the same enumerated leaves as the statusline's, with `surface: 'vscode'`
- [ ] It cannot bypass VS Code's global telemetry switch
- [ ] The initializing state — no snapshot — emits nothing
- [ ] The wiring is **asserted**, not assumed

## Explicitly out of scope

Anomaly detection, the `FailureClass` timeout gap, and the 51 ms p95 — all queued separately.

## Open questions

- **Which call site?** `doRefresh` has twelve `statusBar?.update()` calls. Resolved in Design.
- **How is it tested**, given `statusbar.test.ts` mocks the shared bridge process-wide?
  Resolved in Design.

---

**Next stage:** Design.
