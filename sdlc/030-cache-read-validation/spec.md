# Spec: validate `lastErrorMessage` where it enters, not where it leaves

- **ID:** 030-cache-read-validation
- **Stage:** 2 — Design
- **Status:** draft
- **Date:** 2026-08-28

Reads `intent.md`. The design question it left open — whether the parse-boundary check makes
`extractLastError`'s gate redundant enough to remove — is settled below **by measurement**, not by
argument.

## Measurements this spec is built on

| Question | Measured |
|---|---|
| Ways a `CacheEnvelope` comes into existence | **exactly two**: `JSON.parse(raw) as CacheEnvelope` (`cache.ts:88`) and `makeCacheEnvelope` (`cache.ts:196`) |
| Production callers of `extractLastError` | **one**: `extension.ts:185`, whose argument came from `readCache()` — i.e. through the parse boundary |
| Typecheck errors from narrowing `CacheEnvelope.lastErrorMessage` | **1** — `cooldown.ts:30` |
| Import cycle `cache.ts` → `client.ts` | **none** |
| Existing precedent | `cache.ts` already imports `isFailureClass` from `cooldown.ts` |

So after B1 and B2 below, **`extractLastError`'s gate is redundant on every reachable path.**

## Behaviour

### B1 — `lastErrorMessage` is validated at the parse boundary

`readCacheResult` already says *"Two fields cross the `as CacheEnvelope` assertion unchecked"* and
nulls both. `lastErrorMessage` is the third. Same idiom, same reasoning — null rather than reject,
because a bad message says nothing about the snapshot beside it and discarding a good snapshot costs
a live token-bearing fetch:

```ts
if (parsed.lastErrorMessage !== null && !isSurfaceableMessage(parsed.lastErrorMessage)) {
  parsed = { ...parsed, lastErrorMessage: null };
}
```

The comment's own count — "**Two** fields" — becomes three and must be updated in the same edit.
Loop 029 shipped a stale comment adjacent to its own falsifier; this is the same shape and is called
out here so it cannot be repeated by inattention.

**This closes the `--debug` bypass** (`main.ts:143`, `:171`) without importing anything into
`packages/statusline`: those two sites read an envelope that has already been cleaned. Loop 029's
security pass established that they are the **only** two bypasses, having checked every read of
`lastErrorMessage`/`lastErrorClass`/`lastHttpStatus` in all four packages — so this is a complete
fix, not a partial one.

### B2 — the persisted field is narrowed

`CacheEnvelope.lastErrorMessage: SurfaceableMessage | null`, and both writer params
(`makeCacheEnvelope`'s `lastErrorMessage`, `enterCooldown`'s `errorMessage`) with it. Costs one
typecheck error, measured.

After B1 the type is **true at runtime** rather than aspirational. Order matters: narrowing without
B1 would produce a type that lies about disk contents, which is worse than a wide one — the compiler
would promise something the parse boundary does not deliver.

### B3 — `extractLastError`'s gate is KEPT, and relabelled

It is redundant on every path reachable today. Kept anyway, for one stated reason: it is the only
check that survives a **third** construction site being added, and there is currently no test that
would notice such a site appearing. One predicate call is a cheap standing guard.

**But its test must keep constructing the envelope in memory.** After B1, a test that reaches the
gate *through `readCache`* would pass with the gate deleted — the parse boundary would have caught it
first. Loop 029's B3 test uses `makeCacheEnvelope(..., '…' as never)`, which bypasses both the type
and the parse boundary; that is exactly right and must not be "tidied" into a `readCache` round-trip.
Stated because the tidier version looks more realistic and tests less.

### B4 — gap 3 is recorded, not fixed

`` `Server error (${number})` `` accepts `-1`, `NaN`, `1e5`; the regex rejects all three.
Unreachable — `response.status` is a bounded positive integer from `Response.status`. **Decision:
leave it**, with the divergence recorded in `review.md` so the next producer knows the predicate is
the tighter of the two. Constraining the template type to real status codes costs more than the
unreachable case is worth, and inventing a status-code union would be its own loop.

## Edge cases

- **An old cache file with free text AND a non-null `lastHttpStatus`.** B1 nulls the message and
  keeps the status. `format.ts:404` and `tooltip.ts:50` both guard on `lastError?.message`, so the
  `Last error:` line is omitted rather than rendered empty — verified by loop 029's security pass.
- **`readCacheResult`'s telemetry.** The existing nulling branches emit no event; B1's must not
  either, or the shape of `cache_event` changes (§17).
- **A cache file whose message is valid but whose class is not** — the two checks are independent and
  both already null-on-failure, so they compose without ordering concerns.

## Acceptance criteria

- **A1** — `readCacheResult` nulls a non-surfaceable `lastErrorMessage`. Demonstrated by writing a
  cache file containing free text into a sandbox `HOME` and reading it back.
- **A2** — **the check can fail.** Remove B1's branch; a test fails naming it. Restore; green. **Both
  halves in `review.md`** — a `review.md` showing only the green half fails this criterion.
- **A3** — `CacheEnvelope.lastErrorMessage` and both writer params are `SurfaceableMessage | null`;
  `grep -c "lastErrorMessage: string | null" packages/core/src` is **0**.
- **A4** — the `--debug` path is clean **end to end**: a seeded free-text cache file, read through the
  same code path `printDebug` uses, yields `lastErrorMessage: null`. Asserted against the value, not
  against the absence of a grep hit.
- **A5** — `readCacheResult`'s "Two fields" comment says three, and names the third.
- **A6** — `extractLastError`'s test still constructs its envelope in memory. If it goes through
  `readCache`, A6 fails even if the suite is green.
- **A7** — lint warnings unchanged at **11**, and the before/after lists differ by **no** line. Stated
  as a diff, not a count: loop 029's A7 was written as a count, violated, and shipped unnoticed.
- **A8** — every mutation in the plan's table produces its predicted count.
- **A9** — `sdlc/029/review.md`'s "What is NOT done" list is updated to mark which items this loop
  closed and which remain. An open-gaps list that silently goes stale is what 029's retrospective was
  about.

## Risks

- **A2 is the criterion most likely to ship as nothing** — it always is. It requires deleting the
  branch and watching a specific test go red.
- **B2 before B1 would be actively harmful.** The plan must sequence them, and the implementation must
  not land the narrowing alone "because it typechecks".
- **The `as never` in loop 029's B3 test is load-bearing** and looks like a smell. A future cleanup
  that removes it silently makes the test unable to construct the case it exists for.

## Next stage

`/sdlc-plan`, after the spec review.
