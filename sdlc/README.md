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

One more thing the mutation pass established, which no amount of reading had: the retry
condition's two halves are **independently** load-bearing. `!policy.retryable` alone starts
retrying every 429; `result.status === 429` alone starts retrying 401s. 429 and 5xx are the same
`FailureClass` and want opposite answers, so retry is the one decision here that is not a pure
function of the class — and the "obvious" tidy-up that merges them is a live bug in both
directions.
