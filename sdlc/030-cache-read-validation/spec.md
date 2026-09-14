# Spec: validate `lastErrorMessage` where it enters, not where it leaves

- **ID:** 030-cache-read-validation
- **Stage:** 2 — Design
- **Status:** revised after spec review (three BLOCKING, eight MAJOR; see "Spec review")
- **Date:** 2026-08-28

Reads `intent.md`. The design question it left open is settled below by measurement.

## Measurements — CORRECTED after review

| Question | Measured |
|---|---|
| Producers of a `lastErrorMessage` **value** | **three**: `JSON.parse(raw) as CacheEnvelope` (`cache.ts:88`), `makeCacheEnvelope` (`cache.ts:196`), `enterCooldown` (`cooldown.ts:30`) — the third writes to disk and is re-read through the first |
| Production callers of `extractLastError` | **one**: `extension.ts:185`, argument from `readCache()` |
| Typecheck errors, narrowing `CacheEnvelope.lastErrorMessage` **alone** | **2** — `cache.ts:209`, `cooldown.ts:30` |
| ...narrowing it **together with both writer params** | **0** |
| Typecheck errors, additionally narrowing `LastErrorInfo.message` | **0** |
| Import cycle `cache.ts` → `client.ts` | **none** |

**Two of these were wrong in the first draft.** It claimed "exactly two" producers, missing
`enterCooldown` — which is the site that *historically wrote free text to disk*, i.e. the one this
whole loop exists for. And it claimed **1** typecheck error where narrowing the interface alone gives
**2**: the first draft's probe narrowed the interface *and* a writer param in one edit, so it
described one mutation and measured another. A wrong number in a table headed "Measured" is a
first-class defect in this repo, not a typo.

## Behaviour

### B1 — `lastErrorMessage` is validated at the parse boundary

`readCacheResult` already says *"Two fields cross the `as CacheEnvelope` assertion unchecked"* and
nulls both. `lastErrorMessage` is the third:

```ts
if (parsed.lastErrorMessage !== null && !isSurfaceableMessage(parsed.lastErrorMessage)) {
  parsed = { ...parsed, lastErrorMessage: null };
}
```

Null rather than reject — a bad message says nothing about the snapshot beside it, and discarding a
good snapshot costs a live token-bearing fetch. The comment's own count must go two → three in the
same edit, naming which three (and noting they use two idioms: null-on-invalid ×2, sanitise-and-clamp
×1). Loop 029 shipped a stale comment adjacent to its own falsifier; this is that shape.

**`CACHE_VERSION` stays 2.** B1 degrades one field rather than rejecting the envelope. A bump would
discard every existing user's snapshot and force a token-bearing fetch on next render — the exact
cost `readCacheResult`'s own comment says to avoid.

**This makes `SPEC.md §12` true rather than amending it.** §12 already claims the predicate runs "at
the cache-read boundary". It does not — it runs in `extractLastError`, a consumer. `types.ts:145`
carries the same inaccuracy and is corrected in the same edit. That is a stronger argument for B1
than any the first draft made, and it went unnoticed.

### B2 — three types narrowed, not one

`CacheEnvelope.lastErrorMessage`, both writer params (`makeCacheEnvelope`'s, `enterCooldown`'s
`errorMessage`), **and `LastErrorInfo.message`** (`format.ts:355`) — the last measured at **0**
additional errors.

`LastErrorInfo` was missing from the first draft and is the type actually **rendered**
(`format.ts:405`, `tooltip.ts:51`). It has two producers: `extractLastError` (gated) and
`extension.ts:235`, which builds one straight from a `FetchResult` and **never touches
`extractLastError`**. Leaving it `string | null` re-widens `SurfaceableMessage` at the last hop, so a
reader of the first draft would have believed the render path closed when half of it was not.

After B1 the type is an **over-approximation** of disk contents, not an exact match: the template
literal admits `Server error (-1)`, which `isSurfaceableMessage` nulls. Harmless, and stated because
"the type is true at runtime" was B2's entire justification and is only approximately so.

### B3 — `extractLastError`'s gate is KEPT, and relabelled

Redundant on every path reachable today. Kept as a standing guard against a **fourth** producer
appearing (the first draft said "third", not knowing about `enterCooldown`).

**Its test must keep constructing the envelope in memory.** Verified by the reviewer, both ways: with
B1+B2 applied and the gate deleted, loop 029's existing test still fails — because it uses
`makeCacheEnvelope(..., '…' as never)`. And the `as never` survives B2: `never` is assignable to
every type, so narrowing the param does not disarm it. A test that reached the gate *through*
`readCache` would pass with the gate deleted, since the parse boundary catches it first. The
realistic-looking version tests less.

### B4 — gap 3 recorded, with the claim CORRECTED

The first draft said the type accepts `-1`, `NaN` and `1e5` while the regex rejects all three.
**Two of those three are wrong**, and the claim was copied verbatim from `sdlc/029/review.md` without
re-measurement — the exact behaviour this loop's thesis criticises 029 for. Measured:

| value | template-literal type | regex |
|---|---|---|
| `-1` | accepts | rejects → **the only divergence** |
| `NaN` | **TS2322** | rejects → no divergence |
| `1e5` | accepts, renders `100000` | **accepts** → no divergence |
| `Infinity` | **TS2322** | rejects → no divergence |

Unreachable confirmed independently: the only two construction sites are `client.ts:109` and `:112`,
both interpolating `response.status`, and `FetchOptions` carries no injected-fetch seam.
**Decision: leave it**, recorded in `review.md`, and B1 nulls the divergent value off disk anyway.

## Scope

**Not in scope, recorded by name:** `printLiveDebug`'s `fetchError.message: string`
(`main.ts:158`), carried from `sdlc/029/review.md:176`. It comes from a live `FetchFailure`, never
from the cache, so **B1 cannot touch it** — it is type-safe today only because `result.message` is
`SurfaceableMessage`, which that declaration immediately re-widens. The first draft quoted 029's
bullet and silently dropped this clause: an open gap narrowed without a decision, in the same
artifact that adds A9 against exactly that.

Also out of scope: `commands.ts:26`'s modal; `enterprise.disabledReason`; `metrics.db`'s `0644` mode;
`SPEC.md §17`'s allowed-debug list, which does not name `lastErrorClass`/`lastHttpStatus`/
`lastErrorMessage`/`cooldownUntil`/`freshness` although `printDebug` emits all five — pre-existing,
improved by this loop, recorded not amended.

## Acceptance criteria

- **A1** — `readCacheResult` nulls a non-surfaceable `lastErrorMessage`. Demonstrated by writing a
  cache file containing free text into a sandbox `HOME` and reading it back.
- **A2** — **the check can fail.** Remove B1's branch; a named test fails. Restore; green. Both halves
  in `review.md`.
- **A3** — REWRITTEN; the first draft's check **could not fail**. It ran `grep -c "…" packages/core/src`
  non-recursively on a directory, which prints `0` and exits 2 unconditionally — green before, after,
  and on revert, while the string it hunts is present twice. Replaced with:
  `grep -rnE "(lastError|error)?[Mm]essage: string \| null" packages/ --include=*.ts` returns **0**
  lines, **and** `bun run typecheck` exits 0 as the positive control.
- **A4** — SCOPED and STRENGTHENED. The `--debug` **cache-read** path is clean end to end, asserted in
  `packages/statusline/src/smoke.test.ts` against the compiled binary with `seedSandboxHome`:
  ```
  expect(out.lastErrorMessage).toBeNull();        // strict null, not falsy
  expect(typeof out.cacheAgeSec).toBe('number');  // the cache was actually READ, not missed
  expect(out.lastHttpStatus).toBe(503);           // and THIS envelope, not some other
  ```
  **A test in `main.test.ts` does NOT satisfy A4** — that file mocks `./core-deps.js`, so it would
  assert against a mocked `readCache` and prove nothing about `readCacheResult`. The hit-precondition
  assertions exist because `printDebug` omits the key entirely on a cache miss or a rejected seed, so
  a loose assertion goes green while proving nothing. The seed override needs its own `as never` once
  B2 narrows `Partial<CacheEnvelope>` — a **second** load-bearing `as never`.
- **A5** — `readCacheResult`'s "Two fields" comment says three and names them; `types.ts:145` and
  `SPEC.md §12` no longer misdescribe where the predicate runs.
- **A6** — mechanical, not an eyeball:
  `grep -A20 'drops a message no producer emits' packages/core/src/security.test.ts | grep -c 'readCache\|writeCache'`
  is **0**.
- **A7** — REWRITTEN; the first draft's mechanism produces spurious failures. oxlint's output order is
  **nondeterministic across runs on an identical tree** (measured). Sorted:
  `oxlint 2>&1 | grep warning | sort` before and after; `diff` empty and `wc -l` = **11** on both,
  both pasted in `review.md`.
- **A8** — every mutation in the plan's table produces its predicted count, and the table has **at
  least three rows for B1**: delete the `if` block; invert the condition; replace the predicate with
  `true`. A plan cannot satisfy A8 with a one-row table.
- **A9** — **all nine** bullets under `sdlc/029/review.md`'s "What is NOT done" carry a marker
  (`CLOSED by 030` / `OPEN` / `DEFERRED — reason`). The first draft said 029 left "three gaps"; it
  left **nine**, so an unmarked-bullet loophole would have let this loop mark three and leave six —
  self-undermining, in the criterion that exists against stale gap lists.
- **A10** — NEW. B1 and B2 land in the **same commit**. `git log -p` for the range shows `cache.ts`'s
  new branch and `types.ts`'s narrowing in one diff. See Risks for why prose was not enough.

## Risks

- **B2 alone is a review hazard with a concrete consequence**, not the "type that lies" rhetoric the
  first draft offered. Measured: B2 alone changes zero runtime behaviour and fails zero tests. The
  real consequence is that `extractLastError`'s ternary becomes redundant *by the declared type* while
  still load-bearing *at runtime* — so a later cleanup (a `no-unnecessary-condition` rule, or a
  reviewer grepping types) deletes it and free text from a pre-029 cache file flows to `format.ts:405`.
  The first draft's only mitigation was prose; **A10 now enforces it**, because no other criterion
  was violated by B2-alone.
- **A2 is the criterion most likely to ship as nothing.** It always is.
- **Two `as never` casts are load-bearing** — 029's test fixture and A4's seed override. Both look like
  smells; removing either silently makes its test unable to construct the case it exists for.

## Spec review

Run at Stage 2 against `127f922..c3acbb2`. Returned **three BLOCKING**, eight MAJOR, five MINOR. The
central claim was traced and **confirmed**: `main.ts:201` is the sole assignment to `cache`, from
`readCache()`, so both `--debug` sites receive a post-B1 envelope.

Three findings were re-measured by me before acting, because each falsified something written as
measured: the typecheck count (2, not 1), A3's grep (cannot fail — exits 2 on a directory), and B4's
divergence set (one member, not three).

## Next stage

`/sdlc-plan`.
