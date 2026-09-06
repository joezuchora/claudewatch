# Intent: finish the cache-read boundary

- **ID:** 031-cache-read-completeness
- **Stage:** 1 — Plan
- **Status:** draft
- **Author:** carried forward from `sdlc/030-cache-read-validation/review.md` — "What is NOT done"
- **Date:** 2026-08-28

## Problem

Loop 030 established the principle that a value read from a cache file is outside the trust
boundary and must be validated where it enters, not where it is used. It then applied that
principle to **one** field.

`readCacheResult` validates three fields (`lastErrorClass`, `lastErrorMessage`, `cooldownUntil`).
At least three more cross the `as CacheEnvelope` assertion unvalidated and reach `--debug` stdout
verbatim:

- `snapshot.fetchedAt` — checked for `typeof === 'string'` and nothing further. It is printed as
  `lastFetchedAt` and is the input to the `cacheAgeSec` arithmetic, so a non-timestamp string is
  both a free-text surface and a `NaN` age.
- `snapshot.freshness.staleReason` — only the *presence* of `freshness` is checked. The value is
  typed as the five-member `StaleReason` union and validated nowhere.
- `snapshot.rawMetadata.normalizationWarnings` — not checked at all. Printed as an array.

Each is closed-set at every writer **today**. That is precisely the posture loop 029 left
`lastErrorMessage` in, and loop 030 demonstrated — with a leak that reached `--debug` — that "no
producer emits anything else" is a property of the current producers, not a guarantee about a file
written by an older build or edited by hand.

Two docstrings still describe the world as it was before loop 030 moved the check:

- `packages/core/src/client.ts:161-164` says `isSurfaceableMessage` closes the set *"at the
  CONSUMER… `extractLastError` reads `lastErrorMessage` off disk"*. Since 030 the primary caller is
  `readCacheResult`, at the parse boundary, and `extractLastError` is a standing second guard.
- `packages/core/src/snapshot.ts:58-62` says the same thing about its own gate. Loop 030's `spec.md`
  asked for that gate to be *"KEPT, and relabelled"*; loop 030's `plan.md` then put `snapshot.ts` on
  its "explicitly not touched" list. **The spec asked for an edit the plan forbade**, and no
  acceptance criterion noticed, so the loop shipped reporting the criterion met.

This repo treats a stale comment as a defect rather than a cosmetic issue, on the evidence that its
last three loops each shipped one adjacent to its own falsifier.

## Who is affected

Nobody today, and saying otherwise would be inventing urgency. There is no known cache file in the
wild carrying a poisoned `fetchedAt`, and the three fields' writers are all in this repository.

The exposure is the same shape as the one loop 030 actually closed, which is the argument for doing
it: a `usage.json` written by a build from before a field was constrained, an older release left on
a machine that has since been upgraded, a file edited by hand during debugging, or a future writer
that interpolates. `--debug` output is the surface users paste into issue reports, which is where
loop 029's original concern came from.

The stale docstrings affect the next person to touch `client.ts` or `snapshot.ts`, which — on this
repository's recent history — is the next loop.

## Why now

Three reasons, in order of weight.

1. **The principle is established and half-applied.** `SPEC.md §12` now names the three unvalidated
   fields as a known open gap. A gap named in the spec and left open is a debt with a due date; the
   alternative is that the sentence quietly becomes furniture.
2. **The cost is lowest now.** The validation idiom, the degrade-don't-reject decision and its
   security reasoning, and the fixture pattern that catches a re-widening all exist and were argued
   through in the last loop. This is applying a settled pattern, not designing one.
3. **The spec-versus-fence contradiction is a live harness defect**, not just a stale comment. It is
   the second consecutive loop in which the plan-to-diff audit found something no acceptance
   criterion could have caught, and this one is checkable.

## What "done" means

- [ ] A `usage.json` whose `snapshot.fetchedAt` is free text does not put that text on `--debug`
      stdout, and `--debug` still reports a usable state rather than `NaN`.
- [ ] A `usage.json` whose `freshness.staleReason` is not one of the five union members does not put
      that value on any surface.
- [ ] A `usage.json` whose `normalizationWarnings` contains a string no producer in this repository
      can emit does not put that string on any surface.
- [ ] In all three cases the envelope is **kept**, not discarded — a poisoned field must not cost a
      live authenticated fetch, and must not discard the `cooldownUntil` that throttles one. Loop
      030's review records why: rejecting is the path that removes the §9.4 backoff.
- [ ] Each of the three has a test that fails when its check is removed, named in the review.
- [ ] `client.ts`'s and `snapshot.ts`'s docstrings describe where the check actually runs.
- [ ] Someone reading `SPEC.md §12` finds the "known gap" paragraph either gone or reduced to what
      genuinely remains — not left standing while the code beneath it changed.
- [ ] The harness gains a check that a spec's requested edits are all inside its plan's fence, so
      loop 030's contradiction cannot ship silently again.

## Explicitly out of scope

- **Rejecting a poisoned envelope.** The degrade-don't-reject decision is settled and its reasoning
  is a security property, not a preference.
- **`packages/vscode/src` in its entirety** — including `commands.ts:26`'s raw `err.message` modal
  and `enterprise.disabledReason`, both deferred by name for three loops now.
- **`ok: false, statusClass: '2xx'`**, reachable since 029 and asserted nowhere. It is a `client.ts`
  concern and belongs to whichever loop next has `client.ts` in its fence for a real reason.
- **`metrics.db`'s 0644 mode.** Outside this area entirely; a standing observation.
- **Bumping `CACHE_VERSION`.** Adding validation does not change the envelope's shape, and a bump
  would discard every user's cache to fix a problem no user has.
- **Any change to what `normalize.ts` writes.** This loop is about what the reader accepts, not
  about narrowing producer types. Narrowing `normalizationWarnings` to a union at the producer is a
  defensible separate change and would be a much larger one.
- **`--debug`'s output shape.** No key added, removed or renamed.

## Open questions

1. **What should a poisoned `fetchedAt` degrade *to*?** Unlike the other two it has no safe empty
   value: `null` is not in its type, and the snapshot is meaningless without it. The candidates are
   (a) treat an unparseable `fetchedAt` as the one case that *does* reject the envelope, which
   collides with the degrade-don't-reject rule and its cooldown reasoning, or (b) canonicalise it
   the way loop 030 canonicalised `cooldownUntil` and let the existing staleness logic conclude the
   cache is old. **Deferred to `spec.md`** — it is a design decision with a real trade-off, and the
   spec reviewer is the right gate for it.

2. **`categorizeWarning` cannot serve as the warning validator.** Loop 030's security reviewer
   suggested validating `normalizationWarnings` "against `categorizeWarning`'s closed set". Read:
   `telemetry.ts` `categorizeWarning` maps *any* string to a category, falling through to `'shape'`
   — it is a bucketer, not a predicate, and would accept everything. The eight strings the repo can
   actually emit come from `normalize.ts`: five literals, plus one template interpolated with
   `'five_hour'`, `'seven_day'` and `'seven_day_opus'` — all three literal arguments. So a real
   closed set exists and can be enumerated; it just is not the one the suggestion named.
   **Answered here** so `spec.md` does not inherit the wrong premise.

3. **Does the spec-versus-fence check belong in this loop at all?** It is harness work, and mixing
   harness changes with product changes is how a fence stops meaning anything. **Deferred to
   `spec.md`**, which should decide whether to carve it out as its own loop. Recorded here because
   the defect was found here and would otherwise be lost.

4. **Anything requiring the requester.** None. Every question above is answerable from the
   repository, and no observable outcome depends on an unstated preference.

---

**Next stage:** Design — run `/sdlc-spec 031-cache-read-completeness` to turn this into `spec.md`.
