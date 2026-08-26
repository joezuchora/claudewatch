# SDLC artifact chains

One directory per change. Each holds the full chain: `intent.md` → `spec.md` → `plan.md` →
`review.md`, and `incident.md` if one ever occurs.

| ID | Change | Outcome |
|---|---|---|
| [`001-quality-gate`](./001-quality-gate/) | Make the verification gate real | `bun run verify` exists and is green; `bun test` went from 213/128 to 341/0 |
| [`002-opus-window`](./002-opus-window/) | Track the Opus weekly window | `seven_day_opus` is a first-class window; amends `SPEC.md §5.3` |

How to run the loop: [`CONTRIBUTING.md`](../CONTRIBUTING.md).
How to lift it into another repo: [`.claude/sdlc/README.md`](../.claude/sdlc/README.md).

---

# Retrospective after two loops

Written 2026-08-26, immediately after loop 002. The honest version, because a retrospective
that only records successes is worth nothing.

## Did it work?

Yes, but not for the reason expected.

The anticipated benefit was better planning — think first, code second. That is not where the
value showed up. Both loops were planned carefully and **both plans were wrong in a blocking
way**, discovered only during implementation:

- **Loop 001** specified a test-isolation strategy (a local module re-exporting core via
  `export … from`) that does not work. Bun keeps the mock linked through a static re-export.
  Three further rounds were needed: value re-binding instead of re-export, then discovering
  that two modules both named `deps.ts` produce colliding `'./deps.js'` mocks because Bun keys
  module mocks by specifier string.
- **Loop 002** specified an edge case — "Opus present, others null → Opus is primary" — that a
  pre-existing `No valid usage windows found` guard silently prevented. The spec described the
  destination without checking the road.

The value was not that the specs were right. It was that they were **specific enough to be
falsified in minutes**, and that the correction is now written down where the next person will
find it. A vaguer spec would have produced the same wrong code and no record of why.

## What each stage was actually worth

| Stage | Verdict |
|---|---|
| **Plan** (`intent.md`) | **Worth it, barely.** Loop 001's intent earned its place: writing down "who is affected" is what turned "add a lint script" into "the documented test command has been 37% red for months". Loop 002's added less — the problem was already crisp. Risk: on an obvious change this degenerates into a restated title. |
| **Design** (`spec.md`) | **Highest value per minute.** The edge-case table is the artifact that finds things. Both loops' worst bugs were sitting in it, visible, before any code existed — one as an unchecked assumption, one as an unreachable case. |
| **Build** (`plan.md`) | **The scope fence justified the whole exercise.** Both loops escaped it, both for good reasons. Loop 001 discovered a *second* contaminating test file; loop 002's compiler named three files immediately. Without the fence those are invisible diff growth. With it they became a decision and a written justification. |
| **Test** | **Not a separate stage in practice.** Tests were written with the code, as they should be. Treating this as its own stage is bookkeeping. |
| **Deploy** (`review.md`) | **Worth it, and the easiest to fake.** The "findings deliberately not fixed" section is the whole point — 10 real findings recorded across two loops that would otherwise have evaporated. Writing "no findings" would have been faster and worthless. |
| **Maintain** (`incident.md`) | **Unexercised.** ClaudeWatch ships no telemetry by design, so there was no production signal. The mechanism exists and is untested. Do not claim otherwise. |

## What it cost

Roughly 40% of the effort went into artifacts rather than code. That is a real cost and it is
only worth paying at this ratio because both loops touched load-bearing behavior.

For a genuinely small change — a typo, a dependency bump — the full chain is ceremony.
`CONTRIBUTING.md` says so explicitly, and that exemption needs to stay honest or the loop
becomes something people route around.

## What would be trimmed

1. **Fold Test into Build.** It has no separate artifact and produced no separate thinking.
2. **Allow a "Design-only" fast path** for changes where intent is self-evident: skip
   `intent.md`, start at `spec.md`. Loop 002 would have qualified.
3. **Keep the fence and `review.md` non-negotiable.** They carried the weight.

## What should be added

1. **`sdlc-spec` and `spec-reviewer` should require edge cases be checked against the guards
   that stand in front of them**, not just against intended behavior. Both loops were bitten
   by this in different forms. This is the single highest-value change to the harness.
2. **Spike before specifying anything that rests on third-party runtime behavior.** Loop 001
   lost the most time to an assumption about Bun that five minutes of experiment would have
   settled — and eventually did.
3. **A release-note artifact.** Loop 002 changes what users see, and nothing in the chain
   guarantees that reaches them.

## Process deviations, recorded

- **Both loops ran on `claude/ai-sdlc-setup-plan-nqyqbk`**, not per-change `sdlc/<NNN>-<slug>`
  branches, because the session was constrained to one branch. The chain stays legible through
  per-stage commits, but per-change branches and separate PRs are the intended shape.
- **Loop 001's code landed in the same commit as its `review.md`**, through a careless
  `git add -A`. The convention is that artifact commits land separately from code, so the
  intent is visible as it stood before the design rationalized it. Loop 002 got this right.
- **Neither loop's review used the subagents** defined in `.claude/agents/`. The passes were
  run directly instead. They remain wired for CI, and are unexercised in that path too.

## Known defect in the gate itself

> **Update 2026-08-26 06:30.** Two things have been ruled out since this was written.
>
> **Systematic degradation is not happening.** The suite's wall clock grew from 26 s to 36 s,
> which looked like the hang creeping in. Per-test cost tells a different story:
>
> | tests | test step | ms/test |
> |---|---|---|
> | 341 | 26.3 s | 77 |
> | 443 | 26.2 s | 59 |
> | 480 | 36.5 s | 76 |
>
> Flat. The suite grew from 341 tests to 480; that is the whole increase.
>
> **One red run was my own test, not the hang.** `smoke.test.ts` bounded a real process spawn
> at 5000 ms — a figure chosen when the suite was 349 tests, and raced once at 480 with seven
> spawns competing. It turned the gate red on a commit CI had passed. The bound is now 20 s,
> which changes nothing about what the test asserts: *exits rather than hanging forever* needs
> a bound that a slow spawn cannot reach, not a tight one. Verified 5/5 consecutive clean runs.
>
> The original hang has **not recurred in 11 recorded runs.** It remains undiagnosed and
> genuinely blocked on data — there is nothing to analyse until it happens again with
> instrumentation in place.


`bun run verify` **intermittently hangs**. A typical run is ~35 s (26 s of it the test suite);
some runs exceed 550 s and have to be killed. Observed repeatedly while building loops 001 and
002, on an otherwise idle machine with no competing processes.

Not diagnosed. What is known:

- The test step is where it stalls; typecheck, lint and build are consistently fast.
- The suite's 26 s baseline is almost entirely *waiting*, not CPU — 0.24 s user time. That is
  `client.ts`'s `RETRY_DELAY_MS` being slept for real in retry tests, already recorded as a
  loop 001 follow-up.
- Whether the hang is the same mechanism made worse, or something separate, is unknown.
- **It does not reproduce in CI.** The first `verify` run on GitHub Actions completed in 36 s
  end to end, including `bun install` and all three builds. So the hang is either specific to
  this development environment or rare enough not to have surfaced yet in CI. That narrows it
  usefully and argues against a defect in the test code itself.

This matters more than its position at the bottom of this document suggests: **an
intermittently hanging gate is a gate people learn to skip.** It should be the next
`intent.md` after the release-note one, and its `spec.md` should start with a spike rather
than a hypothesis — per the design rule above, which this repo has now paid for twice.

## A fourth pattern, found by CI on this very branch

The instrumented gate went green locally and **CI failed twice in a row**, on two different
tests, both mine, both the same class of defect:

1. `expect(JSON.stringify(event)).not.toContain('87')` — the event carries a random UUID
   `eventId`, and a 32-character hex string contains any given two-character substring about
   half the time. Measured: **19 failures in 200**.
2. `expect(raw).not.toContain('14.5')` — the spooled line carries an ISO timestamp whose
   seconds and milliseconds render as `SS.mmm`, so any instant at second 14 with milliseconds
   5xx matches. Measured: **0.18% of instants**, e.g. `2026-08-26T03:20:14.523Z`.

Both passed locally, repeatedly, by luck.

**The rule, now enforced in the tests themselves:** a substring assertion against serialized
output is only safe when the needle is *distinctive*. Numeric or very short needles must be
asserted against the object under construction — here the payload — not the whole envelope,
because the envelope legitimately contains digits nobody chose.

The generalisation worth carrying: **a test that passes locally and fails in CI is usually not
an environment difference. It is usually a probabilistic assertion that happened to be lucky
on your machine.** The instinct to re-run it is exactly wrong; the fix is to compute the
failure rate and remove the randomness from the assertion.

This is also the first time the loop's own machinery caught a defect in the loop's own work
*after* the local gate went green — which is the whole reason CI runs the same command rather
than a weaker one.

## The finding that justifies the whole thing

`bun test` had been reporting 128 failures out of 341 — and CI was green the entire time,
because it ran each package in a separate process. The documented command in `CLAUDE.md` and
`README.md` was 37% red and nobody knew.

That was found in the first fifteen minutes, by the mundane act of running the commands the
documentation claimed to support before trusting them. No stage of the loop found it. The
loop's contribution was that once found, it could not be quietly absorbed into an unrelated
change — it got an intent, a spec that had to name the root cause, and a review that recorded
what was still broken afterwards.
