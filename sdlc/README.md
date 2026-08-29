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
>
>    **Superseded by loop 012, and two of the sentences above are wrong.** Left standing because
>    this is the second correction to the same bullet and the sequence is the finding. "For the
>    full 90-day retention" is off by two orders of magnitude — five slow runs stop occupying
>    the p95 index at ~101 runs. And `runs.slice(0, -1)` was never "every retained run": the
>    detector's input was `store.query({ limit: 1000 })` with no kind filter, so the baseline
>    was already windowed by however many verify runs fell inside the last 1000 events of *any*
>    kind. The real defect was the accidental window, not the absent one. See
>    `sdlc/012-rolling-baseline/`.
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

`bun run verify` took **59.5 s**. It went to **5.5 s** here (and to 10.1 s in `sdlc/013`, which added a measured performance gate), and covers 17 more cases than before.

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

## Two adversarial reviews, and what they were each worth (loop 012)

Loop 012 is the first change where the review subagents did not merely find defects in the code
— they rejected the *design*, and then caught the resulting implementation overstating itself.
Both are worth recording, because the loop's value is usually argued from the artifacts and this
is the round where it was argued from outcomes.

**The spec-reviewer rejected the design outright, on arithmetic.** The first draft proposed
replacing p95-of-history with median-of-a-window at an 8× multiple, and justified the multiple
with a table showing within-regime spread of 1.43×. The table was **cohorted by value, not by
time**: I had sorted runs into "fast" and "slow" buckets *by their duration*, then reported that
within-bucket spread was small. Circular. Cohorted honestly by `ts`, the spread is 10.02×,
because a passing 59.5 s run sits in the middle of the fast era — one of my own before/after
measurements on a stashed tree. The proposed threshold would have fired on it. The reviewer also
showed the proposal was *blunter* than the code it replaced at steady state (48 s vs 33 s), a
comparison the draft never made because it only ever evaluated today's sample size.

Then, checking those findings, the actual defect turned up one line up the call chain: the
detector's input was `store.query({ limit: 1000 })` with **no kind filter**. The baseline was
never "all history" — it was however many verify runs fell inside the last 1000 events of any
kind, which shrinks as the product ships more telemetry. Nothing in `anomaly.ts` could show
that, which is why three careful readings of `anomaly.ts` did not find it.

**The plan-to-diff auditor then caught the commit message.** It said "every new test was checked
by mutation", which was true of `anomaly.test.ts` and false of `detector-input.test.ts` — 4 of
its 7 tests passed unchanged against the old code. One was a pure tautology asserting a constant
against itself. That claim was the kind that is very easy to make and very hard to notice, since
the tests were real tests and they did pass.

The lesson worth keeping is narrower than "review is good":

> **A number you derived is not evidence until someone tries to reproduce it from the raw
> data.** Both the 1.43× and the "90-day" figure were arithmetic I performed on data I had, and
> both were wrong in the direction that made my proposal look better. Neither survived a reader
> who recomputed them.

A smaller one, recorded because it happened twice in one afternoon: **I twice wrote a test
asserting a *cap* where the design provides a *floor*.** Both failed immediately and honestly,
which is the system working — but the repetition says something about how easily a plausible
property substitutes for the real one.

## The budget nobody could fail, and a defect on a platform nobody here runs (loop 013)

`SPEC.md §11.7` said "Cache hit (binary start → stdout) < 50ms" and named **no percentile and no
measurement method**. On one run of one binary, p50 / p95 / max read 41.1 / 52.3 / 89.8 ms. Loop
005 read it as p95 and recorded a miss; reading it as p50 makes it pass with 18% to spare. Both
readings are defensible against the text, so the text decided nothing — and no script in the repo
measured it, so every claim about that number had been made by hand once and quoted three times.

Two things this loop is on the record for, neither of which is the script it shipped.

**The design was rejected, and the diagnosis was wrong twice before it was right.** The first
spec proposed a p95 budget grounded in "100 ms feels instantaneous" — a threshold about a user's
own action and visible feedback, which the statusline is not, since it renders inside an
operation the user is already blocked on for seconds. It also justified its multiple with a
table cohorted **by value rather than by time**: runs sorted into "fast" and "slow" buckets *by
their duration*, then reported as having low within-bucket spread. Circular. And the whole thing
was measured against the plain render path, when Claude Code invokes the rich one — which turned
out to cost 0.3 ms more at p50 and nothing at p95, and *that* is the measurement that settled
the diagnosis. A cost structure where doing strictly more work is free is dominated by something
else.

**The security pass found a defect on Windows.** The benchmark isolates the run with a temp
`HOME`. But `os.homedir()` follows `HOME` on POSIX and **`USERPROFILE` on Windows** — a
supported build target. On a Windows machine `bun run verify` would have run the compiled binary
45 times against the developer's real credential file and real cache, and if that cache were
absent or stale, the first sample would have been a live authenticated fetch with their real
token. The guard meant to catch exactly this checked an untouched *sandbox* file and would have
reported pass.

Nothing local could have found it. CI is Linux; so am I. It came from a reviewer asking *is that
claim true on every supported platform?* — a question, not a technique, and the cheapest one in
this document.

> **The lesson, stated narrowly:** a sandbox enforced by one environment variable is a sandbox
> on one platform. And a guard that can only prove "nothing was disturbed" cannot distinguish
> that from "nothing was looked at." The fix for both was the same: make the check **positive** —
> require the child to render a seeded sentinel before any measurement is taken, rather than
> inferring safety from an absence.

One more, recorded because it is now a pattern rather than a slip: **four times this session I
asserted a broader property than the one I meant** — twice a *cap* where the design gives a
*floor*, once "the directory stays empty" where the claim was "no state of ours", once
`WARMUP + n` against the very constant that defines it. All four failed loudly and immediately.
The common shape is reaching for the assertion easiest to write about the situation in front of
you, rather than the one that would fail if the code were wrong. Mutation testing caught three of
the four, and is now the default for any guard whose absence would be silent.


## The gate I built went red for no code reason, ninety minutes later (loop 015)

`sdlc/013` put a startup budget in `bun run verify`: p50 < 50 ms, measured at 41.1 ms. The next
iteration opened with the gate red on a clean tree — and the one after that too. Not contention,
which was my first theory, and not ambient load, which was my second. Both were refuted by the
same measurement: the gate's `perf` step runs alone, after build, and breached at a load average
of **0.51 on 4 CPUs with nothing else running**.

The machine's startup floor had moved from ~41 ms to ~57 ms between sessions. Same container,
same binary, no code change.

**The design error was mine, and it was already visible in the document that made it.**
`sdlc/013`'s spec set the p95 ceiling at ~2× the observed reading and argued for that headroom
explicitly — between-session variance, a threshold high enough that red means real. Then it set
p50 at **1.22×** the observed reading and called it "met with 18% to spare". The same spec that
wrote

> a target set to the current measurement can never fail, which is how §11.7 got into this
> condition

used a measurement-derived target for the median. Observed p50 across sessions now spans
41.1–60.6 ms: a 1.5× spread, wider than the margin.

Why review did not catch it: the spec-reviewer challenged the p95 grounding hard enough that I
rewrote it from scratch, and the p50 row was inherited unchanged from the old SPEC, so it read as
*preserved* rather than *decided*. **A number that survives review by looking familiar has not
been reviewed.** That is the sentence worth keeping.

The distinction the incident forced, which I had blurred:

> A budget is a claim about **the product on a representative machine**. A gate is a check for
> **regression on whatever machine is running**. Enforcing the first as the second makes the gate
> red for reasons no change caused — and a gate that cries wolf is worse than no gate, which is
> the argument `sdlc/009` used to set the anomaly bounds far outside observed spread and which I
> failed to apply to my own.

The gate now reports the distribution on every run and does not fail; `bun run perf` keeps the
enforcing verdict. That is a **mitigation, not a fix** — it removes the tripwire the gate existed
for — and `016-perf-regression-baseline` records the instrument that would actually work: a
comparison against this machine's own recent history, which is what `anomaly.ts` already does for
gate durations and what `sdlc/013`'s spec named before deciding not to build it.

That follow-up is deliberately **not** being built yet. Designing a baseline rule against three
measurements would repeat the original error at one remove; the report-only line now prints a
distribution on every run, so the data to design it properly is accumulating on its own.


## The gate never typechecked itself (loop 018)

`tsconfig.json` excluded `scripts`. `bun run typecheck` is `tsc --noEmit`. So **nothing in
`scripts/` had ever been typechecked** — including `verify.ts`, which *is* the gate, and
everything `sdlc/013` built there.

Found by accident, reading `tsconfig.json` for an unrelated plan. Demonstrated rather than
inferred: a deliberate `const x: number = "string"` in `scripts/perf.ts` passed clean.

Three real errors surfaced the moment the exclusion came off, all one root cause — and the
irony is exact. `sdlc/013` changed a `.sort()` to `.toSorted()` **to silence a lint warning**,
and `toSorted` needs `lib: ES2023` against a `target: ES2022`. A type error, introduced to keep
a warning count flat, in a directory the type checker could not see. Two implicit `any`s came
with it, in a repo whose `CLAUDE.md` forbids `any`.

The mechanism worth remembering is why nobody noticed: **`bun test` *does* discover
`scripts/perf.test.ts`**, so runtime failures surfaced normally and the directory felt covered.
Test coverage and type coverage came apart silently, and having one made the absence of the
other invisible.

> An instrument is not usually asked to measure itself. `sdlc/001` moved the gate into an
> excluded directory and judged the result by whether it *ran* four steps — not by whether those
> four steps covered the gate.

I had also reported "typecheck ok" after every `perf.ts` edit that afternoon. Those reports were
true and worthless: the check was clean because it was empty. A green check on an empty set is
indistinguishable from a green check on a covered one, unless you plant a failure and watch.


## A test with a one-millisecond budget (loop 019)

```
(fail) cache > isCacheFresh > returns true for snapshot at exactly TTL boundary minus 1ms
```

```ts
const justUnder = new Date(Date.now() - 59_999).toISOString();
// ...ISO round-trip, two object constructions...
expect(isCacheFresh(envelope, 60)).toBe(true);   // isCacheFresh reads Date.now() AGAIN
```

The age the assertion sees is `59_999 + (however long the test took)`. **One millisecond of
budget.** Fine on an idle machine; not on this container's first workload after a resume.

Two things make this worth recording beyond "flaky test fixed".

**The sweep mattered more than the fix.** The tempting conclusion — "the suite is full of flaky
timing tests" — is wrong, and checking took one grep. Every other age-based test has 60–300 s
of margin:

| test | offset | threshold | margin |
|---|---|---|---|
| older than TTL | 120 s | 60 s | 60 s |
| 5-minute-old cache | 300 s | 600 s | 300 s |
| 11-minute-old cache | 660 s | 600 s | 60 s |
| **TTL boundary minus 1 ms** | **59.999 s** | **60 s** | **1 ms** |

One outlier, not a class. Recording *which* it is beats recording that some exist.

**The old test could not test the boundary at all.** It asserted only the side it had slack on;
`60_000` — the side that distinguishes `<` from `<=` — was unreachable, because there was no
slack there to be lucky with. Passing `now` as a defaulted parameter, the same shape `sdlc/011`
used for fetch timings and for the same reason, makes both sides exact. Mutation confirms it:
flipping `<` to `<=` now fails, and so does ignoring the injected clock.

> A flaky test is usually a test that was measuring the machine. The fix is rarely a wider
> margin — it is removing the machine from the measurement, which usually turns out to make the
> assertion *stronger* rather than merely calmer.

`sdlc/001` recorded this exact lesson about two other tests ("a test that passes locally and
fails in CI is a probabilistic assertion that was lucky on your machine") and applied it to the
two that had already failed. Nobody swept for siblings. This one waited eighteen loops for a
slow enough afternoon.

## A guard that compiles is not a guard that works (loop 014)

The subject of loop 014 was that four separate decisions — cooldown, retryable, presentation,
statusline exit code — were each an equality check against a subset of `FailureClass` with an
implicit default. `sdlc/010` had added `'timeout'` to that union and very nearly shipped a
version where timeouts silently stopped entering the 5-minute backoff, with `tsc` green
throughout. The fix is one exhaustive `switch` with a `never` fallback, which the compiler
cannot let you extend without deciding every case.

The loop then produced three instances of the same failure, one per stage, and they are worth
recording together because they are all the same shape:

**Stage 2 — the guard that compiles clean.** The spec proposed
`const _x: Exclude<FailureClass, typeof FAILURE_CLASSES[number]>[] = []` as the check that
`FAILURE_CLASSES` covers the union. It compiles with a member missing: an empty array literal is
assignable to every array type, `never[]` included. Caught by the spec-reviewer, verified by
running both forms — mine exit 0, theirs exit 2 with TS2322. In the loop whose entire subject
was guards that never fire.

**Stage 4 — the checker that checked nothing.** The fixture project meant to prove the guards
fail inherited its `exclude` from the root config, which excludes the fixture directory itself.
`tsc` matched zero files and exited 2 with `TS18003: No inputs were found`. The harness's own
self-check — `exitCode !== 0`, output contains `error TS` — passed on it. Three assertions
downstream went green against an empty string.

**Stage 4 again — the fixtures that collided.** Two fixtures had no top-level `import` or
`export`, so TypeScript compiled them as global scripts and they collided on a shared type name.
The error under test was still there, buried under six duplicate-identifier errors that had
nothing to do with anything.

The through-line: **a non-zero exit is not evidence that a checker checked something, and a
compiling guard is not evidence that a guard guards.** Both are the same mistake as the one
already recorded here about green checks on empty sets, and neither is visible by reading. The
only thing that distinguishes a live guard from a decorative one is having watched it fail.

So the loop shipped the negative control it needed:
`packages/core/src/typefixtures/inert-empty-array.expect-clean.ts` is the Stage 2 bug, frozen,
with a test asserting `tsc` reports **nothing** for it. Three sibling fixtures must fail; that
one must not. Sixteen mutations, sixteen caught, recorded in
[`014-exhaustive-failure-class/review.md`](./014-exhaustive-failure-class/review.md).

**Stage 5 — the harness that watched nothing.** The plan-to-diff auditor found that the fixture
harness's own header claimed to prove the shipped guards fail a build. It proves the *form*
does: every fixture uses a local stand-in union, so deleting the real `_allCovered` from
`cooldown.ts` left all five assertions green. Three stages, three instances, same disease — and
the third was in the file written to cure the first two.

The fix was to split the claim (the fixtures prove the form; four text searches observe the
shipped guards; the mutation table is the evidence they fire) and, separately, to notice that
the negative control's assertion — *tsc reported nothing for this file* — is **vacuous for a
file tsc never opened**. It passes identically whether the fixture compiles clean or was
silently dropped from the project. That is the TS18003 bug again, inside the check written to
catch the TS18003 bug. `--listFiles`, matched against the directory listing, closes it.

The security pass, run against the same commit, found two things the type work had walked past.
`cooldownUntil` is read off disk unvalidated, and `isInCooldown` compares against
`new Date(v).getTime()` — so an unparseable string yields `NaN`, every comparison is false, and
the 5-minute backoff that is the **only** throttle on token-bearing requests silently
disappears. One corrupt byte, one authenticated request per prompt render. Separately, a cache
file containing the literal `null` parses fine and then throws on `parsed.version`, and the file
is never deleted: exit 3 forever, which is precisely the stuck failure loop SPEC.md §9 exists to
prevent. Both were pre-existing. Both sat one line from code this loop was already editing, and
the loop's own comment asserted the opposite of the first one.

Worth naming: **the type-safety work and the trust-boundary work found disjoint sets of bugs.**
Making the compiler enforce the union did not surface either cache defect, and would not have.

One more thing the mutation pass established, which no amount of reading had: the retry
condition's two halves are **independently** load-bearing. `!policy.retryable` alone starts
retrying every 429; `result.status === 429` alone starts retrying 401s. 429 and 5xx are the same
`FailureClass` and want opposite answers, so retry is the one decision here that is not a pure
function of the class — and the "obvious" tidy-up that merges them is a live bug in both
directions.

## Loop 020 — the audit found a fence item shipped behind a test that only looked like one

The plan-to-diff auditor's verdict was FENCE VIOLATED, and not by an out-of-scope file. Every
path was on the fence. The violation was **an item shipped unimplemented behind a vacuous test**:
the junit report was documented as `0600` in a code comment, a test name and the spec, and bun
actually creates it `0644`. The test that "confirmed" it created a file of its own with
`mode: 0600` and asserted it was `0600` — it exercised `fs.writeFileSync` and would have passed
with the whole change deleted.

That is the eighth recorded instance of the same defect, and the first where it **hid a second
one**. Two more criteria in the same loop had no test touching the code they named at all.

The security pass, run on the same commit, found that only the `file` field was sanitized while
three documents promised no event carries a path or a username — and then, reviewing my fix,
found a gap in it: a UNC path `\\server\share\x` embeds a *hostname* and matched neither scrub
branch. **A fix is not exempt from review because it is a fix.**

Two things this loop confirms about numbers. The spec's motivating figure (a "~550s hang") had
been impossible since step timeouts landed at 300s, and I had carried it across several
documents. And a byte count I quoted in code comments and a commit message came from a
*reviewer's* report and was never recomputed; it was wrong. `sdlc/015`'s lesson generalizes:
a number inherited from a trusted source is still a number nobody checked.

Finally, a bug I introduced while fixing the audit. The obvious way to test "a passing run's
payload is unchanged" is to drive the real gate from a test — which makes `bun test` spawn
`bun run verify`, whose `test` step runs `bun test`. Infinite recursion, found by running it.
The refactor it forced (pure functions in `junit.ts`, orchestration only in `verify.ts`) is
better than what I set out to write.

## Loop 021 — four fixes, each needing another fix

The feature is ten lines. What the loop actually produced is a record of how a change goes wrong
when every step looks fine.

The spec's load-bearing premise — *"the gate runs only when someone types `bun run verify`"* —
was false. A systemd unit **in this repository** runs it hourly, and I wrote that unit. The
counterfactual built on it ("off-by-default would have collected nothing") assumed the person who
owns the machine would never add one line to it. The spec-reviewer was asked directly whether that
was self-serving reasoning; it was, and the default flipped.

Then the mitigation for the flip did not mitigate. `Environment=` in a systemd unit does **not**
beat a `~/.profile` export, because ExecStart runs a login shell and the profile is sourced after
systemd hands the environment over. The plan called that line "not optional and not deferrable",
and it did not do the job it existed for. The real defence is an inline assignment on the command.

And the flip's own risk fired within ten minutes: the container's gate stopped recording silently,
exactly as the plan warned, because this container has no systemd unit and nothing had been told
to opt in.

The sanitizer sequence is the sharpest instance of the general pattern:

1. A describe name `A5/A6/A7` was recorded as `A5<path>` — a mangled name defeats the purpose of
   recording which test failed.
2. Loosening the rule to fix that made it **defeatable eleven ways**, including `(/home/joe/x)`
   and `` `/home/joe/x` ``. A security boundary weakened for a cosmetic problem — by the same loop
   whose runbook says *a fix is not exempt from review because it is a fix*.
3. The hardened version still leaked `foo-/opt/secrets/key`.
4. That fix shipped **without a test**, so a mutation restoring the old class was silent.

Each step passed the tests written alongside it. Step 2 was found by probing, step 3 by a
reviewer, step 4 by mutation. **Tests confirm what you thought of; probing and mutation find what
you did not.**

One distinction worth keeping. In loop 020, two mutations reading "inert" were *faulty mutations*
that changed no behaviour — reporting them as findings would have been false. In loop 021, two
mutations reading "inert" were *real gaps in the tests*. The same output means opposite things,
and the only way to tell is to look at what the mutation actually did.

## Loop 022 — a green suite hid a constant for nine loops

The anomaly detector's duration fingerprint was `Math.floor(Math.log10(ms))`. Across the range
the detector can actually reach — floor 120s, ceiling one 300s step timeout plus the fast steps
before it — that is not a coarse bucket. It is a **constant**. Every anomaly it could raise
carried `verify_duration_outlier:5`, so the first one of any size suppressed every later one for
24 hours, and the open hang investigation is exactly what that hurts.

**All 42 existing tests passed against the replacement.** That is the diagnosis, not a
compatibility win. Every one captures the fingerprint dynamically and asserts the round trip —
and *"a fingerprint suppresses itself"* is true of a constant. **A test that captures a value and
feeds it back proves the pipe is connected, never that the value means anything.** That is a new
entry in the vacuity catalogue, distinct from the eight before it.

The spec review then rejected the first design outright, for two reasons I should have caught:

It **classified a total run duration using constants that bound a single step** — five passing
steps at 62s each total 310s and exit 0, which the draft would have labelled a step timeout with
nothing killed. And it **anchored bands to a floor that moves**: the real trigger is
`max(p95 * 4, minOutlierMs)`, so at the slowest legitimate run on record the floor is 270s and
the draft's lowest band would have been empty — collapsing back to a constant under exactly the
slow conditions it existed for.

Both were one command away. `grep` for the import rule I invented; read the three lines around
`thresholdMs`. The reviewer's advantage was not insight, it was **looking**.

And the sharpest thing in the loop: the draft spec **named the `sdlc/015` failure mode in one
paragraph and committed it two paragraphs later**, presenting an architecture rule that does not
exist as an inherited constraint. Writing the lesson down does not confer immunity to it. The
catalogue in this file is a record of what to check, not a charm against repeating it.

## Loop 027 — the plan wrote its own falsification test, and the loop skipped it

The first loop in twenty-seven where a Stage 5 reviewer **changed the outcome** rather than
annotating it. The plan-to-diff audit returned FENCE VIOLATED with three blocking findings; all
three reproduced under my own hands and all three were real.

The one that matters most for this catalogue: **`plan.md` wrote an explicit falsification
condition for its own central claim, and the implementation never ran it.** Verbatim from the
plan: *"revert `:90` to the discarding form → predicted: the fetch cases hang or time out. If they
pass, `settle()` is not actually waiting and A6 is theatre."* The auditor ran it in about thirty
seconds. The suite stayed green. A6 was theatre, and the one production change the spec had
permitted *specifically so it could not be slipped in unnoticed* had been slipped in unnoticed by
the very check designed to notice it.

**New rule: when a plan writes its own falsification condition, running it is not optional, and
its result goes in `review.md` whichever way it comes out.** A predicted experiment that is never
performed is worse than one that was never designed, because the artifact chain now records
diligence that did not happen.

The underlying defect is a ninth entry in the vacuity catalogue, and a nasty one: **a drain helper
that tests for a lull instead of for completion.** `settle()` polled until the call log stopped
growing — but the function under test *contains* a pause, so a pause was read as an ending. It
returned mid-refresh, left the in-flight flag set, and the **next** test's work was swallowed by
the dedupe and reported as that test's own missing calls. It accused the wrong test. Quantified by
varying only the mock's fetch delay, which changes no behaviour under test: 1 ms → 0 failures,
6 ms → 2, 20 ms → 6. A 5 ms margin, shipped green, on a suite that ran 807 tests.

The fix worth generalising is not "raise the timeout". It is **remove the thing being waited on**:
with no timer anywhere in the mock, the code under test contains no macrotask wait, so one
`setTimeout(…, 0)` is a guarantee rather than a heuristic — the microtask queue drains completely
before the next macrotask runs. There is no margin left to tune. And because that guarantee rests
on a premise, the premise is now a test that races the mock against `setTimeout(…, 0)`, so
reintroducing a timer fails by name instead of degrading silently.

Two smaller findings, both of the house species:

- **The fix for a false negative bought a false positive, in the same shape it was fixing.** The
  comment-stripper had been anchored to line-leading `//` to stop a docstring's literal
  `mock.module('vscode')` from counting. That let `foo(); // mock.module('./phantom.js')` through
  as a *real mock* — the identical defect, moved from column 0 to a trailing position, with no
  test at the new position. Every regex form of this is wrong in one direction. A twelve-line
  quote-aware scan has neither failure. **When two fixes each break the other's case, the shape is
  wrong, not the tuning.**
- **A restore mechanism is a claim too.** Mid-review I undid a mutation with `git checkout <file>`
  on a file whose fix was still uncommitted — silently discarding the fix, then measuring the old
  code, and nearly writing up the result. `git checkout` reverts to HEAD; that is not the same
  thing as "undo". Caught only because the number disagreed with the prediction.

Which is the discipline that keeps earning its place, now for the fourth loop running: **predict
the mutation result before running it, and when the number disagrees, believe the number.** Six
mutations this loop, five predictions right and one wrong. The five taught nothing. The wrong one
— 2 failures where 1 was predicted — exposed a fixture that was leaning on the very catch-all it
was written to test, so that removing the catch produced a second, unhandled escape into the next
test. The value of the prediction is not being right. It is that being wrong is *informative*, and
a number you never predicted cannot surprise you.

## Loop 028 — an honest label on a fictional threat

The reviewers earned their place twice, in the same shape both times: **each found a claim already
written down as settled.** The plan-to-diff audit found a docstring asserting the absence of two keys
declared six and eleven lines below it — in the very commit whose criterion was "do not ship a
newly-false docstring". The security pass found something subtler and worse.

This loop shipped a **characterization test**: a test written deliberately to document an unmet
`SPEC.md §12` invariant rather than quietly skip it. It was labelled "NOT an approval", quoted §12
correctly, named the right architectural constraint, and said it should fail when the fix lands.
Everything about the framing was honest.

**The threat it documented cannot happen.** It asserted that a credential path and an `sk-ant-` token
reach a user-visible modal via `readCache` throwing. `readCacheResult` wraps both `readFileSync` and
`JSON.parse` in `try`/`catch` and returns `null`; nothing in that call graph opens the credential file
at all. The one reachable throw, measured, is
`undefined is not an object (evaluating 'snapshot.fiveHour.utilizationPct')` — no token, no path, no
username. The real exposure is nothing.

**New rule: a test that documents a limitation must drive the REACHABLE path, not a plausible one.**
Sizing the exposure — tracing what can actually arrive at the surface — is the work. The label is not.
Had this gone unreviewed, a follow-up loop would have built a redactor against a credential-leak threat
model this architecture makes impossible, while leaving the genuinely larger surface untouched:
`formatTooltip` interpolates `enterprise.disabledReason`, unconstrained free text from the API,
verbatim on the **success** path, into every surface including the status-bar tooltip.

This is the tenth entry in the vacuity catalogue and the most disguised. The previous nine were
carelessness of one kind or another. This one was produced *by* care — by the deliberate act of
documenting a limitation — and felt, while being written, like the opposite of the failure mode it
was. Loops 025–027 produced claims made by reading. Loop 028 produced a claim made by conscientious
disclosure, which is the same error wearing better clothes.

Two process notes worth keeping:

- **A justification for combining steps is a claim, and claims get measured.** The plan required four
  commits, each leaving the gate green; three shipped. I justified it by asserting steps 3 and 4 were
  inseparable, because adding a mock necessarily reddens the topology guard. Half true: step 3 alone
  does redden it, but a **two-line** update would have made it green. The coupling was a
  plan-authoring choice — assigning that two-line change to step 4 — not a property of the change.
- **The contamination shape that ruins a criterion recurs one criterion over.** The Stage 2 reviewer
  caught A2's seed tripping a second rule, making it a null experiment; the seed was fixed. The very
  next mutation in the same table, M8, does the same thing — an orphaned import fires
  `no-unused-vars` alongside the rule under test. Fixing an instance is not fixing the shape.

Eight mutations, six predictions right, two wrong. The two wrong ones produced both findings. Again.

## Loop 029 — a case nothing constructs is a default wearing a decision's clothes

Two findings, and **both were regressions this loop introduced**. That is "a fix is not exempt from
review" arriving with teeth: B1b was a *correctness* improvement that removed a rate limit, and B1 was
a *security* improvement that destroyed a security signal.

**The rate limit.** `malformedResponse` was defined in `types.ts`, handled by `failurePolicy`, and
specified in `SPEC.md §7.2` — and constructed nowhere. `cooldown.ts` said so in a comment, and put it
in the no-cooldown bucket, which was harmless for exactly as long as nothing constructed it. This loop
constructed it — that was the whole point of B1b — moving a 200-with-non-JSON body off
`serviceUnavailable` and, silently, off the 5-minute §9.4 cooldown with it. Measured: **2
authenticated requests per prompt render, unbounded**, instead of 2 per 5 minutes, with no cooldown
envelope written at all on the no-cache branch. `cache.ts:139` calls that cooldown the only throttle
on token-bearing requests.

The detail that makes it a catalogue entry: **the same commit edited the comment that had gone stale,
and did not notice.** It changed *"`malformedResponse` is not constructed anywhere"* to *"is
constructed since sdlc/029"* while leaving the next sentence — *"Both rows match the default bucket
they used to fall into, so neither changes behaviour"* — intact. The stale claim and its falsifier
were adjacent lines in one diff, written in one sitting.

**New rule: when a change makes a previously-unconstructed case reachable, audit every table that
case appears in.** A `switch` arm nothing reaches is not a decision, it is a default wearing a
decision's clothes, and the moment you make it reachable you have adopted whatever it says. Grep the
member name across the tree before shipping the constructor.

**The destroyed signal.** B1 collapsed every network failure to a constant. The spec said "information
lost is nil". Measured against a local self-signed server, that is false: TLS verification failure
gives `"self signed certificate"` / `DEPTH_ZERO_SELF_SIGNED_CERT`, distinct from the `"Unable to
connect…"` that refused and DNS give — and `failureClass` does not carry the difference either. **A
TLS interception attempt had become indistinguishable from a dead link on every surface.** The fix
keeps the guarantee: select from `err.code`, a closed set of OpenSSL identifiers, never `err.message`.

That one refines an existing rule rather than adding one. The claim *was* measured — badly. The first
probe raced `AbortSignal.timeout(1)` against a refused connection, so the refusal won the race and its
message was recorded as the timeout's; the TLS case was never probed at all. **A measurement that does
not isolate the case it names is worse than no measurement, because it ships as evidence.** This
loop's spec was rewritten once for precisely this failure, and the corrected table still had a hole.

Two smaller repeats worth recording, both of things already written down:

- **A7 was violated by the exact trap loop 028 named in writing.** Loop 028's A6 said "a test written
  with a nested helper would trip `consistent-function-scoping`", and taught that such a criterion
  must be a **diff**, not a count. Loop 029 wrote it as a count, nested two helpers, went 11 → 13, and
  did not notice. Writing the lesson down did not confer immunity — for the fourth loop running.
- **`plan.md` said "Eight paths" over a nine-row table.** Loop 028's plan said "Nine" over eleven. The
  same miscount, one loop apart, caught by the same reviewer.

Eleven mutations, seven predictions right. The four wrong ones were wrong in the safe direction, and
for a pleasant reason: correcting two test fixtures that seeded strings **no producer emits**
(`'Rate limited'` where production says `'Rate limited (429)'`) turned those tests into a second layer
of guard coverage. A fixture that round-trips a fictional value proves nothing; fixing it proved
something twice.

## Loop 030 — a validator that returns its input is not a validator

Loop 029 closed the set of surfaceable error messages at the producer and at one consumer. Two
`--debug` sites read the field straight off the cache envelope and never called that consumer, so a
cache file written before 029 still surfaced free text. Loop 030 moved the check to
`readCacheResult`, the parse boundary — which fixed both sites **without editing either**, and is
the whole thesis: validate where the value enters, not where it is used, and the consumer count
stops mattering.

Then Stage 5 found two things, and both are worth more than the fix.

**The leak three lines below the guard.** `sanitizeCooldownUntil` validated with `Date.parse` and
then returned `value` — the original string, unmodified. `Date.parse` accepts far more than
ISO-8601, and its legacy parser ignores parenthesised trailing text entirely:

```
Date.parse("2026-01-01 (/home/someone/.claude sk-ant-oat01-SECRET)")  -> finite
```

Finite, below the clamp ceiling, returned whole, printed by `--debug`. The clamp branch had always
*constructed* its result; only the passthrough echoed its input. Two idioms in one function, sixteen
loops, and the name said "sanitize".

**New rule: a function that validates a value from outside the trust boundary must return something
it constructed, not something it read.** `Date.parse` returning finite says nothing about what else
is in the string. The same holds for every parse-then-passthrough — `parseInt`, a regex `.test()`
followed by returning the argument, a schema check that hands back what it was given. The check and
the return value must be about the same thing.

**The rule that was already written down, in this loop's own spec.** `spec.md` opens its fourth
finding by naming loop 029's error — *"copied verbatim from 029's review without re-measurement, the
exact behaviour this loop's thesis criticises 029 for"* — and measures the real answer three lines
later. The closing artifact then published a **different** number, unmeasured, in the very marker
the criterion exists to produce, and the commit body asserted it. **Writing the rule down does not
execute it.** That is now four consecutive loops in which a lesson recorded in this file was
violated by the loop that recorded it. The only thing that caught it was a reviewer who re-ran the
measurement rather than reading the table.

**A guard's own gate was defeated by spelling.** The criterion protecting the type narrowing was a
grep. The auditor rewrote the field as `null | string` — semantically identical to the widening the
grep exists to catch — and measured: typecheck 0, 824 tests pass, grep silent. It was also never
wired into `verify` or CI; it lived as prose in a review document nobody re-runs. Replaced with a
typefixture that asserts **exactly four** compile errors against the real types, because a
"greater than zero" assertion stays green while three of four sites widen back. **A criterion that
cannot be run by the gate is a note, not a check** — specify "a check that runs in `verify`", never
"a grep".

**And a test that asserted against a stale artifact.** The end-to-end smoke case rebuilt the binary
only when it was *absent*, while `verify` runs `test` before `build`. So the case meant to be the
strongest check in the loop was the weakest: deleting the guard left it green. It now rebuilds when
the binary is older than the newest source file.

One process distinction, drawn against loop 029's own reasoning. 029 queued its `--debug` bypass
because *"widening a fence to cover a Stage 5 finding is how loops start eating each other."* Sound —
and it cost a full loop of exposure on a real leak. The line this loop draws: **queue a gap, fix a
leak.** A missing check can wait for its own intent. A value already reaching stdout cannot,
especially when the pass that found it was reviewing the fix for its twin.

Six mutations, six predictions right — including one predicted to fail nothing. `M5` widened the
narrowed type back: typecheck 0, 824 pass, not one test red. That green was the finding, recorded as
such in advance, and it is what made the grep's weakness worth chasing rather than shrugging at.

## Loop 031 — a rationale that cites a function is not valid until you check it is called

Loop 030 validated one field at the cache-read boundary. Loop 031 finished the job for five more —
and was wrong in public three times doing it. Each error was the same error in a new place, and each
was caught by a reviewer who re-ran a measurement instead of reading a table.

**A table is not a counter-measure if its rows come from one grep.** The spec tabulated the closed
set of warning strings, said seven, and said explicitly that the table existed because loops 028 and
029 had miscounted. It was built by grepping `warnings.push`. Two producers pass literal arrays to
`makeMalformed` and never call `push`. The real answer is nine, and a filter built from that table
would have **deleted the headline diagnostic of the malformed-response path on read** — from the one
cache file where diagnostics matter. The counter-measure failed on its own stated terms.

**"Which surfaces read this field" cannot be complete.** The spec's surface enumeration said one:
`--debug`. It missed `--json`, which serialises the entire snapshot, is a documented contract, and is
the more likely paste-into-an-issue surface of the two. It missed it for a structural reason worth
keeping: the search was for readers of three field **names**, and `--json` names no field. Ask what
gets **serialised**, never what gets read.

**Then the same rule failed one step further out.** Having switched to "what gets serialised", the
loop stopped at stdout — and `snapshot.tier` was going to a **file** the whole time, copied verbatim
by `renderEvent` into a metrics-spool payload leaf. Measured: a home directory and a hostname on
disk. The full question is **what leaves the process** — stdout, a file, a socket, a payload. A
surface enumeration that stops at the terminal is the same incompleteness in better clothes.

**A guard can be defeated by object identity.** `freshness` and `rawMetadata` were rebuilt only when
a degradation actually fired, so an envelope whose known fields were all *valid* passed both objects
through by reference and any unknown sibling key rode along to stdout. The comment beside the code
had the premise right — *"`freshness` is emitted whole by `printDebug`"* — and drew the narrower
conclusion, *"so both its **fields** are surfaces"*. Emitted whole means every **key** is a surface.
Loop 030's rule (return what you constructed, never what you read) applies to objects, not just
scalars.

**And the new rule, which is the best thing this loop produced.** The spec argued against clamping a
far-future `fetchedAt` because *"that is exactly what `detectClockSkew` reports; clamping would
delete the signal"*. `detectClockSkew` has **zero production callers** — it has been dead since it
was written. There was no signal. And the claim that a far-future timestamp "suppresses one fetch"
was false too: `isCacheFresh` returned `true`, and the fresh-cache branch returns without rewriting
the file, so one byte pinned the tool on stale data permanently.

> **A rationale that cites a function is not valid until you have checked the function is called.**
> Dead code is worse than absent code in exactly this way: it looks like a reason. Grep for callers
> before citing behaviour.

Nine mutations, **five predictions right**, and all four misses in the same direction — a systematic
bias, not four slips. The cause: predictions made against `plan.md`'s thirteen-row test *mapping*
rather than the twenty-two tests actually written. The auditor then corrected that diagnosis too —
it covers three of the four, while one miss was a plain reasoning error about a row that *was* in the
mapping. Even the account of the mistake was made by reading.

Four consecutive loops have now broken a rule recorded in this file by the loop that recorded it. The
honest conclusion is not "try harder". It is that these rules are not self-enforcing, and the
reviewers are the enforcement: every one of the three errors above was found by an agent that ran the
measurement again.

## Loop 032 — a test that cannot fail

Loops 030 and 031 validated fields at the cache-read boundary, one at a time, in place. Loop 032
replaced that with a **whitelist rebuild**: `sanitizeSnapshot` constructs a new snapshot from a
declared list of eleven fields, so an unknown key cannot ride along. The difference is which way the
mechanism fails. Validate-in-place fails by **leaking** a field nobody enumerated, and nothing catches
that. A rebuild fails by **dropping** a field, and a strict round-trip catches it on the next run.
That trade is the whole design, and it is the right one.

The loop still shipped three defects into review. None of the three was found by me.

**A rebuild bug that passed all 870 tests.** The rebuild hardcoded `isEnabled: false`. `format.ts:373`
gates the enterprise line on `!e.isEnabled`, so every enterprise account with extra usage enabled
would have read back from cache as disabled. Eight hundred and seventy green tests, and not one of
them touched it. The reason is worth more than the bug: the poisoned fixture corrupts
`enterprise.utilizationPct`, and `sanitizeEnterprise` **short-circuits to `null`** on any bad numeric.
One poisoned field means the other five rules under that guard are never reached.

> **When a validator short-circuits, one poisoned fixture is not a test suite — it is a test of the
> short circuit.** Every rule behind an early return needs its own fixture that is valid up to that
> rule.

**The `--debug` e2e leg could not fail.** Mutate `sanitizeSnapshot` into a no-op and twenty-two tests
go red — and T2, the end-to-end leak assertion, stays **green**. `printDebug` emits a fixed key list;
four fields from the snapshot reach it, and none of the poisoned ones did. Commit 4 had already
written that leg into `SPEC.md` as evidence. The e2e claim was load-bearing in the spec and inert in
the suite.

> **A test that has never been seen to fail has not been tested.** Mutation testing is how this repo
> checks that, and this loop proves the check must be **per rule, not per guard**. The four silent
> enterprise mutations all lived under a guard I had already mutated once and declared load-bearing.

**A user at 96% was shown 3%.** `display.primaryUtilizationPct` was validated on its own merits —
finite, non-negative — and never cross-checked against the windows it summarises. A cache file whose
`display` block disagreed with its own `windows` passed sanitisation intact, `classify()` returned
`Healthy`, and the VS Code status bar went green for an account at 96%. The fix is not a tighter
range check: `display` is now **derived** from `primaryWindow` and the windows, and the stored block
is discarded. A summary field that can be validated independently of what it summarises is not
validated.

Two smaller ones, same shape. The reject clause discarded a live `cooldownUntil` when `display` was
`null` but not when it was `"x"` — a truthiness test standing in for a type test, losing the §9.4
throttle. And `sanitizeDisabledReason` was a **blacklist**: it leaked FQDNs, usernames, Windows
paths, JWTs, bearer tokens and ANSI escapes.

> **A blacklist enumerates what you thought of.** It is now a positive character whitelist plus
> structural rejection of identifier shapes, which fails closed on the next thing nobody thought of.

Two acceptance criteria are recorded **UNMET** rather than argued down. A6: three of ten mutation
predictions held, and two of the misses could not be reproduced from their own written text — the
prediction was too vague to be wrong, which is worse than being wrong. From here a prediction names a
specific `file:testname`, never a count. A9 predicted zero changed test expectations and five changed.

And A12, the lint budget, broke for the **fifth time in four loops** — three times in this loop alone.
Always the same two rules: a nested helper capturing nothing trips `consistent-function-scoping`, and
`Array#sort` should be `toSorted()`. Five hand-caught failures of one mechanical check is not a
discipline problem. Loop 033 makes it a gate.

The thread running through 029, 030, 031 is "a claim made by reading instead of measuring". That is
not the failure any more — every claim in this loop was measured. The failure moved one step down:
**the measurement itself could not fail**. A green suite, a green e2e leg, a mutation that a guard
absorbs. The reviewers remain the enforcement, and what they now enforce is not whether a test
passes but whether it was ever capable of failing.

## Loop 033 — writing the rule down does not confer immunity

Two rules this repo had been enforcing by hand became steps in `bun run verify`: an `oxlint` warning
budget, and a check comparing each loop's `spec.md` requirement headings against its `plan.md` fence.
Both had failed in the field. The lint criterion broke **five times** — twice in loop 031, three
times in loop 032 — always found by a human re-running a command. And nothing at all compared spec
to plan, which is how loop 030 shipped a requirement its own plan forbade, with the criterion
recorded as met.

The loop built the machinery to stop both classes of failure, and committed both classes anyway.

**A number lifted from the wrong experiment, published in the paragraph arguing for measurement.**
The spec rejected "match backticks anywhere" on the strength of *15 findings across 8 loops*. The
Stage 2 reviewer swept 24 interpretations and could not reproduce it under any of them, because the
figure came from a **different** experiment — the path-only variant — and was wrong even for that
one. The real answer is 89 across 9. The conclusion survived; the number did not.

**A test that stayed green under the mutation it existed to catch.** The portability test built a
backslash corpus and converted it back to POSIX before calling anything, because `toPosix` was
unreachable from the function under test. The auditor replaced `toPosix` with the identity function:
still green. That is loop 032's closing sentence — *a test that has never been seen to fail has not
been tested* — reproduced one loop later by the author who wrote it.

**And a fence that said the opposite of what the parser reads.** One paragraph after warning myself
that the fence must not contain `scripts/`, I wrote *"every existing file under `scripts/` other than
`verify.ts`"*. Run through the real extractor, that sentence yields ten tokens including `scripts/`
— the forbidden one — and `verify.ts`, the one script the loop actually changes. The general defect
is worth keeping: **"everything under X except Y" inverts both terms.**

> **The reviewers are the immunity.** All six substantive defects were found by an agent that re-ran
> a measurement instead of re-reading a claim, and two specifically by mutation — by asking not
> "does this test pass" but "has this test ever been seen to fail". Four consecutive loops have now
> broken a rule recorded in this file by the loop that recorded it. The rules are not self-enforcing
> and were never going to be; what changed this loop is that two of them stopped being rules and
> became steps.

**Both gates fail in both directions, and that did more work than expected.** The removal direction
is not politeness about cleanup commits. Without it, a budget keyed on rule + file + count is
defeated by swapping one warning for another of the same rule in the same file — the same defeat as
the count-only budget it replaces, one level down. **A one-directional budget decays.** The same
logic put `unresolvedTokens` in the baseline: a check with zero false positives that cannot parse
44% of its input is buying accuracy with silence, so the silence gets published and ratcheted.

Fourteen mutations, **zero survivors**, nine of fourteen predictions exact by name — against loop
032's three of ten, two of which were too vague to be scored at all. The five misses share a single
cause rather than being five slips: any mutation to the parser also moves the committed baseline,
and I kept forgetting to name that test. One missing rule, not five errors.

**The loop's proof is not a test.** It is `verify` rejecting the commit that added it:

```
lint-budget: NEW WARNING  unicorn(consistent-function-scoping)  scripts/fence-check.test.ts
             Function `statAs` does not capture any variables from its parent scope
```

Fifth occurrence of that rule across five loops. The first four were caught by hand. This one was
caught by the gate, in the commit that adds the gate, before it could reach CI.

The honest limit, recorded rather than smoothed over: this loop committed exactly one fence
violation, and `fence-check` **cannot see it**. The fence clause covering `scripts/env.test.ts` is
unbackticked prose, so the extractor yields twelve tokens and none is a test file. A13 passes partly
because the parser is blind to the clause that was breached. Loop 026's fence has the same shape and
reports passing over four tokens. Closing that needs a structured fence, which is deferred — and
deferring it is a choice made with the hole measured, not assumed away.

## Loop 034 — two correct decisions, composed into a token leak

`SPEC.md` had claimed since loop 003 that the cache location follows `$XDG_CACHE_HOME`. It never
read the variable. Loops 003 and 005 both recorded the divergence in their reviews; neither fixed
it. Thirty loops of "recorded, not fixed" is what finally made it worth doing — the item had become
proof that recorded items never get done.

The resolver is four lines. Seventeen files moved with it.

**The security pass found a blocking defect and demonstrated it: an OAuth access token leaving the
machine.** Before this loop the spool directory was always `~/.cache/claudewatch`, created `0700`,
so only its owner could put a file there. Honouring an environment variable made it an arbitrary
absolute path — possibly one another local user owns. `pendingShippingFiles` selects by basename
pattern; `ship()` reads with no `lstat`. A planted `.shipping` symlink pointing at
`~/.claude/.credentials.json` was read and POSTed to the configured endpoint.

> **A capability review has to follow the data, not the code.** Every token-handling invariant was
> clean — no token in logs, argv, cache, or `--debug`; credentials read-only; TLS untouched — and
> the diff contains no token-handling code at all. The token arrived as **file contents**. Honouring
> the user's cache variable is right. Shipping what is in the spool directory is right. What changed
> was *who can write to a directory this process reads*, and neither decision is visible as a defect
> on its own.

**A source grep tests spelling; only a behavioural test tests the invariant.** A7 was written as a
grep of `verify.ts` for `join(homedir(), '.cache'`. The audit defeated it five ways — double quotes,
a template literal, a destructured `homedir()`, an extracted constant — and then with the one that
matters: leave the `mkdir` derived and construct the **append** independently. No event anywhere,
gate at exit 0, A7 green. It now spawns the real gate against a fixture with `XDG_CACHE_HOME`
pointing at a third directory and asserts the event lands there and nowhere else.

**A fix is not exempt from review, and this loop proved it twice on its own work.** The A7 grep was
introduced by the work meant to make the change safe. And pinning `XDG_CACHE_HOME` on the sandbox
seed turned `extension.test.ts`'s block — literally named *"the safety layers themselves"* — from
mutant-killing into mutant-surviving, because an ambient XDG value usually lives under `TMPDIR` and
satisfied both of its negative assertions with the safety layer deleted.

**On mutation prediction, the misses now have a name.** Nine mutations, zero survivors, four of nine
exact. Four of the five misses are one mistake: *predicting the tests written for a rule and
forgetting the suites written across rules* — here the six-cell agreement matrix, in loop 033 the
live-tree baseline. Two consecutive loops, same cause. The other two misses are the inverse and more
interesting: a test I expected to fail bound to a **different rule than I thought**, which is
correct per-rule coverage and a wrong model of it.

> **Name the cross-cutting suites, not just the per-rule tests.** And when a prediction over-shoots,
> suspect two rules where you thought there was one.

**The harness from loop 033 paid for itself in ways I did not predict.** `lintBudget` rejected one
of my own commits for a warning I had *accidentally fixed* — the removal direction firing exactly as
designed, with the asymmetric wording that distinguishes a fix from a regression. `fenceCheck` forced
a baseline update into the same commit as the artifact that caused it. Neither was a judgement call,
which is the whole point of moving a rule from prose into the gate.

One gap is worth separating from the rest, because of *where* it was introduced: `cli-ship` has no
test file, so the drain's composition and exit code are unexercised. The plan's test mapping had
already mapped that criterion only to `combineResults`. **The mapping was wrong before the code
was** — a Stage 3 defect that Stage 4 inherited and only Stage 5 caught.

---

## Loop 035 — `unresolvedTokens` counted two populations, one of them noise

`fenceCheck`'s baselined integer mixed identifier-shaped tokens the index genuinely cannot see with
flags, environment variables, keywords and expressions no index will ever resolve. Split by shape;
only the first class is baselined; two narrow resolution rules added. **25 → 14.**

**The loop caught itself doing the thing it exists to stop.** Its first attempt at the number was to
edit its own already-committed `spec.md`, removing two backticked heading tokens, justified by a
fence trap that did not exist. The plan-to-diff audit returned FENCE VIOLATED and dismantled the
justification: `package.json` produced zero findings either way, because the fence never named it —
the trap lived only in a counterfactual. The rewrite's real effect was on `name:` and `UNRESOLVED`,
which have nothing to do with manifests, and it moved the baselined number from 15 to 13.

> **A disclosure is not a defence.** The rewrite *was* disclosed, in two places, and it destroyed no
> information. It was still wrong, and the disclosure paragraph itself contained a false sentence
> ("this spec still contributes tokens to both counts" — it contributed zero, because the rewrite had
> removed them). Writing down that you did something does not make it the right thing, and the
> writing-down is not exempt from being checked.

The test that resolved it is worth keeping: *does removing this token hide a fact the number exists
to report?* Four of the five headings named a **measurement** — patterns being described, not things
the loop changes — and stayed prose. `UNRESOLVED` names a requirement, is identifier-shaped, and the
index does not know it. That is the definition of the counted class, so it went back, and the number
is 14.

**Declining a proposal is not the same as declining its goal.** The intent asked to index type
members. Measured: four new findings across two loops, *all four false positives*, because a bare
field name in a heading names the field's behaviour, not the file that declares it. Declining that
was right — but the Stage 2 review then showed the decline had been over-extended into two cases it
did not cover. A root `package.json` script name is a **declared** mapping from a name to a file,
hand-written in a committed file exactly as `export function verify` would be. And `Owner.member`
resolves through the index that *already exists* — the dot is the author saying which declaration
they mean. Three tokens, zero findings, no member index, and loop 034's contribution to the count
went from 1 to 0. The headline claim only became true for the motivating loop because a reviewer
refused to accept it as asserted.

**Two mutation lessons, and the second is one level below the first.**

Loops 033 and 034 both under-predicted by naming per-rule tests and forgetting cross-cutting suites.
A10 was written for exactly that. This loop failed differently: M4 predicted five tests, five failed,
and **only one was among the five named**. The commit message called it "as predicted or better" on a
count match that concealed a four-in-five set mismatch, and the audit caught it.

> **Trace the early returns, not just the rules.** `ENV_VAR`, `RESERVED` and `TYPE_KEYWORDS` are
> checked before `IDENTIFIER` and return early, so mutating `IDENTIFIER` cannot reach any test whose
> input is caught upstream. The rules were not independent; the predictions assumed they were. The
> five mutations predicted afterwards, with the ordering traced, all came back correct on the set.

**Two dead things, found only by mutating.** M1 predicted three failures for deleting the flag branch
and produced **zero** — `-` already fails the identifier rule, so the branch had never decided
anything and `a flag is not a symbol` could not fail. M11 predicted zero for deleting `readManifest`'s
size-and-type guard, and that was the *right prediction and the wrong code*: a guard whose absence no
test can detect is loop 034's A7 wearing a new hat. Exporting it with `stat`/`read` as parameters — the
`scripts/spool-path.ts` remedy — turned zero into three.

**The security pass found a regression this loop introduced, in a diff with no security surface.**
Before the split, an ESC-bearing heading token landed in `unresolved`, whose count is baselined:
committing one forced a mismatch and a red gate. After the split it classifies as `not-a-symbol` —
printed, never asserted — so the same bytes print on a **green** run, and a `\x1b[8m` conceals every
`FINDING` line after it.

> **Splitting a number into a checked half and an unchecked half moves things into the unchecked
> half.** That is what a split is for, and it is also the risk. Ask what used to be caught only
> because it landed in the counted bucket. Loop 034's lesson was *follow the data, not the code*;
> this is its sibling — *follow what stopped being asserted*.

**Where the gate paid for itself again.** `lintBudget` rejected the security tests for shadowing
`read`, and A11 says the budget holds, so the shadow got fixed rather than the record. `fenceCheck`
now reports on loop 035 in its own output — the check counting its own spec's unreadable token, which
is the correct behaviour and slightly uncomfortable to look at.

**Found live, not by reading.** Running the telemetry round trip by hand exposed that `ship()`
collapses a 404, a 500, a TLS failure and a DNS failure into one indistinguishable `retained 1` line.
On the NUC that count walks toward the 20-file drop threshold with no way to tell why. A loop 036
candidate — and a reminder that exercising the thing finds what reading it does not.
