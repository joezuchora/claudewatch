# Intent: a metrics pipeline the Maintain stage can actually observe

- **ID:** 003-metrics-telemetry
- **Stage:** 1 — Plan
- **Status:** accepted
- **Author:** Joe Zuchora
- **Date:** 2026-08-26

## Problem

The Maintain stage is the only one of the six that has never run. `sdlc/README.md` says so
plainly: ClaudeWatch ships no telemetry, has no production monitoring, and therefore produces
no signal an incident could be raised from. The `sdlc-incident` skill and the `incident.md`
template exist and have never been exercised.

That is not a cosmetic gap. Maintain is the stage that closes the loop — the playbook's whole
claim is that an anomaly exceeding a control bound drafts a new `intent.md` and restarts the
cycle, rather than dropping into a ticket queue. Without a signal there is no anomaly, without
an anomaly there is no edge from Maintain back to Plan, and the "loop" is a line with an
unused sixth box on the end.

There is already a real anomaly waiting to be caught. `bun run verify` **intermittently
hangs** — typical ~35 s, observed runs exceeding 550 s, undiagnosed, and it does not reproduce
in CI. Nothing currently records when it happens, how often, or which step stalls. Every
observation so far has been someone noticing a terminal that stopped moving.

## Who is affected

- **Anyone running the loop.** An intermittently hanging gate is a gate people learn to skip,
  and skipping the gate is how the 128-failure defect survived for months.
- **The process itself.** Six recorded findings across loops 001 and 002 are deferred with no
  mechanism to notice if they get worse, and no data to prioritise them by.
- **ClaudeWatch's users**, for the product-telemetry half: there is currently no way for a
  user running the tool to see whether it is healthy — whether fetches are failing, whether
  the cache is thrashing, whether the endpoint schema has drifted. `SPEC.md §3.1` calls the
  usage endpoint undocumented and best-effort; when it drifts, nobody finds out but the user,
  and they find out as a blank status line.

## Why now

Loops 001 and 002 proved the loop works for planned change. Both ended by recording findings
that nothing is watching. Building the observation layer is the difference between a process
that produces documents and one that produces feedback.

It is also the prerequisite for diagnosing the hang. The hang is intermittent, environment-
specific, and invisible to CI — exactly the shape of problem that cannot be solved by staring
harder, and can be solved by recording every run until a pattern appears.

## What "done" means

- [ ] Every `bun run verify` run records its outcome, total duration, and per-step durations,
      whether it passes, fails, or is killed
- [ ] A metrics service accepts those records, stores them durably, and can be queried for
      history
- [ ] ClaudeWatch itself can emit health metrics to that service
- [ ] A human can see the current state at a glance without writing a query
- [ ] The service runs on a machine the user controls, survives restarts, and requires no
      third-party account
- [ ] Nothing in any payload could identify a person or expose a credential

## Explicitly out of scope

- **Anomaly detection and the auto-incident path.** This change produces the signal; loop 004
  consumes it. Building both at once means neither gets a fair review.
- **Diagnosing or fixing the verify hang.** Loop 005, using the data this change collects.
  Fixing it here would be guessing, and guessing is what has failed so far.
- Historical usage retention or burn-rate analytics for end users (`SPEC.md §19.3`, separate).
- Any hosted or third-party metrics backend.

## The telemetry decision, stated plainly

This change **amends `SPEC.md §12` and §20 and revokes a published guarantee.** `SECURITY.md`
currently promises: *"No telemetry. Nothing is transmitted anywhere except the documented
Anthropic usage endpoint. There is no analytics, no crash reporting, and no phone-home."*

That sentence will no longer be true as written, and pretending otherwise in a footnote would
be worse than the change itself. The amendment is deliberate and is recorded in `spec.md`,
`SPEC.md`, and a rewritten `SECURITY.md`.

Three properties are **not** negotiable and constrain the design absolutely:

1. **No default destination.** ClaudeWatch ships with telemetry disabled and no endpoint. It
   cannot phone home because there is nowhere for it to phone. The user supplies a URL or
   nothing happens.
2. **No secrets, no PII.** No access token, no refresh token, no credential path, no
   hostname, no username, no file path, no account identifier. `SPEC.md §12`'s token rules
   survive this change untouched and are re-asserted against every field.
3. **Opt-in, and off is the default.** A user who never edits their settings is in exactly the
   position they are in today.

The distinction being drawn is between *"the tool reports on itself to a service its owner
runs"* and *"the tool reports on its user to someone else."* The first is what is being built.
The second remains forbidden, and the rewritten `SECURITY.md` must say so in those terms
rather than dropping the section.

## Open questions

- **What transport and storage?** Resolved in Design. Constraint: `packages/core` has zero
  third-party runtime dependencies and that is a stated identity (`SPEC.md §2.2`).
- **Does emitting telemetry risk blocking or slowing the status line?** Resolved in Design.
  The status line has a performance budget (`SPEC.md §11.7`) and a 5 s hard timeout; telemetry
  must not be able to spend any of it.
- **How do SDLC process metrics and product metrics share a service** without one's schema
  constraining the other? Resolved in Design.

---

**Next stage:** Design — run `/sdlc-spec 003-metrics-telemetry`.
