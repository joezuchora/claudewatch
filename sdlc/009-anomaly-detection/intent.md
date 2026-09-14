# Intent: let the metrics act, not just display

- **ID:** 009-anomaly-detection
- **Stage:** 1 — Plan
- **Status:** accepted
- **Date:** 2026-08-26

## Problem

The metrics pipeline collects, stores and displays. Nothing reads it and *decides* anything.

The playbook's Maintain stage closes the loop when an anomaly exceeding a control bound drafts
a new `intent.md` and restarts the cycle. In this repo that edge has been traversed exactly
once — [`004`](../004-statusline-stdin-hang/incident.md) — and entirely by hand: I noticed a
hang while doing something else, and wrote the incident myself. Nothing would have noticed if
I had not been looking.

`dashboard.ts` already computes a hang heuristic and renders a banner. It is one `if` away
from being a detector, and the gap between *displaying* a concern and *acting* on it is the
whole difference between monitoring and a wall poster.

## Who is affected

The loop itself. Between 06:00 and 08:00 today the gate went red three times. **I found all
three by running `verify` manually as step 1 of an iteration** — which works only because a
loop happens to be running hourly and happens to start with that command. Nothing watches the
data that is already being collected.

## Why now

Last unexercised part of the playbook in automated form, and there is finally enough data —
23 `verify_run` events — for a baseline to mean something.

There is also a caution this repo has earned the hard way. Of today's three red gates, **two
were my own test bounds, not product defects**, and one was a correction to the other. A
detector that fired an incident on each would have produced three incident records for one
underlying cause and taught everyone to ignore it. Whatever gets built has to be more
reluctant than that.

## What "done" means

- [ ] Control bounds over the stored metrics, evaluated without a human present
- [ ] A breach drafts an `incident.md` containing the evidence that triggered it
- [ ] The draft derives a follow-up `intent.md`, so the loop restarts
- [ ] The same ongoing condition does **not** raise a second incident every hour
- [ ] Too little data produces **no** verdict rather than a confident wrong one
- [ ] Nothing is committed or pushed automatically — a draft is for review

## Explicitly out of scope

- Alerting anywhere off the machine — no email, no webhook, no push.
- Auto-committing or auto-pushing drafts.
- Diagnosing the original 550 s verify hang, which remains blocked on a recurrence.
- Changing what is collected. This reads what loops 003 and 007 already store.

## Open questions

- **What bounds, on what windows, with what minimum sample?** Resolved in Design. Getting this
  wrong in the noisy direction is how the mechanism dies.
- **How is a repeat of the same condition suppressed** without also suppressing a genuine
  second occurrence? Resolved in Design.
- **Where does a drafted incident go**, given the detector may run on a NUC where the repo is
  present but nobody is watching? Resolved in Design.

---

**Next stage:** Design — run `/sdlc-spec 009-anomaly-detection`.
