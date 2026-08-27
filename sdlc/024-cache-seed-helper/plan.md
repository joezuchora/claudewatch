# Plan: one cache-seed helper, checked by the compiler

- **ID:** 024-cache-seed-helper
- **Stage:** 3 — Build (planning half)
- **Status:** accepted
- **Reads:** `spec.md` (revision 2)
- **Date:** 2026-08-27

## Approach

Four moves, in this order, because each makes the next safe:

1. **`makeTestEnvelope` delegates to `makeCacheEnvelope`.** One line. It fixes the `version: 1`
   trap and the missing `lastHttpStatus`/`lastErrorMessage`, and it is what lets the new seeder
   write a correct envelope without knowing anything about versions.
2. **Add `seedSandboxHome` beside it**, building its snapshot through the typed
   `makeTestSnapshot`. This is the guard: `tsc` now sees the fixture.
3. **Point all three consumers at it** and delete their local copies.
4. **Correct the two stale literals** the scoping turned up — `cooldown.test.ts:61` and
   `SPEC.md:497`.

Order matters for step 1 before step 3: if the consumers switched first, they would briefly seed
`version: 1` envelopes and the perf sentinel probe would fail.

## Scope fence

Exactly these seven files. Anything else in the diff is an excursion and must be explained in
`review.md`.

| Path | Why |
|---|---|
| `packages/core/src/test-helpers.ts` | the helper, the `makeTestEnvelope` fix, the docstring |
| `packages/core/src/test-helpers.test.ts` | **new** — A2, A4, A6 |
| `packages/core/src/cooldown.test.ts` | `:61` fixture-value leak |
| `packages/statusline/src/smoke.test.ts` | consumer 1 |
| `scripts/perf.ts` | consumer 2 |
| `scripts/perf.test.ts` | consumer 3 |
| `SPEC.md` | §9.6 documents `"version": 1` |

**Explicitly not touched:** `packages/core/src/cache.ts` (no `CACHE_VERSION` export — the whole
point of the revision-2 design), `packages/core/src/index.ts`, `packages/core/src/types.ts`
(except transiently, during A3's mutation, which is reverted), any `packages/vscode` file, and
`scripts/verify.ts`.

## Changes

### `packages/core/src/test-helpers.ts`

- `makeTestEnvelope` becomes `{ ...makeCacheEnvelope(makeTestSnapshot()), ...overrides }`;
  import `makeCacheEnvelope` from `./cache.js` (already imported for `setCacheBaseDir`).
- Add `SandboxSeed` and `seedSandboxHome` per spec §2. The credential is
  `const creds: CredentialFile = {...}` — typed, per M5 — and `CredentialFile` joins the
  existing type import.
- Snapshot overrides are written as **inline object literals** at the `makeTestSnapshot` call
  (N7: excess-property checking is skipped for a pre-declared variable, so a `ageSeconds: 0`
  would slip through if the override were hoisted to a `const`).
- Modes at creation; **no** trailing `chmodSync`, and no repetition of the false "advisory
  against a permissive umask" justification (M6).
- Docstring: no longer "only imported by `*.test.ts` files"; note the `fetchedAt` hazard (a
  stale seed puts the binary on `main.ts:249-255`, which writes the cache) and the 600s TTL
  coupling.

### `packages/core/src/test-helpers.test.ts` *(new)*

Covers A2, A4, A6. Uses the existing `setupTestCacheDir()` so nothing touches
`~/.cache/claudewatch`.

### `packages/core/src/cooldown.test.ts`

`:61` `expect(result.version).toBe(1)` → `toBe(env.version)`, matching its sibling at `:83`.

### `packages/statusline/src/smoke.test.ts`

Delete `makeSandbox` (lines 24-54) and the now-unused `fs` imports it alone used. `beforeAll`
calls `seedSandboxHome({ prefix: 'cw-smoke-', utilizationPct: 42, accessToken:
'sk-ant-oat01-SMOKE-TEST-NOT-REAL' })` into a module-level `seed`; `sandbox` becomes `seed.home`.
The five `toContain('42%')` become `` toContain(`${seed.utilizationPct}%`) ``.

### `scripts/perf.ts`

Delete `makeSandbox` (lines 100-136) and its now-unused imports. `measure()` calls
`seedSandboxHome({ prefix: 'cw-perf-', utilizationPct: SENTINEL_PCT, accessToken:
'sk-ant-oat01-PERF-FIXTURE-NOT-REAL' })`, takes `home` and `cachePath` from the result rather
than re-joining the path. Import is the relative `../packages/core/src/test-helpers.js`, matching
the `anomaly.js` precedent three lines above.

### `scripts/perf.test.ts`

Drop `makeSandbox` from the import. The three tests that call it directly — `:104` (v2 envelope
+ 0600 credential), `:122` (token not real), `:224` (0600/0700 modes) — move to
`test-helpers.test.ts` retargeted at `seedSandboxHome`; `:114`'s `expect(envelope.version)
.toBe(2)` is not carried over, because A2's round trip is the property that literal was reaching
for. Perf-level coverage of the seeding is unaffected: `:218` still proves the sentinel probe
fires through the real CLI, and `:246`'s `toContain('cw-perf-')` still proves the prefix reaches
the child.

### `SPEC.md`

§9.6's cache-file example: `"version": 1` → `"version": 2`.

## Tests

| Criterion | Where | What would make it fail |
|---|---|---|
| A2 round trip | `test-helpers.test.ts` | `makeTestEnvelope` emitting any version the reader rejects |
| A2 precondition | same test | `{ version: 0 }` **not** yielding `versionMismatch` + deletion |
| A4 honours input | `test-helpers.test.ts` | a seeder that ignores `utilizationPct` (seeded 77, no default is 77) |
| A6 modes on disk | `test-helpers.test.ts` | mode set after creation, or not at all |
| A3 schema guard | manual mutation, recorded | `perf.ts` absorbing a new required field silently |
| A5 no bare `42%` | `grep` | a literal reappearing |
| A1 no local fixtures | `grep` | a consumer regrowing its own |
| A7 gate | `bun run verify` | anything |
| A8 no token in artifacts | `grep` after `build` | the helper becoming reachable from `index.ts` |
| A9 SPEC.md | `grep` | — |

A2 is the one that must not become vacuous: the negative half (a rejected envelope) and the
positive half (an accepted one, file still present) live in the **same** test, so neither can
pass alone.

## Verification

1. `bun run verify` exits 0.
2. A3's mutation run twice — once on the pre-change tree, once after — with both outputs pasted
   into `review.md`. This is the criterion the loop exists for; a summary of it is not evidence.
3. Mutation-test each new guard: revert `makeTestEnvelope` to `version: 1` (A2 must fail),
   make `seedSandboxHome` ignore `utilizationPct` (A4 must fail), move the mode to a trailing
   `chmodSync` (A6 must still pass — that one is a *false* mutation, and saying so in advance is
   how I avoid reading its "inert" result as a gap).
4. `bun test scripts/perf.test.ts` and `bun test packages/statusline/src/smoke.test.ts`
   individually, since both were edited and `verify` runs the suite as one.
5. Stage 5: `plan-to-diff-auditor` and `security-reviewer` on the commit range, briefed not to
   write into the tree.

## Risks

- **`perf.test.ts` is itself the test file**, so an error there is silent by construction. The
  plan-to-diff audit must look at it specifically rather than treating it as churn.
- **25 call sites gain two envelope fields.** Expected inert; `verify` decides.
- **Smoke's sandbox tightens `0755`→`0700`.** A real behaviour change on a directory the test
  owns.
- **The `fetchedAt` parameter ships unused.** Justified by `seedCache: false` and the cooldown
  cases it exists to enable, but an unused parameter is a thing reviewers rightly dislike; if
  the reviewer pushes back, dropping it costs nothing this loop.
