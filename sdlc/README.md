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

> **Update 2026-08-26 (loop 011) — the baseline this section is written against has moved.**
>
> Everything below reasons about a gate whose typical run was 35–60 s, ~90% of it the test
> step. Loop 011 took the test step to 3.4 s by removing 48 s of `setTimeout` that no test
> needed. Two consequences worth stating before anyone reads further:
>
> 1. **The 550 s hang, if it recurs, is a far larger outlier against the new normal.** The
>    second half of what this bullet originally said was wrong on both counts, and running the
>    detector rather than reasoning about it is what showed that. It does **not** fire on a
>    gate that got faster — the rule is one-sided, comparing only the *latest* run against the
>    baseline p95. And the baseline is **not** rolling: `detectDurationOutlier` builds it from
>    `runs.slice(0, -1)`, every retained run. So the threshold stays anchored to the pre-011
>    p95 of 67.5 s for the full 90-day retention, putting the trip wire at ~270 s. The
>    instrument did not get sharper; it got *blunter relative to the thing it now watches*, and
>    a 100 s hang would pass unnoticed. Filed as `012-rolling-baseline`.
> 2. **Nothing below is retracted.** The hang was never explained, and a faster gate does not
>    explain it. It remains blocked on data, and the smaller baseline is a better instrument
>    for catching it, not evidence that it is gone.

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
> **Update 2026-08-26 07:30 — and a correction to the update above.**
>
> The gate went red twice more. The 06:30 fix raised `runWithStdin`'s SIGKILL timer from 5 s
> to 20 s and **changed nothing**, because that timer was never the binding constraint:
> **Bun's default per-test timeout is 5000 ms**, and Bun aborted the test before the timer
> could fire. Both failures reported exactly `[5000.50ms]`. The answer was in the number and
> I read past it twice.
>
> Every spawning smoke case now declares its own 30 s ceiling, so the 20 s SIGKILL is the
> binding constraint as intended — a genuine hang still fails the test rather than passing
> quietly. Verified 6/6 consecutive clean `bun run verify` runs.
>
> **What the investigation has now established about the binary**, which is the useful part:
>
> | measurement | result |
> |---|---|
> | 150 consecutive runs, closed stdin | p50 48 ms, p95 56 ms, p99 83 ms, **max 123 ms** |
> | runs exceeding 1 s | **0 / 150** |
> | bare `bun test`, full suite | 10 / 10 clean |
>
> **The binary is not slow.** The slowness lives in the test harness under `verify`, which
> spawns `bun test` as a child, making the smoke test's processes grandchildren. That is a
> materially different problem from "the product hangs", and it is the first time the two have
> been told apart.
>
> The **original** verify hang — the 550 s one — has still not recurred in 13 recorded runs.
> It remains undiagnosed. Today's failures were a test-harness ceiling, not that, and
> conflating them would poison the investigation.


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

## The gate got 10.8× faster by being made testable, not by being optimised (loop 011)

`bun run verify` took **59.5 s**. It now takes **5.5 s**, and covers 17 more cases than before.

None of that came from making anything faster. 48 of the 57 test-seconds were `setTimeout`
doing nothing: the production 5 s HTTP timeout and 2 s retry delay were module constants, so
the only way a test could exercise a retry or an abort was to sit through the real one. Two
abort tests alone cost 12 s each. The fix was one optional parameter — timing is a property of
a *call*, not of a process — and then passing fast timings from the tests that were waiting.

The interesting part is the misdiagnosis. This sat on the queue as "the gate is slow," a
performance item. It was a **testability** problem the whole time, and the cure was a design
change rather than an optimisation. That reframing is worth remembering: when a suite is slow
and nothing in it is computing anything, the constants are usually the reason.

Two more things this loop is on the record for:

**The security pass improved the design, not just the safety.** It arrived to check for token
leaks, found none, and instead noticed the new parameter was unbounded in the wrong direction:
`{ timeoutMs: 600_000 }` would hold a request carrying the user's bearer token open for ten
minutes past the documented hard kill, and `{ maxRetries: 1e9 }` would turn the retry loop into
a flood of authenticated requests. Both latent — no production caller passes options — but the
parameter is public core API, and "nobody does it today" is a habit, not a property. The
change became "defaults are **ceilings** you may only tighten," which is a stronger contract
than the spec asked for and costs nothing, since every override this loop exists to serve asks
for shorter. Running the pass on a change that looks like a test-speed tweak is what earned it.

**Both wrong citations were caught by the auditor, not by the gate.** `SPEC §11.5` — cited in
`client.ts` as the source of the 5 s hard kill — is *Exit Codes*; the hard kill is §3.1 and
§11.7. And the `SPEC.md` amendment landed in §18.3 while the plan and review both claimed §8.3.
Typecheck, lint, tests and build were all green with a wrong pointer shipped in production
source. Prose that cross-references a spec is unverifiable by any tool this repo runs, which
makes it exactly the sort of thing an adversarial reader has to be pointed at deliberately.
