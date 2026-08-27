# Spec: one cache-seed helper, checked by the compiler

- **ID:** 024-cache-seed-helper
- **Stage:** 2 — Design
- **Status:** draft
- **Reads:** `intent.md`
- **Date:** 2026-08-27

## Answers to the intent's open questions

**Q1 — where does the helper live?**
`packages/core/src/test-helpers.ts`. Three facts decide it, all checked rather than assumed:

- `packages/core/package.json` already publishes the subpath `"./test-helpers":
  "./src/test-helpers.ts"`, and `packages/statusline/package.json` already declares
  `"@claudewatch/core": "workspace:*"`. `main.test.ts:2` already imports across it. So
  `smoke.test.ts` needs no new dependency.
- The root `package.json` declares **no** dependency on the workspace packages, which is why
  `scripts/perf.ts:39` reaches relatively into `../packages/metrics/src/anomaly.js` instead of
  using a package specifier. `perf.ts` therefore imports `../packages/core/src/test-helpers.js`
  the same way. This is precedent in the file being changed, not a new pattern.
- The file already contains filesystem helpers (`makeTempCacheDir`, `setupTestCacheDir`), so a
  seeder that writes a sandbox `HOME` is not a change of kind.

Its docstring says "only imported by `*.test.ts` files". That becomes false and must be
corrected in the same change: a benchmark script will import it too.

**Q2 — write files, or return an envelope for the caller to write?**
Write the files, and return the paths. The consumers want different things back — `perf.ts`
needs `cachePath` for its mtime guard, `smoke.test.ts` needs only `home` — and a helper that
returned an envelope would leave both callers re-writing the credential file, which is half of
what drifted. One function, one write, a result object carrying every path a caller might
assert on.

**Q3 — does correcting `version: 1` change a test's meaning?**
Yes, in exactly one place. `packages/core/src/cooldown.test.ts:61` asserts
`expect(result.version).toBe(1)` inside a test named *"preserves existing snapshot"*. The
number is the fixture's value copied into the assertion; the property under test is
preservation. Its sibling at line 83 already writes the correct form,
`expect(result.version).toBe(env.version)`. Line 61 becomes the same. That is not a weakening:
if `enterCooldown` dropped the field, `result.version` would be `undefined` and `env.version`
would not, so the assertion still fails for the reason it exists. The other 27 call sites pass
the envelope to in-memory mocks and never read `.version`.

## Behaviour

### The helper

```ts
export interface SandboxSeed {
  /** Absolute path to the sandbox HOME. */
  home: string;
  /** Absolute path to the seeded cache envelope. */
  cachePath: string;
  /** Absolute path to the fixture credential. */
  credentialsPath: string;
  /** The utilization the seeded envelope renders — assert on THIS, never on a literal. */
  utilizationPct: number;
}

export function seedSandboxHome(opts: {
  prefix: string;
  utilizationPct: number;
  accessToken: string;
  fetchedAt?: string;
}): SandboxSeed;
```

It creates `mkdtemp(<tmpdir>/<prefix>)` and inside it:

| Path | Mode | Contents |
|---|---|---|
| `.claude/` | `0700` | — |
| `.claude/.credentials.json` | `0600` | `{claudeAiOauth:{accessToken, refreshToken:'r', expiresAt:4102444800000}}` |
| `.cache/claudewatch/` | `0700` | — |
| `.cache/claudewatch/usage.json` | `0600` | `makeTestEnvelope({ snapshot })` serialized |

The `0700`/`0600` column is `perf.ts`'s current behaviour, adopted over `smoke.test.ts`'s
defaults (`0755`/`0644`). Reason, taken from the comment already at `scripts/perf.ts:107`: this
helper is a template someone will copy to a path where the mode matters. Modes are passed to
`mkdirSync`/`writeFileSync` at creation, not chmodded after, so no `0644` window exists — plus
the belt-and-braces `chmodSync` `perf.ts` already carries, because `mode` is advisory against a
permissive umask.

The snapshot is built by `makeTestSnapshot(...)`, whose return type is annotated
`UsageSnapshot`. **This is the whole mechanism.** Both current seeds are `JSON.stringify` over
an unannotated object literal, which `tsc` cannot check; routing through a typed builder means
a schema change that invalidates the fixture is a compile error in a file `bun run typecheck`
covers. `scripts/` has been inside that coverage since loop 018 removed it from
`tsconfig.json`'s `exclude`.

The envelope is built by `makeTestEnvelope`, so the cache version comes from one place.

### The `version: 1` correction

`makeTestEnvelope` changes `version: 1` to `version: CACHE_VERSION`, imported from `cache.ts`
(which already exports nothing of the sort — see Risks). This is the change that makes hoisting
correct rather than merely tidy: the hoisted helper writes its envelope through
`makeTestEnvelope`, so if that still said `1`, both consumers would begin failing.

### Consumers

`packages/statusline/src/smoke.test.ts`: `makeSandbox()` is deleted; `beforeAll` calls
`seedSandboxHome({ prefix: 'cw-smoke-', utilizationPct: 42, accessToken:
'sk-ant-oat01-SMOKE-TEST-NOT-REAL' })` and keeps the result. The seven
`expect(r.stdout).toContain('42%')` literals become `` `${seed.utilizationPct}%` ``.

`scripts/perf.ts`: `makeSandbox()` is deleted; `measure()` calls `seedSandboxHome({ prefix:
'cw-perf-', utilizationPct: SENTINEL_PCT, accessToken: 'sk-ant-oat01-PERF-FIXTURE-NOT-REAL' })`
and takes `home` and `cachePath` from the result instead of recomputing the join. `SENTINEL_PCT`
stays exported from `perf.ts` — it is that script's contract with its own guard, and the intent
puts collapsing the two sentinels out of scope.

Everything else in both files is untouched: the timeout guard, the mtime guard, the sentinel
probe, the `USERPROFILE`/`HOMEDRIVE`/`HOMEPATH` pinning, the signal handlers.

## Edge cases

1. **`makeTestSnapshot`'s defaults are not the seeds' values.** It defaults `fiveHour` to `42`
   with `resetsAt: '2026-03-07T17:00:00.000Z'` — a date in the past — and `display` to match.
   The seeds use `'2099-01-01T00:00:00.000Z'`. The helper must override `fiveHour`, `sevenDay`,
   and the whole `display` block together; overriding `fiveHour` alone would leave `display`
   pointing at 42 while the window said something else. A past `resetsAt` is not obviously
   harmless — it feeds reset-time rendering — so the helper keeps `2099`.
2. **`fetchedAt` and staleness.** Probed against the real binary: a seed 20 minutes old renders
   `42% stale`. Staleness is recomputed from `fetchedAt` at render; the seeded `freshness` block
   is decorative and only its *presence* is checked (`cache.ts:113`). Default `fetchedAt` is
   therefore `new Date().toISOString()`, matching both current seeds, and is a parameter so a
   future case can seed a stale one deliberately.
3. **The two consumers run concurrently.** `bun test` runs `smoke.test.ts` while `verify`'s perf
   step may be running `perf.ts`. `mkdtempSync` guarantees distinct directories, and the
   distinct `prefix` values keep them legible in `/tmp`. No shared path exists.
4. **Cleanup is the caller's.** `perf.ts` registers SIGINT/SIGTERM handlers around its sandbox
   and `smoke.test.ts` uses `afterAll`; both are existing, correct, and different. The helper
   does not attempt a shared cleanup policy — it returns `home` and each caller keeps the
   `rmSync` it already has.
5. **A fake token in a shipped bundle.** The helper holds `sk-ant-oat01-*-NOT-REAL` strings and
   lives in the core package's `src/`. `packages/core` builds with `bun build src/index.ts`, and
   `index.ts` does not re-export `test-helpers.js`, so it should not be reachable — but "should"
   is the word that has been wrong before in this repo. Verified against the built artifact as
   an acceptance criterion, not asserted here.

## Acceptance criteria

Each is mechanically checkable, and each names the command that checks it.

- **A1.** `packages/statusline/src/smoke.test.ts` and `scripts/perf.ts` contain no
  `writeFileSync` of a credential or a cache envelope.
  `grep -c 'claudeAiOauth' packages/statusline/src/smoke.test.ts scripts/perf.ts` → `0` for both.
- **A2.** `bun run typecheck` exits 0.
- **A3.** Corrupting the fixture's shape is a **compile** failure, not a silent pass: changing
  the helper's `staleReason` to `null` — the exact invalid value `scripts/perf.ts` ships today
  — makes `bun run typecheck` exit non-zero naming that property. Demonstrated by mutation.
- **A4.** `makeTestEnvelope().version === CACHE_VERSION`, asserted in
  `packages/core/src/test-helpers` coverage by a test that reads `CACHE_VERSION` rather than the
  literal `2`.
- **A5.** An envelope from `makeTestEnvelope()`, written to a sandbox `HOME` and read by the
  **compiled binary**, is a cache hit: stdout contains the seeded utilization and the exit code
  is 0. Before this change the same test yields `auth invalid` and exit 2. This is the criterion
  that distinguishes "the number was changed" from "the trap was removed", and it must spawn the
  real binary — the 28 existing call sites all pass because they never write to disk.
- **A6.** Both consumers still pass: `bun test packages/statusline/src/smoke.test.ts` exits 0,
  and `bun run perf --samples 30 --report-only` exits 0 with its sentinel probe satisfied.
- **A7.** `bun run verify` exits 0.
- **A8.** The seeded utilization reaches the assertions by reference: `grep -c "42%"
  packages/statusline/src/smoke.test.ts` → `0`.
- **A9.** Mode claims are true of the files on disk, not just of the arguments passed:
  `statSync(cachePath).mode & 0o777 === 0o600` and the same for the credential, asserted in a
  test that reads a sandbox the helper really created. (Loop 014 shipped a `0600` claim that was
  `0644` on disk; the test that "checked" it chmodded a file of its own first.)
- **A10.** `packages/core/dist/index.js` does not contain `NOT-REAL` — the fixture token is not
  in the shipped bundle. Checked after `bun run --filter @claudewatch/core build`.

## Risks

- **`CACHE_VERSION` is not exported.** `packages/core/src/cache.ts:12` declares it
  `const CACHE_VERSION = 2` — module-private. A4 and the helper both need it. Exporting a
  constant from a shipped module is a production-surface change, small but real, and it must be
  named in `plan.md`'s fence rather than smuggled in. The alternative — re-declaring `2` in
  `test-helpers.ts` — recreates the exact defect this loop exists to remove.
- **A5 spawns the compiled binary**, so it belongs in a suite that already tolerates the build
  dependency. `smoke.test.ts` has the `beforeAll` that builds on demand; putting A5 anywhere
  else means duplicating that. Placing it in `smoke.test.ts` is the cheap answer and keeps the
  binary-spawning tests in the file whose docstring says that is its job.
- **Tightening modes on the smoke sandbox from `0755` to `0700`** changes behaviour for a
  directory the test itself creates and removes. If anything in the statusline path enumerates
  a parent directory, this could surface as a permission error rather than a cleaner test. Low,
  and A6 catches it, but it is a real behaviour change and not a pure refactor.
