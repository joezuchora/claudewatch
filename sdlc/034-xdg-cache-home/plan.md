# Plan: honour `$XDG_CACHE_HOME`, or stop claiming to

- **ID:** 034-xdg-cache-home
- **Stage:** 3 — Build
- **Reads:** `sdlc/034-xdg-cache-home/spec.md`
- **Date:** 2026-08-28

## Scope fence

Nineteen paths — counted against the table, not asserted. The table has **nineteen** rows.

| Path | Change | Criterion |
|---|---|---|
| `packages/core/src/cache.ts` | B1's resolver; `getLegacyCacheDir()` exported | A2–A5 |
| `packages/core/src/cache.test.ts` | the resolution matrix, `setCacheBaseDir` both directions, `win32.isAbsolute` | A2–A5, A14 |
| `packages/core/src/telemetry.ts` | `getLegacySpoolPath()` exported | A3 |
| `packages/core/src/telemetry.test.ts` | all four derived paths move together | A3 |
| `packages/core/src/test-helpers.ts` | `XDG_CACHE_HOME` joins the `SandboxSeed.env` allowlist | A13 |
| `packages/core/src/test-helpers.test.ts` | the seed carries it, mirroring `:157-165` | A13 |
| `scripts/spool-path.ts` | **new** — side-effect-free `resolveCacheDir(home, env)` / `resolveSpoolPath(home, env)` | A6 |
| `scripts/spool-path.test.ts` | **new** — A6's matrix, no subprocess | A6 |
| `scripts/verify.ts` | imports the resolver; `spoolPath()` **and** `:169`'s `mkdirSync` both derive from it | A7 |
| `scripts/env.test.ts` | `runGate`'s `childEnv` pins `XDG_CACHE_HOME` | A1, A13 |
| `scripts/perf.test.ts` | the two sandbox sites pin it | A1, A13 |
| `packages/vscode/src/extension.test.ts` | `:73`'s assertion updated for the resolver | A13 |
| `packages/metrics/src/agent.ts` | `shouldDrainLegacy()` and `combineResults()` exported | A8, A9 |
| `packages/metrics/src/agent.test.ts` | both, including the retained-`.shipping` case | A8, A9 |
| `packages/metrics/src/cli-ship.ts` | composes the two; exit on the combined result | A8, A9 |
| `packages/statusline/src/smoke.test.ts` | `--debug` reports the resolved `cachePath` | A15 |
| `SPEC.md` | §9.6's paragraph, plus `:1073`, `:1191`, `:1256` | A9 (doc), B8 |
| `README.md` + `CONTRIBUTING.md` | the two approximate sites | B8 |
| `deploy/README.md` | B6's `ReadWritePaths` note with exact syntax | B6 |

**Explicitly not touched:** `packages/core/src/snapshot.ts`, `packages/core/src/normalize.ts`,
`packages/core/src/format.ts`, `packages/core/src/state.ts`, `packages/core/src/client.ts`,
`packages/core/src/config.ts`, `packages/statusline/src/main.ts`, `packages/vscode/src/extension.ts`,
`scripts/junit.ts`, `scripts/fence-check.ts`, `scripts/lint-budget.ts`, `.oxlintrc.json`,
`.oxlint-budget.json`, `CLAUDE.md`, `deploy/install-nuc.sh`,
`deploy/systemd/claudewatch-ship.service`.

> **No bare `scripts/`, deliberately.** Loops 029–032 all fence it as house style and loop 033
> proved what that costs: this loop adds `scripts/spool-path.ts`, so a bare directory entry would
> make `fenceCheck` report a finding against its own loop. Every `scripts/` exclusion is named
> file-by-file. **No `except` clause either** — loop 033's plan amendment recorded that "everything
> under X except Y" inverts both terms, and this fence avoids the construction entirely rather than
> relying on remembering it.

> **`config.ts` is on the negative fence on purpose.** The spec's *Recorded, not fixed* names it:
> `deploy/install-nuc.sh:14-15` honours `${XDG_CONFIG_HOME:-$HOME/.config}` while `config.ts:29`
> hardcodes `.config`. Same defect, opposite direction, already shipped. Fixing it here would widen
> a cache loop into a config loop; it stays recorded.

**On `sdlc/README.md`:** Stage 6's retrospective lands in its own commit after `review.md`, as every
prior loop's has, and is not in this fence.

## Changes

### 1. `packages/core/src/cache.ts` — the resolver

```ts
import { isAbsolute, join } from 'path';

/** Today's behaviour, kept as a named export so nothing reconstructs it by hand. */
export function getLegacyCacheDir(): string {
  return join(homedir(), '.cache', 'claudewatch');
}

export function getCacheDir(): string {
  if (cacheBaseDir !== null) return cacheBaseDir;
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg !== undefined && isAbsolute(xdg)) return join(xdg, 'claudewatch');
  return getLegacyCacheDir();
}
```

One condition, not two: `isAbsolute('') === false`, so an explicit empty-string test is an
equivalent mutant. The spec fixes this shape so two implementers do not build two resolvers, and
A10 predicts five rules rather than six because of it.

`getLegacyCacheDir()` exists so `cli-ship` imports the legacy path rather than becoming a ninth
hand-built definition — the failure this whole loop is about.

### 2. `packages/core/src/telemetry.ts`

`getLegacySpoolPath()` = `join(getLegacyCacheDir(), 'metrics-spool.jsonl')`. `getSpoolPath()` and
`getSpoolStatePath()` are unchanged: they already derive from `getCacheDir()` and move for free,
which A3 asserts rather than assumes.

### 3. `scripts/spool-path.ts` — new, and the reason A6 is writable

`verify.ts` exports nothing and ends in `process.exit()`, so no test can import it. The pattern the
repo already uses for exactly this is `scripts/env.ts`, documented at `config.ts:37-42`. So:

```ts
export function resolveCacheDir(home: string, env: NodeJS.ProcessEnv): string
export function resolveSpoolPath(home: string, env: NodeJS.ProcessEnv): string
```

`home` and `env` are **parameters**, not ambient reads, because `homedir()` is resolved once at
process start and does not re-read a mutated `process.env.HOME` — already documented at
`extension.test.ts:12-16`. Without parameterisation A6's `HOME` axis needs a subprocess per cell at
`env.test.ts`'s 180 s timeouts.

The file carries a comment stating it is a deliberate copy of core's rule, why it cannot import
core, and that `spool-path.test.ts` is what stops it drifting.

### 4. `scripts/verify.ts` — both sites

`spoolPath()` becomes `resolveSpoolPath(homedir(), process.env)`. The `mkdirSync` at `:169` becomes
`mkdirSync(dirname(spoolPath()), { recursive: true, mode: 0o700 })`.

**This is the finding the Stage 2 review caught, and the second half is the load-bearing one.**
Patching only `spoolPath()` makes `record()` create the legacy directory and append to an XDG path
whose parent does not exist; the append throws `ENOENT` and `:187`'s catch swallows it, so every
`verify_run` event is silently lost while the gate still exits 0. Deriving the directory from the
file removes the possibility rather than testing for it — and A7 tests for it as well.

### 5. `packages/metrics/src/agent.ts` + `cli-ship.ts` — the drain

`agent.ts` gains two exported, pure functions so the behaviour is testable without spawning a script
that calls `process.exit()`:

```ts
export function shouldDrainLegacy(legacySpool: string): boolean {
  return existsSync(legacySpool) || pendingShippingFiles(legacySpool).length > 0;
}
export function combineResults(a: ShipResult, b: ShipResult): ShipResult
```

The `pendingShippingFiles` half is the case the first spec draft missed: after a failed ship the
live spool is **gone** and the events sit in a retained `.shipping` file, which is exactly the
situation a drain exists for, and `agent.ts:91-95` silently drops those files once 20 accumulate.

`cli-ship.ts` stays thin: resolve both paths, ship the primary, ship the legacy when
`getSpoolPath() !== getLegacySpoolPath() && shouldDrainLegacy(legacy)`, combine, report both, and
exit `1` when the **combined** `filesRetained > 0`. Exiting on the primary alone would report
success to systemd forever while a failing legacy drain accumulated toward the 20-file drop.

### 6. The three sandboxes

`test-helpers.ts`'s `env` allowlist gains `XDG_CACHE_HOME: join(home, '.cache')`; `env.test.ts`'s
`runGate` `childEnv` gains the same. `perf.test.ts`'s two sites and `extension.test.ts:73` follow.

Without this the change turns `verify` **red** on any machine with the variable set: the seed writes
under the sandbox `HOME` and the post-change binary reads the ambient XDG path, so `perf.ts`'s
sentinel throws. `test-helpers.test.ts`'s existing loop — every env value must start with `s.home`
— accepts `join(home, '.cache')` unchanged, which is the check working rather than being widened.

### 7. Documents

`SPEC.md` §9.6's paragraph (`:491`) states B1, that it applies on all platforms, and that no
migration occurs. `:1073`, `:1191`, `:1256`, `README.md:155` and `CONTRIBUTING.md:28` each gain
"(or `$XDG_CACHE_HOME/claudewatch`)". `deploy/README.md` gains B6's note with the literal
`ReadWritePaths=` syntax.

The first spec draft cited **§12** three times for a paragraph that lives in §9.6 — an implementer
following it would have edited the wrong section and left the false sentence in place.

## Test mapping

| Test | Asserts | Criterion |
|---|---|---|
| `cache.test.ts` — unset resolves to the legacy dir | `join(homedir(), '.cache', 'claudewatch')` | A2 |
| `cache.test.ts` — an absolute value is honoured | `<abs>/claudewatch` | A3 |
| `cache.test.ts` — an empty value is ignored | falls back | A4 |
| `cache.test.ts` — a relative value is ignored | falls back, and does **not** resolve against cwd | A4 |
| `cache.test.ts` — a trailing slash normalises | `join()` | A4 |
| `cache.test.ts` — `~/cache` is ignored, not expanded | falls back | A4 |
| `cache.test.ts` — `setCacheBaseDir` wins with the variable set | override | A5 |
| `cache.test.ts` — `setCacheBaseDir` wins with it unset | override | A5 |
| `cache.test.ts` — `setCacheBaseDir(null)` restores env sensitivity | the `afterEach` path | A5 |
| `cache.test.ts` — `win32.isAbsolute` classifies `C:foo` / `C:\foo` | the one platform-dependent thing, checked on Linux | A14 |
| `telemetry.test.ts` — all four derived paths move together | cache, spool, cursor, legacy spool | A3 |
| `spool-path.test.ts` — script and core agree across `home` × four XDG values | no subprocess | **A6** |
| `verify` — the directory created equals `dirname(spoolPath())` | the ENOENT that would be swallowed | **A7** |
| `agent.test.ts` — `shouldDrainLegacy` true when a live spool exists | | A8 |
| `agent.test.ts` — **true when only a retained `.shipping` file exists** | the case the draft missed | **A8** |
| `agent.test.ts` — false when neither exists | positive precondition for the above | A8 |
| `agent.test.ts` — `combineResults` sums retained and shipped | exit-code input | A9 |
| `test-helpers.test.ts` — the seed carries `XDG_CACHE_HOME` under `home` | | A13 |
| `smoke.test.ts` — `--debug` prints `cachePath` under the variable | | A15 |

## Risks

- **A7 is the hardest test to write honestly.** `record()` is private to a script that
  `process.exit()`s. The assertion must be against the *derivation* — that the mkdir target is
  `dirname(spoolPath())` — reachable through `scripts/spool-path.ts`, not by importing `verify.ts`.
  If it cannot be written that way it must be recorded UNMET rather than replaced by something that
  passes for a different reason. Loop 033 shipped a portability test that could not fail; this is the
  same trap one loop later.
- **`extension.test.ts:73` currently asserts `getCacheDir() !== join(homedir(), '.cache', …)`.** With
  the sandbox pinning `XDG_CACHE_HOME` under a temp home, that stays true — but for a *different
  reason* than before. The test must be re-read, not just re-run, or it becomes a vacuous pass.
- **`bun.lock` must not change.** Nothing here adds a dependency; a lockfile diff means something
  unintended ran.
- **The `unresolvedTokens` baseline moved the moment this plan was committed, and that is worth
  recording as a defect in loop 033's gate rather than a chore.** Adding `plan.md` made loop 034
  checkable, and its three heading tokens — `XDG_CACHE_HOME`, `verify`, `--debug` — are an
  environment variable, a script name and a flag. **None of them will ever resolve.** The count went
  22 → 25 and the baseline was updated in the same commit, exactly as the gate requires.
  
  But that is now the second consecutive loop where the number moved as a matter of course. Loop
  033's spec justified baselining it as "a ratcheted number so the silence cannot grow quietly" —
  and if every loop legitimately adds unresolvable tokens, updating it becomes routine, which is
  precisely the reflex loop 033's B3.1 guardrails were written to prevent for the lint budget. The
  signal decays toward zero. Recorded for loop 035: either the count should exclude token shapes
  that can never resolve (flags, `SCREAMING_CASE` env vars), or it should be a per-loop figure
  rather than a global one. **Not fixed here** — it is loop 033's design, not this loop's scope.
- **Nineteen paths is a wide fence for a four-line resolver.** The width is real and comes from the
  eight definitions, but it makes the plan-to-diff audit more valuable, not less: any file in the
  table that ends up unchanged is a plan item that did not happen.

## Out of scope, recorded

- `XDG_CONFIG_HOME`, and `config.ts:29`'s matching hardcode.
- `XDG_STATE_HOME` for the spool, which is arguably its correct home.
- Install-time substitution of the resolved path into the systemd unit — the only thing that makes a
  non-default `XDG_CACHE_HOME` work unattended on the NUC.
- The four `SPEC.md`/`README.md` sites are made approximate-but-true, not exhaustively rewritten.

---

**Next stage:** Build/Test — run `/sdlc-implement 034-xdg-cache-home`.
