# Review: validate `lastErrorMessage` where it enters

Range reviewed: `88da224..HEAD` — `aa65659` (B1+B2 together), `9b9dbce` (the tests and 029's gap
list), `04ce575` (Stage 5 remediation).

Reviewers, run **sequentially** on a clean tree, both briefed on the commit range and told not to
write into the working tree: `plan-to-diff-auditor` (**EXCURSIONS RECORDED** — one BLOCKING, four
SHOULD-FIX, two NIT) and `security-reviewer` (**no BLOCKING**, three SHOULD-FIX, two NIT, one
informational). Both reported. Every finding below is fixed or recorded as not-done.

## Verdict

**Accept, after remediation.** The change does what it claims: free text read off a cache file
cannot reach `--debug`, the tooltip, the statusline or telemetry. But the security pass found a
**second, live §12 leak three lines below the new guard, in the same function, under a comment this
loop wrote calling the field "sanitised"** — and the audit found this loop **reproducing the exact
failure it was opened to criticise 029 for**. Both are fixed in `04ce575`.

## Pass 1 — bugs and logical errors

### The hole 029 left, and why fixing it edited no consumer

029 closed the message set at the producer (`FetchFailure.message`) and at **one** consumer
(`extractLastError`). `main.ts:140` and `:168` read `lastErrorMessage` straight off the envelope and
never call it, so a cache file written before 029 — when the network path assigned `err.message`
verbatim — still surfaced free text to `--debug` stdout.

Validating in `readCacheResult` fixes every consumer at once **without editing any of them**. The
security reviewer enumerated all six reads of the field across all four packages and confirmed the
envelope reaching each one passes through `readCache()` → `readCacheResult()`; no raw reader of
`usage.json` exists outside `cache.ts`. 029's "wrong by two call sites" failure is not repeated.

### Degrading, not rejecting — the load-bearing half of the design

B1 nulls the field and keeps the envelope. Had it rejected, it would have joined the
`tryDelete(path)` paths — and `cooldownUntil` lives in the same file. One poisoned byte in
`lastErrorMessage` would then delete the cache on every read, discarding the cooldown with it: a
token-bearing fetch on every prompt render, removing §9.4's only throttle. That is precisely loop
029's BLOCKING defect class, and the reviewer verified empirically that the cooldown survives the
nulling (`cooldownActive: true, lastErrorMessage: null`).

## Pass 1b — the plan-to-diff audit

**Fence held.** Eight files changed in `88da224..9b9dbce`, all eight declared rows; nothing from the
negative list touched. The auditor noted the fence is *specific enough to have been violable* — nine
named paths and an explicit negative list, no `packages/**` glob.

### BLOCKING — this loop reproduced the failure it exists to criticise. Fixed.

`sdlc/029/review.md:207` and `9b9dbce`'s body both published *"two values, not three"* for the
type/predicate divergence set. This loop's own `spec.md:89-94` had measured it and called `-1`
**"the only divergence"**. Re-measured independently, both sides:

| value | template type | `/^Server error \(\d+\)$/` | diverges? |
|---|---|---|---|
| `-1` | accepted | rejected | **yes** |
| `1e5` → `100000` | accepted | accepted | no |
| `NaN` | TS2322 | rejected | no |
| `Infinity` | TS2322 | rejected | no |

The set is `{-1}`, size **one**. The marker counted *values the template type accepts* and labelled
that count "the disagreement". `spec.md:83-87` opens B4 by naming this exact behaviour — *"copied
verbatim from 029's review without re-measurement"* — and `spec.md:24-26` says *"a wrong number in a
table headed Measured is a first-class defect in this repo, not a typo."* Fixed in `04ce575`, with
the measurement table above written into 029's marker so the next reader gets the evidence and not
another number to trust.

### SHOULD-FIX from the audit

1. **The new block was inserted between a comment and the code it documented** — "nulled on garbage,
   clamped on magnitude" read as if it described `lastErrorMessage`, which is nulled but never
   clamped. In a commit whose A5 is about comment accuracy. **Fixed**: the three validators each
   carry their own comment, immediately above their own statement.
2. **`client.ts:161-164` — `isSurfaceableMessage`'s own docstring is now false.** It says the
   predicate closes the set "at the CONSUMER… `extractLastError` reads `lastErrorMessage` off disk".
   After B1 the primary caller is `readCacheResult`. **NOT fixed** — `client.ts` is on the explicit
   negative list. Recorded below.
3. **`snapshot.ts:58-62` — same staleness, and it is spec B3's unimplemented half.** `spec.md` said
   the gate should be *"KEPT, **and relabelled**"*; `plan.md`'s fence then forbade touching
   `snapshot.ts`. **Plan and spec contradict each other**, and no acceptance criterion catches it.
   **NOT fixed.** Recorded below.
4. **A test named for a boundary it does not touch** — `'the cache-read boundary drops a message no
   producer emits'` constructs in memory; the test 18 lines below it is the one at the boundary.
   **Fixed**: renamed to `'extractLastError drops a message no producer emits, in memory'`.

### C1 — A3's grep is defeated by spelling. Fixed by the fence's own row 9.

The auditor rewrote `types.ts:80` as `null | string` — semantically identical to the widening A3 is
the **sole** net for, per `plan.md:105-110`. Measured: `typecheck` 0, **824 pass**, grep **silent**.
A3 was also never wired into `verify` or CI; it lived as prose in a review document.

Row 9 of the fence was conditional on *"the grep proving weak in practice"*. That condition fired.
`typefixtures/widened-cache-message.expect-error.ts` freezes all four narrowed sites against the
**real** types and asserts **exactly four** TS2322s — a floor assertion would stay green while three
of the four widened back. `exhaustive-guard.test.ts`'s fixture count goes 5 → 6, as `plan.md`
declared in advance it would have to.

Verified: under `null | string`, typecheck 0 and the grep silent, **the fixture fails**. It catches
what the grep and all 824 other cases missed.

## Pass 2 — security (SPEC.md §12, §17)

### SHOULD-FIX — a live §12 leak three lines below the new guard. Fixed.

`sanitizeCooldownUntil` validated with `Date.parse` and returned **`value` verbatim** on the
in-range path. `Date.parse` accepts far more than ISO-8601 and its legacy parser ignores
parenthesised trailing text. Measured:

```
Date.parse("2026-01-01 (/home/someone/.claude sk-ant-oat01-SECRET)")  -> 1767225600000  PARSED
Date.parse("2026-01-01T00:00:00.000Z (leak someones-nuc.local)")      -> NaN            REJECTED
```

Finite, below the ceiling, returned whole — path, token-shaped literal, hostname — and printed by
`--debug` at `main.ts:140` and `:168`. The reviewer reproduced it against the compiled binary in a
sandboxed `HOME`, having first read the `--debug` path to confirm it is network-inert.

The clamp branch always **constructed** its result; only the passthrough echoed its input. Now
`new Date(Math.min(ms, ceiling)).toISOString()`: what comes out is always a string we built. Every
consumer already reads it through `new Date(...)`, so the change costs nothing.

**Fixed in-loop rather than queued**, and the reasoning is worth stating because 029 chose the other
way: 029 queued its `--debug` bypass, and that gap stayed open for a full loop while a real leak
existed. This is the same class, in the same function, found by the pass reviewing the fix for it.
Pinned by `cache.test.ts` → *"a parseable string carrying free text is canonicalised, not echoed"*,
which fails when the passthrough is restored.

### SHOULD-FIX — the comment's count was wrong in the other direction. Fixed.

The new comment claimed "**THREE** fields cross the `as CacheEnvelope` assertion unchecked". Three
are **validated**; at least three more cross **unvalidated** and reach `--debug` stdout verbatim:
`snapshot.fetchedAt` (checked `typeof === 'string'` and nothing more),
`snapshot.freshness.staleReason` (presence of `freshness` only), and
`snapshot.rawMetadata.normalizationWarnings` (not checked at all). All three are closed-set at every
writer today — **which is exactly the posture 029 left `lastErrorMessage` in, and which this loop
declared insufficient.**

Fixed by saying both, in the comment and in `SPEC.md §12`, with the three named as an **open gap**
rather than left implied. Not closed here: closing it is a separate change with its own tests, and
widening this fence twice in one Stage 5 is how loops start eating each other.

### SHOULD-FIX — A4 was asserting against a stale binary. Fixed.

`smoke.test.ts`'s `beforeAll` rebuilt only when the binary was **absent**, and `scripts/verify.ts`
runs `test` **before** `build`. So the end-to-end case ran against a binary compiled from an earlier
source state: deleting `cache.ts`'s guard left this file green while the core suite went red. The
mutation table in Stage 4 only caught it because I rebuilt by hand between rows — the audit
independently hit the same confound and said so.

A4 was supposed to be the *stronger* of the two checks and was the weaker. `beforeAll` now rebuilds
when the binary is older than the newest `.ts` under `packages/core/src` or `packages/statusline/src`.
Verified: guard deleted, **no manual rebuild**, the case fails.

### NITs, fixed

- The import-cycle comment claimed more than its premise gave. `client.ts` does not import
  `cache.ts`, but it imports `telemetry.ts`, which imports `getCacheDir` from here — so
  `cache → client → telemetry → cache` closes. Benign (everything crossing is a hoisted function
  declaration) and the `cache ↔ telemetry` arm pre-existed, but a module-level `const` added to
  `client.ts` would TDZ. Comment corrected to say that.
- One `FAKE_TOKEN` constant instead of two hand-rolled copies of a token-shaped literal.
- `main.ts:203-206` → `:204-207` in three citations. `:203` is the comment.
- *"`printDebug` omits every cache key on a miss"* — it omits `lastErrorMessage` and
  `lastHttpStatus`, and reports `cacheAgeSec: null`. The assertion was sound either way; the
  sentence was not.

### Verified clean

Token traced end to end — the only production reader is `resolveCredentials` → `fetchUsage`, neither
reached by the diff. No new payload field, leaf or event kind; `telemetry.ts` not in the range. No
new production write path; `writeCache`'s temp-plus-rename, `0700` and `0600` unchanged. No `fetch`,
no agent, no `rejectUnauthorized`, no `NODE_TLS_REJECT_UNAUTHORIZED`. Both `as never` casts confined
to test files, where `never` is assignable to everything and cannot propagate. The new smoke case is
network-inert by two independent mechanisms, both confirmed **by reading**: `--debug` without
`--refresh` returns at `main.ts:204-207` before `resolveCredentials`, and the seeded credential's
`expiresAt` is a day in the past.

## Pass 3 — compliance

No domain logic outside `packages/core`. No `any`. Bundle CJS. `SPEC.md §12` amended by this loop
with both the fix and the open gap.

## A2 — both arms, recorded

| arm | condition | result |
|---|---|---|
| (a) | `cache.ts`'s `if` block deleted | **`(fail) §12: … > free text read off DISK is nulled at the parse boundary`** — named, single, in `packages/core/src/security.test.ts` |
| (b) | restored | `verify` exit 0 |

Confirmed independently by the security reviewer (17 pass / 1 fail, the poisoned string as the
received value) and by the auditor.

## A8 — the mutation table, predicted before the run

Predictions were committed in `plan.md` at `88da224`, **before** either implementation commit — the
property 029 failed. All six reproduce, and the auditor re-ran every row independently.

| # | Mutation | Predicted | Measured |
|---|---|---|---|
| M1 | delete B1's `if` | 2 | **2** |
| M2 | invert the condition | 2 | **2** |
| M3 | predicate → `true` | 2 | **2** |
| M4 | delete `extractLastError`'s gate | 1 | **1** |
| M5 | widen the field back | typecheck 0, **no test fails** | **exactly that** |
| M6 | seed `--debug` with a cache miss | 1 | **1** |

**M5's green is the finding, not a success.** Nothing in 824 cases caught a re-widening. That is why
A3's first draft — a grep that could not fail — was BLOCKING, and why the audit's demonstration that
the *replacement* grep is defeated by `null | string` mattered enough to trigger row 9. As of
`04ce575`, M5 fails: the new fixture catches it.

Both reviewers independently hit the same trap on M4 — the first run shows **2** because
`dist/claudewatch` is still compiled from the previous mutation. Rebuild between rows. That confound
is now impossible to hit by accident, since `beforeAll` rebuilds a stale binary.

## What is NOT done

- **`client.ts:161-164`'s docstring is stale** — it describes the predicate as closing the set at
  the consumer. `client.ts` is on this fence's explicit negative list. **OPEN**, queued.
- **`snapshot.ts:58-62` is stale, and spec B3's "relabelled" half is unimplemented** — the spec
  asked for it and the plan's fence forbade it. **OPEN**, and the contradiction itself is the more
  interesting defect: no acceptance criterion compares the spec's verbs against the plan's fence.
- **Three fields still cross `readCacheResult` unvalidated** (`fetchedAt`, `staleReason`,
  `normalizationWarnings`) and reach `--debug` verbatim. **OPEN**, now named in `SPEC.md §12` rather
  than implied.
- **`ok: false, statusClass: '2xx'`**, newly reachable via `malformedResponse` since 029, is still
  asserted nowhere. **OPEN**, `client.ts` outside the fence.
- **A3 as a grep is dead weight** — superseded by the fixture, but its text still stands in
  `spec.md`. The criterion should have been "a check that runs in `verify`", not "a grep".
- **`commands.ts:26`** (raw `err.message` into a modal) and **`enterprise.disabledReason`** remain
  uncovered. **DEFERRED**, `packages/vscode/src` outside the fence.
- **`metrics.db` is mode 0644.** **DEFERRED**, outside the fence.
- **`readCacheResult` still accepts `staleReason: null`** — presence-only validation. **OPEN.**

## Retrospective

Three loops running, the same shape each time: **the claim made by reading.** This loop found the
sharpest version yet, because it was mine and it was in the sentence criticising someone else for it.

`spec.md:83-87` opens B4 by naming 029's error — *"copied verbatim from 029's review without
re-measurement, the exact behaviour this loop's thesis criticises 029 for"* — and then the closing
artifact published a number I had not measured, in the marker A9 exists to produce, and the commit
body asserted it. The spec two directories away had the right answer written down. **Writing the
rule down does not execute it.** The only thing that caught it was a reviewer who re-ran the
measurement instead of reading my table.

The security finding has a different and older shape, worth its own entry: **a validator that
returns its input is not a validator.** `sanitizeCooldownUntil` checked `Date.parse(value)` and then
returned `value` — the check and the return value were about different things, and the gap between
them was invisible because the name said "sanitize". Three lines above it, a guard I had just added
did the same job correctly by *reconstructing* the value. The two idioms sat in one function for
sixteen loops.

**New rule for `sdlc/README.md`: a function that validates a value from outside the trust boundary
must return something it constructed, not something it read.** `Date.parse` returning finite says
nothing about what else is in the string. The same applies to any parse-then-passthrough:
`parseInt`, a regex `.test()` followed by returning the original, a schema check that returns its
argument.

And one about process. 029 queued its `--debug` bypass because *"widening a fence to cover a Stage 5
finding is how loops start eating each other."* That reasoning is sound and it cost a loop of
exposure. The distinction this loop is drawing: **queue a gap, fix a leak.** A missing check waits.
A value already reaching stdout does not — especially when the pass that found it was reviewing the
fix for its twin.

## Next stage

None. No production signal, so no `incident.md`. The four OPEN items above become the next loop's
`intent.md` candidates; `client.ts`'s and `snapshot.ts`'s stale docstrings plus the three
unvalidated fields are one coherent change and should go together.
