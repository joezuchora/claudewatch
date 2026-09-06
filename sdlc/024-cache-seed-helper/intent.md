# Intent: one cache-seed helper, checked by the compiler

- **ID:** 024-cache-seed-helper
- **Stage:** 1 — Plan
- **Status:** accepted
- **Author:** carried forward from sdlc/013's review as finding S6
- **Date:** 2026-08-27

## Problem

Two places seed a sandbox `HOME` with a fake credential and a cache envelope so a test or a
benchmark can run the compiled binary without touching the network:

- `packages/statusline/src/smoke.test.ts` — `makeSandbox()`
- `scripts/perf.ts` — `makeSandbox()`, whose docstring says "Same shape as
  packages/statusline/src/smoke.test.ts's helper, deliberately"

They are not the same shape, and the docstring asserting it is the only thing anyone has been
reading. Loop 013's review recorded this as S6 and it has sat open for eleven loops.

Both seeds are **JSON string literals**. `JSON.stringify({...})` on an object literal that is
never annotated `UsageSnapshot` gives `tsc` nothing to check, so the schema and the fixtures
are connected by nothing but the care of whoever last edited them. Measured today:

| | `smoke.test.ts` | `scripts/perf.ts` | `UsageSnapshot` says |
|---|---|---|---|
| `display.primaryResetsAt` | present | **absent** | required (`string \| null`) |
| `freshness.staleReason` | `'none'` | **`null`** | `StaleReason`, a 5-member string union with no `null` |
| `freshness.ageSeconds` | absent | **`0`** | no such field |
| cache `version` | literal `2` | literal `2` | `CACHE_VERSION`, a constant |
| `lastHttpStatus`, `lastErrorMessage` | **both absent** | **both absent** | both required on `CacheEnvelope` |
| dir modes | default `0755` | `0700` | — |
| `usage.json` mode | default `0644` | `0600` | — |

Neither fixture is an envelope the product could have written: `perf.ts`'s fails four rows and
`smoke.test.ts`'s fails the last one. That row is what says this is not a `perf.ts` problem with
a tidy neighbour — both are wrong, differently, which is what drift looks like.

It survives because `readCacheResult` (packages/core/src/cache.ts:114-124) checks presence of
`snapshot`, `display` and `freshness`, and string-ness of `fetchedAt` — never the *contents* of
`display` or `freshness`. (`version`, non-null-object and non-array are checked at 102-112.) Run against
the real binary in a sandboxed `HOME`, a seed whose `fetchedAt` is 20 minutes old renders
`42% stale`, proving the seeded `freshness` block is decorative: staleness is recomputed from
`fetchedAt` at render, and only the block's *presence* is load-bearing. So the invalid `staleReason` has
never had a symptom — but **not** because nothing reads the field. Five production sites do:
`state.ts:30,43,49`, `main.ts:250`, and `extension.ts:173`. All five sit behind an `isStale`
guard that these `isStale: false` fixtures never trip. The field is unread by accident of the
fixture, not by design, and `main.ts:250`'s branch *writes the cache file* — which is why the
spec treats seeding a stale `fetchedAt` as a hazard rather than a free parameter.

There is a **third** copy, and it is the one that bites. `makeTestEnvelope` in
`packages/core/src/test-helpers.ts:64` — the repo's designated shared fixture, the one
`CLAUDE.md` tells contributors to check first — hardcodes `version: 1`. `CACHE_VERSION` has
been `2` since loop 002. Probed against the compiled binary in a sandboxed `HOME`:

```
version 2  →  "⊙ 42% stale resets thu 12:00 am · 7d 18% ..."   exit 0
version 1  →  "⊙ auth invalid"                                  exit 2, and the cache file is DELETED
```

**That probe is not reproducible offline, and running it was a mistake.** `authInvalid` is
produced only by an HTTP 401 (`client.ts:91`); a network failure maps to `serviceUnavailable`
and renders `⊙ error`. So `⊙ auth invalid` is proof that a live authenticated request reached
the real endpoint carrying the fixture token — the version-1 envelope is rejected and deleted,
the fixture's year-2100 `expiresAt` makes `resolveCredentials` return `valid`, and `main.ts:284`
fetches. Repeating it with the proxy pointed at a dead port changed nothing, because bun's fetch
ignored the override. No real credential was exposed, but CLAUDE.md says "never hit the real API
in tests", and any acceptance criterion phrased against this output would have put that inside
`bun test`. The spec therefore states the defect as an **offline round-trip** —
`makeTestEnvelope()` written to an isolated cache dir and read back through `readCacheResult`,
which returns `versionMismatch` and deletes the file — and asserts nothing about `auth invalid`.

All 25 current call sites pass that envelope to an in-memory mock, so the version never reaches
`readCacheResult` and nothing is red today. It is a loaded trap, not a live bug: the first
person to write `makeTestEnvelope()` to disk — the obvious thing to do, from the helper
`CLAUDE.md` points at — gets a `versionMismatch`, a deleted file, and an error naming *auth*.

## Who is affected

Nobody today; every symptom above is latent. The cost is paid by the next contributor, and the
shape of the bill is known because this repo has already paid it twice: loop 013's own review
found a seeded cache that, if rejected, would have turned 200 benchmark samples into 200
authenticated API calls against the operator's real token. The guard that catches that is
`SENTINEL_PCT` in warm-up 0. `smoke.test.ts` has that protection in substance for **five of its
seven cases** — they assert `42%` in the child's stdout — but spelled as unrelated literals
rather than one named value, so nothing connects the seed to the assertions that depend on it.
The other two cases (rich output, `--version`) assert neither, so neither would notice the
fixture being rejected.

## Why now

The three copies are diverging monotonically: 013 recorded two, and a third has since appeared
in the file `CLAUDE.md` nominates as the place to look. The next `CACHE_VERSION` bump has to
find and fix three literals in three packages, and nothing will tell whoever does it that the
third exists.

The mechanical opportunity is new. Loop 018 removed `scripts` from `tsconfig.json`'s `exclude`,
so `scripts/perf.ts` is typechecked today and was not for the eleven loops this finding sat
open. A helper that builds a **typed** `UsageSnapshot` is now checked by `bun run typecheck` in
both consumers — which is what makes this a guard rather than a tidy-up.

## What "done" means

- [ ] One helper seeds the sandbox `HOME`; `smoke.test.ts` and `scripts/perf.ts` both call it
      and neither contains its own credential-or-envelope construction.
- [ ] The envelope is built from a value annotated `UsageSnapshot`, so a schema change that
      invalidates the fixture fails `bun run typecheck` instead of passing quietly.
- [ ] The seed's envelope is produced by the **product's own writer** (`makeCacheEnvelope`),
      not by any literal, so a version bump or a new envelope field cannot leave a seed behind.
      This also keeps `CACHE_VERSION` module-private, which the fence below requires.
- [ ] `makeTestEnvelope` no longer produces an envelope the reader rejects.
- [ ] The seeded utilization is a single named value each consumer *derives* its assertions
      from. `smoke.test.ts` writes `42` twice as the seed (lines 45, 48) and five more times as
      bare literals in `toContain('42%')`; those five are already a real read-the-seed guard, so
      this is not a new guard but a removal of the ways it can be silently detached from what
      was seeded.
- [ ] Each of the five claims above fails when the guard is removed. Demonstrated by mutation,
      recorded in `review.md`. A guard nobody has broken on purpose is a guard nobody has tested.

## Explicitly out of scope

- **Tightening `readCacheResult`'s shape validation.** That it accepts `staleReason: null` is a
  real observation and a separate change: it alters product behaviour on malformed cache files,
  needs its own spec on whether to reject or coerce, and touches SPEC.md §9. Recorded here,
  fixed elsewhere. This loop makes the *fixtures* honest, not the reader stricter.
- Changing what the statusline renders, or any `packages/core` production code beyond the
  `version: 1` correction in the test-only helper.
- The `0644`/`0600` and `0755`/`0700` mode differences are in scope only to the extent that one
  helper must pick one answer; this loop does not audit cache permissions generally.
- Unifying the two *sentinel utilization values* (42 and 37) into one constant. Each is
  asserted by its own consumer and the helper takes it as a parameter; collapsing them would
  couple the smoke suite's expectations to the benchmark's.
- `016-perf-regression-baseline`, which stays deliberately unbuilt.

## Open questions

1. Where does the helper live so both a workspace test and a root-level script can import it?
   `scripts/perf.ts` already reaches relatively into `../packages/metrics/src/anomaly.js`
   rather than by package specifier, because the root `package.json` declares no dependency on
   the workspace packages — so the answer is constrained by real precedent, not preference.
2. Does the helper seed by writing files, or by returning a typed envelope the caller writes?
   The two consumers differ in what they need back (`perf.ts` needs the cache path for its
   mtime guard; `smoke.test.ts` needs only the directory).
3. `makeTestEnvelope`'s `version: 1` → `CACHE_VERSION`: does any of the 28 call sites assert on
   the literal `1`, such that the correction changes a test's meaning rather than its value?

## Found while scoping, recorded here

- **SPEC.md:497 still documents `"version": 1`** in the §9.6 cache-file format, while
  `CACHE_VERSION` has been `2` since loop 002. It is plausibly where `test-helpers.ts`'s
  `version: 1` came from. Fixed in this loop: a change whose point is "the cache version comes
  from one place" cannot leave the source of truth stating the wrong number.
- **`readCacheResult` accepts `staleReason: null`**, and any other malformed `freshness` or
  `display` contents. Real, and out of scope by the fence above.
- **A third consumer exists.** `scripts/perf.test.ts` imports `makeSandbox` from `perf.ts` and
  has a whole `describe('makeSandbox')` block, including the on-disk mode assertions this
  intent proposed as new work. Found by the Stage 2 reviewer in a file I had not opened.
