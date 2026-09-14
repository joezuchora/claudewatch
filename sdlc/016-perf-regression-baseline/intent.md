# Intent: check startup for regression, not against a fixed number

- **ID:** 016-perf-regression-baseline
- **Stage:** 1 — Plan
- **Status:** draft
- **Author:** follow-up from [`sdlc/015-perf-gate-incident`](../015-perf-gate-incident/incident.md)
- **Date:** 2026-08-26

## Problem

`sdlc/013` put a fixed startup budget in the gate. `sdlc/015` is the record of it going red on a
clean tree because the host got slower, and of the mitigation: the gate now reports the
distribution and does not fail.

That restores the loop and keeps the number visible, but it removes the thing the gate was for.
A startup regression introduced by a real change would now print and be scrolled past.

The instrument that fits is not a tighter threshold — it is a **comparison against this
machine's own recent history**, which is exactly the shape `packages/metrics/src/anomaly.ts`
already implements for `verify` durations, and which `sdlc/013`'s spec named before choosing not
to build it:

> If a tighter tail check is ever wanted, the right shape is a regression rule against a
> committed baseline — which `packages/metrics/src/anomaly.ts` already implements for `verify` —
> not a fixed threshold.

A 41 → 57 ms environmental drift is not a regression. A 41 → 80 ms jump on the commit that
touched `main.ts`'s startup path is. A fixed threshold cannot tell those apart; a rolling
baseline on the same host can, which is the whole lesson of `sdlc/012`.

## Who is affected

Nobody yet. The risk is a future startup regression shipping unnoticed — plausible, because the
statusline is on Claude Code's prompt path and `SPEC.md §11.7` treats its latency as contractual,
but not currently happening.

## Why now

Not necessarily now. This is worth **watching before building**: the report-only line now prints
a distribution on every gate run, and those runs already flow into the metrics store. A few days
of that data would say what the real between-session and within-session spreads are, and a
baseline rule designed against three measurements would repeat `sdlc/013`'s mistake at one
remove.

Recorded now so the mitigation is not mistaken for a resolution.

## What "done" means

- [ ] A startup regression large enough to matter fails something, on the machine that caused it
- [ ] Host drift — the whole distribution moving with no code change — does **not** fail anything
- [ ] The rule is derived from recorded spread, not from a single session's reading
- [ ] Both sides tested, as `sdlc/009` established for every bound

## Explicitly out of scope

- **Re-enforcing the fixed budget in the gate.** That is what `sdlc/015` just undid.
- **Changing `SPEC.md §11.7`'s targets.** They are a product claim and remain met on a
  representative machine.

## Open questions

- **Where does the baseline live?** The metrics store already holds `verify_run` durations and
  has a windowed-p95 detector. Startup samples are a different quantity from gate duration and
  would need their own event kind — or the `perf` run could emit one, which is a design choice
  with a telemetry-payload constraint attached (closed enumerations and numbers only).
- **Per-machine or global?** A baseline shared across a laptop, a NUC and a CI runner is a
  baseline that means nothing. Keying it per host raises an identifier question that
  `SPEC.md §12` has strong opinions about.
- **Is the gate even the right place?** The detector already runs hourly and drafts incidents.
  Startup drift might belong there rather than in `verify`.

---

**Next stage:** Design — but only after several days of recorded distributions. Building this
against today's data would repeat the error it exists to correct.
