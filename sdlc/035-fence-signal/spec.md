# Spec: stop counting what can never be counted

- **ID:** 035-fence-signal
- **Stage:** 2 — Design
- **Status:** revised after review (see *Corrections*)
- **Reads:** `sdlc/035-fence-signal/intent.md`
- **Date:** 2026-08-29

## Summary

The intent said `unresolvedTokens` counts two populations — noise that can never resolve, and "a
genuine coverage gap" of member-shaped tokens the check ought to resolve.

**Half of that is wrong, and measuring it is what this spec is for.** The noise half is real and is
fixed here by classification. The coverage-gap half is not a gap: indexing type members produces
**only false positives**, because a field name in a heading denotes the field's *behaviour*, not the
file that declares it.

But declining the intent's proposal is not the same as declining its goal. Two narrower resolution
rules — **root `package.json` script names** and **dotted-prefix lookup against the existing index**
— were measured after the first draft and both come back clean: three tokens resolved, **zero new
findings, zero false positives, no member indexing.** They are adopted. Together with
classification they take the baselined number from **25 to 13**, and — the point of the whole loop —
take the *motivating* loop's contribution to it from 1 to **zero**.

## The measurement that changed the design

Four candidate rules, all run over the whole committed corpus against today's index of top-level
exports. The first two were in the first draft; the last two were added by review.

### Rule 1 — any indented `name:` in any `.ts` file

| | |
|---|---|
| names indexed | **376** (vs 245 exports) |
| names appearing in ≥5 files | **43** |
| worst collisions | `freshness` (15 files), `snapshot` (14), `source` (14), `ok` (13), `fetchedAt` (12), `kind` (11), `payload` (10) |
| new findings across committed loops | **17, across 4 loops** |

Disqualified on its face. `ok` and `kind` are not identifiers in any useful sense; a heading naming
`freshness` would resolve to fifteen files and fire against any fence covering one of them.

### Rule 2 — members declared inside `interface X {` / `type X = {`, non-test files only

| | |
|---|---|
| names indexed | **156** |
| names appearing in ≥5 files | **0** |
| tokens newly resolved | **10** |
| new findings across committed loops | **4, across 2 loops** |

The collision problem disappears completely. This is the rule the intent was reaching for, and it
works exactly as hoped on every axis except the one that matters — see below.

### Rule 3 — a root `package.json` script name resolves to the file it runs

| | |
|---|---|
| script names mapping to a tracked file | **4** — `lintBudget`, `fenceCheck`, `perf`, `verify` |
| collisions with an exported symbol of the same name | **0** |
| tokens newly resolved | **2** — `verify` in loops 033 and 034 |
| new findings | **0** |
| false positives | **0** |

This is not a heuristic. `"verify": "bun run scripts/verify.ts"` is a *declared* mapping from a name
to a file, written by hand in a committed file, exactly as `export function verify` would be. Loops
033 and 034 both write headings about the gate command, and both genuinely edit `scripts/verify.ts`
while fencing other things — so both resolve and neither fires.

### Rule 4 — a dotted token resolves by its prefix, against the index that already exists

| | |
|---|---|
| tokens newly resolved | **1** — `MetricEvent.payload` → `packages/core/src/telemetry.ts` |
| new findings | **0** |
| false positives | **0** |
| new names indexed | **0** — `MetricEvent` is already a top-level `export interface` |

`MetricEvent.payload` is a member reference whose *prefix* is an ordinary exported symbol. Resolving
`Owner.member` to wherever `Owner` is declared requires no member index at all, and it is strictly
more precise than Rule 2 would be: it maps the token to the file that declares the type, not to every
file that happens to contain a field spelled the same.

The first draft dismissed this in a sentence — "a dotted token is a member reference and B3 declines
those" — and presented the dismissal as though it followed from the Rule-2 measurement. It does not:
**the Rule-2 measurement contains no dotted tokens at all.** Measured separately, it is clean.

### All four Rule-2 findings are false positives

Checked one at a time against the artifacts and the code:

| Finding | Verdict |
|---|---|
| `033`: `verify` → `packages/metrics/src/types.ts` (fence `packages/metrics`) | **False.** `types.ts:32` has `verify: {` — a nested field in a metrics event type. Loop 033's heading means the gate command. Two unrelated things spelled the same. Rule 3 resolves this token *correctly*, to `scripts/verify.ts`. |
| `032`: `primaryUtilizationPct` → `types.ts` (fence `packages/core/src/types.ts`) | **False.** The heading is *"A null `primaryUtilizationPct` renders `⊙ error`"* — a statement about rendering, in a loop whose change was in the sanitizer. |
| `032`: `disabledReason` → `types.ts` (same fence) | **False.** Headings are *"`disabledReason` reaches the tooltip verbatim"* and *"B2 — `disabledReason` is the one field a closed set cannot cover"*. Both describe handling; neither asks to edit the declaration. |
| `032`: `lastHttpStatus` → `types.ts` (same fence) | **False.** *"B4 — `lastHttpStatus`, and the paragraph the first draft deleted"*. |

**Four findings, four false positives, zero true positives.** Loop 032 was right to fence `types.ts`
and right not to touch it: its subject was validating those fields at the cache boundary, which
happens in `sanitize-snapshot.ts`.

> **A path in a heading names a file. A symbol in a heading names a definition. A bare field name in
> a heading names a *topic*.** The first two have a defensible mapping to "the spec asks to change
> this file". The third does not, and no index rule can supply one, because the information is not
> in the token — it is in the sentence around it.
>
> `Owner.member` is not in the third class. The dot is the author saying which declaration they mean.

## Behavior

### B1 — two resolution rules are added; the index is NOT widened

`buildIndex` still indexes only top-level `export`s. Rules 1 and 2 are rejected; Rules 3 and 4 are
adopted, both as **fallbacks after the existing lookup fails**, so no finding that exists today can
change.

**B1a — script names.** A new exported `indexScripts(packageJsonText, corpus)` returns
`Map<scriptName, file>`: for each entry in `scripts`, the first `.ts`/`.sh`/`.ps1`/`.js` path in the
command, kept only if that path is in the corpus. `resolveSymbol` consults it when the symbol index
returns nothing, trying the **raw** token first and then `bareSymbol(token)` — raw first because
`bareSymbol` truncates at `:` and would destroy `verify:plain` and `metrics:ship`.

**B1b — dotted prefixes.** When the symbol index returns nothing and the token matches
`^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$`, look up the segment before the first dot. A hit resolves
to that symbol's files, through the same core-wins ordering. This deliberately does not fire for
`SPEC.md §12` (space), `response.json()` (after the signature strip, `response.json` — the prefix
`response` is not in the index), or `enterprise.utilizationPct` (prefix `enterprise` is not in the
index). Only clean dotted chains whose owner is a known export resolve, which today is exactly one
token.

### B2 — the count splits by whether a token *could* denote a definition

`checkLoop` returns `unresolved: string[]`. It gains a classification, applied to each token that
survived resolution:

```
NOT_A_SYMBOL   the token cannot denote a definition in any language this repo contains
UNRESOLVED     it is identifier-shaped, and the index does not know it
```

`NOT_A_SYMBOL` is decided by shape, never by a hand-maintained list of specific tokens — a list
would need editing every loop, which is the disease being treated.

**Every rule is applied to `bareSymbol(token)`, never to the raw token** — the same string the
resolution attempt failed on. Applying them to the raw token would let a heading written
`XDG_CACHE_HOME: string` classify differently from one written `XDG_CACHE_HOME`, which is a
distinction the author never intended to draw. (Measured both ways on today's tree: identical
split. This is a forward-looking decision, not a measured difference, and is stated because the
first draft left it unspecified.)

| Shape | Rule, applied to `bareSymbol(token)` | Today's members |
|---|---|---|
| flag | starts with `-` | `--json`, `--debug` |
| environment variable | `^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$` | `XDG_CACHE_HOME` |
| keyword | in the enumerated keyword set below | `any`, `try` |
| not an identifier | fails `^[A-Za-z_$][\w$]*$` | `⊙ error`, `SPEC.md §12`, `response.json()`, `enterprise.utilizationPct` |

**The keyword set** is ECMAScript's reserved words *plus* TypeScript's built-in type keywords,
enumerated in the code because no dependency here provides it:

```
ECMAScript reserved: await break case catch class const continue debugger default delete do else
  enum export extends false finally for function if implements import in instanceof interface let
  new null package private protected public return static super switch this throw true try typeof
  var void while with yield
TypeScript type keywords: any bigint boolean never number object string symbol undefined unknown
```

The first draft called this "TypeScript's reserved set" and said "eight words". Both are wrong:
`any` is **not** an ECMAScript reserved word — it is a contextual type keyword, legal as an
identifier — and the set is 56 entries, not eight. `try` is genuinely reserved. Naming the two
sources separately is what makes the set auditable rather than arbitrary. **Its size does not affect
today's count**: none of the thirteen remaining `UNRESOLVED` tokens is a keyword under any
plausible variant of the set, so the choice is a forward-looking one only.

**The environment-variable rule requires an underscore**, which is a deliberate narrowing of the
first draft's `^[A-Z][A-Z0-9_]*$`. That form swallows module-private SCREAMING/ALLCAPS constants —
`MARKERS`, `HEADING`, `TOKEN`, `EXPORTED`, `PATH_RE` all live in `fence-check.ts` itself and all
match it — and a heading naming one of them would be classified "not a symbol" when it is precisely
a symbol the index cannot see. That is the silent false negative this loop exists to remove, so the
narrower rule is correct even though it costs a permanent `+1` for any future heading naming `HOME`
or `PATH`. **Underscore-free constants remain a known false negative** (`PATH_RE` has one and is
still swallowed); recorded, not fixed, because no shape rule can separate `MARKERS` from `TMPDIR`.

`vscode`, `outcome`, `freshness` and the rest remain **`UNRESOLVED`**. They are identifier-shaped
and the index genuinely does not know them; calling them "not symbols" would be a lie that happens
to make the number smaller.

### B3 — only `UNRESOLVED` is baselined, under a new key

`sdlc/fence-baseline.json` replaces `unresolvedTokens` with **`unresolvedSymbols`**, keeping the
both-directions comparison and counting only the second class. `notASymbol` is **printed, never
asserted** — it is expected to rise with every loop, which is precisely why it must not be a gate.

The rename is not cosmetic. Keeping the name across a redefinition would make `git log -p` on the
baseline unreadable: a reader six months from now sees `25 → 13` under an unchanged key and cannot
tell whether the check improved or the definition moved. A new key makes the redefinition a visible
event, and the parser rejecting the old key means no half-migrated baseline can pass.

### B4 — the report says which class each token fell into

```
  unresolved   032-snapshot-validation: freshness
  not-a-symbol 034-xdg-cache-home: XDG_CACHE_HOME
```

## What the numbers actually are

Measured on the tree at this commit (loop 035 has `spec.md` but no `plan.md`, so it is *skipped*,
not counted):

| | |
|---|---|
| unresolved today | **25** |
| resolved by Rule 3 (script names) | **2** |
| resolved by Rule 4 (dotted prefix) | **1** |
| classified `not-a-symbol` | **9** |
| classified `unresolved`, i.e. baselined | **13** |

Per loop, `[not-a-symbol / unresolved]` after the change:

```
022  0/1     029  3/1     032  2/3
027  0/3     030  0/1     034  2/0
028  1/1     031  1/3     033  —
```

**Loop 034 — the loop that motivated this one — goes from 1 to 0, and loop 033 drops out entirely.**
That is the headline claim, and it is now true for the motivating case rather than asserted about a
hypothetical one. The first draft claimed the same thing while leaving loop 034 at 1; the difference
is Rule 3.

### The remaining thirteen, and why the number still cannot go *down*

```
022: outcome                      030: lastErrorMessage        032: primaryUtilizationPct
027: doRefresh                    031: fetchedAt               032: disabledReason
027: refreshInFlight              031: freshness               032: lastHttpStatus
027: vscode      028: vscode      031: normalizationWarnings   029: malformedResponse
```

Eight are interface members in `types.ts`; two are module-local declarations in `extension.ts`; two
are the `vscode` API module, which is an external dependency and not in the corpus at all; one is a
string-literal value. **Every one of them is unreachable under B1's declared rules**, so 13 is a
floor, not a target. The number can still go *up*, which is the property loop 033 wanted: a future
heading naming an identifier the index cannot see raises it, and that is a signal.

This is worth stating plainly because the intent implied the opposite — that the count "cannot go
down as a matter of course" was the defect. It is only half the defect. After this loop the count
still cannot go down; what changes is that it no longer goes *up* for reasons that carry no
information.

### The intent's third question, answered

The intent asked whether `MetricEvent.payload` is a hole: if a spec asked to widen the telemetry
payload while a plan fenced `telemetry.ts`, would `fenceCheck` be silent? It was. **Rule 4 closes
it** — that token now resolves to `packages/core/src/telemetry.ts` and would fire. The first draft
declined to close it on evidence that turns out not to bear on it.

## Data and types

```ts
export type TokenClass = 'unresolved' | 'not-a-symbol';
export function classifyToken(token: string): TokenClass;
export function indexScripts(packageJsonText: string, corpus: readonly string[]): ReadonlyMap<string, string>;
```

`checkLoop` gains a sixth parameter, `scripts: ReadonlyMap<string, string>`, and its return becomes
`{ findings, unresolved, notASymbol }` — two string arrays rather than one. `Baseline`'s
`unresolvedTokens` becomes `unresolvedSymbols`; `notASymbol` is deliberately absent from the record.

## Backward compatibility

- `bun run verify` still exits 0. The finding set is unchanged: exactly one, loop 030's.
- `sdlc/fence-baseline.json` swaps `unresolvedTokens: 25` for `unresolvedSymbols: 13` in the same
  commit as the code, as the both-directions comparison requires.
- No committed `spec.md` or `plan.md` is edited.
- **`scripts/fence-check.test.ts` must change**, so it is inside the fence:
  - *"matches the committed baseline"* (`the live tree`) accumulates `res.unresolved.length` and
    asserts it equals `baseline.unresolvedTokens`. Both the field and the key move.
  - *"an unresolvable token is recorded, not silently dropped"* asserts
    `res?.unresolved === ['MetricEvent.payload']`. This test does **not** fail — the fixture corpus
    declares `renderEvent` and `MAX_LINE_BYTES` in its synthetic `telemetry.ts` but no
    `MetricEvent`, so Rule 4 finds no prefix and the token still falls through. That is worse than
    failing: the test would stay green while no longer testing what its name claims. It must be
    split into one token that is genuinely unresolvable and a sibling proving Rule 4 *does* fire
    when the prefix is known.
  - `compareToBaseline`'s fixtures (`BASE`, `MATCH`) name `unresolvedTokens`/`unresolved`.
  - `parseBaseline`'s malformed-input tests use JSON with the old key, which must now be rejected.

## Acceptance criteria

- [ ] **A1** — `bun run verify` exits 0, CI green.
- [ ] **A2** — `classifyToken` returns `not-a-symbol` for a flag, an underscored `SCREAMING_CASE`
      name, a keyword, and a non-identifier; and `unresolved` for a plain identifier **and for an
      underscore-free all-caps name**. Six named tests, one per rule plus the narrowing, not one
      loop over a table.
- [ ] **A3** — an **invariant**, not a constant: over the live tree,
      `notASymbol.length + unresolved.length` equals the number of tokens that failed resolution;
      no token appears in both arrays; and `unresolved.length === baseline.unresolvedSymbols`.
      Stated as an invariant deliberately — loops 033, 034 and this spec's own first draft each
      hardcoded a token count and each got it wrong, because the loop's own artifacts join the
      corpus the moment its `plan.md` lands. The *measured* split at this commit is 9/13; the
      implementation commit records whatever the tree then holds, and A3 is what proves the two
      agree.
- [ ] **A4** — the finding set is **unchanged**: exactly one, loop 030's. This is the criterion that
      catches Rules 3 and 4, or the classifier, leaking into resolution.
- [ ] **A5** — a fixture loop whose headings name only flags and env vars adds to `notASymbol` and
      **not** to `unresolvedSymbols`. The intent's headline requirement, as a test.
- [ ] **A6** — a fixture loop whose heading names a plain identifier the index does not know **does**
      raise `unresolvedSymbols`. The positive precondition for A5 — without it A5 passes on a
      classifier that returns `not-a-symbol` for everything.
- [ ] **A7** — a fixture script name resolves to its file and is neither `unresolved` nor
      `notASymbol`; and a script name whose target is absent from the corpus does **not** resolve.
      The second half is what stops `indexScripts` inventing files.
- [ ] **A8** — `Owner.member` resolves to `Owner`'s file when `Owner` is indexed, and does not when
      it is not; `response.json()` and `SPEC.md §12` are unaffected. Loop 020's fenced token
      (`MetricEvent.payload` against `telemetry.ts`) is the worked case.
- [ ] **A9** — `notASymbol` is absent from `sdlc/fence-baseline.json`, and `unresolvedTokens` is
      absent too, asserted by reading the committed file with **raw `JSON.parse`** — not
      `parseBaseline`, whose return type structurally cannot contain either key, which would make
      the assertion vacuous. (A7 in the first draft; it was vacuous exactly that way.)
- [ ] **A10** — mutation predictions name a specific `file:testname` **before** the run, one per
      rule, each against a line that actually exists in the diff: the flag prefix test in
      `classifyToken`; the env-var underscore quantifier; the keyword-set membership check; the
      identifier regex; `resolveSymbol`'s script-map fallback; and its dotted-prefix fallback.
      **Six**, and each prediction must name any cross-cutting suite it also trips. In this diff
      those are all in `scripts/fence-check.test.ts`: the `the live tree` test, the
      `compareToBaseline` fixtures, and the `parseBaseline` malformed-input tests. Under-predicting
      cross-cutting suites is the single cause of the mutation misses in loops 033 and 034.
- [ ] **A11** — `.oxlint-budget.json` unchanged at 8 rows / 10 warnings.
- [ ] **A12** — the plan-to-diff audit reports no file outside the fence; `fenceCheck` reports zero
      findings for this loop.

## Edge cases

- **Classification runs only after resolution fails.** A `SCREAMING_CASE` name that *is* an exported
  constant (`MAX_LINE_BYTES`) never reaches the classifier. This ordering is why the env-var rule is
  safe at all, and A10 mutates it.
- **A script name that is also an exported symbol.** The symbol index wins; the script map is a
  fallback. Zero such collisions exist today (`lintBudget`, `fenceCheck`, `perf`, `verify` are not
  exported anywhere), and the ordering makes the outcome deterministic if one appears.
- **A single-letter uppercase token** like `T` — no longer matches the environment-variable shape
  once the underscore is required, so it classifies `unresolved`. Correct: a bare `T` is a type
  parameter, which is a declaration the index cannot see, which is what `unresolved` means.
- **A dotted token whose prefix resolves to several files** — goes through the same core-wins
  ordering as any other symbol, and produces one finding per surviving file. No new path.
- **A heading token that is a *measurement* rather than a requirement.** `HEADING` matches every
  `##`–`####`, so "requirement heading" overstates what is read: loop 032's `primaryUtilizationPct`
  false positive comes from a measurement heading, not a requirement. The docstring saying
  "requirement headings" is corrected in this loop; the *behaviour* is not changed, because
  narrowing to requirement headings would need a heading convention no loop has followed.

## Rejected alternatives

**Index type members (the intent's proposal).** Measured: 4 findings, 4 false positives, 0 true
positives, under the tightest rule that eliminates all collisions. A check whose first four new
outputs are all wrong would be switched off before its first true positive.

**Index any indented `name:`.** 376 names, 43 in five or more files, 17 new findings. Worse on every
axis.

**Resolve workspace names** (`vscode` → `packages/vscode`), the other half of the Rule-3 idea.
Rejected on meaning, not on measurement: a workspace name maps to a *directory*, and `vscode` in
loops 027 and 028 means the **`vscode` API module**, an external dependency, not the package in this
repo. Resolving it would map a token to a directory its author never referred to — Rule 1's disease
with a smaller sample.

**Keep one number and subtract the noise by hand each loop.** That is the current state with extra
steps.

**Drop the number entirely.** The remaining 13 are identifier-shaped tokens the index does not know,
which is the fact loop 033 wanted visible. Deleting the number because part of it was noise would
discard the signal with it.

**A hand-maintained exclusion list of specific tokens.** Needs editing every loop — the exact
maintenance reflex this loop exists to remove.

## Corrections to the first draft

Recorded rather than silently patched, per loops 033 and 034.

| # | The first draft said | Correction |
|---|---|---|
| B-1 | "12 `NOT_A_SYMBOL`, 13 `UNRESOLVED`", 25 → 13 | Arithmetically impossible: its own table enumerates 10 not-a-symbol members, and 25 − 10 = 15. The 12 was carried from the intent while the membership was being reversed. A1 and A3 were mutually unsatisfiable as written. **A3 is now an invariant**, which is the only fix that survives the next loop. |
| B-2 | A3 asserts constants over "the committed tree" | Ignored that loop 035's own `spec.md` joins the corpus the moment its `plan.md` is committed — the third consecutive loop to make this mistake. Note that this spec's own heading token `UNRESOLVED` would have classified as not-a-symbol under the draft's env-var rule, which is what prompted the underscore narrowing. |
| B-3 | "the gate stops firing for reasons that carry no information" | False for the motivating loop: loop 034 would still have moved the number by 1, via `verify`. Rule 3 was measured in response and takes it to 0. |
| M-1 | `MetricEvent.payload` dismissed on the Rule-2 measurement | That measurement contains no dotted tokens. Measured separately: Rule 4 resolves it against the *existing* index, 0 findings, 0 false positives. Adopted. |
| M-2 | silent on whether 13 can fall further | It cannot. The thirteen are enumerated above with the reason each is unreachable. |
| M-3 | shape rules unspecified as to raw vs `bareSymbol` | Now `bareSymbol` throughout, stated, with the measured note that today's split is the same either way. |
| M-4 | "TypeScript's reserved set … eight words" | `any` is not reserved; the set is 55 entries from two sources, now enumerated. |
| M-5 | A7 asserts `notASymbol` absent via `parseBaseline` | Vacuous — `parseBaseline`'s return type cannot contain it. Now raw `JSON.parse`, and it also checks the old key is gone. |
| M-6 | backward compatibility silent on the test file | Four affected test sites listed; `scripts/fence-check.test.ts` is inside the fence. The `MetricEvent.payload` test does not *fail* — it goes green-but-vacuous, which is worse and is why it is named. |
| m-1 | `unresolvedTokens` keeps its name | Renamed `unresolvedSymbols`, so the redefinition is legible in `git log -p`. |
| m-2 | "only requirement headings are read" | `HEADING` matches all of `##`–`####`; the docstring is corrected. |
| m-4 | env-var rule `^[A-Z][A-Z0-9_]*$` | Swallows module-private constants. Underscore now required; the residual false negative (`PATH_RE`) is recorded. |
| n-1 | (in `intent.md`) third group "**Three.**", two listed | The missing token is `lastErrorMessage`, and it belongs in the *second* group — it is an interface member at `types.ts:87`. The correct split is 12 / 11 / 2 = 25. Recorded here rather than by editing a committed artifact. |
| n-2 | A3 "asserted against the baseline" alongside constants | Resolved by making A3 an invariant. |

---

**Next stage:** Build — run `/sdlc-plan 035-fence-signal`.
