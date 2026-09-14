# Review: finish the cache-read boundary

Range reviewed: `e783783..HEAD` — `5e42d21` (four degradations + `closed-sets.ts`), `3000564` (the
tests, two docstrings), `d7d79ea` (`SPEC.md`), `e1d8320` (audit remediation), `5a71328` (security
remediation).

Reviewers, run **sequentially** on a clean tree, briefed on the commit range and told not to write
into the working tree. `spec-reviewer` at Stage 2 (**two BLOCKING**, seven MAJOR, six MINOR);
`plan-to-diff-auditor` (**EXCURSIONS RECORDED** — no BLOCKING, eight SHOULD-FIX, three NIT);
`security-reviewer` (**no BLOCKING** — two SHOULD-FIX, three NIT, one informational). All three
reported. Every finding below is fixed or recorded as not-done.

## Verdict

**Accept, after remediation.** The guarantee holds for the five fields it now claims. But this loop
was wrong in public three times — once in its spec, once in its code, once in its own retrospective
mechanism — and each error was the *same* error in a new place: a claim made by reading rather than
running. The reviewers caught all three. That is the finding.

## Pass 1 — bugs and logical errors

### What the change does

`readCacheResult` validated three of the values it returned from a cache file. It now validates
**seven** — `lastErrorClass`, `lastErrorMessage`, `cooldownUntil` (pre-existing), plus `fetchedAt`,
`freshness.staleReason`, `freshness.isStale`, `rawMetadata.normalizationWarnings`, and `tier`.
`main.ts` is not edited: validating at the boundary fixes every consumer without touching one.

### A behaviour change worth stating plainly

The shape gate lost its `typeof fetchedAt !== 'string'` clause. A non-string `fetchedAt` used to
delete the whole envelope, **taking the live `cooldownUntil` with it** — §9.4's only throttle on
token-bearing requests. Measured before the change: `cooldownActive: false`, `usage.json` gone.

The draft spec excused that with *"shape checks reject, value checks degrade"*. The Stage 2 reviewer
demonstrated that is a taxonomy, not a hazard analysis, with the identical hazard on both sides of
the line. Redrawn: **degrade whenever there is a coherent value to degrade to; reject only when there
is not.** The remaining reject paths (`snapshot`, `display`, `freshness` missing) keep their §9.4
exposure — named in `cache.ts`, in `SPEC.md §12`, and pinned by a test, not closed.

## Pass 1a — the Stage 2 spec review

### BLOCKING 1 — the closed set was nine, not seven, and the counter-measure failed on its own terms

The draft tabulated seven warning strings and said the table was the counter-measure against a
miscount. The table was built by grepping `warnings.push`. **Two producers do not use `push`** —
`normalize.ts:121` and `:165` pass literal arrays to `makeMalformed`.

A filter from that table would have **dropped `'Response is not an object'` and `'No valid usage
windows found'` on read**, deleting the headline diagnostic of the malformed-response path from the
one cache file where it matters. The intent said eight; the draft "corrected" it to seven; the answer
is nine. A table defends against a miscount only when its rows come from the behaviour.

### BLOCKING 2 — `--json`, and why no field-name search could have found it

`main.ts:241`, `:256` and `:310` call `output(cache.snapshot, …)`; `output` at `:371` is
`console.log(JSON.stringify(snapshot, null, 2))` — the whole snapshot, unfiltered, a documented
contract, and the more likely paste-into-an-issue surface of the two.

The draft missed it because it searched for readers of three field **names**. **`--json` names no
field.** A "which surfaces read this field" search is structurally incapable of being complete; the
question has to be *what is serialised*.

The fix did not change — validating at the boundary covers `--json` for free. The **claim** changed:
the draft's "validate every value it returns" was false and would have stayed false.

## Pass 1b — the plan-to-diff audit

**Fence held exactly.** Twelve declared paths, twelve changed, one-to-one; the negative list intact.
The auditor called it the tightest fence it had audited here — twelve literal paths, no globs.

### SHOULD-FIX — the loop's own thesis, defeated by object identity. Fixed.

`freshness` and `rawMetadata` were rebuilt **only when a degradation fired**. An envelope whose known
fields were all valid passed both through **by reference**, and any unknown sibling key rode along to
`--debug` (which emits `freshness` whole) and `--json`. Measured: `freshness.evil` and
`rawMetadata.evil` both reached stdout.

The comment beside the code stated the premise correctly — *"`freshness` is emitted whole by
`printDebug`"* — and drew the narrower conclusion, *"so both its **fields** are surfaces"*. Emitted
whole means every **key** is a surface. Both objects are now rebuilt unconditionally: loop 030's rule
(return what you constructed, never what you read) applied to an object rather than a scalar.

Measured how far the same hole goes rather than assuming: unknown keys on `snapshot`, `display` and
every window object survive too. Not fixed — sdlc/032 — but named in code and spec.

### SHOULD-FIX — two artefacts asserted a structural guarantee the code did not provide. Fixed.

Commit 1's body and `spec.md` both said `normalize.ts` sources **all nine** warning strings from the
shared constants. It sourced **five**; the four `extra_usage` warnings were still inline literals
duplicated verbatim. No data-loss risk — `closed-sets.test.ts` re-derives the set by running
`normalize()` — but the mechanism the artefacts described did not exist. Now nine.

### SHOULD-FIX — A9's test measured the wrong side. Fixed.

It compared the docstring's count to the **function body**, so adding a ninth `SurfaceableMessage`
member with no check and no docstring change left it green — the auditor did exactly that. A new
message class arrives as a **union member** first. Now measures both; re-run against the auditor's
own probe, it goes red.

### SHOULD-FIX — `closed-sets.ts` reproduced the defect A9 exists to fix. Fixed.

An orphaned docstring, separated from `NORMALIZATION_WARNINGS` by a second docblock — in the module
this same loop introduced, in the loop whose A9 is *"it was ORPHANED"*.

### Also fixed

A5 was PARTIAL (T9 drove `classify` only; T9b now evaluates both `!== 'fetchFailed'` guards against
the validated snapshot, without touching the two out-of-fence files). `main.ts:310` was missing from
the `--json` call-site enumeration in five places.

## Pass 2 — security (SPEC.md §12, §17)

### SHOULD-FIX — a dead function cited as a reason not to act. Fixed.

`spec.md`'s Rejected-alternatives argued against clamping a far-future `fetchedAt`: *"it suppresses
one [fetch] and is exactly what `detectClockSkew` reports. Clamping would delete that signal."*
**False in both halves**, measured:

```
grep -rn detectClockSkew  ->  definition, its own tests, and my two comments. ZERO production callers.
isCacheFresh('2099-01-01T00:00:00.000Z')  ->  true
```

Not one fetch: `main.ts:240` returns the cached snapshot **without rewriting the file**, so every
render repeats it — escapable only with `--refresh`. **The one place a value off disk makes the tool
believe the cache is fresher than it is**, and the loop argued for leaving it on the strength of code
nothing calls. Fixed by bounding the comparison (`age < -CLOCK_SKEW_TOLERANCE_MS` is not fresh)
rather than clamping the stored value, so the skew stays visible.

### SHOULD-FIX — `tier` reached a file, not a terminal. Fixed.

`renderEvent` (`telemetry.ts:229`) copies `snapshot.tier` verbatim into a payload leaf; `emit`
appends it to the metrics spool. Measured: a home directory and a hostname on disk in a payload leaf.
`telemetry.ts`'s own header forbids an unconstrained string in a payload and justifies this one as
*"constrained by their producing unions"* — the argument loops 029 and 030 established is void for a
value read off a cache file. Validated against `ACCOUNT_TIERS`, degrading to `'unknown'`.

**The shape of this miss is the loop's thesis one step further out.** It found `--json` by asking
what gets serialised instead of what reads the field — and then stopped at stdout. The surface set is
`{--debug, --json, the telemetry spool}`.

### An unclaimed §9 fix, now pinned

Commit 4's unconditional rebuild **incidentally closed a stuck-failure-loop bug** nothing in this
loop claimed: a v2 file with no `rawMetadata` passed the shape gate, then `main.ts:144` threw a
`TypeError` reading `.normalizationWarnings` — top-level catch, exit 3, file never deleted, repeating
forever. Unclaimed and unpinned until T16.

### Verified clean

Token traced end to end; no new `console.*`, `throw`, `fetch`, agent, `rejectUnauthorized` or
`NODE_TLS_REJECT_UNAUTHORIZED`; `writeCache`'s temp+rename, `0700`/`0600` untouched; credentials
never written outside a `mkdtemp` sandbox; enterprise credit amounts still absent from every payload;
both smoke cases network-inert by two independent mechanisms, confirmed by reading. The closed set
was verified **by running `normalize()`** over fourteen fixtures — set difference empty in both
directions, so nothing real is silently deleted on read.

## Pass 3 — compliance

No domain logic outside `packages/core`. No `any`. Bundle CJS. `SPEC.md §12` amended with what closed
**and** what did not; §11.4 and §14 record the `fetchedAt` sentinel against the `--json` contract.

## A2 — the mutation table, predictions committed before the run

`git log --oneline e783783..HEAD` shows `e783783` (predictions) preceding every implementation
commit, which is the mechanism that makes "predicted, not backfilled" checkable rather than trusted.

| # | Mutation | Predicted | Measured |
|---|---|---|---|
| M1 | delete B1's `fetchedAt` degradation | 3 | **5** |
| M2 | invert B1 — return the input | 3 | 3 |
| M3 | delete B2a's `staleReason` fallback | 3 | 3 |
| M4 | invert B2a | 4 | **7** |
| M5 | delete B2b's `isStale` check | 3 | 3 |
| M6 | delete B3's warning filter | 3 | 3 |
| M7 | invert B3 | 4 | **5** |
| M8 | drop the two `makeMalformed` rows from the set | 2 | **8** |
| M9 | restore the `fetchedAt` shape clause | 1 | 1 |

No mutation survived: every check is load-bearing. But **five of nine predictions were right, and all
four misses were in the same direction**, which makes it a systematic bias rather than four slips.

My first diagnosis — "I predicted against `plan.md`'s 13-row test *mapping*, not the 22 tests
actually written" — is the dominant cause and is **incomplete**. The auditor named three more:

1. **One unmapped test drives three of the four misses.** `security.test.ts`'s "an honest envelope is
   untouched — the positive control for all six above" has **no row in the mapping at all**. Its
   fixture carries a real `StaleReason` member and a real set member, so it dies under M4, M7 **and**
   M8. Predicting against the mapping could not have found it; neither could "predict against the
   tests written" without reading its fixture.
2. **M8 overlooked a row that WAS in the mapping.** T11 compares the constant against nine hard-coded
   literals; deleting two members must break it. `plan.md` predicted "T10 and T8" and missed its own
   T11. A plain reasoning error, not a granularity artefact.
3. **T12 asserts more than its mapping row states**, so M1 kills it as well as both `fetchedAt`
   security tests.

And M4's T9 failure **was predictable from `plan.md` alone** — the plan lists `'malformedResponse'`
and `'fetchFailed'` as T9's positive controls, and inverting B2a forces both to `'none'`. The
information was in the plan; it was not carried across two sections.

## Criteria

A1, A2, A3, A4, A6, A7, A8, A10, A11, A12, A13 **MET**. A5 and A9 were **PARTIAL** at the audit and
are now MET after `e1d8320`. **A11's budget was zero and held** — verified by the auditor from the
diff (`git diff … -- '*.test.ts' | grep '^-'` returns two lines, both widened imports), not from my
claim. Commit 1's cited evidence for it was a non-sequitur: an unchanged pass count cannot show that
no expectation was edited.

## What is NOT done

- **Unknown keys on `snapshot`, `display` and window objects** still reach `--json`. **OPEN**, sdlc/032.
- **The remaining unvalidated leaves** (`source.usageEndpoint`, `authState`, `display.*`, window
  fields). **OPEN**, sdlc/032.
- **Structural rejects still discard the cooldown.** **OPEN**; needs `cooldownUntil` stored separably
  from the snapshot. Pinned by T12b so the day it closes, a test says so.
- **`detectClockSkew` has no production caller.** Left as dead code, now labelled. **OPEN.**
- **A12 is still a manual step**, not a gate — the lesson loop 030 recorded and this loop did not
  act on. **OPEN**, sdlc/032 with the spec-versus-fence check.
- **The spec-versus-fence check** (`intent.md` outcome 8), knowingly unmet and deferred at Stage 2.
- **`commands.ts:26`**, **`enterprise.disabledReason`**, **`metrics.db` mode 0644**, **`writeCache`
  has no `lstat` before `renameSync`** — **DEFERRED**, all outside this fence.
- **`ok: false, statusClass: '2xx'`** still asserted nowhere. **OPEN.**

## Retrospective

**Three public errors, one shape.** The spec asserted a measured conclusion that was wrong twice. The
code shipped a guard defeated by object identity while its own comment stated the correct premise.
And the security pass found the spec arguing against a fix by citing a function nothing calls.

Every one is *a claim made by reading*, and this loop knew that — it is the rule at the top of
`sdlc/README.md`, written by loop 030, which broke it too. **Four consecutive loops.** The honest
conclusion is not "try harder": it is that the rule cannot be self-enforced, and the reviewers are
the enforcement. All three findings came from an agent that re-ran the measurement instead of reading
the table.

**New rule: a rationale that cites a function is not valid until you have checked the function is
called.** `detectClockSkew` was a perfectly good reason not to clamp, except that it has been dead
since it was written. Dead code is worse than absent code in exactly this way — it looks like a
reason. Grep for callers before citing behaviour.

**And a sharper form of the surface rule.** Loop 031 improved on 030 by asking *what gets serialised*
rather than *what reads this field* — that is how `--json` was found. It then stopped at stdout, and
`tier` was going to a file the whole time. The full question is **what leaves the process**: stdout,
a file, a socket, a payload. A surface enumeration that stops at the terminal is the same
incompleteness wearing better clothes.

One thing that worked exactly as designed, worth recording because it is rare: **a positive
precondition caught a vacuous fixture.** `closed-sets.test.ts` derives its set by running
`normalize()`; my first fixtures used the wrong field names, so three producers were never reached,
and the subset assertion passed anyway because a smaller set is trivially a subset. Only
`expect(produced.length).toBeGreaterThanOrEqual(9)` failed. The auditor then corrected my write-up of
it: the sibling superset test fails on those fixtures too, so the precondition was not the *only*
thing that caught it — commit 2's body credited a counter-measure with more than it did, which is the
loop's own failure mode appearing inside its account of the loop's own failure mode.

## Next stage

None. No production signal, so no `incident.md`. The OPEN items above are sdlc/032's `intent.md`
candidates; the snapshot-level validator, the spec-versus-fence check and the lint budget are one
coherent harness-plus-product loop.
