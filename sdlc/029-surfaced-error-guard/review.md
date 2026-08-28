# Review: close the set of surfaceable error messages

Range reviewed: `31d682a..HEAD` — `706dac4` (steps 1+2), `ed0b709` (step 3), `c3df9c9` (audit
fixes), `573e7d5` (security fixes).

Reviewers, run **sequentially** on a clean tree: `plan-to-diff-auditor` (**FENCE VIOLATED**, no
BLOCKING) and `security-reviewer` (**one BLOCKING**, three SHOULD-FIX). Both reported. Every finding
below is fixed or recorded as not-done.

## Verdict

**Accept, after remediation.** The security pass found a **rate-limit regression this loop
introduced**, and a **security-relevant signal this loop destroyed**. Both are fixed. Neither was
visible from the diff alone; both required running the code.

## Pass 1 — bugs and logical errors

### The asymmetry, and what it cost to close

`client.ts:180` already called `err.message` *"exactly the free text the telemetry allowlist exists
to keep out"*, and four lines later assigned it to a value **persisted to the cache** and **rendered
in the tooltip**. Both legs were traced and confirmed by the spec reviewer. The guard existed on the
telemetry path and not on this one, and nothing recorded that as a decision.

`FetchFailure.message` now narrows to a closed union, so a free-text producer is a compile error;
`isSurfaceableMessage` re-checks at the cache-read boundary, where a type cannot reach.

### Two guarantees that existed only on paper

- `malformedResponse` was defined in `types.ts`, handled by `failurePolicy`, and specified in
  `SPEC.md §7.2` — and **constructed nowhere**. `cooldown.ts:122` said so in a comment.
- `SPEC.md §15.2`'s "Network timeout (>5s)" scenario was asserted by a mock that threw a *synthetic*
  `AbortError`, leaving `timedOut` false. **The test named for the timeout never entered the timeout
  branch.** It now drives the real timer, which required a mock that honours the abort signal.

### A misclassification a test had enshrined

`contract.test.ts`'s malformed-JSON test was **named** *"non-JSON response body causes network error
on json()"* and asserted `serviceUnavailable`. The seventh failure path was not undiscovered — it was
documented as correct.

## Pass 1b — the plan-to-diff audit

**FENCE VIOLATED**, narrowly and mostly about the record. Every guard it tested proved non-vacuous:
it instrumented `client.ts` and confirmed all seven branches reached, saw `BRANCH:TIMER-FIRED`
precede `catch timedOut=true`, found the predicate control load-bearing, and confirmed the
typefixture errors at the right line for the right reason.

Four findings, all fixed in `c3df9c9`:

1. **A7 was violated and unmentioned** — lint 11 → 13, both from helpers I nested in the new describe
   block. **Loop 028's own A6 named this trap in writing** — *"a test written with a nested helper
   would trip `consistent-function-scoping`"* — and loop 028 also taught me to write the criterion as
   a **diff** rather than a count. I wrote 029's as a count and broke it without noticing. Hoisted.
2. **A test name asserting the opposite of its body** — `'aborted fetch returns serviceUnavailable'`
   while asserting `failureClass === 'timeout'`. The same commit celebrates renaming the *adjacent*
   test for exactly that defect.
3. **`spec.md` claimed "after B3 every consumed message is checked".** False — see Pass 2.
4. **`snapshot.test.ts` was an undeclared excursion**, and `plan.md` said "Eight paths" over a
   **nine**-row table. Loop 028's plan made the identical miscount.

## Pass 2 — security (SPEC.md §12, §17)

### BLOCKING — B1b silently removed a rate limit. Fixed.

Moving the 200-with-non-JSON path from `serviceUnavailable` to `malformedResponse` also moved it off
the §9.4 cooldown, because `malformedResponse` sat in the no-cooldown bucket — harmlessly, **while
nothing constructed it**. Measured:

```
serviceUnavailable  shouldCooldown= true
malformedResponse   shouldCooldown= false
```

Net effect: **2 authenticated requests per prompt render, unbounded**, instead of 2 per 5 minutes.
On the no-cache branch (`main.ts:318`) no cooldown envelope is written at all, so every invocation
refetches. `cache.ts:139` calls the cooldown the **only** throttle on token-bearing requests, and
`SPEC.md §2`'s risk table names prompt-hook frequency as the thing it mitigates.

**And the comment I amended in the same commit that made it stale still read** *"Both rows match the
default bucket they used to fall into, so neither changes behaviour."* True before B1b. False after.
I edited that comment to announce the class was now constructed and did not notice the announcement
falsified the sentence beside it.

Fixed: `malformedResponse` has its own row with `cooldown: true`. Three tests pinned the old policy,
including loop 014's documented-policy table; all three updated, and **`SPEC.md §9.4`'s enumeration
amended** — changing a documented policy without documenting it is how the original comment went stale.

### SHOULD-FIX — "information lost is nil" was false. Fixed.

B1 collapsed every network failure to `'Network error'`. Measured against a local self-signed server:

```
message: "self signed certificate"
code   : "DEPTH_ZERO_SELF_SIGNED_CERT"
```

Distinct from the `"Unable to connect…"` that refused/DNS give, and `failureClass` does not carry it
either — both are `serviceUnavailable`. **A TLS interception attempt had become indistinguishable
from a dead link on every surface.**

Restored as an eighth union member selected from `err.code` — a closed set of OpenSSL identifiers
mapping to a literal we choose, never `err.message`. That distinction is the whole of this loop, so
preserving the signal costs the guarantee nothing. A1 still measures 0.

### SHOULD-FIX — the consumer gate has a hole. NOT fixed; recorded.

`spec.md` claimed "after B3 every consumed message is checked". **False.**
`packages/statusline/src/main.ts:143` and `:171` read `lastErrorMessage` off the envelope directly,
bypassing `extractLastError`, so a pre-029 cache file's free text still reaches `--debug` stdout
verbatim. The reviewer checked **every** read of `lastErrorMessage`/`lastErrorClass`/`lastHttpStatus`
across all four packages and confirmed these two are the only bypasses.

Not fixed here: closing it means importing the predicate into `packages/statusline`, which this
plan's fence excludes, and widening a fence to cover a Stage 5 finding is how loops start eating each
other. Queued.

### Verified clean

Token traced end to end: read once into the `Authorization` header, referenced nowhere else — and the
diff's `catch` originally took **no binding at all**, so there was strictly less error-object surface
than before (the TLS fix reintroduces a binding that reads `.code` only). No new event kind, payload
field or leaf. No file write of any kind. TLS verification genuinely enforced — the reviewer's
self-signed probe threw rather than connecting.

## Pass 3 — compliance

No domain logic outside `packages/core`. No `any`. Bundle CJS. `SPEC.md §12` now names its enforcing
test; §9.4 and §10.5 amended by this loop and the last.

## A2 — the three arms, recorded

A2's own text makes recording part of the criterion.

| arm | condition | result |
|---|---|---|
| (a) | seed applied | `TS2322: Type '\`Authentication failed (401) at https://…\`' is not assignable to type 'SurfaceableMessage'` |
| **(b)** | seed retained, union widened to `string` | typecheck clean; **2** additional test failures |
| (c) | restored | `verify` exit 0, 822 pass |

**Arm (b) fails its own literal wording**, which demanded "exactly one additional failure". The second
is the typefixture guard — which exists only because of the `exhaustive-guard.test.ts` excursion. The
spirit is met (one names B4); the letter is not, and A2 is recorded as **partially met**.

## Mutation log — all ten rows

| # | Mutation | Predicted | Actual |
|---|---|---|---|
| M1 | drop `Authentication failed (401)` | 1 | **1** ✓ |
| M2 | drop `Rate limited (429)` | 1 | **2** ✗ |
| M3 | drop `Server error (n)` | 1 | **2** ✗ |
| M4 | drop `Unexpected status n` | 1 | **1** ✓ |
| M5 | drop `Network error` | 2 | **2** ✓ |
| M6 | drop `Request timed out` | 1 | **2** ✗ |
| M7 | drop `Malformed response` | 1 | **1** ✓ |
| M8 | revert the `json()` guard | 1 | **2** ✗ |
| M9 | remove the cache-read gate | 1 | **1** ✓ |
| M10 | free-text seed | TS2322 before any test | ✓ |
| M11 | gut the TLS branch (added at Stage 5) | 1 | **1** ✓ |

Every literal form is individually load-bearing — no row produced 0. The four wrong predictions were
wrong in the **safe** direction, and for one reason: the fixture corrections in steps 1+2 (replacing
`'Rate limited'` and `'Network timeout'`, strings no producer emits) turned those tests into a second
layer of coverage.

## What is NOT done

Each bullet was re-checked at the close of **sdlc/030-cache-read-validation** and carries its status.
Three kinds appear. `CLOSED by 030` means the code changed and a named test now fails without it.
`OPEN` means it is still true of the tree. Bullets 1–3 are records of *this loop's own* process
failures: nothing a later change can edit makes them untrue, so they are marked `OPEN (record)` and
their value is the rule they produced, not a fix.

- **A6 is UNMET, and worse than I recorded.** It permitted three expectation changes. **Seven**
  changed. I self-declared six; the auditor found the seventh — `contract.test.ts`'s timeout
  `failureClass` edit, distinct from the message edit A6 licensed.
  → **OPEN (record).** Unfixable by construction. Its output is the rule loop 030 wrote its own A6
  and A7 to obey: an expectation-change budget is only a budget if the count is *measured against a
  diff*, not self-declared. Loop 030 changed zero existing expectations.
- **A8's record is incomplete and misquotes itself.** `ed0b709`'s body says "nine mutations" over a
  ten-row plan (one literal form never run — the auditor ran it: 1 failure, as predicted), and claims
  M8 was "predicted 2" when `plan.md:119` predicts **1**.
  → **OPEN (record).** Its output is loop 030's A8, which requires the prediction column to be
  committed in `plan.md` *before* the run and the commit body to quote that file rather than memory.
- **A2 arm (b) yields two failures, not "exactly one".**
  → **OPEN (record).** Loop 030's A2 asks for a *named* failing test rather than a count, which is
  what the criterion was actually trying to buy.
- **The `--debug` bypass stays open** (`main.ts:143`, `:171`), as does `printLiveDebug`'s
  `fetchError.message: string`, which the producer type does not reach.
  → **Both `--debug` sites CLOSED by 030; `fetchError.message` OPEN.** `main.ts:143` and `:171` both
  read `lastErrorMessage` off the *cache envelope*, and 030's B1 validates it in `readCacheResult`
  before either can see it — which is why neither line had to be edited. Proved end to end by
  `smoke.test.ts`'s `--debug` case against the compiled binary. `printLiveDebug`'s `fetchError`
  parameter is a different value: the *live* fetch result, still typed `string`, still unnarrowed.
  It is unreachable from a cache file and remains open.
- **`CacheEnvelope.lastErrorMessage` is still `string | null`.** The type closes the set on
  `FetchFailure.message` only; the field actually persisted and printed is unnarrowed, and both
  writers accept `string | null`. The reviewer compiled a leak through it cleanly.
  → **CLOSED by 030 (B2).** The field, `makeCacheEnvelope`'s parameter, `enterCooldown`'s
  `errorMessage`, and `format.ts`'s `LastErrorInfo.message` all narrowed to
  `SurfaceableMessage | null` in one commit. The same leak now needs an `as never` to compile, and
  the two places 030 writes one are annotated as load-bearing.
- **The type and the predicate disagree at the edges** — `` `Server error (${number})` `` accepts
  `-1`, `NaN`, `1e5`; the regex rejects all three. Unreachable today; the predicate is the tighter.
  → **OPEN, and re-measured — the original claim was half wrong.** `-1` and `1e5` are accepted by the
  template type (`1e5` renders `100000`); `NaN` and `Infinity` are *rejected* by it with TS2322. So
  the disagreement is narrower than recorded: two values, not three. Still unreachable, since no
  producer constructs a status outside 100–599.
- **`ok: false, statusClass: '2xx'`** is newly reachable via `malformedResponse` and asserted nowhere.
  → **OPEN.** Out of 030's scope fence (`client.ts` is explicitly not touched). Still unasserted.
- **`commands.ts:26` and `enterprise.disabledReason`** remain uncovered, both deferred by name.
  → **DEFERRED.** `packages/vscode/src` is explicitly outside 030's fence; `enterprise.disabledReason`
  is a display concern with no §12 exposure.
- **`metrics.db` is mode 0644, not 0600** — outside this diff entirely, reported as an observation.
  → **DEFERRED.** Outside 030's fence too (`packages/metrics` is named in it). Carried as a standing
  observation, not a finding against either loop.

## Retrospective

Two findings this loop, and **both were regressions this loop introduced**. That is the "a fix is not
exempt from review" principle arriving with teeth: B1b was a *correctness improvement* that removed a
rate limit, and B1 was a *security improvement* that destroyed a security signal.

The shape is worth naming, because it is new to this catalogue: **a change that moves a value from
one bucket to another inherits the destination's properties silently.** `malformedResponse` was safe
in the no-cooldown bucket for exactly as long as nothing constructed it. Constructing it was the whole
point of B1b — and the same commit *edited the comment saying so* without noticing that the edit
falsified the sentence beside it. The stale comment and its falsifier were adjacent lines in one diff.

**New rule for `sdlc/README.md`: when a change makes a previously-unconstructed case reachable, audit
every table that case appears in.** A `switch` arm nothing reaches is not a decision — it is a default
wearing a decision's clothes, and the moment you make it reachable you have adopted whatever it says.

The second finding refines a rule this loop already had. "Information lost is nil" was a claim about
what a platform emits, and I had *measured* it — badly. The first probe raced `AbortSignal.timeout(1)`
against a refused connection, so the refusal won and I recorded its message as the timeout's; the TLS
case I never probed at all. **A measurement that does not isolate the case it names is worse than no
measurement, because it is presented as evidence.** Loop 029's spec was rewritten once for exactly
this and the corrected table still had a hole in it.

Eleven mutations, seven predictions right. The four wrong ones were wrong safely — and the reason
(earlier fixture corrections doubling as coverage) is the one genuinely pleasant surprise here.
