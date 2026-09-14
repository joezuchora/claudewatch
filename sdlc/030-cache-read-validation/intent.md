# Intent: loop 029 gated a consumer when the value enters at one place

- **ID:** 030-cache-read-validation
- **Stage:** 1 — Plan
- **Status:** draft
- **Author:** loop 029's Stage 5 (plan-to-diff audit + security pass)
- **Date:** 2026-08-28

## Problem

Loop 029 closed the set of surfaceable error messages at the producer (a type) and at **one**
consumer (`extractLastError`). Its Stage 5 left **nine** open items in `sdlc/029/review.md`; three
concern this loop. (The first draft of this file said "three gaps" full stop — corrected after the
spec review, because A9 requires marking all nine and an undercount would have licensed marking
three and leaving six.)

1. **The `--debug` bypass.** `packages/statusline/src/main.ts:143` and `:171` read
   `lastErrorMessage` straight off the envelope, never through `extractLastError`, so a cache file
   written before 029 still prints free text to stdout. The security reviewer checked **every** read
   of `lastErrorMessage`/`lastErrorClass`/`lastHttpStatus` across all four packages and confirmed
   these two are the only bypasses — so the scope is known exactly, not sampled.
2. **`CacheEnvelope.lastErrorMessage` is still `string | null`.** The union closes
   `FetchFailure.message`; the field actually **persisted and printed** is unnarrowed, and a leak
   compiles cleanly through `enterCooldown` and `makeCacheEnvelope`.
3. **The type and the predicate disagree at the edges.** `` `Server error (${number})` `` accepts
   `-1`, `NaN`, `1e5`; the regex rejects all three. Unreachable today; the predicate is tighter.

## The finding that reframes all three

**Loop 029 gated the wrong layer, and the right pattern was six lines away in the same function.**

`readCacheResult` (`cache.ts:126`) opens with:

> *"Two fields cross the `as CacheEnvelope` assertion unchecked. Both are nulled rather than
> rejected: neither says anything about the snapshot beside it, and discarding a good snapshot would
> cost a live token-bearing fetch on every read."*

`lastErrorClass` is nulled there if `!isFailureClass(...)`. `cooldownUntil` is sanitised there.
`lastErrorMessage` is **the third field crossing that assertion unchecked**, and loop 029 did not
add it to the list — it wrote a gate at one consumer instead.

Validating where the value **enters the program** rather than at each place it leaves closes gaps 1
and 2 together, with one check, in the idiom this file already uses. `extractLastError`'s gate then
becomes defence in depth rather than the only line.

Measured, so the cost is known rather than guessed:

| Question | Measured |
|---|---|
| Typecheck errors from narrowing `CacheEnvelope.lastErrorMessage` **alone** | **2** — `cache.ts:209`, `cooldown.ts:30`. CORRECTED: the first draft said 1, having narrowed the interface *and* a writer param in one probe — describing one mutation and measuring another |
| Import cycle from `cache.ts` → `client.ts` | **none** — `client.ts` does not import `cache.ts` |
| Precedent for the import | `cache.ts` already imports `isFailureClass` from `cooldown.ts`, the module owning that policy |

## Who is affected

- **Anyone running `--debug`** with a cache file written before loop 029.
- **`SPEC.md §12`**, whose redaction clause now names an enforcing test that does not cover this path.
- **The next contributor**, who reads 029's "the set is closed" and finds a field typed
  `string | null` holding whatever was on disk.

## What "done" means

1. `lastErrorMessage` is validated in `readCacheResult`, in the same idiom as `lastErrorClass`, so
   free text from an old cache file cannot reach **any** consumer — `--debug` included.
2. `CacheEnvelope.lastErrorMessage` and both writer params are narrowed, so the type is **true at
   runtime** rather than aspirational. A type that lies about disk contents is worse than a wide one.
3. A test that **fails** when the parse-boundary check is removed — seeded with free text and
   demonstrated both ways.
4. Gap 3 resolved or explicitly recorded with its reasoning. It is unreachable today, so "record and
   leave" is a legitimate outcome if the alternative costs more than it buys.
5. `sdlc/029/review.md`'s "What is NOT done" list is updated to say which items this loop closed —
   an open-gaps list that silently goes stale is the defect 029 spent a whole retrospective on.

## Not in scope

- `commands.ts:26`'s modal, which interpolates `err.message` from `readCache`/`formatTooltip`.
  Deferred by name in 029 and still deferred: it is not a `FetchResult`, so neither the type nor the
  predicate applies.
- `enterprise.disabledReason` — the largest uncontrolled string reaching a surface, on the **success**
  path. A separate design question about rendering untrusted text.
- `metrics.db`'s `0644` mode, observed by 029's security pass and outside that diff entirely.

## Next stage

`/sdlc-spec` — the design question is whether the parse-boundary check makes `extractLastError`'s
gate redundant enough to remove, or whether keeping both is defence in depth worth its cost.
