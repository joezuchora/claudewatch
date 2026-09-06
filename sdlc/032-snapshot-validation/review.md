# Review: validate the whole snapshot, not four fields of it

Range reviewed: `de4c232..HEAD` — `c09eba8` (closed sets + `sanitize-snapshot.ts`), `f57f77f` (wire
it in + `PayloadLeaf`), `8224e31` (fourteen tests), `61788a2` (SPEC.md), `864fc9b` (audit
remediation), `7aa5218` (security remediation).

Three reviewers, all run **sequentially** on a clean tree and briefed on a commit range:
`spec-reviewer` at Stage 2 (**five BLOCKING**, seven MAJOR, seven MINOR); `plan-to-diff-auditor`
(**three BLOCKING**, four SHOULD-FIX, two NIT); `security-reviewer` (**no BLOCKING**, four
SHOULD-FIX, three NIT, two informational). All three reported before this file was written.

## Verdict

**Accept, after two rounds of remediation.** The boundary now holds: 26 of 26 poisoned values are
scrubbed, no unknown key survives at any depth, and a bare-string telemetry payload is a compile
error. But this loop shipped **a rebuild bug that passed all 870 tests**, **an end-to-end leg that
could not fail while `SPEC.md` asserted it as evidence**, and **a display bug that showed a user at
96% the number 3%**. None was caught by me; all three were caught by reviewers, and two of the three
were only findable by running code rather than reading it.

## What the change does

`readCacheResult` passes the snapshot through `sanitizeSnapshot`, a **whitelist rebuild** that
constructs a fresh `UsageSnapshot` naming every field. Unknown keys at any depth are dropped by
construction; every leaf is a closed-set member, a checked number, a constructed timestamp, or a
bounded string. Coupling rules stop independent degradation inventing states no producer can emit.
`lastHttpStatus` is validated separately as an envelope field. `MetricEvent.payload` narrows to
`PayloadLeaf`. `main.ts` is not edited — validating at the boundary fixes every consumer.

## Pass 1a — the Stage 2 spec review (five BLOCKING)

Recorded in full in `spec.md`'s revision. The two that changed the design:

- **My leak count was 14; it is 26.** The probe behind my table poisoned `fiveHour` but not the
  other two windows, three of `enterprise`'s six fields but not the rest, and never seeded an
  unknown key at the enterprise level — a level my own edge-case table asserted.
- **I measured the wrong renderer.** I ran `formatStatusLine`, got `⊙ error`, and wrote "this
  settles question 2". `formatRichStatusLine` — the *default* production renderer — never reads
  `primaryUtilizationPct` and renders normally. I measured the fallback.

Also: `lastHttpStatus` is an envelope field my A8 would have deleted the §12 paragraph about;
narrowing `renderEvent`'s two parameters does **not** stop a *new* string field (proved by adding
one and watching typecheck exit 0); and A3 was vacuous for five fields whose fixture value equals
their own degraded value.

## Pass 1b — the plan-to-diff audit (three BLOCKING)

**Fence CLEAN.** Fourteen paths declared, fourteen changed, one-to-one, no globs, negative list
honoured, commit-to-row assignment exact. The auditor called it the strongest fence in the series.

### BLOCKING — a rebuild bug that passed all 870 tests

Hardcoding `isEnabled: false` in `sanitizeEnterprise` was **completely silent**. It is a live
user-facing bug: `format.ts:373` gates on `!e.isEnabled`, so every enterprise account with extra
usage *enabled* would read back disabled after one cache read. Dropping the `currency` check and
deleting either `disabledReason` rule were silent too — **four of six enterprise rules were
load-bearing in production and untestable by the fixture that claimed to test them.**

The cause was a fixture defect, not a design one: the poisoned envelope corrupts
`enterprise.utilizationPct`, which nulls the whole object and masks every other enterprise field.
This is the Stage 2 reviewer's `currency` argument reproduced on fields the fix did not cover.
Closed by a second envelope with **valid** numerics; all four mutations now fail.

Writing that fixture caught me misreading my own rule — I asserted a non-boolean `isEnabled`
degrades to `false`; it nulls the whole object. The precondition fired immediately.

### BLOCKING — the `--debug` leg could not fail, and SPEC.md had been made to assert it

`printDebug` emits a **fixed key list**: from the snapshot only `fetchedAt`, `classify()`,
`normalizationWarnings` and `freshness`. The 24 keys T2 asserted could not reach that surface at
all. **Proof: under the mutation making `sanitizeSnapshot` a total no-op — 22 other tests red — T2
stayed green.**

My own diagnosis one iteration earlier was "a strict subset of T3". The truth was stronger: the
snapshot assertions were *entirely* vacuous. Worse, commit 4 had promoted the claim into `SPEC.md`
as "checked end to end on **both** `--debug` and `--json`", making a false sentence the repo's
source of truth. T2 now asserts what `--debug` can see; `SPEC.md` says `--json` is the
whole-snapshot leg.

### BLOCKING — `SANITIZED_FIELDS` stopped at the top level

Eleven top-level keys named; fifteen validated leaves live in nested shapes with no equivalent.
Measured: adding `newNestedField?: string` to `EnterpriseUsage` typechecked clean and passed 870
tests, silently dropped. A11's headline — "one place names every validated field" — was true of
eleven of twenty-six, **the exact arithmetic A11 exists to stop the next loop re-running.** Six
nested `never` guards added; the auditor's own probe now fails to compile.

## Pass 2 — security (no BLOCKING, four SHOULD-FIX)

### A user at 96% was shown 3%

`display.primaryUtilizationPct` was accepted on its own merits and never cross-checked against the
window it names. Measured:

```
fiveHour.utilizationPct = 96,  display.primaryUtilizationPct = 3
renders: "⊙ 3% resets thu 12:00 am · 7d 18% …"      classify: Healthy
```

A green VS Code status bar with it, because the thresholds key off the same field. It **understates**
usage, which is the direction that costs the user something. My coupling rules were written to stop
exactly this class of invented state and did not cover it.

Both display fields are now **derived** from the window `primaryWindow` names — this module's own
rule (return what you constructed, never what you read) applied to a pair I had let through. A third
coupling gap went with it: `primaryWindow: 'enterprise'` beside `enterprise: null` under a
*non*-enterprise tier passed both rules and rendered a fabricated percentage.

### The reject clause outlived its justification and cost the §9.4 throttle

It rejected a missing `display` or `freshness` because there was "nothing coherent to substitute".
After the whitelist rebuild that is false — `sanitizeSnapshot` constructs both. Measured:

```
display: null  ->  invalidShape, file deleted, live cooldownUntil DISCARDED
display: "x"   ->  hit,          file kept,    cooldown preserved
```

The same class of garbage cost the only throttle on token-bearing requests **or not, depending on
truthiness**. One byte. Only a non-object snapshot still rejects.

### The `disabledReason` blacklist leaked, including control characters

The reviewer drove an FQDN, a username, a Windows path, a JWT, an underscored token, ANSI escapes,
newlines and tabs through the four-shape blacklist and into the tooltip verbatim. **A blacklist
enumerates what you thought of.** Replaced with a positive whitelist — what an administrator's
sentence is made of — plus a structural rule rejecting a dot or colon wedged between non-space
characters, which is what separates an identifier from prose. All nine probes now drop;
`"Note: contact your administrator."` survives. Stated cost: `"e.g."` is rejected too.

The order was already right and the reviewer confirmed it: both checks run on the **full** string
before the slice, so a 5,000-character value with a token at index 4,000 is dropped entirely rather
than truncated into apparent safety.

### Verified clean

Token traced end to end; no new `fetch`, agent, `rejectUnauthorized` or `NODE_TLS_REJECT_UNAUTHORIZED`;
`writeCache`'s temp+rename, `0700`/`0600` unchanged; credentials never written outside a `mkdtemp`;
enterprise credit amounts absent from every payload; `PayloadLeaf` real and not defeated by a cast,
verified through both bridges; both new smoke tests network-inert by two independent mechanisms,
confirmed by reading.

## A6 — the mutation table. **UNMET: 3 of 10.**

Predictions committed in `plan.md` at `de4c232`, verified to precede all four implementation commits.

| # | Mutation | Predicted | Measured |
|---|---|---|---|
| M1 | sanitiser returns its input | T1,T2,T3,T4,T12,T13 | **22** |
| M2 | drop `usageEndpoint` | T1,T2,T3 | T1,T3 |
| M3 | drop `authState` | T1,T2,T3 | T1,T3 |
| M4 | drop `primaryWindow` | T1,T2,T3 | 5 |
| M5 | drop window `resetsAt` | T1,T2,T3 | T1,T3 |
| M6 | drop enterprise numerics | T1,T2,T3,T10 | T1,T3,T10,T12 |
| M7 | drop `currency` | T1,T2,T3 | **nothing** |
| M8 | delete coherence | T12,T13 | ✓ |
| M9 | drop `lastHttpStatus` | T14,T2 | ✓ |
| M10 | widen `PayloadLeaf` | T9 | ✓ |

**A6 is UNMET on two counts**, and naming tests instead of counts is what made both visible:

1. **3 of 10.** Every miss is diagnosable, which a count could not have given me. M1 missed because
   commit 2 folded loops 030 and 031's guards *into* the function being mutated, so it gutted three
   loops at once. M2/M3/M5 missed because of the `printDebug` fixed key list. M7 was **inverted** —
   I predicted the leak tests would catch a dropped `currency` and the round-trip would not; in fact
   the round-trip is the only catcher.
2. **M6 and M7 are not reproducible from their own text.** The auditor ran two readings of "drop the
   enterprise numeric checks" and got 4 and 4 where I recorded 2; and `plan.md`'s M7 as literally
   worded ("drop `currency`'s **check**") measures **0**, not the 1 I recorded for a different
   mutation. A prediction a reader cannot reproduce from the row is not a contract, and that is an
   A6 defect independent of the score.

## A9 — **UNMET: five changed expectations against a predicted zero**

| # | Expectation | Cause |
|---|---|---|
| 1 | loop 031's T14 positive control | seeded `tier:'enterprise'` beside `enterprise:null` — the incoherent pair the new coupling eliminates |
| 2 | `exhaustive-guard.test.ts` fixture count 6→7 | anticipated by fence row 11 |
| 3 | T12b | the reject-clause reversal |
| 4 | `cache.test.ts` invalidShape pin | same |
| 5 | `call-sites.test.ts` invalidShape pin | same |

The spec recorded a **measured** zero, taken by the Stage 2 reviewer against a prototype. That number
was honest and turned out not to describe this implementation — which is why `plan.md` marked it
INHERITED and required Stage 4 to re-take it. It did, and the answer is five. Recorded, not
reconciled.

## Criteria

A2, A4, A5, A7, A8, A10, A12, A13 **MET**. A1, A3, A11 were **PARTIAL** at the audit and are MET
after `864fc9b`. A6 and A9 **UNMET**, above.

## What is NOT done

- **stderr is unconstrained and structurally untested.** `main.ts:398`'s `console.error` interpolates
  an unbounded `string`; an `EACCES` out of `writeCache` puts the absolute cache path, hence the home
  directory, on it. No cache-derived value reaches it today (the one that did — `pct.toFixed is not
  a function` — is closed by `sanitizeEnterprise`). **Both smoke runners spawn with stderr
  `'ignore'`, so every e2e leak assertion in loops 031 and 032 is blind to that channel by
  construction.** OPEN, and it is the same structural shape as loop 031's `--json` miss.
- **The `--json` `disabledReason` leg is vacuous** for the same masking reason the audit found on the
  enterprise rules — the e2e fixture poisons the numerics. Unit coverage is real; the e2e leg is not.
- **`normalize()` does not sanitise `disabledReason`.** Redact-then-bound is a cache-read-only
  property, so §12's bullet is true only from the second render onward. OPEN.
- **No ceiling on `utilizationPct`** — `1e21` renders `⊙ 1e+21%`. The comment argues correctly against
  a 0–100 clamp; it does not argue for *no* bound.
- **`printLiveDebug`'s `fetchError.message` is `string`**, not `SurfaceableMessage` — sdlc/030's
  finding, still open, out of fence.
- **Unknown envelope keys** survive, inert at every current surface.
- **`parseSessionInfo` `as`-asserts stdin**, outside this boundary entirely.
- **A12 is still a manual step.** Fifth violation in four loops — see below.

## Retrospective

**The dominant failure is no longer "a claim made by reading". It is a test that cannot fail.**

Three of this loop's four worst defects were tests or criteria that were green for structural
reasons: T2 asserting 24 keys against a surface that emits four; the enterprise fixture masking four
of six rules behind a nulled object; `SANITIZED_FIELDS` naming eleven of twenty-six leaves. Each was
*written* to check the thing it names. Each *could not*.

**New rule: a test that has never been seen to fail has not been tested.** Mutation testing is how
this repo checks that, and this loop proves the check must be per-rule, not per-guard — the four
silent enterprise mutations all lived under one guard I had already mutated once and declared
load-bearing.

**The second rule is about masking.** A fixture that poisons everything at once tests only the first
check that fires. `sanitizeEnterprise` returns `null` on any bad numeric, so a fixture poisoning the
numerics can never reach `currency`, `disabledReason` or `isEnabled`. **When a validator
short-circuits, one poisoned fixture is not a test suite — it is a test of the short circuit.**

**And a third, from the security pass: a blacklist enumerates what you thought of.** The
`disabledReason` blacklist had four shapes and leaked six more, including ANSI escapes into a
terminal. The whitelist that replaced it is not clever; it is just the right direction of
enumeration.

On A12: the lint budget broke **five times across four loops**, always caught by hand, three times in
this loop alone. Loop 030's review concluded a criterion the gate cannot run is a note rather than a
check. Three loops have now agreed with that in writing and none has acted on it. Loop 033 is where
that stops being a preference.

Finally, the thing worth saying plainly: **the reviewers found what I could not.** The `isEnabled`
bug, the vacuous `--debug` leg and the 96%-shown-as-3% display bug were all invisible to a green
suite and to me reading my own diff. Two of the three required running code. That is the fourth
consecutive loop where the adversarial gates were the enforcement rather than the ceremony.

## Next stage

None. No production signal, so no `incident.md`. The OPEN items are loop 033's candidates alongside
the two harness gates; **stderr and the `--json` `disabledReason` leg are the two worth taking first**,
because both are surfaces a test claims to cover and does not.
