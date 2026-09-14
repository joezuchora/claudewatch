# Stage 2 review: spec-reviewer findings

**Verdict: revise.** Five blocking findings. Accepted in full; the design was replaced rather
than adjusted. Every falsifiable claim was re-verified here before acting on it.

## The finding that replaced the design

**The band table classified a TOTAL run duration using constants that bound a SINGLE step.**

`latest.durationMs` is `totalMs` — the sum of up to five steps (`verify.ts:224`).
`STEP_TIMEOUT_MS` bounds one step. Five passing steps at 62s total 310s and exit 0; the draft
labelled that run `stepTimeout`, and nothing was killed. The implication only runs one way: a
killed step forces total ≥ 300s, but total ≥ 300s implies nothing about any step.

That is not cosmetic. The draft's entire argued advantage over a finer logarithm was that a
reader "learns something" from the name. What they would learn is false roughly whenever the
machine is uniformly slow rather than hung — the exact condition `sdlc/015` documented.

## The finding I would have shipped and never noticed

**The bands were anchored to a floor that moves.** The trigger is
`Math.max(p95 * durationOutlierMultiple, minOutlierMs)`, not `minOutlierMs`:

| baseline p95 | real threshold | consequence |
|---|---|---|
| 30s | 120s | as the draft assumed |
| 35s | 140s | `elevated` is [140, 240), not [120, 240) |
| 60s | 240s | **`elevated` empty** |
| 67.5s — the slowest legitimate run on record | 270s | `elevated` empty, `severe` reduced to [270, 300) |
| 75s | 300s | `elevated` **and** `severe` both empty |

`sdlc/012` made that baseline rolling precisely so it would move, and it moves most during
sustained slow periods — which is when duration anomalies fire. The draft's fingerprint would
have degraded back toward a constant under exactly the conditions it was built for, and nothing
in the spec asked whether its own bands were reachable.

## Everything else

| # | Finding | Resolution |
|---|---|---|
| B2 | `multiTimeout` named an event `verify.ts` cannot produce — it breaks on first failure, so at most one step can time out. **I had already found and removed this** before the review returned. The reviewer added the other half: 600s *is* reachable, with zero timeouts, via five slow passing steps. So my removal was right for a reason I had half wrong. | Band gone; the reasoning corrected. |
| B3 | `STEP_TIMEOUT_MS` is `Number(process.env.CLAUDEWATCH_VERIFY_TIMEOUT_MS ?? 300_000)` — not a constant, not exported, in a module that runs the whole gate at import. A8 was unimplementable, and binding to the default would have bound to the wrong number whenever the override is set. | Dissolved: the revised design needs no per-step constant. |
| B4 | The spec asserted *"`packages/metrics` must not import from `scripts/`"*. **No such rule exists.** The real one runs the other way (`config.ts:36-39`), and `scripts/env.test.ts:7` already imports across that boundary. | Dissolved, and recorded — see below. |
| M1 | 240s was arbitrary dressed as a decision. The only reasoning was "2× the threshold", which per B5 is not the threshold. | Gone with the absolute bands. |
| M3 | **The fix moved the collision rather than removing it.** A killed run (exit 124) and a run that passed in 310s share a band — dead gate and green gate, one fingerprint. So does a typecheck hang and a test hang. | `outcome` added to the fingerprint; it is a recorded fact, not an inference from a sum. `failedStep` deliberately omitted, with the trade stated. |
| M4 | Boundaries placed inside the distribution's mass, with no account of run-to-run variance: a recurring condition oscillating across one would alternate fingerprints and file an incident every other hour — the outcome `sdlc/009` added suppression to prevent. `log10` did not have this problem because its only boundary sat outside the reachable range. | Accepted knowingly as E5, with the mitigation stated (`outcome` is stable across the oscillation). |
| M5 | A6/A7 named `evaluate`, which **does not exist** in `packages/metrics` — the entry point is `detect` — and described a suppression writeback `detect` does not perform. | Rewritten against `detect`. |
| M6 | Four criteria were satisfiable by a no-op or an unwired implementation: A9 cannot fail at all (one call site), A5 passes against *today's* code, A1–A3 pass with a `durationBand` that is never wired in. | A10 added — fails against today's code, against an unwired band function, and against a constant. A11 kept but relabelled a guard rather than evidence. |
| m2 | The §17 claim was overstated: fingerprints go to a machine-local `suppressions.json` and incident drafts, neither of which is telemetry. And the old function was safe *structurally*, not incidentally. | Corrected. |
| m3 | The `suppressions.json` risk was unquantified. `isSuppressed` already ignores rows older than 24h, so the impact is at most one duplicate draft, on one machine, once. | Quantified. (`writeSuppressions` never prunes — pre-existing, queued.) |
| m4 | The intent's "900s hang" is close to unreachable; the realistic collision is 150s vs ~320s and is just as damning. | Noted; A4 keeps 900s as a synthetic value but the intent no longer implies it is typical. |
| N1 | The `MAX_LINE_BYTES` precedent is `sdlc/020`, not `sdlc/021`. | Fixed. |

## What the reviewer confirmed rather than found

Worth recording, because the point of checking is that some claims survive:

- The intent's core measurement — every reachable anomaly lands in log10 bucket `5` — is correct,
  verified independently, and if anything **understated**: the reviewer noted the real floor is
  dynamic, which makes the constancy worse rather than better.
- **Intent drift: none in either direction.** Every "done" bullet maps to a criterion and no
  criterion serves an unstated outcome.
- **No `SPEC.md` amendment is required.** §8.2 covers core/statusline/vscode; §17 governs
  telemetry payloads, which fingerprints are not.
- Backward compatibility is clean apart from the quantified `suppressions.json` note.

## The meta-finding

`sdlc/021` ended with *"a premise about your own system is still a premise nobody checked."*
This loop's spec **named the `sdlc/015` failure mode in one paragraph and committed it two
paragraphs later** — asserting an architecture rule that does not exist, and presenting it as
inherited. Writing the lesson down does not confer immunity to it.

Two of the five blocking findings were also things I could have caught with one command: `grep`
for the import rule, and reading the three lines around `thresholdMs`. The reviewer's value here
was not superior insight; it was **actually looking**.
