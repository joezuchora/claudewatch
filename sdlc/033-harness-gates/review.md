# Review: two harness gates — spec-vs-fence, and a lint budget in `verify`

- **ID:** 033-harness-gates
- **Stage:** 5 — Deploy
- **Range reviewed:** `f2427f3..9ffdb1e` (eight commits)
- **Verdict:** **Accept.** Both reviewers returned, both found real defects, both are remediated.
- **Date:** 2026-08-28

## What shipped

`bun run verify` runs seven steps instead of five. Two of them enforce rules that were prose in a
review document for four loops:

```
verify: pass in 14.5s  [typecheck 2.5s  lint 0.1s  lintBudget 0.1s  fenceCheck 0.1s
                        test 9.2s  build 0.5s  perf 2.1s]
929 pass, 0 fail
```

`fence-check` on the committed tree, verbatim (A2 evidence):

```
fence-check: 13 checkable, 13 uncheckable, 6 skipped
fence-check: 22 unresolved heading tokens
  FINDING  030-cache-read-validation: extractLastError -> packages/core/src/snapshot.ts (fence: snapshot.ts)
```

That one finding is the defect the loop exists for, and a **path-only check cannot see it** — loop
030's `spec.md` never writes the string `snapshot.ts`. It names `extractLastError`, and the file is
merely where that symbol lives. Measured before the design was fixed: path-only misses loop 030 and
reports `client.ts` instead.

## The three defects that shaped the design, in order of when they were caught

### 1. The headline number came from the wrong experiment (Stage 2)

`spec.md`'s central design argument rejected "match backticks anywhere" on the strength of a
measurement: *15 findings across 8 loops*. The Stage 2 reviewer could not reproduce it under **any**
of 24 variants it swept, and it was right: that figure came from the **path-only** experiment, and
was wrong even for that one (7 loops, not 8). Re-measured over the corpus and markers the spec
actually specifies: **89 findings across 9 loops**.

The conclusion survived — the heading restriction got *more* justified, not less. The number did
not. This repo's standing rule is that a published unmeasured number is the defect independently of
whether the conclusion holds, and I published one in the section arguing for measurement.

### 2. A parser bug one commit from becoming a baselined constant (Stage 2)

The marker list matched `Explicitly not touched` and `Not touched, deliberately`. Loops 021 and 022
carry perfectly good fences under a third phrasing, `**Not touched:**`. I called them `UNCHECKABLE`,
counted 15, and then *justified the count* with "the convention starts at loop 020" — a sentence
that was false and that reads like evidence. Since `B2` asserts the count against a baseline,
shipping it would have made **fixing the parser a gate failure**.

`Not touched` is a prefix of the long form, so a two-entry list covers all three. Corrected:
**12 checkable, 13 uncheckable**, one finding, zero false positives — and the result held when the
corpus later widened, when `scripts/` stopped losing to core, and when loop 033 itself became
checkable.

### 3. A test the audit proved could not fail (Stage 5)

The portability test built a backslash corpus and then converted it **back to POSIX** before calling
anything, because `toPosix` lived only in `gitFiles` and was unreachable from `checkLoop`. The
auditor replaced `toPosix` with the identity function and the test stayed **green**.

This is loop 032's closing finding — *a test that has never been seen to fail has not been tested* —
reproduced inside the loop written to enforce it, one loop later, by the author who wrote that
sentence. `toPosix` now applies at the entry of `buildIndex` and `checkLoop`, the test passes the
backslash array straight in, and the re-mutation fails exactly the two named tests.

The same audit found **every failure path of `fence-check` untested**: all four comparisons lived
inside an unexported `main()`, including the `NEW CONTRADICTION` message that is the intent's first
done-criterion. They are now `compareToBaseline`, exported, one test per direction.

## Security pass

**No blocking or major findings**, and the headline was established by running the gate rather than
reading it: a sandbox `HOME` with a deliberately leaky failing `lintBudget` step, whose stderr
carried an absolute path and a token-shaped string. The spooled event was

```
"payload":{"outcome":"fail","failedStep":"lintBudget","stepCount":3,"typecheckMs":7,"lintMs":5,"lintBudgetMs":15}
```

Steps run with `stdio: 'inherit'`, so no child output is ever captured, and `testFailures` is
populated only for the `junit` step. An `oxlint` filename, rule message or budget row **cannot**
reach the spool. Both committed record files were inspected field by field: every path repo-relative
POSIX, no absolute path, home directory, username, hostname or email.

Seven minors and informationals, all fixed:

- **A repository file's NAME could decide what gets read.** `buildIndex` called `readFileSync` on
  every tracked `.ts` path with no `lstat` and no size cap. Demonstrated in a scratch repo: a
  tracked symlink pointing outside the repo had its exports indexed, and one pointing at `/dev/zero`
  grew until `ENOMEM` and killed the gate — an unbounded OOM on any CI runner without a ulimit. Now
  `lstat` (so a symlink is refused, not followed), a 1 MiB cap, and a `try` around the read.
- **Control characters in a committed record reached stderr intact.** The validators checked *type*,
  not character class, so a `fenceEntry` carrying a raw CSI sequence survived them — and a record
  file is exactly what a reviewer skims in a diff viewer, where escapes are invisible. Scrubbed on
  parse. Same shape as loop 032's `disabledReason` rule: a positive bound at the boundary rather
  than a blacklist at the printer.
- `rowsFrom` sat **outside** the `try` meant to catch it, so a malformed `oxlint` payload surfaced as
  a stack trace whose message was the whole diagnostic. Moved inside.
- `parseOxlintOutput` exported and used by both the CLI and its test, removing the diff's one
  unguarded `JSON.parse … as` — a standing item in `docs/audit-report.md`.
- `bunx oxlint` → `node_modules/.bin/oxlint`. `bunx` falls back to **fetching from the registry**
  when `node_modules` is absent, which is a path where the version pin this loop added is not what
  runs.
- `bun.lock` refreshed. The pin went into `package.json` but the lock still said `^1.80.0`, and CI
  runs plain `bun install`.

## Then the gate failed on its own author

`verify` rejected the security-remediation commit:

```
lint-budget: NEW WARNING  unicorn(consistent-function-scoping)  scripts/fence-check.test.ts
             Function `statAs` does not capture any variables from its parent scope
```

`unicorn(consistent-function-scoping)` on a nested helper — one of the two rules behind **all five**
historic budget regressions, every previous one found by a human re-running a command. This is the
first time it was caught by the gate, and it caught it in the commit that adds the gate. That single
line is the loop's justification, produced by the loop.

## Mutation testing (A10)

Fourteen mutations, one per **rule** rather than one per guard — loop 032's correction, where four
silent bugs hid behind a guard already mutated once and declared load-bearing. Every prediction named
a specific `file:testname` **before** the run.

| # | Mutation | Predicted | Actual | |
|---|---|---|---|---|
| M-A | `toPosix` → identity | 2 named | 2, both named | ✓ |
| M-B | disappeared-baseline branch deleted | 1 named | 1, named | ✓ |
| M1 | parenthetical strip → no-op | 2 named | **3** | under |
| M2 | sentence truncation → no-op | 2 named | **3** | under |
| M3 | earliest marker → latest | 1 named | 1, named | ✓ |
| M4 | heading filter → all lines | 3 named | **4** | under |
| M5 | signature strip removed | 2 named | 2, both named | ✓ |
| M6 | core-wins removed | 1 named | **2** | under |
| M7 | scripts-independent removed | 1 named | 1, named | ✓ |
| M8 | typefixtures exclusion removed | 1 named | 1, named | ✓ |
| M9 | `message` dropped from budget key | 1 named | 1, named | ✓ |
| M10 | budget removal direction deleted | 3 named | 3, **one misnamed** | partial |
| M11 | `lstat` guard removed | 2 named | 2, both named | ✓ |
| M12 | `scrubControls` → identity | 2 named | 2, both named | ✓ |

**Zero surviving mutants.** Nine of fourteen predictions exact by name; five under-predicted.

The misses are **systematic in one direction**, which is worth more than the score: four of the five
are the live-tree baseline test, which fails whenever the parser changes at all and which I kept
forgetting to name. That is not five independent slips, it is one missing rule — *any mutation to
the parser also moves the committed baseline* — and naming it here is the fix. Compare loop 032's
3-of-10 with two predictions too vague to be falsifiable; every prediction here was specific enough
to be scored.

## Acceptance criteria

| # | Verdict | Evidence |
|---|---|---|
| A1 | **MET** | Seven steps, `verify` exit 0 locally and CI green on `dfad948` and `3ac46fb`. |
| A2 | **MET** | Output pasted above: exactly one finding, loop 030's. |
| A3 | **MET** | 13 checkable, 13 uncheckable, asserted against the baseline in `fence-check.test.ts`. |
| A4 | **MET** | `unresolvedTokens: 22`, asserted. The Stage-2 spec said 21; the plan predicted the correction and the tool confirmed it. |
| A5 | **MET** | CLI: `NEW WARNING  eslint(no-shadow)  packages/core/src/security.test.ts  'cleanup' is already declared…`, exit 1. |
| A6 | **MET** | CLI: `1 fewer unicorn(no-array-sort) in packages/metrics/src/agent.ts — if you fixed it, update .oxlint-budget.json in this commit`. |
| A7 | **MET** | Same rule, same file, different message → one added **and** one removed. M9 confirms the key is what does it. |
| A8 | **MET** | Seeded contradiction detected; both near-misses not; M1 and M2 confirm each normalisation. |
| A9 | **MET** | Reorder, line-move and backslash all covered; the backslash leg was vacuous and is now M-A-confirmed. |
| A10 | **MET, with the miss recorded** | Fourteen mutations, zero survivors, 9/14 exact. The five under-predictions share one cause, named above. |
| A11 | **MET** | 9 rows / 11 warnings, byte-identical to the committed file, **zero** rows under `scripts/`. Earned rather than assumed — the gate rejected the first attempt. |
| A12 | **MET, excursion recorded** | Fence is 12 tokens, no bare `scripts/`, nothing under `packages/*/src`. Two paths added during implementation, recorded in `plan.md`. |
| A13 | **MET — but see below** | Zero findings on loop 033's own artifacts. |

## What is NOT done

1. **A13 passes partly because the parser is blind to the clause that was breached.** This loop
   committed exactly one fence violation — `scripts/env.test.ts`, forced when the sandbox proved that
   steps must be package scripts. The fence's closing clause, *"and the tests beside those four"*, is
   **unbackticked prose**, so `extractFence` yields twelve tokens and none is a test file.
   `fence-check` structurally cannot see it. The auditor found this; it is the known
   unbackticked-prose-fence hole, and it fired on the very loop that introduced the gate. Recorded,
   not fixed — closing it needs the structured fence the spec defers.
2. **"Everything under X except Y" inverts both terms.** My first fence said *"every existing file
   under `scripts/` other than `verify.ts`"*, which the parser reads as fencing `scripts/` (forbidden
   by A12) and `verify.ts` (the file actually being changed). Caught by running the extractor over my
   own plan. Recorded in `plan.md`; the fix belongs with the structured fence.
3. **Only 28 of 50 heading tokens resolve.** Type members are the big class — `MetricEvent.payload`
   is precisely the token loop 020's fence protects as the telemetry security boundary, and this
   check is silent on it. Baselined so it cannot grow quietly; indexing type members is the next
   increment.
4. **Loop 026's fence is prose** — *"every existing source and test file"*, unbackticked. `fence-check`
   sees four tokens and reports it passing. Same hole as (1), on a committed loop.
5. **`compareToBaseline`'s output is tested; `main`'s wiring is not.** The four comparisons have tests;
   the walk that feeds them does not.
6. **The two new scripts' own exports are now in the global symbol index**, so the baselined counts
   are coupled to their export names. No collision today.
7. **`spec.md`'s B5 seam description was written before the code** and diverged; corrected at Stage 5
   rather than at Stage 3, which is later than it should have been.
8. **The 11 existing lint warnings stay.** Deliberately out of scope: the budget records the tree as
   it is.

## Retrospective

Loop 032 closed on *"the dominant failure is no longer a claim made by reading — it is a test that
cannot fail."* Loop 033 built the machinery to stop both, and committed both anyway: a number lifted
from the wrong experiment and published in the paragraph arguing for measurement, and a test that
stayed green under the mutation it existed to catch.

So the honest finding is not a new failure mode. It is that **writing the rule down does not confer
immunity, and the reviewers are the immunity.** Every one of the six substantive defects here was
found by an agent that re-ran a measurement instead of re-reading a claim. Two of them were found
specifically by mutation — which is to say, by asking not "does this test pass" but "has this test
ever been seen to fail".

What *is* new is the shape of the fix. Both gates are budgets that fail in **both** directions, and
that choice did more work than expected. The removal direction is not politeness about cleanup
commits: without it, `code + filename + count` is defeated by swapping one warning for another of the
same rule in the same file. A one-directional budget is a budget that decays. The same logic put
`unresolvedTokens` in the baseline — a check with zero false positives and 44% of its input
unparsed is buying its accuracy with silence, and the only defence is to publish the silence and
ratchet it.

And the loop produced its own proof. Not the tests, not the criteria — the gate rejecting the
commit that added it, for `consistent-function-scoping` on a nested helper, the fifth occurrence of
a rule whose previous four were all caught by hand.

---

**Next stage:** Maintain — no incident. The retrospective goes to `sdlc/README.md`.
