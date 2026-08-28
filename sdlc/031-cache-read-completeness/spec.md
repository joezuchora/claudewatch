# Spec: finish the cache-read boundary

- **ID:** 031-cache-read-completeness
- **Stage:** 2 — Design
- **Status:** draft
- **Derived from:** [`intent.md`](./intent.md)

## Summary

`readCacheResult` will validate every value it returns from a cache file, not three of them. The
three fields loop 030 named as a known gap — `snapshot.fetchedAt`, `snapshot.freshness.staleReason`,
`snapshot.rawMetadata.normalizationWarnings` — are degraded to values this repository constructed
whenever they fail their check, using the idiom loop 030 settled: **keep the envelope, replace the
field**. Two docstrings stop describing where the check used to run.

## What was measured before designing

The intent asserted these three fields "reach `--debug` stdout verbatim". That claim is inherited
from loop 030's security pass and this loop's thesis is that inherited claims get re-measured. Both
the claim and its boundaries were checked:

| field | verbatim surfaces | non-verbatim consumers |
|---|---|---|
| `fetchedAt` | `--debug` `lastFetchedAt` only (`main.ts:136`, `:164`) | `formatLocalTime` (**never echoes** — renders a time or the literal `unknown`, measured); `detectClockSkew` (returns `false` on unparseable); `isCacheFresh` (arithmetic) |
| `staleReason` | `--debug` `freshness` — `printDebug` emits the whole `freshness` object (`main.ts:145`) | compared only, never rendered: `state.ts:30,43,49`, `main.ts:250`, `extension.ts:175` |
| `normalizationWarnings` | `--debug` (`main.ts:144`, `:172`) | telemetry passes each through `categorizeWarning` and emits only the bucket — already pinned by `security.test.ts` → "a poisoned normalization warning cannot reach the spool as text" |

So the intent's claim is **correct and its scope is exactly right**: one surface, `--debug`. The
statusline and tooltip were checked and are clean, which is worth stating because it is the
difference between this being a `--debug` hardening and a rendered-output leak.

**A correction carried from the intent, restated so it cannot be re-inherited:** loop 030's security
pass proposed validating warnings "against `categorizeWarning`'s closed set". `categorizeWarning`
maps *any* string to a category and falls through to `'shape'`. It is a bucketer, not a predicate,
and would accept everything. The real closed set is defined below.

## Behavior

Three new degradations in `readCacheResult`, after the existing shape gate and alongside the three
that exist. All follow §12's settled rule: **degrade, never reject** — rejecting deletes the file,
which discards `cooldownUntil`, which is the only throttle on token-bearing requests (`SPEC.md
§9.4`). Loop 030's review records that reasoning in full.

### B1 — `fetchedAt` is canonicalised or replaced with a sentinel

- Parseable by `Date.parse` → replaced with `new Date(ms).toISOString()`. Same rule loop 030 applied
  to `cooldownUntil`, for the same reason: `Date.parse` accepts far more than ISO-8601 and its
  legacy parser ignores parenthesised trailing text, so `2026-01-01 (/home/someone …)` parses finite
  and was returned whole.
- Not parseable → replaced with the exported constant `UNKNOWN_FETCHED_AT`.

**No clamp.** Unlike `cooldownUntil`, a far-future `fetchedAt` is not a hazard: it makes
`isCacheFresh` *true*, which suppresses a fetch rather than causing one, and `detectClockSkew`
already exists to report it. Clamping would silently discard the skew signal that function was
written to surface.

### B2 — `staleReason` falls back to `'none'`

Not one of the five `StaleReason` members → `'none'`. `isStale` is left alone; the two are stored
independently and this change is about the reason, not the fact.

**Chosen because it changes no observable classification.** Every consumer tests for a *specific*
reason (`=== 'malformedResponse'`, `!== 'fetchFailed'`), so an unknown string and `'none'` take
identical branches at all five sites. The degradation removes the text and nothing else — which is
the property that makes it safe, and which is separately testable.

### B3 — `normalizationWarnings` is filtered to the closed set

The array is filtered to strings this repository can actually emit. A value that is not an array of
strings becomes `[]`.

The closed set is **seven** strings, all from `normalize.ts`, counted against the list and not
asserted:

| # | string | source |
|---|---|---|
| 1 | `extra_usage present but missing required fields` | `normalize.ts:85` |
| 2 | `extra_usage present but has out-of-range values` | `normalize.ts:90` |
| 3 | `extra_usage present but has invalid enabled monthly limit` | `normalize.ts:95` |
| 4 | `extra_usage.currency invalid; defaulted to USD` | `normalize.ts:102` |
| 5 | `five_hour.resets_at is not a valid ISO timestamp` | `normalize.ts:24`, called at `:126` |
| 6 | `seven_day.resets_at is not a valid ISO timestamp` | `normalize.ts:24`, called at `:127` |
| 7 | `seven_day_opus.resets_at is not a valid ISO timestamp` | `normalize.ts:24`, called at `:128` |

All three `name` arguments are string literals, which is what makes the interpolated form a closed
set rather than an open one. That was checked rather than assumed: if any call site passed a key
taken from the API response, this whole approach would be unsound.

My first draft of this paragraph wrote "eight" and then arithmetic caught it. Loop 028 said "nine"
over eleven rows, loop 029 said "eight" over nine, loop 030 published a divergence count it had
never measured. The counter-measure is the table above, plus code that derives the count from the
array rather than from a literal.

To stop the set and the producer drifting, `normalize.ts` sources its warning strings from the same
exported constants. **This is an edit to `normalize.ts`**, which `intent.md` placed out of scope —
scoped narrowly: the strings it writes are byte-identical, pinned by existing tests, and only their
spelling moves. Declared rather than slipped in.

### Amendments to `SPEC.md`

- **§12's "Known gap" paragraph**, added by loop 030, is **deleted** — the gap is closed. Leaving it
  standing while the code beneath it changed is the failure this loop's siblings keep shipping.
- **§12 gains** the three new degradations, each naming its pinning test.
- **`types.ts:20`'s comment** (`fetchedAt: string; // ISO timestamp, always UTC`) becomes true or
  becomes accurate: a reader may substitute `UNKNOWN_FETCHED_AT`, which is not an ISO timestamp.
  This is the one place the design knowingly widens a documented contract, and it is why B1's
  alternative was rejected below rather than merely not chosen.

## Data and types

| name | kind | value |
|---|---|---|
| `UNKNOWN_FETCHED_AT` | exported `const` | `'unknown'` — a string no `Date` parser accepts |
| `NORMALIZATION_WARNINGS` | exported closed set | the seven strings enumerated above |
| `isStaleReason` | exported type guard | `(v: unknown) => v is StaleReason` |

No field is added, removed, renamed or made optional. `CACHE_VERSION` stays **2** — validation does
not change the envelope's shape, and a bump would discard every user's cache to fix a problem no
user has.

`UNKNOWN_FETCHED_AT = 'unknown'` is chosen so that `formatLocalTime` renders the literal string
`unknown` (measured: it returns `'unknown'` for any unparseable input), `isCacheFresh` returns
`false`, and `printDebug`'s `Math.round(NaN)` serialises to `cacheAgeSec: null` — the same shape it
emits on a cache miss. All three measured, not reasoned about.

## Edge cases

| Case | Expected behavior |
|---|---|
| `fetchedAt` is a valid ISO string | unchanged, byte-identical (it is already canonical) |
| `fetchedAt` is `'2026-01-01 (/home/someone sk-ant-…)'` | canonicalised to an ISO string; the free text is gone from `--debug` |
| `fetchedAt` is `'not-a-date /home/someone'` | becomes `UNKNOWN_FETCHED_AT`; `cacheAgeSec` is `null`, statusline renders `unknown` |
| `fetchedAt` is not a string | **unchanged behaviour** — `invalidShape`, envelope rejected. This is a *shape* check and shape checks reject; the new rules are *value* checks and value checks degrade. The line is deliberate and is the answer to `intent.md`'s open question 1 |
| `fetchedAt` is far in the future | **not clamped.** `detectClockSkew` exists to report exactly this |
| `staleReason` is one of the five members | unchanged |
| `staleReason` is `'/home/someone leaked'` | becomes `'none'`; every classification branch takes the same path it took before |
| `staleReason` is absent, `null`, or a number | becomes `'none'` |
| `isStale: true` with a poisoned `staleReason` | `isStale` untouched; reason becomes `'none'`. The pair is left inconsistent-looking on purpose — inventing a cause is worse than recording none |
| `normalizationWarnings` contains one real warning and one poisoned string | the real one survives, the poisoned one is dropped |
| `normalizationWarnings` is `[]` | unchanged |
| `normalizationWarnings` is a string, `null`, or an array of objects | becomes `[]` |
| every field valid | envelope byte-identical to the file, `reason: 'hit'` |
| a poisoned field alongside a live `cooldownUntil` | envelope kept, `cooldownUntil` intact, `cooldownActive` still true. **The §9.4 regression test** |

## Backward compatibility

- **No `CACHE_VERSION` bump**, so no user's cache is discarded.
- **An honestly-written envelope is unchanged in every field.** `writeCache` emits canonical ISO,
  union members, and warnings from the set, so a round-trip is byte-identical. Pinned by a test.
- **No `--debug` key added, removed or renamed.**
- **`isCacheFresh`, `classify`, `detectClockSkew` and the two `!== 'fetchFailed'` guards keep their
  current results for every input reachable today.** B2 is chosen specifically to make this true.
- **Breaking, narrowly and knowingly:** `snapshot.fetchedAt` may now hold a non-ISO sentinel. Any
  future code assuming it parses must handle `unknown`. Every current reader was enumerated above
  and all four already handle unparseable input.

## Acceptance criteria

- [ ] **A1** — a cache file whose `fetchedAt` carries free text does not put that text on `--debug`
      stdout — verified by a test in `security.test.ts` that writes the file, reads it through
      `readCacheResult`, and asserts the returned value is a constructed string, plus the
      end-to-end `--debug` case in `smoke.test.ts` asserting the raw stdout does not contain it.
- [ ] **A2** — same for `staleReason` and for `normalizationWarnings` — verified by two further
      tests in the same file, each asserting on the raw serialised envelope, not on a field alone.
- [ ] **A3** — **each of the three checks is individually load-bearing** — verified by a mutation
      table in `review.md` with the result of every row **predicted in `plan.md` before it is run**,
      at least one row per check, and at least one row that inverts rather than deletes.
- [ ] **A4** — the §9.4 property holds: a poisoned field costs no fetch and no cooldown — verified
      by a test asserting the envelope survives with `cooldownUntil` intact and `reason === 'hit'`.
- [ ] **A5** — an honestly-written envelope round-trips byte-identically — verified by a test that
      `writeCache`s a `makeTestEnvelope` and asserts `readCacheResult` returns a deep-equal value.
      Without this, "validate everything" can quietly become "rewrite everything".
- [ ] **A6** — B2 changes no classification — verified by a test driving `classify`,
      `isCacheFresh` and both `!== 'fetchFailed'` guards with a poisoned `staleReason` and asserting
      results identical to the pre-change behaviour, which must be **recorded as measured values in
      `plan.md` before the change**, not asserted after.
- [ ] **A7** — the closed set has no member the producer cannot emit and no member missing —
      verified by a test asserting `NORMALIZATION_WARNINGS` has exactly the enumerated count **and**
      that every string `normalize.ts` can produce is in it, driven through `normalize` with
      fixtures rather than by reading the source.
- [ ] **A8** — `SPEC.md §12`'s "Known gap" paragraph is gone and the three degradations are
      documented with their pinning tests — verified by reading the diff; an amended §12 that still
      claims an open gap fails it.
- [ ] **A9** — `client.ts:161-164` and `snapshot.ts:58-62` describe where the check runs —
      verified by reading the diff.
- [ ] **A10** — no new lint warning — verified by `oxlint 2>&1 | grep warning | sort` before and
      after, `diff` empty. Sorted because oxlint's output order is nondeterministic across runs on
      an identical tree, measured in loop 029.
- [ ] **A11** — `bun run verify` exits 0.

## Rejected alternatives

- **Reject the envelope on a poisoned value.** Consistent with the existing non-string `fetchedAt`
  check, and wrong for the same reason loop 030 gave: `tryDelete` discards `cooldownUntil`, so one
  poisoned byte becomes an authenticated fetch on every prompt render — §9.4's defect, which loop
  029 shipped once already.
- **Substitute the epoch for an unparseable `fetchedAt`** (keeps the type contract intact). Rejected
  on measurement: `formatLocalTime(new Date(0))` renders `12:00 AM`, so `format.ts:437` would print
  **"Fresh as of 12:00 AM"** for a snapshot whose age is unknown. A sentinel renders "Fresh as of
  unknown". Trading a documented-contract nuance for a plausible falsehood on the user's statusline
  is the wrong trade.
- **Clamp a far-future `fetchedAt`** by symmetry with `cooldownUntil`. Rejected: the hazards are
  opposite. A far-future cooldown *suppresses fetches forever*; a far-future `fetchedAt` suppresses
  one fetch and is exactly what `detectClockSkew` reports. Clamping would delete that signal — the
  same "destroyed signal" finding loop 029's security pass raised about TLS errors.
- **Validate warnings via `categorizeWarning`.** Rejected on reading: it accepts every string.
- **Narrow `normalizationWarnings` to a union at the producer**, making a bad warning a compile
  error. Correct in principle and much larger: it changes `UsageSnapshot`, every fixture, and the
  telemetry path. Out of scope by `intent.md`, and the reader-side check is what closes the actual
  hole, since a cache file never saw the producer's compiler anyway.
- **Include the spec-versus-fence harness check in this loop** (`intent.md`'s outcome 8 and open
  question 3). **Deferred to its own loop**, and this is the answer to that question rather than a
  punt: it is harness work with a different fence, different reviewers and no shared code, and
  mixing it here is how a fence stops meaning anything. `intent.md` outcome 8 is therefore
  **knowingly unmet by this spec** — recorded here because a dropped outcome that is not written
  down is a dropped outcome nobody notices.

---

**Next stage:** Build — run `/sdlc-plan 031-cache-read-completeness` to turn this into `plan.md`.
