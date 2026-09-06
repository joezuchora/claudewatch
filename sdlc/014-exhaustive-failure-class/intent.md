# Intent: adding a FailureClass member changes behaviour silently

- **ID:** 014-exhaustive-failure-class
- **Stage:** 1 — Plan
- **Status:** amended after review — see the correction below
- **Author:** carried from `sdlc/010-timeout-failure-class`, follow-up 2
- **Date:** 2026-08-26

## Correction, 2026-08-26 (Design stage)

The `spec-reviewer` returned four blocking findings. Two land on this document:

1. **The consumer count is wrong. There are seven, not five.** The spec found a sixth
   (`statusClassOf`); the reviewer found the seventh, and it is the highest-consequence one:
   `client.ts:165` decides **whether to retry** from `failureClass === 'authInvalid'`, with
   "everything else gets retried" as the default bucket. A new auth-adjacent member would
   silently earn a second credential-bearing request; a new rate-limit-adjacent one would earn
   exactly the amplification SPEC §9.4 exists to prevent. The prose below that says "four of the
   five decisions live in surfaces" is therefore built on an undercount.

2. **"The current mapping is correct" is unverifiable for two members.** `notConfigured` and
   `malformedResponse` are **never constructed** as `FailureClass` values anywhere in the
   product — `grep` finds them only in `types.ts` and in tests. So for those two there is no
   "today" to preserve, and any row assigned to them is a *choice*. Saying otherwise would have
   smuggled a decision in under a compatibility claim.

Left standing rather than edited, because a corrected count that never shows the undercount
teaches nobody where the reading went wrong.

## Problem

`FailureClass` has six members. Every place that *decides* something from one is an equality
check against a subset, with an implicit default for everything else:

| Decision | Code | Everything else |
|---|---|---|
| enter the 5-minute cooldown | `fc === 'serviceUnavailable' \|\| fc === 'timeout'` (`cooldown.ts:49`) | no cooldown |
| which error snapshot to show | `fc === 'authInvalid' ? 'invalid' : 'unknown'` (`main.ts:228`) | `'unknown'` |
| statusline exit code | `fc === 'authInvalid' ? 2 : 1` (`main.ts:234`) | `1` |
| show "auth expired" | `if (fc === 'authInvalid')` (`main.ts:324`) | not shown |
| VS Code auth handling | `if (result.failureClass === 'authInvalid')` (`extension.ts:217`) | generic error |

So **adding a member silently enrols it in every default bucket**, and `tsc --noEmit` stays
green while behaviour changes. That is not hypothetical: `sdlc/010` added `'timeout'`, and its
own review records that leaving `shouldCooldown` alone

> would have silently stopped timeouts from entering the 5-minute cooldown (SPEC.md §9.4) — the
> backoff that exists mainly FOR a slow endpoint. A behaviour regression wearing a type change's
> clothes.

It was caught by a human reading the diff, and the comment now sitting on that line is a
warning to the next reader rather than a check. The next member will not have loop 010's author
watching for it.

There is a second problem visible in the same table: **four of the five decisions live in
surfaces**, three in `main.ts` and one in `extension.ts`. `CLAUDE.md`'s first architecture rule
is that all domain logic belongs in `packages/core` and surfaces are thin rendering layers.
"Which failures mean the user must re-authenticate" is domain, and it is currently duplicated
across two surfaces that could drift apart without anything noticing.

## Who is affected

Nobody today — the current mapping is correct. This is entirely about the next change. The cost
is paid by whoever adds the seventh `FailureClass` member and by the users of whatever they
silently get wrong; `sdlc/010` shows the interval between "add a member" and "notice the
behaviour change" is one careful review away from being permanent.

## Why now

The type has been extended once already and it took a hand-review to survive it. It will be
extended again — SPEC §7.2's error taxonomy is not obviously closed, and the metrics work keeps
turning up distinctions worth making. Making the compiler enforce it is a fixed, small cost now
against an unbounded one later.

It is also the cheapest remaining queue item that is about *correctness* rather than tidiness.

## What "done" means

- [ ] Adding a member to `FailureClass` **fails `bun run typecheck`** until every decision is
      updated — verified by actually adding one and watching the gate go red, not by reasoning
- [ ] No behaviour changes for any of the six current members — verified case by case
- [ ] The auth decision exists once, in `packages/core`, rather than four times across two
      surfaces
- [ ] Every current mapping is asserted, so a future edit that changes one is visible in a diff
      as a changed test rather than as a changed line of logic

## Explicitly out of scope

- **Adding or removing a `FailureClass` member.** This change makes extension safe; it does not
  extend. A new member is its own decision with its own evidence.
- **`RuntimeState`, `StaleReason`, `ThresholdLevel`** and the other closed unions. They have the
  same latent shape, and the same fix would suit them — but each has its own consumers and its
  own risk of behaviour drift, and doing them together would make the diff unreviewable.
  Whether to follow up is a decision for after this one is seen working.
- **The exit-code contract itself** (SPEC §11.5). This preserves the current mapping exactly;
  arguing about whether `notConfigured` should exit 1 or 2 is a different change.

## Open questions

- **One function returning a policy object, or several exhaustive functions?** One switch means
  the next member forces every decision to be made at once, in one place. Several means each
  call site reads more naturally. They differ in what a future author is *forced* to think about.
- **Does the statusline's exit code belong in core at all?** It is surface-specific in form but
  domain in substance, and `SPEC.md §11.5` treats it as a contract. Design should settle it.
- **How is "the compiler catches it" itself tested?** A test that adds a union member cannot
  exist in normal source, since it would break the build it is meant to prove breaks. Whatever
  the answer, "we reasoned it would fail" is not one — `sdlc/013` shipped four tests that passed
  against a broken implementation.

---

**Next stage:** Design — run `/sdlc-spec 014-exhaustive-failure-class` to turn this into `spec.md`.
