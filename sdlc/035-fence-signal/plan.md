# Plan: stop counting what can never be counted

- **ID:** 035-fence-signal
- **Stage:** 3 — Build
- **Reads:** `sdlc/035-fence-signal/spec.md`
- **Date:** 2026-08-29

## Scope fence

Four paths. **The fourth was added at Stage 5 after the plan-to-diff audit reported FENCE VIOLATED**
— the same correction loop 034's plan made for the same reason. The first three are the point: the
spec declined the intent's index widening, so nothing in `packages/` moves and no product code is
touched.

| Path | Change | Criterion |
|---|---|---|
| `scripts/fence-check.ts` | `indexScripts`, `classifyToken`, `TokenClass`; `resolveSymbol`'s two fallbacks; `checkLoop`'s sixth parameter and split return; `Baseline.unresolvedSymbols`; `parseBaseline`, `compareToBaseline`, `main`; the `HEADING` docstring | A2–A10, A12 |
| `scripts/fence-check.test.ts` | six classifier tests, the two resolution-rule suites, the invariant, and the four sites the rename breaks | A2–A10 |
| `sdlc/fence-baseline.json` | `unresolvedTokens: 25` → `unresolvedSymbols: 14` | A3, A9 |
| `sdlc/035-fence-signal/spec.md` | **added at Stage 5.** Four measurement headings rewritten to prose; `UNRESOLVED` restored to B3's; the disclosure corrected | A3, A12 |

**Explicitly not touched:** `scripts/verify.ts`, `scripts/lint-budget.ts`, `scripts/spool-path.ts`,
`scripts/junit.ts`, `scripts/env.ts`, `scripts/perf.ts`, `scripts/mock-topology.ts`,
`packages/core/src/telemetry.ts`, `packages/core/src/cache.ts`, `packages/core/src/types.ts`,
`packages/core/src/snapshot.ts`, `packages/vscode/src/extension.ts`, `packages/metrics/src/agent.ts`,
`.oxlintrc.json`, `.oxlint-budget.json`, `SPEC.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `REVIEW.md`.

> **No bare `scripts/` and no bare `packages/…` directory entry**, the lesson loops 033 and 034 both
> paid for. Every exclusion is a named file. There is no `except` clause anywhere in this fence.

> **`package.json` is deliberately absent from the fence, in both directions.** It is not changed —
> `verify`, `perf`, `lintBudget` and `fenceCheck` are already declared there, which is exactly why
> Rule 3 needs no manifest edit. Naming it on the *negative* fence would still be a trap in principle:
> `inFence` matches a basename tail, so the entry would cover all five committed manifests. Leaving it
> off both sides does mean it is now a runtime input to the gate with no fence protection; recorded.
>
> **This paragraph originally also justified rewriting the spec's headings, and that justification was
> wrong.** The audit established that `package.json` produced zero findings either way, because the
> fence never named it — the trap existed only in a counterfactual. The rewrite's real effect was on
> `name:` and `UNRESOLVED`, which have nothing to do with manifests, and it lowered the baselined
> number from 15 to 13. `UNRESOLVED` has been restored and the number is **14**. The full correction
> is in the spec's *A note on this spec's own headings*.

**On `sdlc/README.md`:** Stage 6's retrospective lands in its own commit after `review.md`, as every
prior loop's has, and is not in this fence.

## Changes

### 1. `scripts/fence-check.ts` — `indexScripts` (new export)

```ts
const SCRIPT_TARGET = /([\w./@-]+\.(?:ts|sh|ps1|js))\b/;

export function indexScripts(
  packageJsonText: string,
  corpus: readonly string[],
): ReadonlyMap<string, string>
```

Parses the manifest, walks `scripts`, takes the **first** matching path in each command, and keeps
the entry only if `toPosix`-normalised it is present in the corpus. A script whose command names no
file (`"lint": "oxlint"`, `"build": "bun run --filter …"`) contributes nothing; a script naming an
untracked file contributes nothing. Validated, not `as`-asserted — `parseBudget` and `parseBaseline`
already establish the house rule and `docs/audit-report.md` carries `JSON.parse … as` as a standing
finding.

Failure mode is deliberately **empty map, not throw**: a repository without a manifest is a
repository where this rule finds nothing, which is correct, and a gate that dies on a missing
optional input is worse than one that resolves less.

### 2. `scripts/fence-check.ts` — `resolveSymbol` gains two fallbacks

```ts
function resolveSymbol(token, index, scripts): readonly string[] {
  const direct = index.get(token) ?? index.get(bareSymbol(token)) ?? [];
  if (direct.length > 0) return prefer(direct);        // unchanged path
  const s = scripts.get(token) ?? scripts.get(bareSymbol(token));
  if (s !== undefined) return [s];                      // Rule 3
  const b = bareSymbol(token);
  if (DOTTED.test(b)) {
    const owner = index.get(b.slice(0, b.indexOf('.')));
    if (owner) return prefer(owner);                    // Rule 4
  }
  return [];
}
```

Three things this ordering buys, each of which A10 mutates:

- **Fallbacks only.** The existing index wins outright, so no finding that exists today can move.
  A4 is the criterion that proves it, and it is the reason the two rules are safe to add in one
  commit rather than two.
- **Raw before `bareSymbol` in the script lookup.** `bareSymbol` truncates at `:`, which would
  destroy `verify:plain` and `metrics:ship`. The symbol lookup has the opposite preference for the
  opposite reason, and both are now explicit rather than incidental.
- **`DOTTED` is anchored and identifier-segmented**, `^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$`, so
  `SPEC.md §12` (space) and `⊙ error` never reach it, and `response.json()` reaches it only after the
  signature strip, where its prefix `response` is absent from the index.

`prefer()` is the existing core-wins/scripts-kept ordering, extracted so both the direct path and
Rule 4 use one implementation rather than two readings of the same rule.

### 3. `scripts/fence-check.ts` — `classifyToken` (new export)

```ts
export type TokenClass = 'unresolved' | 'not-a-symbol';
export function classifyToken(token: string): TokenClass;
```

Applied to `bareSymbol(token)` throughout, in the spec's B2 order: flag prefix → env-var shape →
keyword set → identifier shape. `RESERVED` and `TYPE_KEYWORDS` are two separate frozen sets, not one
merged constant, because the spec's claim is that they come from two different languages and a merged
set makes that unauditable.

`ENV_VAR = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/` — the underscore is required, and the docstring records
why (`MARKERS`, `HEADING`, `TOKEN`, `EXPORTED` in this very file would otherwise be called
"not a symbol") and what it still misses (`PATH_RE` has an underscore and is still swallowed).

### 4. `scripts/fence-check.ts` — `checkLoop` and the report

`scripts` becomes a **required** sixth parameter, not an optional one with an empty default. There
are four call sites in total, so the churn is trivial, and a required parameter turns "`main` forgot
to wire the script map" into a typecheck failure. An optional one turns it into a silently smaller
number — the exact failure class this loop exists to remove.

Return becomes `{ findings, unresolved, notASymbol }`. `main` accumulates both, prints both, and
passes only `unresolved.length` to `compareToBaseline`.

The `HEADING` docstring's "Only requirement headings" is corrected: it matches every `##`–`####`, and
loop 032's `primaryUtilizationPct` false positive came from a *measurement* heading. Behaviour is
unchanged — narrowing would need a heading convention no committed loop follows.

### 5. `scripts/fence-check.ts` — the baseline key

`Baseline.unresolvedTokens` → `unresolvedSymbols`. `parseBaseline` reads only the new key, so a
baseline still carrying the old one fails the `malformed` guard rather than silently reading
`undefined` as zero. `compareToBaseline`'s message changes to name `unresolved symbol-shaped heading
tokens`, so a failure line cannot be confused with a pre-rename one in a CI log.

### 6. `sdlc/fence-baseline.json`

`"unresolvedTokens": 25` → `"unresolvedSymbols": 14`. `uncheckable` stays 13 and the one baselined
finding is untouched.

**14 is measured, not chosen.** 25 unresolved today, minus 2 resolved by Rule 3 (`verify` in loops
033 and 034), minus 1 by Rule 4 (`MetricEvent.payload`), minus 9 classified `not-a-symbol`, plus 1
for this loop's own `UNRESOLVED` heading token.

**This loop's own `spec.md` contributes exactly one**, and that is the correct outcome rather than an
embarrassment: `UNRESOLVED` is a requirement heading naming an identifier-shaped thing the index does
not know, which is the definition of the class. The claim in this plan's first version — that the
loop contributes zero — was true only because the token had been rewritten away, which the Stage 5
audit correctly called out. A3 stays an invariant for exactly this reason.

## Test mapping

Every criterion to a named test in `scripts/fence-check.test.ts`.

| Criterion | Test |
|---|---|
| A2 | `classifyToken` — six tests: `a flag is not a symbol`, `an underscored ALLCAPS name is an env var`, `an ALLCAPS name with no underscore is left unresolved`, `a reserved word is not a symbol`, `a TypeScript type keyword is not a symbol`, `a plain identifier is unresolved` |
| A3 | `the live tree` — `notASymbol.length + unresolved.length` equals the failed-resolution count, the two arrays are disjoint, and `unresolved.length === baseline.unresolvedSymbols` |
| A4 | `the live tree` — still exactly one finding, still loop 030's |
| A5 | `a loop naming only flags and env vars does not move the baselined count` |
| A6 | `a loop naming an unknown identifier does move it` |
| A7 | `a script name resolves to the file it runs` + `a script whose target is untracked does not resolve` |
| A8 | `Owner.member resolves to Owner's file` + `an unknown prefix stays unresolved` + `a signature-stripped dotted token is unaffected` |
| A9 | raw `JSON.parse` of the committed baseline: `notASymbol` absent **and** `unresolvedTokens` absent |
| A10 | six mutations, predicted before the run (below) |
| A11 | `.oxlint-budget.json` unchanged — the gate enforces it |
| A12 | `fenceCheck` in `bun run verify`, plus the Stage 5 audit |

**The four sites the rename and the split break**, all in `scripts/fence-check.test.ts`:

1. `the live tree` — accumulates `res.unresolved.length` against `baseline.unresolvedTokens`. Both
   move, and it gains A3's invariant.
2. `an unresolvable token is recorded, not silently dropped` — asserts
   `res?.unresolved === ['MetricEvent.payload']`. **It does not fail**: the fixture `telemetry.ts`
   declares `renderEvent` and `MAX_LINE_BYTES` and no `MetricEvent`, so Rule 4 finds no prefix. That
   is worse than failing — the test stays green while its name stops being true. It is split: one
   token that is genuinely unresolvable under all four rules, and a sibling under A8 that proves
   Rule 4 fires when the prefix *is* indexed. The fixture `SOURCES` gains
   `export interface MetricEvent {}` in `telemetry.ts` to make the sibling possible.
3. `compareToBaseline`'s `BASE` / `MATCH` fixtures — `unresolvedTokens` / `unresolved` keys.
4. `parseBaseline`'s malformed-input tests — the old-key JSON must now be *rejected*, which becomes a
   positive assertion rather than a deletion.

### Mutation predictions — written before the run (A10)

| # | Mutation | Predicted failures |
|---|---|---|
| 1 | `classifyToken`: drop the `startsWith('-')` branch | `a flag is not a symbol`; **and** `a loop naming only flags and env vars does not move the baselined count` (A5); **and** `the live tree` (2 flags move class) |
| 2 | `ENV_VAR`: `(?:_[A-Z0-9]+)+` → `(?:_[A-Z0-9]+)*` | `an ALLCAPS name with no underscore is left unresolved`; **and** `the live tree` is **unaffected** — no ALLCAPS-without-underscore token exists today, which is the prediction's real content |
| 3 | `classifyToken`: empty the `RESERVED` set | `a reserved word is not a symbol`; **and** `the live tree` (`try` moves class) |
| 4 | `classifyToken`: `IDENTIFIER` → `/./` | `a plain identifier is unresolved`, `a reserved word…`, `a TypeScript type keyword…`; **and** `the live tree` and A6 |
| 5 | `resolveSymbol`: delete the script-map fallback | `a script name resolves to the file it runs`; **and** `the live tree` (2 tokens move to `unresolved`, count 13 → 15) |
| 6 | `resolveSymbol`: delete the dotted-prefix fallback | `Owner.member resolves to Owner's file`; **and** `the live tree` (count 13 → 13 but `notASymbol` 9 → 10, caught by A3's sum, not by the count) |

Prediction 6 is the one worth watching: the baselined *count* does not move, because
`MetricEvent.payload` falls into `not-a-symbol` rather than `unresolved`. Only A3's disjoint-sum
invariant catches it. If it passes, A3 is not doing its job.

Loops 033 and 034 both under-predicted by naming only per-rule tests and missing the cross-cutting
suite. Every row above names `the live tree` explicitly where it applies, and says explicitly where
it does not.

## Risks

- **A required sixth parameter is a breaking signature change** to an exported function. Nothing
  outside `scripts/` imports `fence-check.ts`, and `bun run typecheck` is the proof. Accepted
  deliberately over an optional parameter, for the reason in change 4.
- **Rule 3 reads `package.json` at gate time.** A malformed manifest yields an empty map and the
  count silently rises by 2, which would fail the gate rather than pass it — the safe direction. A
  manifest that cannot be parsed at all already fails `bun install` long before this.
- **Rule 4 could fire on a dotted token whose owner is coincidentally indexed.** Measured across all
  committed loops: one token, one owner, zero findings. The risk is real for future loops and is the
  reason it resolves through the same core-wins ordering rather than a special path.
- **13 is a floor.** The spec enumerates the thirteen and why each is unreachable. A future loop
  reading a rising number must not read it as "the check got worse" — the number rising is the
  signal working.

## Out of scope, recorded

- **Member indexing**, in either measured form. Declined with evidence in the spec; not deferred.
- **Workspace-name resolution** (`vscode` → `packages/vscode`). Declined on meaning: `vscode` in
  loops 027 and 028 is the external API module, not this repo's package.
- **Narrowing `HEADING` to requirement headings only.** Would need a heading convention no committed
  loop follows. The docstring is corrected; the behaviour is not.
- **`PATH_RE` and its kind still classify as env vars.** No shape rule separates `PATH_RE` from
  `TMPDIR`. Recorded in the spec, not fixed.
- **`cli-ship.ts` still has no test file** (loop 034 A9, PARTIAL). Carried forward again; it is
  product code and outside this fence.

---

**Next stage:** Build/Test — run `/sdlc-implement 035-fence-signal`.
