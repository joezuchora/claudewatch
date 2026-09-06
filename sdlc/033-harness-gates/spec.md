# Spec: two harness gates — spec-vs-fence, and a lint budget in `verify`

- **ID:** 033-harness-gates
- **Stage:** 2 — Design
- **Status:** accepted (revised after Stage 2 review)
- **Reads:** `sdlc/033-harness-gates/intent.md`
- **Date:** 2026-08-28

## Summary

Two rules currently enforced by a human reading a document become steps in `bun run verify`.

Both are **budgets**, not demands for zero. A budget records the tree as it is, fails when
something is added, and — this is the half that stops budgets rotting — fails when something is
removed without the record being updated in the same commit. The lint budget records **9 rows,
11 warnings**; 9 is the number the gate compares. The fence budget records the one known
spec-vs-fence contradiction, loop 030's, and the count of loops it cannot check.

The intent left two questions for this stage. Both are answered by measurement against all 32
committed loops, not by argument.

> **Revision note.** Every measured number below was re-run independently by the Stage 2 reviewer
> and **three of them were wrong in the first draft**. The most important: the draft claimed the
> rejected "match backticks anywhere" alternative yields *15 findings across 8 loops*. That number
> was lifted from a **different** experiment — the path-only variant — and was wrong even for that
> one. The corrected figure is **89 findings across 9 loops**. The conclusion survived; the number
> did not, and in this repo a published unmeasured number is itself the defect. Two more corrections
> are marked inline. The reviewer's full findings and their disposition are recorded in `review.md`.

## Behavior

### B1 — `scripts/fence-check.ts`: spec-vs-fence, over every committed loop

**The corpus is `git ls-files`.** Deterministic, gitignore-aware, never walks `node_modules` or
`dist`, and always emits forward slashes. Every path this check records or compares is
repo-relative POSIX; any `\` read from a tool's output is normalised to `/` before use. `SPEC.md`
§2.1 ships v1 on Windows 11 as well as Linux, and a `readdirSync` + `path.join` corpus makes **A2
fail on Windows** — every finding, loop 030's included, disappears because the fence test is a
`/`-suffix match. That is not a portability nicety; it is the check silently reporting all-clear.

For each `sdlc/<NNN>-<slug>/` that has **both** `spec.md` and `plan.md`:

**Extract the negative fence from `plan.md`.**

```
MARKERS      = ['Explicitly not touched', 'Not touched']
PARENTHETICAL= /\([^()]*\)/g          → replaced with a single space, flat (not nesting-aware)
SENTENCE_END = /\.(\s|$)/             → truncate before the period; the period is dropped
TOKEN        = /`([^`\n]+)`/g         → .trim(); line-bounded, so a token cannot span a newline
```

Take the paragraph beginning at the **earliest** index of any marker (not the latest — a plan
carrying two marker forms must be read from the first), ending at the first blank line. Operate on
the joined multi-line string, not line by line: loop 030's parenthetical **spans a newline**, and
per-line stripping would leave its contents in the fence. Then apply `PARENTHETICAL`, then
`SENTENCE_END`, then collect `TOKEN` matches. Triple-backtick fenced blocks inside the paragraph are
not special-cased; no committed fence contains one.

Both normalisations are load-bearing, each justified by a committed artifact:

- Loop 025's fence reads `` `SPEC.md` (impact assessed as none — §8.1's tree is illustrative and
  already omits `core-bridge.ts`) ``. `core-bridge.ts` is **not** fenced; without the parenthetical
  strip it becomes a false positive.
- Loop 020's fence is one path followed by three sentences of prose, one of which says `verify.ts`'s
  annotation **does** move. Without the sentence truncation, that is a false positive too.

I checked every token either rule drops across all 12 fence-bearing loops. None is a fence entry
that should have survived.

> **Correction (2 of 3).** The first draft's edge case said *"loop 030's fence contains `--debug`"*.
> It does not: `--debug` sits inside the parenthetical at `sdlc/030-cache-read-validation/plan.md:29`
> and rule 1 deletes it with its aside. Loop 030's final fence is exactly nine tokens —
> `packages/metrics`, `packages/vscode/src`, `snapshot.ts`, `client.ts`, `normalize.ts`, `main.ts`,
> `scripts/`, `.oxlintrc.json`, `CLAUDE.md`. The draft documented the behaviour of non-path fence
> tokens using an example that never reaches the fence.

> **Correction (3 of 3): three marker forms, not two.** The draft matched only `Explicitly not
> touched` and `Not touched, deliberately`, and concluded *"the convention starts at loop 020"* with
> **15** loops `UNCHECKABLE`. Loops 021 and 022 carry perfectly good fences under a third phrasing,
> `**Not touched:**` (`sdlc/021-verify-record-optout/plan.md:28`,
> `sdlc/022-duration-fingerprint/plan.md:20`). `Not touched` is a prefix of `Not touched,
> deliberately`, so the two-entry marker list above subsumes all three forms. Measured after the fix:
> **12 checkable, 13 `UNCHECKABLE`, 7 skipped** — still 1 finding, still zero false positives. The
> draft was about to enshrine a parser bug as a baselined constant, which would have made fixing it
> a gate failure. Loops 020–022 use three different phrasings; 024 onward settle on
> `Explicitly not touched`.

A loop whose `plan.md` matches no marker has **no machine-readable fence**: reported `UNCHECKABLE`,
never reported as passing.

**Extract what `spec.md` requires changed.** Take only lines matching `^#{2,4}\s` — the requirement
headings — and collect `TOKEN` matches from those lines. Loop 030's contradiction lives in a
heading: `### B3 — extractLastError's gate is KEPT, and relabelled`. Body prose is excluded, and
that exclusion is the whole difference between a usable check and one that fires 89 times.

Resolve each token:

- **Path-shaped** — matches `^(?:[\w./@-]+\/)?[\w.@-]+\.(ts|md|json|ya?ml|sh|ps1|js)$` — to every
  corpus file equal to it or ending in `/` + it. The non-`.ts` alternatives are not decoration:
  five committed fences name `SPEC.md` or `CLAUDE.md`, and *"the spec amends `SPEC.md §X`; the plan
  fences `SPEC.md`"* is plausibly the most likely future contradiction in this repo.
- **A bare identifier** the symbol index knows, to that symbol's defining file(s). Before lookup,
  strip a trailing call signature or return type: `parseJunitFailures(xml: string): FailedTest[]`
  → `parseJunitFailures`. Loops 020–022 write headings in that style exclusively, and without the
  strip every one of them resolves to nothing.
- Anything else is **unresolved** — see B2.

**The symbol index** scans corpus `.ts` files under `packages/` and `scripts/`, recursively,
excluding `packages/core/src/typefixtures/**`, for
`^export\s+(?:async\s+)?(?:abstract\s+class|function|const|let|class|interface|type|enum)\s+(\w+)`.

Typefixtures are excluded because they are deliberately broken files whose exports are noise, not
API — and because two symbols there are genuinely double-defined (`COLOURS` in
`array-missing-member` and `inert-empty-array`; `leaky` in `free-text-message` and
`payload-string`), inside a directory `sdlc/031-cache-read-completeness/plan.md` fences verbatim.
The draft asserted "no such case exists today"; two do.

**Multiple definitions.** When a symbol resolves to several files and any is under
`packages/core/src/`, core wins **over other `packages/*/src` files only** — those are surfaces
re-exporting core, per `CLAUDE.md`'s architecture rule, and without this rule `renderEvent` resolves
to `packages/vscode/src/statusbar-bridge.ts` and fires against loop 032's fence. A `scripts/*.ts`
definition is **kept as an independent candidate**, because `scripts/` is not a surface over core
and two real counterexamples exist: `scripts/verify.ts:20-25` documents at length that
`MAX_LINE_BYTES` is deliberately duplicated in `junit.ts` rather than imported, and `scripts/perf.ts`
has an unrelated `evaluate`. Under unqualified core-wins, a harness loop naming `MAX_LINE_BYTES`
whose plan fences `scripts/` — as loops 029–032 all do — would resolve to `telemetry.ts` and miss.
That is exactly the class of loop this gate exists for.

**A finding** is a spec-named target whose resolved file falls inside a fence entry, where "inside"
means equal to it, ending in `/` + it (a bare basename such as `snapshot.ts`), or starting with it
+ `/` (a directory such as `packages/metrics`). Trailing `/` and `/**` are stripped from fence
entries first.

### B2 — the fence baseline, and the silence it makes visible

Zero false positives across 12 loops is easy to achieve by checking almost nothing, so the check
must publish how much it does not understand. Measured at Stage 2, with loop 033 not yet
checkable: of **47** heading tokens, **26 resolved** and **21 did not**. **Amended at Stage 5**,
once loop 033's own `plan.md` and its two new scripts existed: **50** tokens, **28 resolve (56%)**,
**22 do not**. The Stage-3 plan predicted exactly this shift and named 22 before the files were
written; `sdlc/fence-baseline.json` is the authority. The unresolved ones cluster:

- **Type members** — `MetricEvent.payload`, `enterprise.utilizationPct`, `anomaly.fingerprint`, and
  the field names `fetchedAt`, `disabledReason`, `lastHttpStatus`, `normalizationWarnings`,
  `freshness`, `primaryUtilizationPct`. `MetricEvent.payload` is precisely what
  `sdlc/020-which-test-failed/plan.md:23` fences as *"the product-telemetry security boundary; this
  change must not widen it"*. Had loop 032 needed to widen it, this check would have been silent.
- **Non-exported or non-top-level symbols** — `doRefresh`, `refreshInFlight`, `malformedResponse`.
- **Flags and prose** — `--json`, `try`, `vscode`, `any`, `SPEC.md §12`, `⊙ error`.

`sdlc/fence-baseline.json` therefore records three things:

```
{ "uncheckable": 13,
  "unresolvedTokens": 22,
  "findings": [ { loop, specToken, file, fenceEntry, note } ] }
```

with exactly one finding: loop 030's `extractLastError` → `packages/core/src/snapshot.ts` against
fence entry `snapshot.ts`. Its `note` records that loop 031 commit 2 implemented the missing half
and that loop 030's `review.md:220` is stale — the finding is retained because the 030 artifacts are
immutable and the contradiction between them is permanent, not because the defect is open.

The check exits non-zero when the finding set, the `uncheckable` count, or the `unresolvedTokens`
count differs from the baseline, **in either direction**, and prints the symmetric difference.
Baselining `unresolvedTokens` converts a silent 44% miss rate into a ratcheted number: the next loop
that writes a heading the check cannot read shows up as a delta rather than as silence.

The **skipped** count is reported but **not** asserted. A loop mid-flight has `spec.md` and no
`plan.md` and is skipped; asserting it would make `verify` red for the first two commits of every
future loop, including this one right now.

Closing the type-member gap — indexing interface and type members, so `MetricEvent.payload`
resolves — is the obvious next increment and is **not** in this loop. It is recorded here so the
next harness loop inherits a measurement rather than a hunch.

### B3 — `scripts/lint-budget.ts`: the lint warning budget

Runs `oxlint --format=json` and reads `diagnostics[]`. For each entry with `severity === "warning"`,
key on **`code` + `filename` + `message`**, and count.

- **Line and column are excluded**: an unrelated edit shifts them, and the intent requires the
  budget to survive that.
- **`message` is included.** The draft omitted it, which reopened the hole its own "Rejected
  alternatives" closes one level down: with a `code` + `filename` key, a warning swapped for a
  *different* warning of the same rule in the same file leaves the count unchanged and is invisible.
  The historical hand procedure (`sdlc/031-cache-read-completeness/plan.md:162`) diffed full oxlint
  lines, messages included; a message-free key is strictly weaker than what it replaces.
- **`count` is still needed**, because messages do collide: both `unicorn(no-array-sort)` in
  `packages/metrics/src/anomaly.ts` and both `unicorn(prefer-array-find)` in
  `packages/core/src/call-sites.test.ts` carry identical messages.
- A rename that appears in a message (``Function `spool` does not capture…``) is a budget change.
  That is correct — it is a different warning — and it is a one-line edit in the same commit.

Rows are sorted by key before comparison; `oxlint`'s emission order is not stable across runs on an
identical tree. Measured with the message in the key: **9 rows, 11 warnings** — unchanged from the
message-free key, so this costs nothing today and closes the hole.

| count | code | filename |
|---|---|---|
| 1 | `eslint(no-shadow)` | `packages/core/src/security.test.ts` |
| 1 | `eslint(no-useless-concat)` | `packages/metrics/src/agent.test.ts` |
| 1 | `oxc(no-map-spread)` | `packages/metrics/src/anomaly.test.ts` |
| 1 | `unicorn(consistent-function-scoping)` | `packages/core/src/call-sites.test.ts` |
| 1 | `unicorn(consistent-function-scoping)` | `packages/core/src/format.test.ts` |
| 1 | `unicorn(consistent-function-scoping)` | `packages/core/src/security.test.ts` |
| 1 | `unicorn(no-array-sort)` | `packages/metrics/src/agent.ts` |
| 2 | `unicorn(no-array-sort)` | `packages/metrics/src/anomaly.ts` |
| 2 | `unicorn(prefer-array-find)` | `packages/core/src/call-sites.test.ts` |

**Errors are unaffected.** `oxlint` already fails `verify` on any error, and because `verify`
short-circuits on the first failing step, a lint error stops the run before `lint-budget` parses
anything. The budget governs warnings only.

#### B3.1 — the removal direction, and why it needs guardrails

Failing on removals is not decoration on the addition check; it is what makes a per-file count key
sound at all. Remove one `unicorn(no-array-sort)` from `anomaly.ts` and introduce a different one in
the same file, and an upward-only budget sees the same count before and after.

But the cost is real and the draft did nothing about it: a cleanup commit that *fixes* a warning
fails `verify`, and the only way to green is to edit `.oxlint-budget.json`. Editing that file thus
becomes the trained response to a `lint-budget` failure — and the response is identical whether the
delta was a fix or a regression. That is the reflex this gate exists to prevent, relocated one file
over. Two guardrails, specified as behavior:

1. **No silent regenerate.** There is **no** `--write` flag. The failure output *is* the corrected
   table, formatted for copy-paste. A flag that rewrites the file without showing what it rewrote
   turns the gate into a formality.
2. **Asymmetric wording**, so a reviewer scanning a `.oxlint-budget.json` diff can tell the two
   directions apart:
   - added → `lint-budget: NEW WARNING  <code>  <file>  <message>`
   - removed → `lint-budget: 1 fewer <code> in <file> — if you fixed it, update .oxlint-budget.json in this commit`

### B4 — both wired into `verify`

`scripts/verify.ts`'s `STEPS` gains two entries, after `lint` and before `test`:

```ts
{ name: 'lintBudget', cmd: ['bun', 'run', 'scripts/lint-budget.ts'] },
{ name: 'fenceCheck', cmd: ['bun', 'run', 'scripts/fence-check.ts'] },
```

Direct script paths, so no new `package.json` scripts are needed. Step names are **camelCase, not
hyphenated**: `scripts/verify.ts:136` writes `payload[\`${s.name}Ms\`]` into the metrics spool, and
a hyphenated name yields the payload key `lint-budgetMs`. `stepCount` goes 5 → 7. Both values stay
numeric, so `REVIEW.md`'s payload rule and `SPEC.md` §17 are satisfied.

Placement is deliberate: `lintBudget` re-runs `oxlint` so it belongs beside `lint`, and putting both
after `lint` is what makes "errors are unaffected" true rather than aspirational. Measured cost:
`oxlint --format=json` 82/88/89 ms, the fence walk 57/57/59 ms, plus one Bun cold start each. On a
13.8 s gate that is under 2%.

**`verify:plain`** (`typecheck && lint && test && build`) is documented at `scripts/verify.ts:8` as
the bare chain for environments without the metrics spool. It **does not** gain the gates, and that
is a decision, not an oversight: it exists to be minimal. `CLAUDE.md` says CI runs `bun run verify`,
which it does, so the gates run in CI.

### B5 — the checks must be seen to fail

`fence-check.ts` exports the pure seams `checkLoop(loop, specMd, planMd, index, corpus)`, returning
`{ findings, unresolved } | null` with `null` as the `UNCHECKABLE` channel, and
`compareToBaseline(actual, baseline): string[]`, which carries the four ways the gate fails so each
one has a test. `buildIndex(corpus, read = readFileSync)` takes an injectable reader so fixtures
need no files on disk. The CLI is a thin wrapper that walks `sdlc/`. `lint-budget.ts` exports
`diffBudget(actual: Row[], budget: Row[]): { added: Row[]; removed: Row[] }` and a pure
`rowsFrom(diagnostics: Diagnostic[]): Row[]`. Both test files drive those functions over fixture
inputs — no fixture directories under `sdlc/`, no dependence on the live tree:

- A fixture spec/plan pair with a seeded contradiction → detected, message naming file and fence
  entry.
- Two **near-misses** → not detected: one where the spec names a symbol only in body prose, one
  where a heading names a file the fence does not cover. A check that fires on these gets disabled
  by its third loop.
- A fixture where the parenthetical strip is what prevents the hit, and one where the sentence
  truncation is — so each normalisation has a test that fails without it.
- A fixture corpus using `\` separators → same findings as with `/`.
- A fixture `oxlint` payload with one warning added, one removed, one whose line moved, and one
  whose *message* changed while code and filename held → the first, second and fourth fail, the
  third passes.

This is loop 032's rule applied to the gates themselves: a check that has never been seen to fail
has not been tested.

## Data and types

- `.oxlint-budget.json` — `Array<{ code: string; filename: string; message: string; count: number }>`,
  sorted by the composite key.
- `sdlc/fence-baseline.json` — `{ uncheckable: number; unresolvedTokens: number; findings:
  Array<{ loop: string; specToken: string; file: string; fenceEntry: string; note: string }> }`.
- No `any`. Both files are parsed and **validated**, not `as`-asserted; `docs/audit-report.md`
  already carries `JSON.parse … as` as a standing informational finding.

## Edge cases

Failure classes, each with a stated outcome:

- **Either JSON file missing** → **fail**, with the message naming the file and saying to create it
  from the failure output. Never bootstrap silently: a first run that writes its own baseline
  records whatever is broken at that moment as correct.
- **Either JSON file malformed** (truncated write, conflict markers) → **fail loudly**. This is the
  opposite of the product cache idiom in `SPEC.md` §9.6 (corruption → delete and refetch), and
  deliberately so: a gate that heals its own record is not a gate.
- **`oxlint` emits no `diagnostics` key**, or the spawn fails → **fail**, distinguished in the
  message from a clean tree. An empty set would silently "improve" the budget to zero.
- **`diagnostics` present but empty** → fail as 11 removals. Correct: the tree has 11 warnings.
- **A diagnostic with no `code`** → fail with a message naming the file, rather than keying on
  `"undefined"`.
- **A loop directory missing `spec.md` or `plan.md`** (seven today: `004`, `015`–`019`, and `033`
  until its own plan lands) — skipped, not `UNCHECKABLE`. They are incidents and follow-ups, not
  designs.
- **A fence paragraph whose scope is stated in prose, unbackticked** —
  `sdlc/026-mock-topology-guard/plan.md:31` fences *"every existing source and test file"*. The
  check sees four tokens and reports 026 as passing. This is a real hole in the "never reported as
  passing" guarantee, which only fires when the paragraph is *absent*. Recorded, not fixed;
  detecting it needs a structured fence, which the Rejected alternatives explain is deferred.
- **A fence entry naming a file that does not exist** — matches nothing, silently. Reported as a
  warning line, not a failure: fixing historic fences is out of scope.
- **A fence entry that survives normalisation but is not a path** — matches no corpus file and
  produces no finding. None exists today.

## Backward compatibility

- No product code changes. Nothing under `packages/*/src` is touched.
- **`oxlint` is pinned to an exact version** (`1.80.0`, dropping the `^`) in the same commit as the
  budget. `.oxlintrc.json` enables whole categories (`correctness: error`, `suspicious: warn`,
  `perf: warn`), so a minor release that adds or renames a rule changes the warning set with **no
  diff to this repo** — and under the both-directions comparison that is an immediate `verify`
  failure for every contributor and for CI, blaming a rule nobody touched. Pinning makes a version
  bump a deliberate act that regenerates the budget. The intent puts *changing `.oxlintrc.json`*
  out of scope; pinning a dependency version is not that, and shipping the gate unpinned would make
  its first field failure a spurious one.
- `verify` gains two rows in its timing line and two JUnit step entries; nothing consumes step names
  by position.
- The 11 existing warnings stay. This change fixes none of them.
- Loop 030's contradiction stays in the baseline, annotated.

## Acceptance criteria

- [ ] **A1** — `bun run verify` exits 0 on the current tree, with `lintBudget` and `fenceCheck` in
      its step list.
- [ ] **A2** — `fence-check` over the committed `sdlc/` tree reports exactly one finding: loop 030's
      `extractLastError` → `packages/core/src/snapshot.ts`. Evidence: the command's own output
      pasted into `review.md`.
- [ ] **A3** — the same run reports **zero** findings for the other **twelve** checkable loops
      (13 checkable in total, loop 033 included) and **13** `UNCHECKABLE`, both asserted against the
      baseline. Checkable and skipped counts are printed, not asserted.
- [ ] **A4** — `unresolvedTokens` is **22**, asserted against the baseline, and the run prints the
      per-loop unresolved list. The Stage-2 draft said 21, measured before loop 033 was itself
      checkable; the plan predicted the correction and the tool confirmed it.
- [ ] **A5** — seeding a twelfth lint warning makes `verify` exit non-zero with a message naming the
      rule, the file and the message. Evidence: the seeded diff and the failure output.
- [ ] **A6** — deleting one of the 11 warnings without updating `.oxlint-budget.json` also makes
      `verify` exit non-zero, with the asymmetric "1 fewer" wording of B3.1.
- [ ] **A7** — swapping one warning for a different warning of the **same rule in the same file**
      is detected. This is the criterion the message-free key would have failed.
- [ ] **A8** — the seeded-contradiction fixture is detected; both near-miss fixtures are not; each
      normalisation has a fixture that fails without it. Named tests, one per claim.
- [ ] **A9** — reordering `oxlint`'s output does not change the outcome, asserted over a fixture
      payload rather than by re-running and hoping. A fixture corpus with `\` separators yields the
      same findings as `/`.
- [ ] **A10** — **mutation predictions name a specific `file:testname` before the mutation runs**,
      per loop 032's finding, and cover one **rule** each rather than one guard: the parenthetical
      strip, the sentence truncation, the earliest-marker choice, the heading filter, the trailing
      signature strip, core-wins-over-surfaces, scripts-as-independent, the message key, and the
      removal direction of each budget.
- [ ] **A11** — `.oxlint-budget.json` as committed is byte-identical to B3's nine rows, and `verify`
      exits 0. **The two new scripts add zero warnings** — use `toSorted()`, and hoist helpers to
      module scope. This is the criterion the draft's A9 failed to state: an implementer could have
      satisfied "no new warning" by adding their new warning to the budget file.
- [ ] **A12** — the plan-to-diff audit reports no file outside the fence, and the fence contains no
      file under `packages/*/src`. **The fence must not contain `scripts/`** — loops 029–032 all
      fence it as house style, and this loop adds two files there, so copying that style would make
      `fence-check` fail on its own loop.
- [ ] **A13** — `fence-check` run against this loop's own `spec.md` and `plan.md` produces zero
      findings. A gate that fails its own loop is not shippable. Expected to pass because this
      spec's only path-shaped heading tokens are `scripts/fence-check.ts` and `scripts/lint-budget.ts`,
      and A12 keeps `scripts/` off the fence — recorded as the reason, so it is a constraint rather
      than luck.

## Rejected alternatives

**Path-only matching in `spec.md`.** Measured: it does **not** detect loop 030's contradiction,
because loop 030's spec never writes the string `snapshot.ts` — it names `extractLastError`, and the
file is where that symbol lives. A path-only check would have shipped, passed, and missed the one
defect it was built for. Symbol resolution is the requirement, not a refinement.

**Matching backticks anywhere in `spec.md`.** Measured over the corpus and markers specified above:
**89 findings across 9 of the 12 checkable loops** (020:2, 024:6, 025:15, 027:20, 028:14, 029:8,
030:5, 031:5, 032:14). Spot-checking loop 029's — `writeCache`, `LastErrorInfo`, `buildTooltip`,
`formatTooltip` — every one is descriptive data-flow prose, several arguing that the file should
*not* be touched. A hit rate near 1-in-89 is a check nobody keeps. Restricting to requirement
headings takes it to **1 finding across 12 checkable loops with zero false positives**, and that
result held when the corpus widened from `.ts`-only to all of `git ls-files`, when the marker list
gained a third form and two more loops, and when `scripts/` definitions stopped losing to core.

**Requiring a structured fence block going forward, and checking only new loops.** Cleaner to parse,
and it fails the intent's second done-criterion outright: it could not run against loop 030's
committed artifacts, so the check would never have been seen to catch the defect that justified it.
Reconsider once the prose parser has a false positive in the field, or to close the unbackticked-
prose-fence hole in Edge cases.

**Rewriting the old plans to a structured fence.** Rejected on principle. A committed artifact is
the record of what was decided at the time; editing 22 of them to suit a checker written three loops
later destroys the evidence the loop exists to produce. The same reasoning is why loop 030's
`review.md` is not amended here.

**Running `fence-check` only on the loop in flight.** Needs a notion of "current loop" — a state
file, or an argument someone remembers to pass. Running over everything is cheap, stateless, and
turns a regression in an old artifact into a failure rather than a silence.

**A count-only lint budget (`warnings <= 11`).** Fails loop 032's case exactly: two of the five
regressions swapped one warning for another, and a count would have stayed at 11 and passed.

**An upward-only budget (fail on additions, ignore removals).** Rejected — see B3.1. Without the
removal direction the per-file key is trivially defeated by a same-rule same-file swap.

---

**Next stage:** Build — run `/sdlc-plan 033-harness-gates` to turn this into `plan.md`.
