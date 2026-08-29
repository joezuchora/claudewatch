# Spec: stop counting what can never be counted

- **ID:** 035-fence-signal
- **Stage:** 2 — Design
- **Status:** draft
- **Reads:** `sdlc/035-fence-signal/intent.md`
- **Date:** 2026-08-29

## Summary

The intent said `unresolvedTokens` counts two populations — noise that can never resolve, and "a
genuine coverage gap" of ten member-shaped tokens the check ought to resolve.

**Half of that is wrong, and measuring it is what this spec is for.** The noise half is real and is
fixed here. The coverage-gap half is not a gap: resolving those tokens produces **only false
positives**, because a field name in a requirement heading denotes the field's *behaviour*, not the
file that declares it.

So this loop does less than the intent proposed, and says why in a form the next loop can re-run.

## The measurement that changed the design

Two candidate member-index rules, both run over the whole committed corpus, comparing against
today's index of 245 top-level exports.

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
works exactly as hoped on every axis except the one that matters.

### All four findings are false positives

Checked one at a time against the artifacts and the code:

| Finding | Verdict |
|---|---|
| `033`: `verify` → `packages/metrics/src/types.ts` (fence `packages/metrics`) | **False.** `types.ts:32` has `verify: {` — a nested field in a metrics event type. Loop 033's heading means the gate command. Two unrelated things spelled the same. |
| `032`: `primaryUtilizationPct` → `types.ts` (fence `packages/core/src/types.ts`) | **False.** The heading is *"A null `primaryUtilizationPct` renders `⊙ error`"* — a statement about rendering, in a loop whose change was in the sanitizer. |
| `032`: `disabledReason` → `types.ts` (same fence) | **False.** Headings are *"`disabledReason` reaches the tooltip verbatim"* and *"B2 — `disabledReason` is the one field a closed set cannot cover"*. Both describe handling; neither asks to edit the declaration. |
| `032`: `lastHttpStatus` → `types.ts` (same fence) | **False.** *"B4 — `lastHttpStatus`, and the paragraph the first draft deleted"*. |

**Four findings, four false positives, zero true positives.** Loop 032 was right to fence `types.ts`
and right not to touch it: its subject was validating those fields at the cache boundary, which
happens in `sanitize-snapshot.ts`.

> **A path in a heading names a file. A symbol in a heading names a definition. A field name in a
> heading names a *topic*.** The first two have a defensible mapping to "the spec asks to change
> this file". The third does not, and no index rule can supply one, because the information is not
> in the token — it is in the sentence around it.

This also answers the intent's third open question and disposes of `MetricEvent.payload`: it is
**not** a hole to close. The intent argued that if a spec asked to widen the telemetry payload while
a plan fenced `telemetry.ts`, `fenceCheck` would be silent. True — and the fix is not to resolve the
token, because loop 032's headings show the same shape producing pure noise. That risk stays open,
recorded, and is `plan-to-diff`'s job rather than `fenceCheck`'s.

## Behavior

### B1 — the count splits by whether a token *could* denote a definition

`checkLoop` already returns `unresolved: string[]`. It gains a classification, applied to each
unresolved token in order:

```
NOT_A_SYMBOL   the token cannot denote a definition in any language this repo contains
UNRESOLVED     it is identifier-shaped, and the index does not know it
```

`NOT_A_SYMBOL` is decided by shape, never by a hand-maintained list of specific tokens — a list
would need editing every loop, which is the disease being treated:

| Shape | Rule | Today's members |
|---|---|---|
| flag | starts with `-` | `--json`, `--debug` |
| environment variable | `^[A-Z][A-Z0-9_]*$` | `XDG_CACHE_HOME` |
| reserved word | in TypeScript's reserved set | `any`, `try` |
| not an identifier | fails `^[A-Za-z_$][\w$]*$` after the signature strip | `⊙ error`, `SPEC.md §12`, `response.json()`, `enterprise.utilizationPct`, `MetricEvent.payload` |

`vscode` and `verify` and `outcome` and `freshness` remain **`UNRESOLVED`**. They are
identifier-shaped and the index genuinely does not know them; calling them "not symbols" would be a
lie that happens to make the number smaller.

### B2 — only `UNRESOLVED` is baselined

`sdlc/fence-baseline.json`'s `unresolvedTokens` keeps its name and its both-directions comparison,
and now counts only the second class. `notASymbol` is **printed, never asserted** — it is expected to
rise with every loop, which is precisely why it must not be a gate.

Measured on today's tree: **12 `NOT_A_SYMBOL`, 13 `UNRESOLVED`.** The baselined number goes 25 → 13.

The property the intent asked for follows: a loop whose spec headings name only flags and
environment variables moves `notASymbol` and leaves `unresolvedTokens` alone — so the gate stops
firing for reasons that carry no information, and still fires when a heading names something
identifier-shaped that the check cannot read.

### B3 — the index is NOT widened

No member indexing. `buildIndex` is unchanged. The four-false-positive measurement above is the
reason, and it is recorded in the code beside the index so the next loop does not re-derive it.

This is the whole of the intent's second half, declined with evidence rather than deferred.

### B4 — the report says which class each token fell into

`fence-check`'s output already lists unresolved tokens. Each line gains its class, so a reader can
see at a glance whether the check failed to read something or there was nothing to read:

```
  unresolved   032-snapshot-validation: freshness
  not-a-symbol 034-xdg-cache-home: XDG_CACHE_HOME
```

## Data and types

```ts
export type TokenClass = 'unresolved' | 'not-a-symbol';
export function classifyToken(token: string): TokenClass;
```

`checkLoop`'s return becomes `{ findings, unresolved, notASymbol }` — two string arrays rather than
one. `Baseline` gains nothing: `notASymbol` is deliberately absent from the record.

## Edge cases

- **A token that is both flag-shaped and known to the index** — impossible today (`-` cannot start
  an identifier), and the order in B1 makes it deterministic anyway: classification runs only on
  tokens the index already failed to resolve.
- **A single-letter uppercase token** like `T` — matches the environment-variable shape. Accepted:
  a bare `T` in a requirement heading is a type parameter, and neither class is more wrong. Recorded
  rather than special-cased.
- **`SCREAMING_CASE` that IS an exported constant**, e.g. `MAX_LINE_BYTES` — classification never
  sees it, because it resolves. This is why B1's order matters and why the rule is applied *after*
  resolution, not before.
- **A token containing a dot**, `MetricEvent.payload` — `NOT_A_SYMBOL` by the identifier rule. The
  signature strip (`bareSymbol`) removes a trailing `(…)` and `: …` but not a dotted prefix, and
  this spec does not add one; a dotted token is a member reference and B3 declines those.
- **The reserved-word set** is TypeScript's, spelled out in the code rather than imported, because
  no dependency here provides it and inventing one for eight words is worse.

## Backward compatibility

- `bun run verify` still exits 0. The one baselined finding (loop 030's) is untouched — this loop
  changes classification of *unresolved* tokens only, and never the finding set.
- `sdlc/fence-baseline.json`'s `unresolvedTokens` changes 25 → 13 in the same commit as the code, as
  the both-directions comparison requires.
- No committed `spec.md` or `plan.md` is edited.

## Acceptance criteria

- [ ] **A1** — `bun run verify` exits 0, CI green.
- [ ] **A2** — `classifyToken` returns `not-a-symbol` for a flag, a `SCREAMING_CASE` name, a reserved
      word, and a non-identifier; and `unresolved` for a plain identifier. Five named tests, one per
      shape rule, not one loop over a table.
- [ ] **A3** — on the committed tree: **12** `not-a-symbol`, **13** `unresolved`, and the baseline
      records 13. Asserted against the baseline.
- [ ] **A4** — the finding set is **unchanged**: exactly one, loop 030's. This is the criterion that
      catches a classification change leaking into resolution.
- [ ] **A5** — a fixture loop whose headings name only flags and env vars adds to `notASymbol` and
      **not** to `unresolvedTokens`. The intent's headline requirement, as a test.
- [ ] **A6** — a fixture loop whose heading names a plain identifier the index does not know **does**
      raise `unresolvedTokens`. The positive precondition for A5 — without it A5 passes on a
      classifier that returns `not-a-symbol` for everything.
- [ ] **A7** — `notASymbol` is absent from `sdlc/fence-baseline.json`, asserted by parsing the
      committed file, so a future loop cannot quietly start baselining it.
- [ ] **A8** — mutation predictions name a specific `file:testname` **before** the run, one per rule:
      the flag shape, the env-var shape, the reserved word, the identifier test, and the
      classify-after-resolution ordering. **Five**, and the prediction must name any cross-cutting
      suite each one also trips — loops 033 and 034 both under-predicted for exactly that reason.
- [ ] **A9** — `.oxlint-budget.json` unchanged at 8 rows / 10 warnings.
- [ ] **A10** — the plan-to-diff audit reports no file outside the fence; `fenceCheck` reports zero
      findings for this loop.

## Rejected alternatives

**Index type members (the intent's proposal).** Measured: 4 findings, 4 false positives, 0 true
positives, under the tightest rule that eliminates all collisions. See above. A check whose first
four new outputs are all wrong would be switched off before its first true positive.

**Index any indented `name:`.** 376 names, 43 in five or more files, 17 new findings. Worse on every
axis.

**Keep one number and subtract the noise by hand each loop.** That is the current state with extra
steps.

**Drop `unresolvedTokens` entirely.** Tempting, and wrong: the remaining 13 are identifier-shaped
tokens the index does not know, which is the fact loop 033 wanted visible. Deleting the number
because part of it was noise would discard the signal with it.

**A hand-maintained exclusion list of specific tokens.** Needs editing every loop — the exact
maintenance reflex this loop exists to remove.

---

**Next stage:** Build — run `/sdlc-plan 035-fence-signal`.
