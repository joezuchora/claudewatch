# Spec: honour `$XDG_CACHE_HOME`, or stop claiming to

- **ID:** 034-xdg-cache-home
- **Stage:** 2 — Design
- **Status:** accepted (revised after Stage 2 review)
- **Reads:** `sdlc/034-xdg-cache-home/intent.md`
- **Date:** 2026-08-28

## Summary

`getCacheDir()` resolves `$XDG_CACHE_HOME` instead of hardcoding `~/.cache`. That is four lines.
The rest of this document is about the **eight** places that decide where this tool's files live.

> **Revision note.** The first draft said four, and the Stage 2 reviewer found a fifth that turns a
> partial fix into silent data loss, plus three more. It also proved one acceptance criterion
> unsatisfiable, one behaviour section a no-op, and showed this change as drafted would have turned
> `bun run verify` **red** on exactly the machines the loop exists to serve. Every finding below
> marked *(measured)* was produced by running something. The corrections are marked inline.

Measured with `HOME` sandboxed to a `mktemp -d`, no writes to the real cache:

| `XDG_CACHE_HOME` | `getCacheDir()` today |
|---|---|
| unset | `homedir()/.cache/claudewatch` |
| `<tmpdir>` (absolute) | `homedir()/.cache/claudewatch` — **ignored** |
| `relative/path` | `homedir()/.cache/claudewatch` |
| `` (empty) | `homedir()/.cache/claudewatch` |

`SPEC.md:491` says it "follows `$XDG_CACHE_HOME` convention". It never reads the variable.

## The eight definitions

| # | Location | Why it is separate | In scope |
|---|---|---|---|
| 1 | `packages/core/src/cache.ts:37` | the real one; `telemetry.ts:120,124` derive the spool and cursor from it | **yes** |
| 2 | `scripts/verify.ts:110-112` — `spoolPath()` | **deliberate.** `verify.ts` must not import `packages/core`: a syntax error there would stop the gate starting at all, so no `verify_run` is recorded in exactly the case the record exists for | **yes** |
| 3 | `scripts/verify.ts:169` — `mkdirSync(join(homedir(), '.cache', 'claudewatch'))` | **the one the first draft missed** | **yes** |
| 4 | `packages/core/src/test-helpers.ts:226,246` + the `env` allowlist at `:272-278` | sandbox seeding | **yes** |
| 5 | `deploy/systemd/claudewatch-ship.service:22` | a systemd sandbox grant, not code | documented only, see B6 |
| 6 | `scripts/env.test.ts:163-169,181,185` | the gate sandbox's `childEnv` allowlist | **yes** |
| 7 | `scripts/perf.test.ts:134,210` | benchmark sandbox | **yes** |
| 8 | `packages/vscode/src/extension.test.ts:73` | extension test sandbox | **yes** |

### Why #3 is the finding that changes the design

`scripts/verify.ts:169` constructs the directory **independently of `spoolPath()`**, then line 186
appends to `spoolPath()`. Patch only the resolver, as the first draft's B5 said ("`spoolPath()`
gains the same resolution" — singular), and `record()` creates the **legacy** directory and appends
to the **XDG** path whose parent does not exist.

*(measured)* The append throws `ENOENT` — and `record()`'s outer `catch` at `:187`, whose comment
reads *"Recording a metric must never be the reason the gate fails"*, swallows it. The gate still
exits 0. **Every `verify_run` event is silently lost**, on the machine that runs the hourly loop.

That is strictly worse than the split the first draft warned about: not two series, but a dead one,
with no error and no gap marker. B5 now names both sites and derives the directory from the
resolved path rather than constructing it a second time.

### Why #5 is a hard failure, not a nicety

*(measured)* `deploy/systemd/claudewatch-ship.service:20-22` sets `ProtectSystem=strict` **and**
`ProtectHome=read-only`, with `ReadWritePaths=%h/.cache/claudewatch`. `ProtectSystem=strict` makes
the entire filesystem read-only except that whitelist, so an `XDG_CACHE_HOME` **anywhere** — inside
`$HOME` or not — is denied. The first draft attributed this to `ProtectHome` alone and understated it.

## Behavior

### B1 — the resolution rule

```
XDG_CACHE_HOME unset, empty, or relative  →  join(homedir(), '.cache', 'claudewatch')
XDG_CACHE_HOME absolute                   →  join(XDG_CACHE_HOME, 'claudewatch')
```

Both halves are the XDG Base Directory specification's own: *"If `$XDG_CACHE_HOME` is either not set
or empty, a default equal to `$HOME/.cache` should be used"*, and *"All paths … must be absolute. If
an implementation encounters a relative path … it should consider the path invalid and ignore it."*

The relative case earns its own rule: without the absoluteness check a relative value makes every
path in this tool relative to the **current working directory**, so the cache would follow the user
around their filesystem and the statusline would refetch on every `cd`.

**The implementation is `if (xdg !== undefined && isAbsolute(xdg))`, and the empty check is
deliberately *not* separate.** *(measured)* `isAbsolute('') === false`, so an explicit empty test is
an equivalent mutant — no test could kill it. The XDG text lists the two conditions separately; the
code collapses them because one subsumes the other, and A10 therefore predicts **five** rules, not
six. Stated here so two implementers do not build two different resolvers.

`setCacheBaseDir()` still wins over both branches, in both directions: it overrides with the
variable set and unset, and `setCacheBaseDir(null)` restores env-sensitive resolution in the same
process. That second half is what every `afterEach` depends on.

### B2 — the rule applies on every platform

`SPEC.md` scopes its claim to "On Linux". The rule above is **not** platform-conditional, for a
testing reason rather than a purity one: a branch that only executes on Windows can only be
exercised on Windows, and CI here runs Linux. Loop 011's review already found a Windows-only path
that would have run real credentials through a benchmark loop, precisely because nothing on Linux
could reach it.

A Windows user who has never set `XDG_CACHE_HOME` — nearly all of them — sees the unset branch,
which is `homedir()` exactly as today.

The intent asked for Windows behaviour **verified, not assumed**, and B2's own argument is that CI
cannot verify it. The honest resolution is to pin the one platform-dependent thing the resolver
leans on, which *is* checkable on Linux: `path.win32.isAbsolute` is importable everywhere, so A14
asserts `win32.isAbsolute('C:foo') === false` and `win32.isAbsolute('C:\\foo') === true`. Beyond
that classification, Windows behaviour is **asserted, not verified**, and recorded as such.

### B3 — no migration, and no existence-based fallback

When a user newly sets `XDG_CACHE_HOME`, the tool uses the new location and does **not** move, copy,
or fall back to the old one.

The rejected alternative — "use the legacy directory if it exists and the new one does not" — is
seductive and wrong: behaviour would depend on directory existence, so the same command means
different things on Tuesday and Thursday, and the day the new directory is created by something else
the tool silently changes where it reads. A rule predictable from the environment alone is worth a
one-time cost, and that cost is exactly one token-bearing refetch of `usage.json`, which is the cache
doing its job.

### B4 — the spool is the exception, because it cannot be regenerated

A lost `usage.json` costs a refetch. A lost `metrics-spool.jsonl` costs measurements of runs that
already happened and exist nowhere else. So `cli-ship.ts` drains a legacy spool.

**The trigger condition is not `existsSync` alone.** *(measured)* `ship()` rotates the live spool to
`<spool>.<stamp>.shipping` and deletes it only on HTTP 2xx, so after a failed ship the live
`metrics-spool.jsonl` is **gone** and the events sit in a retained `.shipping` file. The first
draft's condition would have skipped the drain in precisely the case it exists for — and
`agent.ts:91-95` silently `rmSync`s those files once 20 accumulate. The condition is:

```ts
existsSync(legacySpool) || pendingShippingFiles(legacySpool).length > 0
```

`pendingShippingFiles` is already exported (`agent.ts:49`).

**The legacy path comes from core, not from a ninth hand-built string.** `cache.ts` exports
`getLegacyCacheDir()` — literally today's `getCacheDir()` body — and `telemetry.ts` exports
`getLegacySpoolPath()`. Constructing `join(homedir(), '.cache', …)` inside `cli-ship.ts` would make
this loop add a definition while removing one.

**Result composition is specified**, because `cli-ship` exits on it: the process exits `1` when
`primary.filesRetained + legacy.filesRetained > 0`, and the summary line reports both. *(measured)*
`ship()` holds no module-level state and no lock file — it keys entirely off `opts.spoolPath` — so
calling it twice in one process is safe. Under the unstated alternative (exit on the primary result
only) a permanently failing legacy drain would report success to systemd forever.

**The drain is permanent, not one-time.** *(measured)* `rotate()` returns `null` for a zero-byte
file, so an empty legacy spool is never removed and the extra check runs on every invocation. Two
syscalls; stated rather than left to look like a one-time migration.

`ship()`'s guarantee is **at-least-once** (`agent.ts:8`), not idempotent — a POST that succeeds
server-side but whose response is lost is retained and re-sent. The receiving side already handles
that; the word matters so nobody assumes otherwise.

### B5 — one resolver for the script side, in a module a test can import

`scripts/verify.ts` still must not import `packages/core`. But its copy must not drift, and the
first draft's A6 was unsatisfiable: *(measured)* `verify.ts` exports **nothing**, runs steps at top
level, and ends in `process.exit()` — importing it from a test runs the whole gate and kills the
test process.

The pattern this repo actually uses for exactly this is `scripts/env.ts`, documented at
`packages/core/src/config.ts:37-42`: *"That script deliberately keeps its own copy of the table …
Exporting this is what lets `scripts/env.test.ts` prove the two agree, instead of comparing a
hand-copied table against itself and going green by construction."*

So: a new side-effect-free `scripts/spool-path.ts` exporting

```ts
export function resolveCacheDir(home: string, env: NodeJS.ProcessEnv): string
export function resolveSpoolPath(home: string, env: NodeJS.ProcessEnv): string
```

`verify.ts` imports it and uses it for **both** `spoolPath()` **and** the `mkdirSync` at `:169`,
which becomes `mkdirSync(dirname(spoolPath()), …)` so the two cannot disagree by construction.

Taking `home` and `env` as **parameters** is what makes A6 a plain unit test: *(measured)*
`homedir()` is resolved once at process start and does not re-read a mutated `process.env.HOME`
(documented already at `extension.test.ts:12-16`), while `process.env.XDG_CACHE_HOME` *is* read
live. Without parameterisation the `HOME` axis needs a subprocess per cell, at the `180_000` ms
timeouts `scripts/env.test.ts` already pays. Core's `getCacheDir()` keeps its zero-argument
signature and calls the same shape internally.

### B6 — the systemd unit is documented, not silently half-fixed

The first draft said the unit "gains a `ReadWritePaths` entry for the XDG location". *(measured, on
systemd 255)* `ReadWritePaths=` performs **no environment expansion** — a `${XDG_CACHE_HOME}` entry
is parsed as non-absolute and dropped with `ReadWritePaths= path is not absolute, ignoring`. There is
no `%` specifier for it. So the drafted change could only have added an ignored line or a duplicate
of line 22.

**Decision: no unit change.** `deploy/README.md` gains a short section stating that the unit grants
`%h/.cache/claudewatch` only, and that a non-default `XDG_CACHE_HOME` requires adding a literal
`ReadWritePaths=/your/path/claudewatch` line — with the exact syntax. Having `install-nuc.sh`
substitute the resolved path at install time (as it already substitutes at `:63-65`) is the only
option that works unattended; it is a real scope increase to the deployment path and is recorded as
**out of scope**, to be decided rather than discovered.

The default deployment is unaffected: it does not set the variable, so line 22 remains correct.

### B7 — the sandboxes must pin `XDG_CACHE_HOME`, or this change turns `verify` red

*(measured)* `test-helpers.ts:272-278` builds `SandboxSeed.env` as an **allowlist** — `HOME`,
`USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `CLAUDEWATCH_TELEMETRY` — and every spawn site merges it as
`{ ...process.env, ...seed.env }` (`perf.ts:133`, `smoke.test.ts:83,194,234,295`). With
`XDG_CACHE_HOME=/data/cache` ambient, the seed writes the fixture under the sandbox `HOME` and the
post-change binary reads `/data/cache/claudewatch/` — a guaranteed miss, `perf.ts:157-163`'s
sentinel throws, and the `perf` step fails.

That contradicts **A1** on exactly the population this loop serves. It is a loud failure rather than
a token leak, by construction: the sandbox seeds a deliberately-expired credential, so a miss exits 2
before `fetchUsage`.

So `XDG_CACHE_HOME` joins the allowlist, pinned to `join(home, '.cache')`, in `SandboxSeed.env` and
in `scripts/env.test.ts`'s `runGate` `childEnv`. **After this change, sandboxing `HOME` no longer
implies sandboxing the cache** — which is the whole reason A13 is restated below.

### B8 — the documents that stay false otherwise

`SPEC.md:491` sits under **§9.6 File-Backed Cache**, not §12 — the first draft cited §12 three times
and would have sent an implementer to edit the wrong section while leaving the false sentence in
place. §9.6's paragraph is rewritten to state B1, that it applies on all platforms, and that no
migration occurs.

Four other sites describe the location and become approximate: `SPEC.md:1073`, `SPEC.md:1191`,
`SPEC.md:1256`, `README.md:155`, `CONTRIBUTING.md:28`. Each gains "(or `$XDG_CACHE_HOME/claudewatch`)"
— a two-word edit — rather than being left for the next reviewer to re-file.

### B9 — `--debug` already reports the resolved path

The intent left open whether the resolved directory may appear in `--debug`. It already does:
`main.ts:127` emits `cachePath: getCachePath()`. This change alters that value, not its presence, so
no new field and no new §12 question — the surface is unchanged and was permitted before this loop.
A15 asserts the value moves with the variable.

## Data and types

`getCacheDir()` keeps its zero-argument signature. New exports: `getLegacyCacheDir()`,
`getLegacySpoolPath()`, and `scripts/spool-path.ts`'s two resolvers. No change to what is written,
its permissions (`0700` dir, `0600` spool), or atomicity — this changes **where**, and nothing else.

## Edge cases

- **`~` is not expanded.** A leading-`~` value is relative under `isAbsolute()` and therefore
  ignored, per XDG, which says nothing about tilde expansion. *(measured)* `isAbsolute('~/cache')`
  is `false`. An implementer who adds a helpful expansion would pass every other criterion, so A4
  names this case.
- **`..` segments are normalised by `join()`** — *(measured)* `/a/../../etc` is absolute and
  resolves to `/etc/claudewatch`. The user's own variable under the user's own privileges, so no
  containment check is added; recorded so it is a chosen behaviour rather than an accident.
- **Trailing slash** → normalised by `join()`. Named in A4.
- **A path that does not exist** → created on first write, `0700`, exactly as today.
- **A path that is a file, or unwritable** → the write fails through the existing cache-write error
  path. No new pre-flight check.
- **`XDG_CACHE_HOME` equal to the legacy location** → resolved and legacy paths are identical, so
  B4's drain is skipped by the `differ` condition. This is the case a naive implementation
  double-ships.
- **`HOME` unset** → `homedir()` falls back to the passwd entry; unchanged, out of scope.

## Backward compatibility

- **A user who has not set `XDG_CACHE_HOME` sees no change at all** — same directory, same files,
  same permissions. *(measured)* the unset branch is character-identical to today's body.
- The compatibility breakage in this loop is entirely in the **test harness** (B7), not in shipped
  behaviour.
- `setCacheBaseDir()` is unchanged, so every existing test's isolation is unchanged.
- The systemd unit is unchanged; the default deployment is unaffected.

## Acceptance criteria

- [ ] **A1** — `bun run verify` exits 0, and CI is green. Also exits 0 with `XDG_CACHE_HOME` set to
      an absolute path in the ambient environment — the case B7 exists for.
- [ ] **A2** — With the variable unset, `getCacheDir()` returns `join(homedir(), '.cache', 'claudewatch')`.
- [ ] **A3** — With it absolute, `getCacheDir()`, `getCachePath()`, `getSpoolPath()`,
      `getSpoolStatePath()`, `getLegacyCacheDir()` and `getLegacySpoolPath()` all return the right
      thing. All six, because four are derived and a fix to one is not a fix to the others.
- [ ] **A4** — empty, relative, trailing-slash and `~/cache` each resolve per B1. Four named tests.
- [ ] **A5** — `setCacheBaseDir(d)` wins with the variable set **and** unset; `setCacheBaseDir(null)`
      restores env-sensitive resolution in the same process.
- [ ] **A6** — `scripts/spool-path.ts`'s `resolveSpoolPath(home, env)` and core's `getSpoolPath()`
      return the same string across `home` × `{unset, absolute, relative, empty}`, as a plain unit
      test with no subprocess. Fails if either side is reverted.
- [ ] **A7** — `verify.ts` creates `dirname(spoolPath())`, not an independently constructed
      directory. Asserted by a test that would have caught B-1: with the variable absolute, the
      directory `record()` creates equals the parent of the file it appends to.
- [ ] **A8** — `cli-ship` drains a legacy spool, **including** a legacy directory holding only a
      retained `.shipping` file and no live spool. Two cases; the second is the one the first draft
      missed.
- [ ] **A9** — `cli-ship` does not double-ship when the variable resolves to the legacy location,
      and exits `1` when `primary.filesRetained + legacy.filesRetained > 0`.
- [ ] **A10** — mutation predictions name a specific `file:testname` **before** the run, one per
      rule — **five**, not six: the absoluteness check, the `claudewatch` suffix, the
      `setCacheBaseDir` precedence, the `verify.ts` mirror, and the drain's trigger condition. The
      empty check is an equivalent mutant by B1 and is deliberately not predicted.
- [ ] **A11** — `.oxlint-budget.json` unchanged at nine rows / eleven warnings, enforced by
      `lintBudget`.
- [ ] **A12** — the plan-to-diff audit reports no file outside the fence, and `fenceCheck` reports
      zero findings for this loop.
- [ ] **A13** — every sandbox pins `XDG_CACHE_HOME` as well as `HOME`/`USERPROFILE`, and a test
      asserts `SandboxSeed.env` contains it, mirroring `test-helpers.test.ts:157-165`. The old
      wording — "every case sandboxes `HOME`" — is no longer sufficient, because after this change
      sandboxing `HOME` does not sandbox the cache.
- [ ] **A14** — `path.win32.isAbsolute('C:foo') === false` and `win32.isAbsolute('C:\\foo') === true`,
      asserted directly. Beyond this, Windows behaviour is recorded as asserted, not verified.
- [ ] **A15** — `--debug` with the variable absolute prints `cachePath` under it.
- [ ] **A16** — no test writes into the real `~/.cache/claudewatch`.

## Rejected alternatives

**Delete the `SPEC.md` sentence instead.** The cheapest way to make the document true. Rejected: the
claim describes where the tool writes, and "wherever `homedir()` points, ignoring your configuration"
is a worse answer for a tool a user may run in a container with a read-only `$HOME`. The variable
exists precisely so that case works.

**Honour it on Linux only.** Matches the current sentence; adds a branch CI cannot execute. See B2.

**Migrate the directory on first write.** A move that can fail halfway, race two processes, or
partially copy — for a cache whose purpose is to be safely discardable. The spool is the only file
worth carrying, and B4 carries it by shipping rather than moving.

**Make `verify.ts` import `getCacheDir` from core.** Breaks the reason `verify.ts` is standalone: a
syntax error in core would stop the gate starting, and the failure would arrive as a raw stack trace
with no `verify_run` event — losing the record exactly when it matters. The duplication is
deliberate; A6 is the price of keeping it honest.

**Substitute the XDG path into the systemd unit at install time.** The only option that works
unattended (see B6), and a real change to the deployment path. Out of scope, recorded.

**Resolve `XDG_STATE_HOME` for the spool.** Arguably more correct under the XDG taxonomy — a spool of
unshipped events is state, not cache. A second relocation, a second migration question, and a second
`deploy/` grant. Out of scope by the intent, worth its own loop.

## Recorded, not fixed

- **The config side is already split the same way, in the opposite direction.**
  `deploy/install-nuc.sh:14-15` honours `${XDG_CONFIG_HOME:-$HOME/.config}` while
  `packages/core/src/config.ts:29` hardcodes `join(homedir(), '.config', 'claudewatch')`. Same defect
  class, already shipped. The intent scopes `XDG_CONFIG_HOME` out and that stands — but the framing
  "eight places decide where this tool's files live" is only honest if it says the config side is
  split too and is being left deliberately.

---

**Next stage:** Build — run `/sdlc-plan 034-xdg-cache-home` to turn this into `plan.md`.
