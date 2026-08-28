# Intent: two harness gates — spec-vs-fence, and a lint budget in `verify`

- **ID:** 033-harness-gates
- **Stage:** 1 — Plan
- **Status:** accepted
- **Author:** carried forward from loop 030's review (`sdlc/030-cache-read-validation/review.md:220`)
  and deferred by loops 031 and 032; raised again by loop 032's A12, which broke three times in one loop.
- **Date:** 2026-08-28

## Problem

Two of this repo's own quality rules are enforced by a human reading a document. Both have now
failed in the field, repeatedly, and each failure was caught by an agent re-running a measurement
rather than by the gate.

**1. Nothing compares a spec's requested edits against its plan's fence.**

Loop 030's `spec.md` asked for the gate in `snapshot.ts` to be *"KEPT, **and relabelled**"*.
Loop 030's `plan.md` then listed `snapshot.ts` on its **Explicitly not touched** fence
(`sdlc/030-cache-read-validation/plan.md:29`). The two artifacts directly contradict each other.
The loop ran all six stages, the plan-to-diff auditor reported the diff inside the fence — because
it was — and the loop shipped with its acceptance criterion recorded as met. The unimplemented half
of that spec item is still open today, three loops later.

The auditor compares **plan to diff**. Nothing compares **spec to plan**. A fence that silently
drops a spec requirement is worse than no fence: it converts a missed requirement into a passing
check.

**2. The lint budget is prose in a review document.**

Every loop since 029 has carried an acceptance criterion of the form *"`oxlint` warnings unchanged;
sorted diff empty"*. It is written in `spec.md`, evaluated by hand at Stage 5, and recorded in
`review.md`. `bun run verify` runs `oxlint` and passes as long as it emits **no errors** — the
warning count is not read by anything.

The criterion has been broken five times across four loops, always mid-loop, always found by hand:
11→12 and 11→19 in loop 031, and 11→13 and 11→12 twice more in loop 032. Loop 030's own review
already concluded that *a criterion the gate cannot run is a note, not a check* — and loops 031 and
032 then carried it as a note again. Two rules account for every one of those five regressions:
`unicorn(consistent-function-scoping)` on a nested helper that captures nothing, and
`unicorn(no-array-sort)` where `toSorted()` was meant.

The current tree is at **11 warnings across 6 rules**: 3 × `no-array-sort`,
3 × `consistent-function-scoping`, 2 × `prefer-array-find`, and one each of `no-map-spread`,
`no-useless-concat`, `no-shadow`.

## Who is affected

Anyone running this loop — today that is one maintainer and the agents working the stages, on every
change. The cost is not hypothetical: it is one shipped-and-still-open requirement (loop 030), and
five hand-caught lint regressions that each cost a remediation commit inside a loop that was
otherwise finished.

The second cost is subtler and worse. A criterion that only a careful reader enforces teaches every
later loop that criteria are aspirational. Loop 032's retrospective named the pattern in the product
code — *a test that has never been seen to fail has not been tested* — and these two are the same
defect in the harness itself.

## Why now

Loop 031's spec deferred both of these on the grounds that mixing harness and product changes in one
fence is how a fence stops meaning anything. Loop 032's intent kept that reasoning rather than
abandoning it for convenience, and both deferrals were correct at the time. The condition they were
waiting on has now arrived: A12 has failed in every loop since it was written, three times in the
most recent one. Deferring a third time would make the deferral itself the habit.

There is also a clean window. Loop 032 closed with `verify` green and no product work in flight, so a
harness-only change can have a fence containing no `packages/*/src` product file at all — which is
the strongest form the plan-to-diff check can take.

## What "done" means

- [ ] A run of the loop in which `spec.md` names a file that `plan.md`'s fence excludes **fails a
      check**, naming both the file and the two artifacts, without anyone reading either document.
- [ ] That check, run against loop 030's committed `spec.md` and `plan.md`, reports the
      `snapshot.ts` contradiction. A check that cannot detect the defect that motivated it does not
      count as done.
- [ ] That check, run against every other committed loop in `sdlc/`, reports its result for each —
      and any further contradiction it finds is recorded, whether or not it is fixed here.
- [ ] `bun run verify` exits non-zero when the tree gains a lint warning that was not there before,
      and says which warning appeared.
- [ ] `bun run verify` still exits 0 on the current tree, which has 11 warnings — the gate is a
      budget, not a demand for zero.
- [ ] `bun run verify` exits non-zero — not silently greener — when a warning is *removed* without
      the budget being updated, so the recorded budget cannot rot upward-only.
- [ ] The budget survives `oxlint` reporting the same warnings in a different order, and survives
      unrelated edits that shift line numbers.
- [ ] The A12 acceptance criterion in future specs can cite a command instead of a procedure.

## Explicitly out of scope

- **Fixing any of the 11 existing warnings.** The budget records the tree as it is. Driving it to
  zero is a separate change with a separate fence, and mixing the two would make it impossible to
  tell whether the gate works.
- **Any change under `packages/*/src`** other than what a lint-budget fixture demands, and ideally
  not even that.
- **The unimplemented half of loop 030's spec** (`snapshot.ts:58-62`'s stale relabel). This loop
  builds the check that would have caught it; using the check to fix the defect is product work and
  belongs to a later loop. It stays on the open list.
- **Making the mutation-prediction discipline mechanical** (loop 032's A6, where predictions must
  name a specific `file:testname`). It is the obvious third gate and it is deliberately not here —
  two gates in one fence is already the limit of what a plan-to-diff audit can meaningfully police.
- **Adding new lint rules, or changing `oxlint`'s configuration.** The rule set is the rule set;
  this change only counts what it already reports.
- **The CI review workflow.** If the local gate fails, CI fails, because CI runs `bun run verify`.
  No workflow file needs to change for that to be true.

## Open questions

- **Where the spec-vs-fence check runs.** It could be a step inside `verify`, a Stage-3 obligation on
  the `sdlc-plan` skill, or a fourth subagent. Each has a different failure mode — a `verify` step
  runs on every commit including product ones where it is noise; a skill instruction is prose again,
  which is the exact thing this loop exists to stop being. Design decides, and must state the
  reasoning, because "it is written in the skill" is the failure pattern under repair here.
- **What counts as "a file the spec names".** A spec mentions paths in prose, in tables, in code
  fences and in rationale that explicitly argues *against* touching something. A check that flags
  every path-shaped token in `spec.md` will cry wolf on the first loop and be disabled by the
  second. Design must define the extraction precisely and state the false-positive rate measured
  across all 32 committed loops — not predicted.

---

**Next stage:** Design — run `/sdlc-spec 033-harness-gates` to turn this into `spec.md`.
