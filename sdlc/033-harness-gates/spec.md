# Spec: two harness gates — spec-vs-fence, and a lint budget in `verify`

- **ID:** 033-harness-gates
- **Stage:** 2 — Design
- **Status:** draft
- **Reads:** `sdlc/033-harness-gates/intent.md`
- **Date:** 2026-08-28

## Summary

Two rules currently enforced by a human reading a document become steps in `bun run verify`.

Both are **budgets**, not demands for zero. A budget records the tree as it is, fails when
something is added, and — this is the half that stops budgets rotting — fails when something is
removed without the record being updated in the same commit. The lint budget records 11 warnings.
The fence budget records the one known spec-vs-fence contradiction, loop 030's, which the intent
put explicitly out of scope to fix here.

The intent left two questions for this stage. Both are answered below by measurement against all
32 committed loops, not by argument.

## Behavior

### B1 — `scripts/fence-check.ts`: spec-vs-fence, over every committed loop

For each `sdlc/<NNN>-<slug>/` that has **both** `spec.md` and `plan.md`:

**Extract the negative fence from `plan.md`.** Take the paragraph beginning at the first
occurrence of `Explicitly not touched` or `Not touched, deliberately`, ending at the first blank
line. Then, in order:

1. Delete every parenthesised group `(…)`. Fence lines carry asides — loop 025's reads
   `` `SPEC.md` (impact assessed as none — §8.1's tree is illustrative and already omits
   `core-bridge.ts`) `` — and the aside names files that are *not* fenced.
2. Truncate at the first sentence boundary (`.` followed by whitespace or end). Loop 020's fence
   is one path followed by three sentences of prose, one of which says `verify.ts`'s annotation
   **does** move.
3. Take every backticked token that remains. That is the fence.

A loop with no such paragraph has **no machine-readable fence**. It is reported `UNCHECKABLE` and
is never reported as passing. Of the 32 committed loop directories, 25 carry both artifacts;
**15 of those 25 have no machine-readable fence**. The convention starts at loop 020.

**Extract what `spec.md` requires changed.** Take only lines matching `^#{2,4}\s` — the requirement
headings. Loop 030's contradiction lives in a heading: `### B3 — extractLastError's gate is KEPT,
and relabelled`. Body prose is excluded, and that exclusion is the entire difference between a
usable check and one that fires 15 times across 8 loops (measured; see **Rejected alternatives**).
From those heading lines take every backticked token, and resolve each:

- **Path-shaped** (matches `^(?:[\w./@-]+/)?[\w.@-]+\.(ts|md|json|ya?ml|sh|ps1|js)$`) → every
  repository file equal to it or ending in `/` + it.
- **A bare identifier** that the symbol index knows → the file that defines it.
- Anything else → ignored.

**The symbol index** is built by scanning `packages/**/*.ts` and `scripts/*.ts` for
`^export (async )?(function|const|let|class|interface|type|enum) (\w+)`. When a symbol resolves to
more than one file and any of them is under `packages/core/src/`, **core wins**. This is not a
tiebreak of convenience: `CLAUDE.md` states all business logic lives in core and surfaces are thin,
so a symbol appearing in both is a surface re-exporting core. Without this rule `renderEvent`
resolves to `packages/vscode/src/statusbar-bridge.ts`, a shim, and fires against loop 032's fence.

**A finding** is a spec-named target whose resolved file falls inside a fence entry — where "inside"
means equal to it, ending in `/` + it (a bare basename such as `snapshot.ts`), or starting with it
+ `/` (a directory such as `packages/metrics`). Trailing `/` and `/**` are stripped from fence
entries first.

### B2 — the fence baseline

`sdlc/fence-baseline.json` records the findings that are known and accepted, each as
`{ loop, specToken, file, fenceEntry, owner }` where `owner` names where the defect is tracked.
It contains exactly one entry today: loop 030's `extractLastError` → `packages/core/src/snapshot.ts`
against fence entry `snapshot.ts`, owned by loop 030's `review.md` open list.

The check exits non-zero when the finding set differs from the baseline **in either direction**,
and prints the symmetric difference: findings not in the baseline, and baseline entries no longer
found. It also asserts the `UNCHECKABLE` count, so a plan that loses its fence paragraph is a
failure rather than a silent skip.

### B3 — `scripts/lint-budget.ts`: the lint warning budget

Runs `oxlint --format=json` and reads `diagnostics[]`. For each entry with
`severity === "warning"`, key on `code` + `filename` and count. Line and column are **not** part of
the key: an unrelated edit shifts them, and the intent requires the budget to survive that.
`message` is not part of the key either — two `unicorn(no-array-sort)` warnings in
`packages/metrics/src/anomaly.ts` carry an identical message, so the count is what distinguishes
them.

Rows are sorted by key before comparison, because `oxlint`'s emission order is not stable across
runs on an identical tree.

`.oxlint-budget.json` holds the sorted rows. Today: **9 rows, 11 warnings.**

| code | filename | count |
|---|---|---|
| `eslint(no-shadow)` | `packages/core/src/security.test.ts` | 1 |
| `eslint(no-useless-concat)` | `packages/metrics/src/agent.test.ts` | 1 |
| `oxc(no-map-spread)` | `packages/metrics/src/anomaly.test.ts` | 1 |
| `unicorn(consistent-function-scoping)` | `packages/core/src/call-sites.test.ts` | 1 |
| `unicorn(consistent-function-scoping)` | `packages/core/src/format.test.ts` | 1 |
| `unicorn(consistent-function-scoping)` | `packages/core/src/security.test.ts` | 1 |
| `unicorn(no-array-sort)` | `packages/metrics/src/agent.ts` | 1 |
| `unicorn(no-array-sort)` | `packages/metrics/src/anomaly.ts` | 2 |
| `unicorn(prefer-array-find)` | `packages/core/src/call-sites.test.ts` | 2 |

Exit non-zero on any difference in either direction. The message names the rule, the file, and
whether the count went up or down — the intent requires the gate to say *which* warning appeared,
not that the total moved.

**Errors are unaffected.** `oxlint` already fails `verify` on any error; the budget governs
warnings only and must not weaken that.

### B4 — both wired into `verify`

`scripts/verify.ts`'s `STEPS` gains `lint-budget` and `fence-check`, after `lint` and before
`test`. Placement is deliberate: `lint-budget` re-runs `oxlint`, so it belongs beside it, and both
are sub-second, so neither meaningfully moves the gate's total. A failure in either fails `verify`,
which fails CI, because CI runs `bun run verify` unchanged.

### B5 — the checks must be seen to fail

`scripts/fence-check.test.ts` and `scripts/lint-budget.test.ts` drive each check over **fixture
inputs**, not over the live repository alone:

- A fixture spec/plan pair with a seeded contradiction → detected, and the message names the file
  and the fence entry.
- A **near-miss** pair where the spec names a symbol in body prose but not in a heading, and a
  second where a heading names a file the fence does not cover → **not** detected. A check that
  fires on these is a check that will be disabled by its third loop.
- A fixture `oxlint` payload with one warning added, one removed, and one whose line moved →
  the first two fail, the third passes.

This is loop 032's rule applied to the gates themselves: a check that has never been seen to fail
has not been tested.

## Data and types

- `.oxlint-budget.json` — `Array<{ code: string; filename: string; count: number }>`, sorted by
  `code` then `filename`.
- `sdlc/fence-baseline.json` — `{ uncheckable: number; findings: Array<{ loop, specToken, file,
  fenceEntry, owner }> }`, all `string` except `uncheckable`.
- No `any`. Both files are parsed and validated, not `as`-asserted — `docs/audit-report.md` already
  carries `JSON.parse … as` as a standing informational finding, and adding two more would be a
  regression the security pass should catch.

## Edge cases

- **A loop directory missing `spec.md` or `plan.md`** (six: `004`, `015`, `016`, `017`, `018`,
  `019`) — skipped entirely, not counted as `UNCHECKABLE`. They are incidents and follow-ups, not
  designs, and holding them to a design-stage check would be a category error.
- **A fence entry that is not a path** — loop 030's fence contains `--debug`. It matches no file
  and produces no finding. Harmless, and left rather than filtered, because filtering requires
  guessing intent.
- **A fence entry naming a file that does not exist** — matches nothing, silently. This is a real
  hole: a fence protecting a deleted or renamed file protects nothing. Reported as a warning line,
  not a failure, because it is out of this loop's scope to fix historic fences.
- **A symbol defined in two core files** — resolves to both; both are checked. No such case exists
  today.
- **`oxlint` emitting no `diagnostics` key** (a crash, a config error) — treated as a failure, not
  as an empty warning set. An empty set would silently "improve" the budget to zero.
- **A test file that only exists in a fixture directory** — fixtures live under
  `scripts/fixtures/fence/`, which is not scanned by the symbol index and contains no `.ts`, so it
  cannot perturb the live check.

## Backward compatibility

- No product code changes. Nothing under `packages/*/src` is touched.
- `verify` gains two steps and therefore two rows in its timing line. `scripts/junit.ts` records
  per-step results; two new step names appear in the JUnit output. Nothing consumes step names by
  position.
- The 11 existing warnings stay. This change does not fix one of them.
- Loop 030's contradiction stays. It enters the baseline as accepted-and-tracked.

## Acceptance criteria

- [ ] **A1** — `bun run verify` exits 0 on the current tree, with `lint-budget` and `fence-check`
      present in its step list.
- [ ] **A2** — `fence-check` run over the committed `sdlc/` tree reports exactly one finding, and it
      is loop 030's `extractLastError` → `packages/core/src/snapshot.ts`. Evidence: the command's
      own output pasted into `review.md`.
- [ ] **A3** — the same run reports **zero** findings for the other ten checkable loops (nine
      historic, plus this one), **15** `UNCHECKABLE`, and **6** skipped. The `UNCHECKABLE` count is
      asserted against the baseline, not read off a screen; it is stable because every loop from
      020 on carries a fence.
- [ ] **A4** — seeding a twelfth lint warning makes `verify` exit non-zero, and the message names
      the rule and the file. Evidence: the seeded diff and the failure output.
- [ ] **A5** — deleting one of the 11 warnings without updating `.oxlint-budget.json` also makes
      `verify` exit non-zero.
- [ ] **A6** — a fixture spec/plan pair with a seeded contradiction is detected; the two near-miss
      fixtures are not. Three tests, named for what they assert.
- [ ] **A7** — reordering `oxlint`'s output does not change the outcome. Asserted over a fixture
      payload, not by re-running and hoping.
- [ ] **A8** — **mutation predictions name a specific `file:testname` before the mutation runs**,
      per loop 032's finding. At least six mutations, each covering one rule rather than one guard:
      the parenthetical strip, the sentence truncation, the heading filter, core-wins resolution,
      the count key, and the removal direction of each budget.
- [ ] **A9** — no new `oxlint` warning. This criterion is now checked by A4's own mechanism, which
      is the point of the loop; `review.md` cites the command, not a procedure.
- [ ] **A10** — the plan-to-diff audit reports no file outside the fence, and the fence contains no
      file under `packages/*/src`.
- [ ] **A11** — `scripts/fence-check.ts` run against itself: this loop's own `spec.md` and
      `plan.md` produce zero findings. A gate that fails its own loop is not shippable.

## Rejected alternatives

**Path-only matching in `spec.md`.** Measured: it does **not** detect loop 030's contradiction,
because loop 030's spec never writes the string `snapshot.ts` — it names `extractLastError`, and
the file is where that symbol happens to live. A path-only check would have shipped, passed, and
missed the one defect it was built for. Symbol resolution is not a refinement here; it is the
requirement.

**Matching backticks anywhere in `spec.md`.** Measured across all 32 loops: 15 findings across 8
loops, of which the overwhelming majority are a spec merely *mentioning* a symbol — often while
arguing that it should **not** be touched. That is a check with a worse than 1-in-15 hit rate,
which is a check nobody will keep. Restricting to requirement headings, plus the two
normalisations in B1, takes it to 1 finding across 10 checkable loops with **zero** false
positives — measured, not predicted, across the ten loops that can be checked at all.

**Requiring a structured fence block going forward, and checking only new loops.** Cleaner to
parse, and it fails the intent's second done-criterion outright: it could not be run against loop
030's committed artifacts, so the check would never have been seen to catch the defect that
justified it. Reconsider once the prose parser has a false positive in the field.

**Rewriting the old plans to a structured fence.** Rejected on principle. A committed artifact is
the record of what was decided at the time; editing 22 of them to suit a checker written three
loops later destroys the evidence the loop exists to produce.

**Running `fence-check` only on the loop currently in flight.** Needs a notion of "current loop",
which is either a state file or an argument someone remembers to pass. Running over everything is
cheap, has no state, and turns a regression in an old artifact into a failure rather than a
silence.

**A count-only lint budget (`warnings <= 11`).** Fails loop 032's A12 case exactly: two of the five
regressions swapped one warning for another. A count would have stayed at 11 and passed.

---

**Next stage:** Build — run `/sdlc-plan 033-harness-gates` to turn this into `plan.md`.
