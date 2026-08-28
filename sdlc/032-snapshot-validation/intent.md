# Intent: validate the whole snapshot, not four fields of it

- **ID:** 032-snapshot-validation
- **Stage:** 1 — Plan
- **Status:** draft
- **Author:** carried forward from `sdlc/031-cache-read-completeness/review.md` — "What is NOT done"
- **Date:** 2026-08-28

## Problem

Loops 029, 030 and 031 established a principle and applied it five times. `readCacheResult` now
validates seven values it returns from a cache file. **The snapshot has roughly twenty.**

What is still unvalidated, and reaches a user-visible surface verbatim:

- `source.usageEndpoint` — a three-member closed set, checked nowhere.
- `authState` — a four-member closed set, checked nowhere.
- `display.primaryWindow` — a five-member closed set, checked nowhere.
- `display.primaryResetsAt`, and `resetsAt` on each of the three windows — ISO timestamps, exactly
  the shape `fetchedAt` was before loop 031 canonicalised it.
- `display.primaryUtilizationPct` and each window's `utilizationPct` — typed `number | null`,
  checked nowhere, so a string arrives happily.
- `enterprise` in its entirety when present — including `currency` and `disabledReason`, both free
  strings, the latter deferred by name for four loops.
- **Any unknown key** on `snapshot`, on `source`, on `display`, on a window, or on `enterprise`.
  Loop 031 fixed exactly two objects — `freshness` and `rawMetadata` — by rebuilding them from known
  keys. Every other object is still passed through by reference.

Loop 031 measured the surfaces and got the answer wrong twice before getting it right, so the
enumeration matters: a cache value reaches **stdout** (`--debug`'s named keys, and `--json`, which
serialises the entire snapshot at three cache-derived call sites), and it reaches **a file** (the
telemetry spool, via `renderEvent`). The final formulation loop 031 arrived at is the one this loop
starts from: **ask what leaves the process**, not what reads the field.

Second, related problem. `renderEvent` (`telemetry.ts:229`) declares its `runtimeState` and `tier`
parameters as `string`, with a comment justifying them as *"constrained by their producing unions in
`types.ts`"*. That is the producer-union argument loops 029–031 established is void for a value read
off disk, written in the payload builder itself. Loop 031 closed the `tier` instance at the cache
boundary; the **type** is still `string`, so nothing stops the next payload field from being one.
`SPEC.md §17`'s closed-enum guarantee is a comment, not a compile error.

## Who is affected

Nobody today, and there is no incident. The producers are all in this repository and all emit closed
values; the exposure is a `usage.json` written by an older build, edited by hand during debugging, or
produced by a future writer that interpolates.

What has changed since loop 029 made that same argument is the evidence: **three consecutive loops
each found a live instance of "closed at the producer" failing to hold at a reader**, and loop 031's
security pass measured a home directory and a hostname reaching a file on disk through exactly this
gap. The remaining twenty fields are in the posture the last three loops each disproved.

The `renderEvent` typing affects the next person to add a payload field, which — on this
repository's recent history — is the next loop.

## Why now

1. **The principle is settled and the arithmetic is bad.** Seven of twenty is not "the cache-read
   boundary is validated"; `SPEC.md §12` currently has to carry a gap paragraph saying so.
2. **Field-at-a-time has stopped scaling.** Three loops have each added a handful of checks and each
   discovered the same class of hole one level over. A snapshot-level validator replaces the pattern
   with a single place that is either complete or demonstrably not.
3. **`renderEvent` is where the void argument is still written down.** Leaving it is how the next
   payload field inherits it.

## What "done" means

- [ ] A `usage.json` in which **every** string field carries free text puts none of that text on
      `--debug`, on `--json`, or into the telemetry spool file.
- [ ] A `usage.json` carrying unknown keys — at any depth — puts none of them on any of those three.
- [ ] The envelope is still **kept** in all such cases: no poisoned value costs a live authenticated
      fetch, and none discards the `cooldownUntil` that throttles one.
- [ ] An honestly-written envelope still round-trips unchanged, including every optional shape —
      `enterprise` present and absent, all three windows populated and empty.
- [ ] Adding a payload field typed `string` to `renderEvent` is a **compile error**, not a review
      comment.
- [ ] `SPEC.md §12`'s gap paragraph is gone or names only what genuinely remains — checked against
      the code, not against the previous paragraph.
- [ ] Someone can tell from one place which snapshot fields are validated and which are not.

## Explicitly out of scope

- **The two harness gates** — the spec-versus-fence check and the lint budget wired into `verify`.
  Both are real, both are queued, and both are **harness** work. Loop 031's spec deferred them here
  on the grounds that mixing harness and product changes in one fence is how a fence stops meaning
  anything; abandoning that reasoning the moment it becomes inconvenient would be worse than the
  delay. They become **loop 033**.
- **Rejecting a poisoned envelope.** Degrade-don't-reject is settled: rejecting deletes the file and
  the cooldown with it (SPEC.md §9.4).
- **The structural-reject paths** (`snapshot`, `display`, `freshness` missing entirely), which still
  discard the cooldown. Closing that needs `cooldownUntil` stored separably from the snapshot — a
  different change, pinned today by a test so it cannot close silently.
- **`packages/vscode/src`** and `commands.ts:26`'s raw `err.message` modal.
- **Bumping `CACHE_VERSION`.** Adding validation does not change the envelope's shape.
- **Narrowing producer types in `normalize.ts`.** A cache file never saw the producer's compiler.
- **`detectClockSkew`'s deadness.** Recorded by loop 031, still true, not this change's business.

## Open questions

1. **Whitelist or validate-in-place?** Rebuilding every object from known keys guarantees no unknown
   key survives and makes the validator's completeness structural; validating in place is a smaller
   diff but leaves each new field needing a new line. **Deferred to `spec.md`**, which should also
   settle whether a single `sanitizeSnapshot` or per-object helpers reads better.
2. **What does a bad `utilizationPct` degrade to?** `null` is in its type and means "unknown", which
   is honest — but `display.primaryUtilizationPct` drives the rendered percentage, so a poisoned
   value would silently blank the statusline rather than showing a wrong number. Whether that is the
   right trade needs stating, not assuming. **Deferred to `spec.md`.**
3. **Does narrowing `renderEvent` produce compile errors at its two call sites** (`main.ts:384`,
   `statusbar.ts:63`)? `classify` returns `RuntimeState` and `tier` is now `AccountTier`, so the
   expectation is zero — **but that is a prediction, and this loop's immediate predecessor was
   wrong four times out of nine predicting exactly this kind of count.** `spec.md` must record the
   measured number before the change, not after.
4. **Anything requiring the requester.** None.

---

**Next stage:** Design — run `/sdlc-spec 032-snapshot-validation` to turn this into `spec.md`.
