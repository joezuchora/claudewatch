# Plan: two harness gates — spec-vs-fence, and a lint budget in `verify`

- **ID:** 033-harness-gates
- **Stage:** 3 — Build
- **Reads:** `sdlc/033-harness-gates/spec.md`
- **Date:** 2026-08-28

## Scope fence

Eleven paths — counted against the table, not asserted. The table below has **eleven** rows.

| Path | Change | Criterion |
|---|---|---|
| `scripts/fence-check.ts` | **new** — B1's parser, resolver and CLI; exports `checkLoop` | A2, A3, A4, A13 |
| `scripts/fence-check.test.ts` | **new** — B5's fixture pairs, both near-misses, both normalisations, the `\` corpus | A8, A9 |
| `scripts/lint-budget.ts` | **new** — B3's key, sort and both-directions diff; exports `rowsFrom`, `diffBudget` | A5, A6, A7 |
| `scripts/lint-budget.test.ts` | **new** — B5's fixture payloads: added, removed, line-moved, message-changed, reordered | A5, A6, A7, A9 |
| `.oxlint-budget.json` | **new** — B3's nine rows, generated then committed | A11 |
| `sdlc/fence-baseline.json` | **new** — B2's one finding, `uncheckable: 13`, `unresolvedTokens: 21` | A2, A3, A4 |
| `scripts/verify.ts` | B4's two `STEPS` entries, `lintBudget` and `fenceCheck`, after `lint` | A1 |
| `package.json` | pin `oxlint` to `1.80.0` (drop the `^`) | Backward compatibility |
| `CLAUDE.md` | the "two things it does not check for you" list loses the lint half and gains what the gates now cover | — |
| `sdlc/033-harness-gates/plan.md` | this file | — |
| `sdlc/033-harness-gates/review.md` | Stage 5 | all |

**Explicitly not touched:** `packages/core`, `packages/statusline`, `packages/vscode`,
`packages/metrics`, `SPEC.md`, `REVIEW.md`, `.oxlintrc.json`, `.github/workflows`, `scripts/env.ts`,
`scripts/junit.ts`, `scripts/perf.ts`, `scripts/mock-topology.ts`, and the tests beside those four.
The shell and PowerShell helpers under `scripts` are untouched as well.

> **The fence must not contain the token `scripts/`, and the first draft of it did.** Loops 029–032
> all fence `scripts/` as house style. This loop adds four files there, so that entry would make
> `fence-check` report a finding against its own loop — spec heading `` `scripts/fence-check.ts` ``
> inside fence entry `scripts/` — and A13 would fail.
>
> The first version of this paragraph tried to have it both ways, writing *"every existing file
> under `scripts/` other than `verify.ts`"*. **Measured against the real extractor** (commit
> `f30f20a`), that paragraph yields ten tokens including **`scripts/`** and **`verify.ts`** — the
> one entry the plan forbids, and the one script the plan actually changes, fenced. The prose said
> the opposite of what the parser reads.
>
> Two things follow. The exclusion is now enumerated file-by-file with no bare directory and no
> exception clause. And the parser has a real limitation to record: **a fence sentence of the form
> "everything under X except Y" inverts both terms** — X is read as fenced when it is not, and Y is
> read as fenced when it is the change itself. `spec.md`'s Edge cases gain this at Stage 5; it is
> not fixed here, because "except" phrasing is open-ended and the fix belongs with the structured
> fence that the Rejected alternatives already defer.
>
> This is the first time the gate has constrained the plan that builds it, and it constrained it by
> catching a mistake I had written one paragraph after warning myself about it. That is the point
> of A13.

> **Fence amended during implementation (2026-08-28).** Two paths were added, both forced by
> `scripts/env.test.ts` going red — the sandbox from loop 021 that spawns the real `verify.ts`
> against a temp directory.
>
> The plan said the two steps would be invoked as `['bun', 'run', 'scripts/lint-budget.ts']`,
> *"direct script paths, so no new `package.json` scripts are needed"*. That is wrong, and the
> sandbox is what proved it: `makeFixture` stubs **every step by script name** in a fixture
> `package.json`, so a step named by a repo-relative path cannot be stubbed and all four of loop
> 021's cases exited 1. The steps are now package scripts, which means:
>
> - `package.json` — gains `lintBudget` and `fenceCheck` alongside the `oxlint` pin. Same file the
>   fence already listed, wider change than it described.
> - `scripts/env.test.ts` — **was on the negative fence** ("the tests beside those four") and is
>   now changed: two `noop` entries in the fixture's script list. This is a real fence violation,
>   recorded rather than quietly absorbed, and unavoidable — the alternative is a gate that
>   silently skips a step whose script is missing.
>
> **Twelve distinct paths, not eleven — and not thirteen.** The first version of this amendment
> said thirteen by counting `package.json` twice: it was already row 8, and widening an
> already-fenced file is not a new path. `scripts/env.test.ts` is the only genuinely new one.
> The Stage 5 audit caught the arithmetic; the fence was honest about *what* it permits.

**On `sdlc/README.md`:** Stage 6's retrospective is written after `review.md` and is not in this
fence. It lands in its own commit, as every prior loop's has.

## Changes

### 1. `scripts/lint-budget.ts` + test (first, because it is the simpler gate)

```ts
export interface Row { code: string; filename: string; message: string; count: number }
export function rowsFrom(diagnostics: readonly Diagnostic[]): Row[]
export function diffBudget(actual: readonly Row[], budget: readonly Row[]):
  { added: Row[]; removed: Row[] }
```

`rowsFrom` filters `severity === 'warning'`, normalises `\` → `/` in `filename`, keys on
`code`/`filename`/`message`, counts collisions, and returns rows **sorted by the composite key**
using `toSorted()` — never `Array#sort()`, which is one of the two rules `intent.md` blames for all
five historic regressions.

`diffBudget` compares by the same key and reports a count change as one `added` and one `removed`
row, so the asymmetric wording of B3.1 falls out of one code path.

The CLI spawns `oxlint --format=json`, reads `.oxlint-budget.json`, validates both (no `as`), and on
any difference prints the B3.1 messages followed by the corrected table, then exits 1. **No `--write`
flag.**

Every helper is declared at module scope. `unicorn(consistent-function-scoping)` is the other rule
behind the five regressions, and a gate that trips the rule it enforces is not shippable (A11).

### 2. `.oxlint-budget.json`

Generated by running the new CLI's own `rowsFrom` over the current tree, then committed verbatim.
Expected: the nine rows in `spec.md` B3, 11 warnings. If the generated file disagrees with the spec's
table, the spec is wrong and gets corrected — the table was measured, so a disagreement means the
key changed.

### 3. `package.json`

`"oxlint": "^1.80.0"` → `"oxlint": "1.80.0"`. One character, and without it the gate's first field
failure will be a spurious one on a rule nobody touched.

### 4. `scripts/fence-check.ts` + test

Structured as four pure functions plus a thin CLI, so B5's seam is real rather than claimed:

```ts
export function extractFence(planMd: string): string[] | null   // null = UNCHECKABLE
export function headingTokens(specMd: string): string[]
export function buildIndex(corpus: readonly string[]): SymbolIndex
export function checkLoop(specMd: string, planMd: string, index: SymbolIndex,
                          corpus: readonly string[]): { findings: Finding[]; unresolved: string[] }
```

The CLI gets the corpus from `git ls-files`, walks `sdlc/`, aggregates, compares against
`sdlc/fence-baseline.json`, and prints the per-loop unresolved list whether or not it fails.

The six regexes are taken verbatim from `spec.md` B1 and defined as module-scope constants with the
spec section in a comment beside each, so the audit can compare them character by character.

Order of operations inside `extractFence`, which the spec fixes and which three of the mutations
target: earliest marker index → slice to first blank line → strip parentheticals **on the joined
string** → truncate at first sentence end → collect tokens.

### 5. `sdlc/fence-baseline.json`

Written from the CLI's own output, then hand-checked against `spec.md` B2: one finding,
`uncheckable: 13`, `unresolvedTokens: 21`. The finding carries the `note` recording that loop 031
closed the underlying defect and loop 030's `review.md` is stale.

### 6. `scripts/verify.ts`

Two entries into `STEPS` after `lint`, exactly as B4 gives them. Nothing else in the file changes —
`runStep`, the JUnit path and the metrics payload all take the new steps without modification, which
is worth confirming rather than assuming (`scripts/verify.ts:136` builds payload keys from
`s.name`, hence the camelCase names).

### 7. `CLAUDE.md`

The "Two things it does not check for you" list is now wrong in one half: the lint budget **is**
checked. Item 2 is narrowed to the plan-to-diff audit proper, with a sentence noting that
`fence-check` covers the spec-to-plan direction and the auditor still covers plan-to-diff. The VS
Code bundle item is untouched.

## Test mapping

| Test | Asserts | Criterion |
|---|---|---|
| `lint-budget.test.ts` — `rowsFrom` counts message collisions | two identical-message warnings in one file → one row, `count: 2` | A11 |
| `lint-budget.test.ts` — a new warning is `added` | seeded twelfth diagnostic | A5 |
| `lint-budget.test.ts` — a deleted warning is `removed` | one of eleven dropped | A6 |
| `lint-budget.test.ts` — **same rule, same file, different message** | one `added` **and** one `removed` | **A7** |
| `lint-budget.test.ts` — a moved line is not a difference | line/column changed only | A9 |
| `lint-budget.test.ts` — reordered diagnostics are not a difference | same set, shuffled | A9 |
| `lint-budget.test.ts` — backslash filenames normalise | `packages\core\…` keys as `packages/core/…` | A9 |
| `fence-check.test.ts` — the seeded contradiction is found | fixture pair, heading names a fenced symbol | A8 |
| `fence-check.test.ts` — a symbol named only in body prose is not found | near-miss 1 | A8 |
| `fence-check.test.ts` — a heading naming an unfenced file is not found | near-miss 2 | A8 |
| `fence-check.test.ts` — the parenthetical strip prevents a hit | fixture where the aside names a file | A8 |
| `fence-check.test.ts` — the sentence truncation prevents a hit | fixture with prose after the list | A8 |
| `fence-check.test.ts` — the earliest marker wins | plan carrying two marker forms | A10 |
| `fence-check.test.ts` — a trailing signature is stripped before lookup | `f(x: string): T` heading | A8 |
| `fence-check.test.ts` — core wins over a surface re-export | symbol in core + `packages/*/src` | A8 |
| `fence-check.test.ts` — a `scripts/` definition is an independent candidate | symbol in core + `scripts/` | A8 |
| `fence-check.test.ts` — a `\` corpus yields the same findings | Windows separators | A9 |
| `fence-check.test.ts` — no marker means `UNCHECKABLE`, not pass | plan with no fence paragraph | A3 |
| `fence-check.test.ts` — the live tree matches the baseline | one finding, 13 uncheckable, 21 unresolved | A2, A3, A4 |

## Risks

- **The baseline numbers move under me.** `unresolvedTokens: 21` counts tokens in *this loop's own*
  spec too once `plan.md` exists — 033 becomes checkable, adding its heading tokens to the corpus.
  I have measured 21 with 033 skipped. **This must be re-measured after `plan.md` is committed and
  before the baseline is written**, and the difference recorded in `review.md` rather than
  silently absorbed. Predicted: 033 contributes 0 unresolved (its three heading tokens are two
  paths that will exist and `verify`, which is not a symbol) and 0 findings, so 21 and 13 should
  hold with checkable going 12 → 13. If that prediction is wrong the spec's A3/A4 numbers change
  and the spec gets amended, not the measurement.

  > **Measured immediately after committing this file: the prediction was wrong.** Findings held at
  > 1 and checkable went 12 → 13 as predicted, but `unresolvedTokens` went **21 → 24**, not 21. The
  > reason is timing, not resolution: at Stage 3 `scripts/fence-check.ts` and `scripts/lint-budget.ts`
  > **do not exist yet**, so all three of this loop's heading tokens are unresolved. The prediction
  > described the world after Stage 4 and was checked against the world at Stage 3.
  >
  > Revised prediction for the committed baseline, written before the files exist: once Stage 4
  > lands both scripts, 033 contributes exactly **1** unresolved (`verify`, which is not a symbol
  > and never will be), giving `unresolvedTokens: 22`, `uncheckable: 13`, `checkable: 13`, one
  > finding. `spec.md` A4 says 21 and will need amending to 22 at Stage 5 — recorded here so the
  > amendment is traceable to a measurement rather than appearing in the spec unexplained.
  >
  > The general lesson, and it is the same one loop 032 closed on: **a number measured at one stage
  > of the loop is not the number the next stage will see.** The baseline is written at Stage 4, so
  > it must be measured at Stage 4.
- **`git ls-files` in a shallow CI checkout.** CI clones the repo; `git ls-files` reads the index,
  not history, so depth does not matter. Confirmed by the fact that `verify` already runs git-free
  steps — but the first CI run is the real check, and A1 is not met until CI is green.
- **The two new scripts trip the two rules the budget exists to catch.** Handled by construction
  (`toSorted()`, module-scope helpers) and caught by A11 either way. This risk is listed because it
  has fired in four consecutive loops.
- **Fixture `.ts` files would pollute the symbol index.** Avoided entirely: fixtures are string
  literals inside the test files, not files on disk. The spec's edge case about
  `scripts/fixtures/fence/` is therefore moot and should be dropped from `spec.md` at Stage 5 if it
  survives — noted rather than edited now, so the audit sees the discrepancy.

## Out of scope, recorded

- Indexing type members so `MetricEvent.payload` resolves (spec B2 names it as the next increment).
- The unbackticked-prose-fence hole in loop 026.
- Fixing any of the 11 existing warnings.
- Amending loop 030's stale `review.md`, and the general policy on amending historic artifacts.

---

**Next stage:** Build/Test — run `/sdlc-implement 033-harness-gates`.
