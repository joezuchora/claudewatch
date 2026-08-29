# Intent: `unresolvedTokens` counts two populations, and only one of them is a signal

- **ID:** 035-fence-signal
- **Stage:** 1 — Plan
- **Status:** accepted
- **Author:** raised by loop 034's `plan.md` Risks, recorded again in its `review.md` "What is NOT
  done" (item 6), and queued there for this loop.
- **Date:** 2026-08-29

## Problem

Loop 033 added `fenceCheck` to `bun run verify` and baselined three numbers, one of which is
`unresolvedTokens` — the count of `spec.md` heading tokens the check cannot resolve to a file. The
spec justified baselining it in these words:

> Baselining `unresolvedTokens` converts a silent 44% miss rate into a ratcheted number: the next
> loop that writes a heading the check cannot read shows up as a delta rather than as silence.

That reasoning is sound and the number is not doing it. Measured across the two loops that have
touched the baseline since:

| Commit | `unresolvedTokens` | Why it moved |
|---|---|---|
| `dfad948` (loop 033) | 22 | the baseline was first written |
| `313ae4f` (loop 034) | 25 | loop 034's `plan.md` landed, making its own spec checkable |

**Both moves were routine and neither was a signal.** Loop 034's three new tokens are
`XDG_CACHE_HOME`, `verify` and `--debug` — an environment variable, a script name and a command-line
flag. None of them will ever resolve to a file, in this loop or any other. Updating the number was
correct both times, and it is now something a loop does on the way past rather than something that
tells anyone anything.

That is precisely the reflex loop 033's own B3.1 guardrails were written to prevent for the lint
budget: *"editing that file becomes the trained response to a failure, and the response is identical
whether the delta was a fix or a regression."* The lint budget got asymmetric wording so the two
cases read differently. `unresolvedTokens` got nothing, and it has the same disease.

**The root cause is that one number counts two populations.** Today's 25 tokens, classified by
running the check and then looking up each token:

- **Cannot resolve, by construction** — `--json`, `--debug`, `XDG_CACHE_HOME`, `verify` (×2),
  `vscode` (×2), `any`, `try`, `⊙ error`, `SPEC.md §12`, `response.json()`. Flags, environment
  variables, TypeScript keywords, a package name, a rendered output string, a document reference, an
  expression. **Twelve.** No amount of indexing will ever resolve these, and every future loop will
  add more.
- **Could resolve, and does not** — six are real interface members in `types.ts`
  (`primaryUtilizationPct:39`, `disabledReason:16`, `fetchedAt:27`, `freshness:42`,
  `lastHttpStatus:86`, `normalizationWarnings:47`), plus `MetricEvent.payload` and
  `enterprise.utilizationPct`; and two are module-local declarations in `extension.ts`
  (`refreshInFlight:27`, `doRefresh:154`). **Ten.** These are a genuine coverage gap: the check
  indexes only top-level `export`s, so a spec that says "`MetricEvent.payload` must not widen" is
  invisible to it — and that token is exactly what loop 020's fence protects as the
  product-telemetry security boundary.
- **Neither** — `malformedResponse` is a string literal value, `outcome` an object-literal property.
  **Three.** Not declarations at all; a symbol index will never see them and calling them a coverage
  gap would be wrong.

Mixing those three groups into one baselined integer means the number **cannot go down** as a
matter of course, **must go up** every loop, and says nothing about whether the check got better or
worse.

## Who is affected

Whoever runs the loop — today one maintainer and the agents working the stages. The cost is not the
edit; it is one line in a JSON file. The cost is that a gate designed to make silence visible has
started producing a number nobody can act on, two loops after it was built, and the next person to
see it move will do what I did: update it and move on.

The second cost is concrete and already recorded. `MetricEvent.payload` is unresolvable today, so
**if a future spec asks to widen the telemetry payload while a plan fences `telemetry.ts`,
`fenceCheck` is silent** — on the one token loop 020's fence calls the product-telemetry security
boundary.

## Why now

Two loops of evidence is the right amount: one data point is an anecdote, three would be a habit.
The ratchet has moved twice, both times for reasons that carry no information, and loop 034's review
recorded the diagnosis rather than fixing it because that was out of its scope.

It is also cheap relative to its blast radius. `fenceCheck` runs on every commit and every CI push;
a number in its baseline that everyone learns to bump is a gate quietly training people to ignore
it.

## What "done" means

- [ ] A token that can never resolve — a flag, an environment variable, a language keyword — is not
      counted as an unresolved *symbol*. Whatever replaces the single number distinguishes "the
      check could not read this" from "there was nothing here to read".
- [ ] `MetricEvent.payload` resolves, or the check states plainly and in one place why it cannot.
      A spec that asks to widen the telemetry payload against a fence that forbids it must not be
      silent.
- [ ] Adding a loop whose spec headings name only flags and env vars does **not** move the baselined
      number. Demonstrated against a fixture, not argued.
- [ ] Adding a loop whose spec heading names a real type member that a plan fences **does** produce
      a finding.
- [ ] The remaining number, whatever it is, is one a reader can act on: it goes **down** when the
      check improves and **up** only when something genuinely became unreadable.
- [ ] `bun run verify` still exits 0, and the existing single finding (loop 030's) is unchanged.

## Explicitly out of scope

- **The structured fence.** Loop 033 deferred it and loop 034 did not need it; the unbackticked-prose
  hole stays open and recorded. This loop is about the *resolver*, not the fence format.
- **Rewriting any committed `spec.md` to use resolvable headings.** The artifacts are the record of
  what was decided; the check adapts to them, not the reverse.
- **The lint budget.** Its guardrails already work — loop 034 watched them reject a commit for a
  warning that had been accidentally fixed.
- **`cli-ship`'s missing test file** (loop 034's A9, PARTIAL). Real, recorded, and a different
  subject.
- **Indexing every local binding in every function.** The two module-locals here are top-level
  declarations; going deeper is a different and much larger change.

## Open questions

- **Whether the replacement is one number or two.** "Unreadable tokens" and "tokens with nothing to
  read" are different facts and might warrant separate baselined counts — or the second might not be
  worth counting at all, in which case the honest move is to stop counting it rather than to record
  it more precisely. Design decides, and must say which of the two costs it is optimising: a number
  that moves rarely, or a number that is complete.
- **Whether indexing type members is safe for the check's false-positive rate.** Loop 033 measured
  zero false positives across twelve loops with a very narrow index. Members are far more numerous
  and much more likely to collide with a common word — `outcome`, `message`, `status`. Design must
  re-measure the false-positive rate over all committed loops **after** the index widens, and treat
  a regression there as disqualifying rather than as a tuning problem.
- **Whether a token that resolves to a *value* rather than a declaration should count at all.**
  `malformedResponse` is a string literal in `client.ts`. It is neither unreadable nor a gap, and
  the current number counts it as both.

---

**Next stage:** Design — run `/sdlc-spec 035-fence-signal` to turn this into `spec.md`.
