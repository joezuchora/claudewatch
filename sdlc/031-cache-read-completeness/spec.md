# Spec: finish the cache-read boundary

- **ID:** 031-cache-read-completeness
- **Stage:** 2 — Design
- **Status:** revised after review — two BLOCKING, seven MAJOR, six MINOR, all folded in
- **Derived from:** [`intent.md`](./intent.md)

## Summary

`readCacheResult` will validate **four** fields it currently returns unchecked from a cache file —
`snapshot.fetchedAt`, `snapshot.freshness.staleReason`, `snapshot.freshness.isStale`, and
`snapshot.rawMetadata.normalizationWarnings` — using the idiom loop 030 settled: keep the envelope,
replace the field. Two docstrings stop describing where the check used to run.

**This does not make the envelope fully validated, and the first draft of this spec said it did.**
Roughly a dozen further snapshot fields remain unchecked and reach a user-visible surface verbatim.
They are enumerated below and queued, not implied away.

## What the review changed

The draft's "What was measured before designing" section asserted a conclusion — *"one surface,
`--debug`"* — and was wrong twice. Both errors are recorded here rather than quietly corrected,
because the shape of each is more useful than the fix.

### The set is nine, not seven — and the counter-measure failed on its own terms

The draft tabulated seven warning strings and congratulated itself on using a table. The table was
built by grepping `warnings.push`. **Two producers do not use `push`**: `normalize.ts:121` and
`:165` pass literal arrays to `makeMalformed`, which assigns them at `:208`.

```
normalize.ts:121  makeMalformed(now, ['Response is not an object'])
normalize.ts:165  makeMalformed(now, [...warnings, 'No valid usage windows found'])
```

Both are written to `usage.json` on the ordinary fetch path. A filter built from the seven-string
table would have **dropped the headline warning of the malformed-response path on read** — deleting
diagnostics from precisely the cache file where they matter. Confirmed by driving `normalize()` with
fixtures: `'Response is not an object'` and `'No valid usage windows found'` both appear.

`intent.md` said eight. The draft "corrected" it to seven. The answer is nine. A table is only a
counter-measure against a miscount if the rows come from the behaviour rather than from one grep.

### `--json` is a second verbatim surface, and no field-name search could ever have found it

`main.ts:241` and `:256` call `output(cache.snapshot, …)`, and `output` at `:371` is
`console.log(JSON.stringify(snapshot, null, 2))` — **the entire cached snapshot, unfiltered**. It is
a documented contract (`SPEC.md:631`, `:791`, `:1053`) and the more likely paste-into-an-issue
surface of the two, being the machine-readable one.

The draft missed it because it searched for readers of `fetchedAt`, `staleReason` and
`normalizationWarnings` by name. **`--json` names no field.** That is the finding worth keeping:
grepping for a field name cannot find a surface that serialises the whole object, so a "which
surfaces read this field" search is structurally incapable of being complete. The question has to be
"what is serialised", not "what is read".

### Therefore: the honest scope

Validating at `readCacheResult` covers `--json` for free — that is the whole merit of the idiom, and
it is why the fix does not change. What changes is the claim. Measured on the fresh-cache path, a
poisoned `usage.json` puts free text on `--json` stdout through **at least** `source.usageEndpoint`,
`authState`, `tier`, `display.primaryWindow`, `freshness.isStale` and every window field. `isStale`
is folded into this loop because it sits inside the same `freshness` object as `staleReason` and
costs one line; the rest becomes **loop 032**, a snapshot-level validator, because a dozen fields
with their own closed sets is a different change with its own intent.

## Behavior

Four degradations in `readCacheResult`, after the shape gate, alongside the three that exist.

### The reject-versus-degrade line, restated

The draft drew it as *shape checks reject, value checks degrade*. The review demonstrated that is a
taxonomy, not a hazard analysis: with `fetchedAt: 12345` the envelope is deleted, **and the live
cooldown goes with it** — measured, `cooldownActive: false` and `usage.json` gone. That is the exact
§9.4 defect this spec's own Rejected-alternatives section argues against, sitting on the other side
of a line drawn to excuse it.

**The line is now: degrade whenever there is a coherent value to degrade to; reject only when there
is not.**

| condition | outcome | why |
|---|---|---|
| `fetchedAt` is not a string, or is a string that will not parse | `UNKNOWN_FETCHED_AT` | a sentinel exists, so nothing forces a reject |
| `snapshot`, `snapshot.display` or `snapshot.freshness` missing or not an object | reject, unchanged | there is nothing coherent to substitute; inventing a display object would render fiction |

The reject cases keep their §9.4 exposure. It is **named, not resolved**: a structurally broken
envelope deletes the cooldown, and closing that needs a cooldown store separable from the snapshot,
which is its own change. `intent.md` outcome 4 said "in all three cases the envelope is kept" — true
for all four value cases after this change, and false for the structural cases, which is stated here
rather than left for a reviewer to notice.

### B1 — `fetchedAt`

Parseable → `new Date(ms).toISOString()`. Not parseable, or not a string → `UNKNOWN_FETCHED_AT`.

**No clamp.** Unlike `cooldownUntil` the hazards are opposite: a far-future `cooldownUntil`
suppresses fetches forever, a far-future `fetchedAt` suppresses one and is exactly what
`detectClockSkew` exists to report. Clamping would delete that signal.

### B2 — `freshness`

- `staleReason` not one of the five `StaleReason` members → `'none'`.
- `isStale` not a boolean → `false`.

`'none'` is chosen because it **changes no observable classification**: every consumer tests for a
specific reason, so an unknown string and `'none'` take identical branches at all five sites. The
review enumerated them independently and confirmed there is no `switch`, lookup table or default
fallthrough anywhere.

### B3 — `normalizationWarnings`

Filtered to `NORMALIZATION_WARNINGS`. Not an array of strings → `[]`.

| # | string | producer |
|---|---|---|
| 1 | `Response is not an object` | `normalize.ts:121`, literal array to `makeMalformed` |
| 2 | `No valid usage windows found` | `normalize.ts:165`, literal array to `makeMalformed` |
| 3 | `extra_usage present but missing required fields` | `normalize.ts:85` |
| 4 | `extra_usage present but has out-of-range values` | `normalize.ts:90` |
| 5 | `extra_usage present but has invalid enabled monthly limit` | `normalize.ts:95` |
| 6 | `extra_usage.currency invalid; defaulted to USD` | `normalize.ts:102` |
| 7 | `five_hour.resets_at is not a valid ISO timestamp` | `normalize.ts:24`, called at `:126` |
| 8 | `seven_day.resets_at is not a valid ISO timestamp` | `normalize.ts:24`, called at `:127` |
| 9 | `seven_day_opus.resets_at is not a valid ISO timestamp` | `normalize.ts:24`, called at `:128` |

All three `name` arguments are string literals, which is what makes rows 7–9 a closed set rather
than an open one. Checked, because if any call site passed a key from the API response the whole
approach would be unsound.

`normalize.ts` sources rows 3–9 from the shared constants so producer and set cannot drift. **This
is an edit to `normalize.ts`**, which `intent.md` placed out of scope — declared, and bounded: the
strings written are byte-identical. The draft claimed they were "pinned by existing tests"; the
review measured that **only row 9 is pinned by exact text** (`normalize.test.ts:132-133`), the rest
by `includes()` and length assertions. So A7 carries the pin instead.

Rows 1–2 stay as literal arrays at their call sites for now; making them reference the constants is
the same edit and will be done in the same commit.

### Amendments to `SPEC.md`

- **§12's "Known gap" paragraph** (added by loop 030, naming three fields and `--debug`) is
  **replaced**, not deleted: the four fields close, and a new gap paragraph names the snapshot fields
  that remain and the `--json` surface the old one missed.
- **§12 gains** the four degradations, each naming its pinning test.
- **§11.4 / §14's `--json` contract** (`SPEC.md:631`, `:791` — *"valid JSON matching the
  UsageSnapshot schema"*) is amended: `fetchedAt` may hold `UNKNOWN_FETCHED_AT`. The draft claimed
  `types.ts:20` was "the one place the design knowingly widens a documented contract". It was not.
- **`types.ts:20`'s comment** (`// ISO timestamp, always UTC`) states the sentinel.

## Data and types

| name | kind | value |
|---|---|---|
| `UNKNOWN_FETCHED_AT` | exported `const` | `'unknown'` — no `Date` parser accepts it (checked for `'unknown'`, `'Unknown'`, `'UNKNOWN'`) |
| `NORMALIZATION_WARNINGS` | exported closed set | the nine strings tabulated above |
| `isStaleReason` | exported type guard | `(v: unknown) => v is StaleReason` |

No field added, removed, renamed or made optional. `CACHE_VERSION` stays **2**.

`'unknown'` is chosen on measurement: `formatLocalTime` returns the literal `unknown`, `isCacheFresh`
returns `false`, and `printDebug`'s `Math.round(NaN)` serialises to `cacheAgeSec: null`.

## Edge cases

| Case | Expected behavior |
|---|---|
| `fetchedAt` is a valid ISO string | unchanged, byte-identical |
| `fetchedAt` is `'2026-01-01 (/home/someone sk-ant-…)'` | canonicalised; free text gone from `--debug` **and `--json`** |
| `fetchedAt` is `'not-a-date /home/someone'` | `UNKNOWN_FETCHED_AT`; `cacheAgeSec: null`, statusline renders `unknown` |
| `fetchedAt` is `12345` (not a string) | **changed** — `UNKNOWN_FETCHED_AT`, envelope kept, cooldown kept. Previously `invalidShape` + delete + cooldown loss |
| `fetchedAt` is far in the future | not clamped; `detectClockSkew` reports it |
| `snapshot.freshness` absent or `null` | reject, unchanged. §9.4 exposure named above |
| `snapshot.freshness` is `{}` | passes the shape gate; both fields degrade |
| `staleReason` is a member | unchanged |
| `staleReason` is `'/home/someone leaked'`, absent, `null`, or a number | `'none'`; every classification branch takes the path it took before |
| `isStale` is not a boolean | `false` |
| `isStale: true` with a poisoned `staleReason` | `isStale` untouched, reason `'none'`. Inventing a cause is worse than recording none |
| `normalizationWarnings` has one real and one poisoned string | real survives, poisoned dropped |
| `normalizationWarnings` is `[]` | unchanged |
| `normalizationWarnings` is a string, `null`, or an array of objects | `[]` |
| every field valid | envelope deep-equal to the file, `reason: 'hit'` |
| a poisoned **value** field beside a live `cooldownUntil` | envelope kept, cooldown intact, `cooldownActive` true. **The §9.4 regression test** |
| **`TZ` when asserting a canonicalised date-only-plus-text input** | `Date.parse` uses the legacy **local-time** parser, so `'2026-01-01 (…)'` canonicalises differently per zone (measured: `05:00:00Z` in `America/New_York`, `00:00:00Z` in `UTC`). Any test asserting an exact output must pin `TZ` or assert a shape |

## Backward compatibility

- No `CACHE_VERSION` bump; no user's cache discarded.
- An honestly-written envelope is unchanged in every field.
- No `--debug` or `--json` key added, removed or renamed.
- `classify`, `detectClockSkew` and both `!== 'fetchFailed'` guards keep their current results.
- **Changed, knowingly:** a non-string `fetchedAt` no longer deletes the cache. This is strictly
  safer — it removes a cooldown-discarding path — but it is a behaviour change and an existing test
  asserting `invalidShape` for that input must be updated, which is an expectation change and is
  budgeted in A11.
- **Breaking, narrowly:** `snapshot.fetchedAt` may hold a non-ISO sentinel. All four current readers
  were enumerated and handle unparseable input.

## Acceptance criteria

- [ ] **A1** — free text in any of the four fields reaches neither `--debug` **nor `--json`** stdout
      — verified by tests in `security.test.ts` reading through `readCacheResult`, **and** two
      end-to-end cases in `smoke.test.ts` against the compiled binary, one per flag, asserting the
      raw stdout does not contain the poison. The `--json` case is the one the draft omitted.
- [ ] **A2** — each of the four checks is individually load-bearing — verified by a mutation table in
      `review.md`, at least one row per check and at least one row that **inverts** rather than
      deletes, with every result predicted in `plan.md`. **Mechanically checkable:** the prediction
      commit SHA must precede every implementation commit SHA, and `review.md` must cite both so a
      reviewer can run `git log --oneline <predict>..<impl>`. The draft's "predicted before it is
      run" was an honour system.
- [ ] **A3** — a poisoned **value** field does not discard the envelope or the cooldown — verified by
      a test asserting `reason === 'hit'`, `cooldownUntil` unchanged, `isInCooldown` still true.
      **Stated as what it checks:** the draft called this "costs no fetch", which is false — an
      unparseable `fetchedAt` with no cooldown still makes `isCacheFresh` return `false` and fetches
      per render, unchanged by this loop and recorded as unchanged.
- [ ] **A4** — a rich envelope round-trips deep-equal — verified by a test whose fixture overrides
      **all** of `makeTestSnapshot`'s defaults: a non-`'none'` `staleReason`, `isStale: true`, all
      **nine** members of `NORMALIZATION_WARNINGS`, and a canonical ISO `fetchedAt` that is not the
      current time. The defaults are every field's *degraded* value, so a default fixture passes
      this criterion with an empty closed set and a predicate that accepts only `'none'`.
- [ ] **A5** — B2 changes no classification — verified by a test driving `classify` and both
      `!== 'fetchFailed'` guards with a poisoned `staleReason`, against results **recorded as
      measured values in `plan.md` before the change**, under the same SHA-ordering rule as A2.
      (`isCacheFresh` is not in this list: it reads only `fetchedAt`.)
- [ ] **A6** — the closed set is complete and correct — verified by a test that drives `normalize()`
      with fixtures covering **every** producer, including a non-object input and a
      no-valid-windows input, collects the distinct warnings, and asserts the set equals
      `NORMALIZATION_WARNINGS`. Those two fixtures are named because omitting them is exactly how
      the draft's table lost two rows.
- [ ] **A7** — the nine strings are compared against **hard-coded literals in the test file**, never
      against the exported constant — verified by reading the test. Once `normalize.ts` sources its
      strings from the constant, any assertion phrased against that constant is a tautology and a
      typo lands in both sides.
- [ ] **A8** — `SPEC.md §12`'s gap paragraph names what actually remains, and §11.4/§14's `--json`
      contract names the sentinel — verified by reading the diff. A §12 that claims the envelope is
      fully validated fails it.
- [ ] **A9** — `isSurfaceableMessage`'s docstring is **moved** to sit immediately above the function
      (it is currently orphaned behind a second docblock for `TLS_FAILURE_CODES`), says where the
      check runs, and its count is corrected from **seven to eight** — verified by a test asserting
      the stated count equals the number of `SurfaceableMessage` members, not by reading. A third
      wrong count in a comment, found by the review, in the docstring this loop exists to fix.
- [ ] **A10** — `snapshot.ts:58-61`'s docstring says where the check runs — verified by reading.
- [ ] **A11** — **at most two** existing test expectations change, both named in `plan.md` in
      advance: the `invalidShape` assertion for a non-string `fetchedAt`, and any assertion on
      `--json` output shape. Written as a budget-with-names because loop 029 wrote it as a count,
      changed seven, and self-declared six.
- [ ] **A12** — no new lint warning — recorded in `review.md` as two sorted `oxlint` outputs with an
      empty `diff`. **Stated honestly as a manual step**: loop 030's review concluded a criterion
      should run in `verify`, and this one does not. Wiring a warning budget into the gate is
      harness work and goes to loop 032 with the spec-versus-fence check.
- [ ] **A13** — `bun run verify` exits 0.

## Rejected alternatives

- **Reject the envelope on a poisoned value.** `tryDelete` discards `cooldownUntil` — §9.4's defect,
  which loop 029 shipped once. This is also why the non-string `fetchedAt` case moved to degrade.
- **Substitute the epoch for an unparseable `fetchedAt`.** Rejected on measurement:
  `formatLocalTime(new Date(0))` renders `12:00 AM`, so `format.ts:437` would print **"Fresh as of
  12:00 AM"** for a snapshot of unknown age. A sentinel prints "Fresh as of unknown". A
  documented-contract nuance is a better price than a plausible falsehood on the user's statusline.
- **Clamp a far-future `fetchedAt`.** Deletes the signal `detectClockSkew` exists to report — loop
  029's "destroyed signal" finding.
- **Validate warnings via `categorizeWarning`.** Rejected on reading: it accepts every string,
  falling through to `'shape'`. It is a bucketer, not a predicate.
- **Narrow `normalizationWarnings` to a union at the producer.** Correct in principle, much larger,
  and it does not close the hole — a cache file never saw the producer's compiler.
- **Validate the whole snapshot in this loop**, which is what the draft's "every value" sentence
  promised. A dozen fields with their own closed sets is a different change; it becomes **loop 032**
  rather than being smuggled in behind a summary sentence.
- **The harness spec-versus-fence check** (`intent.md` outcome 8). Deferred to loop 032 with the
  lint budget. `intent.md` outcome 8 is **knowingly unmet by this spec**.

---

**Next stage:** Build — run `/sdlc-plan 031-cache-read-completeness` to turn this into `plan.md`.
