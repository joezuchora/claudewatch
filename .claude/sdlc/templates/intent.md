# Intent: <short title>

- **ID:** <NNN>-<slug>
- **Stage:** 1 — Plan
- **Status:** draft | accepted
- **Author:** <who raised this>
- **Date:** <YYYY-MM-DD>

## Problem

What is wrong, missing, or newly needed. Describe the situation, not the solution.
If this came from a bug report, an incident record, or a user request, link it.

## Who is affected

Who hits this, how often, and what it costs them today. "Nobody yet, but will" is a
legitimate answer — say so plainly rather than inventing urgency.

## Why now

What makes this worth doing at this point rather than later.

## What "done" means

Observable outcomes, in the user's terms. Not implementation steps — those belong in
`plan.md`. Someone who never reads the code should be able to tell whether each one
happened.

- [ ] <outcome>
- [ ] <outcome>

## Explicitly out of scope

The adjacent things this change is *not* going to do. This is the fence that keeps the
later stages honest; be generous with it.

## Open questions

Anything that must be answered before Design can start. If a question would change what
gets built, it belongs here, not buried in a later stage.

---

**Next stage:** Design — run `/sdlc-spec <NNN>-<slug>` to turn this into `spec.md`.
