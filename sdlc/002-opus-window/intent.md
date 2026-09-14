# Intent: track the Opus weekly window as a first-class window

- **ID:** 002-opus-window
- **Stage:** 1 — Plan
- **Status:** accepted
- **Author:** Joe Zuchora
- **Date:** 2026-08-26

## Problem

The usage endpoint returns a `seven_day_opus` window alongside `five_hour` and `seven_day`.
ClaudeWatch declares it in `RawUsageResponse` and then **deliberately discards it** —
`normalize.ts` never reads the field, and `contract.test.ts` has a test named
"ignores seven_day_opus" asserting exactly that.

For anyone on a plan with a separate Opus allowance, that makes the display wrong in the way
that matters most. Opus is the constrained resource: a user can sit at 20% on their general
weekly window while their Opus window is nearly exhausted. ClaudeWatch will show them 20% and
say nothing, right up until Opus requests start failing.

The tool's entire premise (`README.md`: "Claude Code doesn't show how much of your usage
window you've consumed") is undermined by silently dropping the window most likely to bind
first.

`SPEC.md §19.3` lists this as v2 backlog.

## Who is affected

Users on plans that report a distinct `seven_day_opus` window. They see a utilization number
that is accurate for the windows shown and misleading about their actual headroom. There is
no indication anything is missing — the omission is invisible, which is what makes it worse
than an error.

Users without an Opus window are unaffected, and must stay unaffected.

## Why now

This is loop 2. Loop 1 was deliberately behavior-neutral and bounded; its value was proving
the machinery works. This one is chosen to be the opposite: it changes the domain model, the
normalization rules, the primary-window selection, the cache shape, and both surfaces. If the
loop only works on changes that touch nothing, it does not work.

It is also the smallest `SPEC.md §19.3` item that is fully testable here — macOS Keychain
support needs a Mac and Marketplace publishing needs external accounts.

## What "done" means

- [ ] When the endpoint reports an Opus window, its utilization and reset time are visible in
      the terminal status line and the VS Code tooltip
- [ ] When Opus is the most constrained window, it is what the headline number reflects —
      a user near their Opus limit is told so
- [ ] Users with no Opus window see **exactly** what they see today, byte for byte
- [ ] A cache written by an older version does not produce a wrong or crashing display
- [ ] Enterprise accounts, which report all rolling windows as `null`, are unaffected

## Explicitly out of scope

- Historical retention or burn-rate analytics for the Opus window (`SPEC.md §19.3`, separate)
- Any change to how `five_hour` or `seven_day` are parsed or displayed on their own
- Reworking the threshold colours or adding an Opus-specific threshold
- The follow-ups recorded in `sdlc/001-quality-gate/review.md`

## Open questions

- **Should the Opus window participate in the primary-window rule (`SPEC.md §5.3`)?**
  Resolved in Design. It determines whether this change is additive or user-visible, and
  whether it amends `SPEC.md`.
- **Does adding a field to the cached snapshot require a cache version bump?** Resolved in
  Design.

---

**Next stage:** Design — run `/sdlc-spec 002-opus-window`.
