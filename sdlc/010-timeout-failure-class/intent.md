# Intent: tell a timeout apart from a dead network

- **ID:** 010-timeout-failure-class
- **Stage:** 1 — Plan
- **Status:** accepted
- **Date:** 2026-08-26
- **Source:** [`007`'s Pass 1 finding 2](../007-telemetry-call-sites/review.md)

## Problem

`FailureClass` has no `timeout` member, so `client.ts` reports the 5-second hard timeout and a
DNS failure as the same thing: `serviceUnavailable`, status `null`.

Two consequences:

- **The telemetry enum lies.** `StatusClass` includes `'timeout'` and nothing can produce it.
  Loop 007 recorded it as unreachable rather than faking it with an error-message substring
  check — error messages are exactly the free text that must never reach a payload.
- **The signal is blunt where it matters most.** "The endpoint is slow" and "the endpoint is
  unreachable" call for different responses, and loop 009's `fetch_failure_rate` detector
  currently cannot distinguish a degrading endpoint from an offline one.

## Who is affected

- Anyone reading `--debug` output or the metrics dashboard to work out why usage stopped
  updating. Today both cases read identically.
- The detector built last hour, which is now watching this data.

## Why now

Top of the queue, small, and it sharpens a signal that a just-built detector consumes. It also
converts a decorative enum member into a real one — `StatusClass: 'timeout'` has been dead
code since loop 003.

## What "done" means

- [ ] A request aborted by the 5s timeout reports a class distinct from a DNS failure
- [ ] `--debug` and telemetry both reflect the distinction
- [ ] **Cooldown behaviour is unchanged**: a timeout still enters cooldown exactly as before
- [ ] `StatusClass: 'timeout'` becomes reachable

## Explicitly out of scope

- Changing the 5s timeout itself (`SPEC.md §3.1`) or the retry policy (§9.3).
- Any new user-visible copy beyond what the class change implies.

## Open questions

- **How is a timeout distinguished without parsing an error message?** Resolved in Design —
  parsing `err.message` is the approach loop 007 explicitly refused.
- **What must not change?** `shouldCooldown` currently returns
  `failureClass === 'serviceUnavailable'`. Splitting `timeout` out of that class would
  silently stop timeouts from entering cooldown — a behaviour regression wearing a type
  change's clothes. Resolved in Design.

---

**Next stage:** Design.
