# Spec: one cache-seed helper, checked by the compiler

- **ID:** 024-cache-seed-helper
- **Stage:** 2 — Design
- **Status:** accepted (revision 2, after the Stage 2 review)
- **Reads:** `intent.md`
- **Date:** 2026-08-27

## What revision 1 got wrong

The Stage 2 reviewer returned six blocking findings. Five were correct and are the reason this
document changed shape; one I decline. Recording them here rather than only in `review.md`,
because three of them changed the *design*, not the wording.

| | Finding | Verified how | Effect |
|---|---|---|---|
| B1 | A3 was vacuous — it passed on the pre-change tree | the helper never overrides `freshness`, so it contains no `staleReason` to mutate; the only one is in `makeTestSnapshot`, already annotated | A3 rewritten to mutate the **schema** |
| B2 | `scripts/perf.test.ts` is a third consumer; imports `makeSandbox`, has a whole `describe` block | `grep -n makeSandbox scripts/perf.test.ts` → lines 6, 103, 105, 123, 225, 246 | third consumer added to the fence |
| B3 | "nothing reads `staleReason`, and never will" was false | five production readers found | intent corrected; `fetchedAt` hazard documented |
| B4 | A4 was `x === x` after the change | trivially, once `makeTestEnvelope` returns `version: CACHE_VERSION` | replaced by an offline round-trip |
| B5 | intent's fence forbade the `CACHE_VERSION` export the spec required | both documents read side by side | **dissolved** — see below |
| B6 | A5's "before" state is reachable only via a live 401 | `client.ts:91` is the sole `authInvalid` source; a network error maps to `serviceUnavailable` → `⊙ error` | acceptance moved fully offline |

**Declined: N4** ("Stage: 1 — Plan should be Stage 1 — Intent"). `.claude/sdlc/templates/intent.md:4`
itself reads `**Stage:** 1 — Plan`. The header matches the repo's own template; changing it would
put this loop out of step with the other 22.

B4 is the finding that improved the design rather than just correcting it, and it cascades:
building the fixture from the product's own writer means `CACHE_VERSION` need never be exported,
which dissolves B5 outright and fixes M8 (both fixtures omit `lastHttpStatus` and
`lastErrorMessage`, which `makeCacheEnvelope` supplies) for free.

## Answers to the intent's open questions

**Q1 — where does the helper live?** `packages/core/src/test-helpers.ts`. Three facts, each
checked: `packages/core/package.json` already publishes the subpath `"./test-helpers"`;
`packages/statusline/package.json` already declares `"@claudewatch/core": "workspace:*"` and
`main.test.ts:2` already imports across it; and the root `package.json` declares no workspace
dependency, which is why `scripts/perf.ts:39` reaches relatively into
`../packages/metrics/src/anomaly.js` — so `perf.ts` imports `../packages/core/src/test-helpers.js`
the same way. The file already holds filesystem helpers (`makeTempCacheDir`,
`setupTestCacheDir`), so a sandbox seeder is not a change of kind. Its docstring ("only imported
by `*.test.ts` files") becomes false and is corrected in the same change.

**Q2 — write files, or return an envelope?** Write, and return the paths. `perf.ts` needs
`cachePath` for its mtime guard; `smoke.test.ts` needs only `home`. A helper returning an
envelope would leave both callers re-writing the credential file, which is half of what drifted.

**Q3 — does correcting `version: 1` change a test's meaning?** In one place.
`cooldown.test.ts:61` asserts `expect(result.version).toBe(1)` inside a test named *"preserves
existing snapshot"*; the number is the fixture's value copied into the assertion. Its sibling at
:83 already writes the correct form, `expect(result.version).toBe(env.version)`. Line 61 becomes
the same, which is not a weakening: a dropped field gives `undefined !== env.version`. The other
24 call sites use in-memory mocks and never read `.version`. **A fourth literal exists** that
revision 1 missed: `perf.test.ts:114`, `expect(envelope.version).toBe(2)`.

## Behaviour

### 1. `makeTestEnvelope` is built from the product's writer

```ts
export function makeTestEnvelope(overrides?: Partial<CacheEnvelope>): CacheEnvelope {
  return { ...makeCacheEnvelope(makeTestSnapshot()), ...overrides };
}
```

`makeCacheEnvelope` (`cache.ts:196`) is exported, is what `writeCache` uses, and supplies
`version: CACHE_VERSION` plus the `lastHttpStatus`/`lastErrorMessage` both fixtures omit. This
single line fixes the `version: 1` trap and M8's missing row, keeps `CACHE_VERSION` private, and
means the fixture cannot drift from the writer without the writer itself changing.

### 2. The seeder

```ts
export interface SandboxSeed {
  home: string;
  cachePath: string;
  credentialsPath: string;
  /** The utilization the seeded envelope renders. Assert on THIS, never on a literal. */
  utilizationPct: number;
}

export function seedSandboxHome(opts: {
  prefix: string;
  accessToken: string;
  utilizationPct?: number;              // convenience; default 42
  snapshot?: UsageSnapshot;             // full control, e.g. makeTestEnterpriseSnapshot()
  envelope?: Partial<CacheEnvelope>;    // e.g. cooldownUntil, or a deliberately bad version
  seedCache?: boolean;                  // default true; false = first-run, no cache at all
}): SandboxSeed;
```

The wider surface is finding M9: revision 1's four-parameter version could not express an
enterprise snapshot, a cooldown, a deliberately-rejected envelope, or a first-run sandbox — and
the third of those is needed by this loop's own mutation demonstration.

It creates `mkdtemp(<tmpdir>/<prefix>)` and inside it:

| Path | Mode | Contents |
|---|---|---|
| `.claude/` | `0700` | — |
| `.claude/.credentials.json` | `0600` | `const creds: CredentialFile = {...}` — **typed** (M5) |
| `.cache/claudewatch/` | `0700` | — |
| `.cache/claudewatch/usage.json` | `0600` | `makeTestEnvelope({ snapshot, ...envelope })`, unless `seedCache: false` |

Modes are `perf.ts`'s, adopted over `smoke.test.ts`'s `0755`/`0644`, and passed at creation so no
`0644` window exists. Per M6 the `chmodSync` afterwards is **dropped**, and `perf.ts:120`'s
justification for it ("advisory against a permissive umask") is not repeated: umask can only
clear bits, never add them. `mode` is ignored only when the file already exists, which cannot
happen inside a fresh `mkdtemp`.

The snapshot is built by `makeTestSnapshot(...)`, return-annotated `UsageSnapshot`. **That is the
whole mechanism**, and the reviewer confirmed it works by compiling all three drift rows:
`staleReason: null` → TS2322, `ageSeconds: 0` → TS2353, missing `primaryResetsAt` → TS2741.
`Partial<T>` loosens only the top level, so nested literals stay checked. Per N7, overrides must
be written as **inline object literals** at the call — excess-property checking is bypassed when
the override is a pre-declared variable.

### 3. Consumers — three, not two

- `packages/statusline/src/smoke.test.ts`: `makeSandbox()` deleted; `beforeAll` calls
  `seedSandboxHome({ prefix: 'cw-smoke-', utilizationPct: 42, accessToken: '…SMOKE-TEST-NOT-REAL' })`.
  The five `toContain('42%')` literals become `` `${seed.utilizationPct}%` ``.
- `scripts/perf.ts`: `makeSandbox()` deleted; `measure()` calls `seedSandboxHome({ prefix:
  'cw-perf-', utilizationPct: SENTINEL_PCT, accessToken: '…PERF-FIXTURE-NOT-REAL' })` and takes
  `home`/`cachePath` from the result. `SENTINEL_PCT` stays exported.
- `scripts/perf.test.ts`: its `describe('makeSandbox')` block (103–131) and the mode test
  (224–233) retarget to `seedSandboxHome`; `perf.test.ts:114`'s `toBe(2)` is deleted in favour of
  the round-trip in A2, which is the property that literal was reaching for.

Everything else in all three files is untouched: timeout guard, mtime guard, sentinel probe,
`USERPROFILE`/`HOMEDRIVE`/`HOMEPATH` pinning, signal handlers.

## Edge cases

1. **`makeTestSnapshot`'s defaults are not the seeds' values** — `fiveHour` defaults to `42` with
   a *past* `resetsAt`. The helper overrides `fiveHour`, `sevenDay` and the whole `display` block
   together; overriding `fiveHour` alone would leave `display` disagreeing with it.
2. **`fetchedAt` and staleness.** Staleness is recomputed from `fetchedAt`; the seeded `freshness`
   block is decorative and only its presence is checked. Default is `new Date().toISOString()`.
   Per B3 the parameter carries a hazard: a caller seeding a stale `fetchedAt` puts the binary on
   `main.ts:249-255`, which **writes the cache** and would trip `perf.ts:207`'s mtime guard. The
   helper's docstring says so. Kept rather than dropped, because `seedCache: false` and a
   deliberately-stale seed are how the first-run and cooldown cases get written later.
3. **N2 — the 600s coupling.** `isCacheFresh`'s default TTL is 600s and `smoke.test.ts` seeds once
   in `beforeAll` for seven spawns. That is an undocumented 10-minute budget on the whole suite.
   The helper's docstring states it.
4. **N1 — the two consumers do not race.** `verify.ts:36-55` runs `test` then `perf`
   sequentially; revision 1 claimed they overlap and that was wrong. The real concurrency is
   `perf.test.ts` spawning `perf.ts` from inside `bun test`. `mkdtempSync` makes it moot.
5. **Cleanup stays the caller's** — `perf.ts` has SIGINT/SIGTERM handlers, `smoke.test.ts` has
   `afterAll`. Both correct, both different; the helper imposes no policy.

## Acceptance criteria

Every criterion is offline and deterministic. None spawns the compiled binary, and none can be
satisfied by the pre-change tree — B6's lesson, and B1's.

- **A1.** No consumer builds a credential or envelope literal.
  `grep -c "claudeAiOauth\|version\": *2\|\"version\": 2" packages/statusline/src/smoke.test.ts scripts/perf.ts`
  → `0` for both. Run as `grep -c … || true`: `grep -c` **exits 1 on zero matches** (M4), so the
  passing case fails a `set -e` script.
- **A2.** *(replaces r1's A4 and A5 — the round trip, offline.)* In `packages/core`, using the
  existing `setupTestCacheDir()`: write `JSON.stringify(makeTestEnvelope())` to the cache path,
  then call `readCacheResult()`. Assert `reason !== 'versionMismatch'`, the returned envelope is
  non-null, and **the file still exists afterwards**. Positive precondition in the same test: the
  file exists *before* the read, and a deliberately-bad `makeTestEnvelope({ version: 0 })`
  through the same path *does* yield `versionMismatch` and *does* delete the file. Without both
  halves this is a test that proves the pipe is connected and nothing else — loop 022's shape.
  On the pre-change tree the first half fails.
- **A3.** *(replaces r1's vacuous A3.)* Mutate the **schema**: add a required field to
  `UsageSnapshot` in `packages/core/src/types.ts`. After the change, `bun run typecheck` exits
  non-zero **naming `scripts/perf.ts`**. Record the pre-change run of the same mutation, where
  `scripts/perf.ts` is not named at all — its literal absorbs the change silently. That
  difference is the entire point of the loop, and it is the only mutation only this loop
  survives.
- **A4.** *(M1 — the helper honours its input.)* A core test seeds `utilizationPct: 77` — a value
  equal to no default anywhere — and asserts the envelope read **back off disk** has both
  `snapshot.fiveHour.utilizationPct === 77` and `snapshot.display.primaryUtilizationPct === 77`.
  Without this, a `seedSandboxHome` that accepted `utilizationPct` and dropped it would leave
  `makeTestSnapshot`'s default `42` in place and every smoke assertion would still pass green.
- **A5.** `grep -c "42%" packages/statusline/src/smoke.test.ts` → `0` **and** the file still
  contains ≥5 `toContain` assertions referencing `seed.utilizationPct`. The second half matters:
  the first is also satisfied by deleting every assertion in the file.
- **A6.** Modes are true **on disk**, not just in the arguments: `expect(statSync(p).mode & 0o777)
  .toBe(0o600)` — note the parenthesisation; `mode & 0o777 === 0o600` parses as `mode & false`
  and is always falsy (M6). Guarded by `if (process.platform !== 'win32')`, since SPEC.md §12
  calls modes advisory there and `packages/statusline` has a `build:windows` target. This check
  exists today at `perf.test.ts:224-233` and is **relocated**, not written.
- **A7.** `bun run verify` exits 0. (r1's A2 — a bare `typecheck` — is deleted: it is step 1 of
  `verify` and was true of the tree already, M10.)
- **A8.** No fixture token in any **shipped** artifact, after `bun run build`: `grep -c 'NOT-REAL'`
  → 0 against `packages/statusline/dist/claudewatch` (the compiled binary SPEC.md §12 names),
  `packages/vscode/dist/extension.js` (the VSIX payload), and `packages/core/dist/index.js`.
  r1 checked only the last, which no consumer imports — `packages/core/package.json` points
  `main` and `exports` at `src/index.ts` (M2).
- **A9.** `SPEC.md:497` reads `"version": 2`. The §9.6 cache-file format documents `1` today and
  is the likely origin of the `test-helpers.ts` bug (M7).

## Risks

- **`makeTestEnvelope` gains two fields** (`lastHttpStatus`, `lastErrorMessage`) for all 25 call
  sites. All pass it to in-memory mocks or read `cooldownUntil`/`lastErrorClass`, so this should
  be inert — but "should" is the word this repo has been wrong about before, and A7 is what
  actually decides it.
- **Tightening smoke's sandbox from `0755` to `0700`** is a real behaviour change, not a
  refactor, on a directory the test creates and removes. A7 catches it.
- **`perf.test.ts` retargeting is the largest untested-by-design surface.** It is itself the test
  file, so a mistake there is silent by construction; the plan-to-diff audit must look at it
  specifically rather than treating it as incidental churn.
