# Spec: honour `$XDG_CACHE_HOME`, or stop claiming to

- **ID:** 034-xdg-cache-home
- **Stage:** 2 — Design
- **Status:** draft
- **Reads:** `sdlc/034-xdg-cache-home/intent.md`
- **Date:** 2026-08-28

## Summary

`getCacheDir()` resolves `$XDG_CACHE_HOME` instead of hardcoding `~/.cache`. That is four lines.
The rest of this document is about the fact that **four independent places decide where this tool's
files live**, and honouring the variable in only one of them breaks the system in two.

Measured, not read (`HOME` sandboxed to a `mktemp -d`, no writes to the real cache):

| `XDG_CACHE_HOME` | `getCacheDir()` today |
|---|---|
| unset | `$HOME/.cache/claudewatch` |
| `/tmp/tmp.govv6r114t` (absolute) | `$HOME/.cache/claudewatch` — **ignored** |
| `relative/path` | `$HOME/.cache/claudewatch` |
| `` (empty) | `$HOME/.cache/claudewatch` |

`SPEC.md:491` says it "follows `$XDG_CACHE_HOME` convention". It never reads the variable.

## The four definitions

| # | Location | Form | Why it is separate |
|---|---|---|---|
| 1 | `packages/core/src/cache.ts:37` | `join(homedir(), '.cache', 'claudewatch')` | the real one; `telemetry.ts:120,124` derive the spool and cursor from it |
| 2 | `scripts/verify.ts:110-112` | `join(homedir(), '.cache', 'claudewatch', 'metrics-spool.jsonl')` | **deliberate.** `verify.ts` must not import `packages/core`: a syntax error in core would stop the gate from starting at all, so no `verify_run` event is recorded in exactly the situation the record exists for. Same reasoning as `MAX_LINE_BYTES` (`scripts/junit.ts:16-27`). |
| 3 | `packages/core/src/test-helpers.ts:226,246` | `join(home, '.cache', 'claudewatch')` | test seeding, takes `home` as a parameter |
| 4 | `deploy/systemd/claudewatch-ship.service:22` | `ReadWritePaths=%h/.cache/claudewatch` | a systemd sandbox grant, not code |

**Changing only #1 splits the metrics series silently.** Product telemetry and the shipper would use
`$XDG_CACHE_HOME/claudewatch`; the `verify` gate would keep appending to `~/.cache/claudewatch`. The
shipper reads the new path, finds none of the gate's events, and the hourly run count goes flat with
no error and no gap marker — the precise failure mode the runbook already warns about for a missed
`CLAUDEWATCH_VERIFY_METRICS` export, arriving from a different direction.

**And #4 turns it into a hard failure on the deployment target.** `ReadWritePaths` is a whitelist:
if the code writes to `$XDG_CACHE_HOME` and the unit only grants `%h/.cache/claudewatch`, the
shipper gets `EPERM` on the NUC. Not a nicety — the unit stops working.

## Behavior

### B1 — the resolution rule

```
XDG_CACHE_HOME unset, empty, or relative  →  <home>/.cache/claudewatch
XDG_CACHE_HOME absolute                   →  <XDG_CACHE_HOME>/claudewatch
```

This is the XDG Base Directory specification's own rule, both halves of it: *"If `$XDG_CACHE_HOME`
is either not set or empty, a default equal to `$HOME/.cache` should be used"*, and *"All paths set
in these environment variables must be absolute. If an implementation encounters a relative path in
any of these variables it should consider the path invalid and ignore it."*

The relative case matters more than it looks: without the absoluteness check, a relative value makes
every path in this tool relative to the **current working directory**, so the cache would follow the
user around their filesystem and the statusline would refetch on every `cd`.

`setCacheBaseDir()` still wins over both. It is how every test isolates itself and it is unchanged.

### B2 — the rule applies on every platform

`SPEC.md` currently scopes its claim to "On Linux". The rule above is **not** platform-conditional,
and the reasoning is a testing one rather than a purity one: a branch that only executes on Windows
can only be exercised on Windows, and CI here runs Linux. This repo has already paid for that —
loop 011's review found a Windows-only path that would have run real credentials through a benchmark
loop, precisely because nothing on Linux could reach it.

One rule, one code path, one test matrix, on the platform CI actually runs. A Windows user who has
never set `XDG_CACHE_HOME` — which is nearly all of them — sees byte-identical behaviour, because
the unset branch is `homedir()` exactly as today.

`SPEC.md` is corrected to describe this, rather than the code being contorted to match a sentence
nobody implemented.

### B3 — no migration, and no existence-based fallback

When a user newly sets `XDG_CACHE_HOME`, the tool uses the new location and **does not** move,
copy, or fall back to the old one.

The rejected alternative is "use the legacy directory if it exists and the new one does not", which
is seductive and wrong: behaviour would depend on directory existence, so the same command means
different things on Tuesday and Thursday, and the day the new directory gets created by something
else the tool silently changes where it reads. A rule that is predictable from the environment alone
is worth a one-time cost.

That one-time cost is exactly one token-bearing refetch of `usage.json`, which is the cache doing
its job. §9's staleness handling already covers "no cache present".

### B4 — the spool is the exception, because it is the one file that cannot be regenerated

A lost `usage.json` costs a refetch. A lost `metrics-spool.jsonl` costs **events that no longer
exist anywhere** — unshipped measurements of runs that already happened.

So `cli-ship.ts` drains a legacy spool when there is one:

- Resolve `getSpoolPath()`. Also compute the legacy path, `<home>/.cache/claudewatch/metrics-spool.jsonl`.
- If they differ **and** the legacy file exists, call `ship()` a second time against it.
- Report both in the summary line, so a drain is visible rather than silent.

`ship()` is unchanged — it already takes a `spoolPath` and already handles rotation
(`filesShipped`). This is two call sites, not a new capability, and it is idempotent: `ship()`
retains on failure and drops on success, so a drained legacy spool is not re-sent.

Draining is **not** conditional on the legacy file being non-empty; an empty one is cheap and the
check is one `existsSync`.

### B5 — `verify.ts` mirrors the rule, and a test asserts the two agree

`scripts/verify.ts`'s `spoolPath()` gains the same resolution. It stays a **copy**, because the
reason it does not import core is still true and is not this loop's to relitigate.

A copy that can drift is only acceptable with a test that fails when it does. `MAX_LINE_BYTES`
already establishes the pattern (`junit.test.ts` asserts it equals core's value), so this follows it:
a test computes both under a matrix of `HOME` × `XDG_CACHE_HOME` values and asserts they are equal.
Without that test this change **creates** a second silent split rather than fixing the first.

### B6 — the systemd unit grants both paths

`deploy/systemd/claudewatch-ship.service` gains a `ReadWritePaths` entry for the XDG location
alongside `%h/.cache/claudewatch`. systemd tolerates a `ReadWritePaths` entry that does not exist
when prefixed with `-`, which is what makes granting both safe on a machine that sets neither.

The unit cannot expand `$XDG_CACHE_HOME` itself; the entry is written against the documented
default location so the common configurations work, and the deployment README states plainly that a
non-default `XDG_CACHE_HOME` requires editing the unit. **Stated, not silently half-solved.**

### B7 — `SPEC.md` becomes true

§12's cache-location paragraph is rewritten to state the resolution rule, that it applies on all
platforms, and that no migration occurs. The sentence being replaced is the one that has been false
since loop 003 recorded it.

## Data and types

No new types. `getCacheDir()` keeps its signature. No change to what is written, its permissions
(`0700` dir, `0600` spool), or atomicity — this changes **where**, and nothing else.

## Edge cases

- **`XDG_CACHE_HOME` set to a path that does not exist** → created on first write, `0700`, exactly
  as `~/.cache/claudewatch` is today. Not special.
- **`XDG_CACHE_HOME` set to a file, or an unwritable directory** → the write fails and surfaces
  through the existing cache-write error path. This change adds no new pre-flight check; inventing
  one here would be a second behaviour to test for no benefit.
- **`XDG_CACHE_HOME` with a trailing slash** → `join()` normalises it. Covered by a test rather than
  by assertion.
- **`XDG_CACHE_HOME` equal to the legacy location** → resolved and legacy paths are identical, so
  B4's drain is skipped by the `differ` condition. This is the case a naive implementation
  double-ships.
- **`HOME` unset** → `homedir()` falls back to the OS passwd entry; unchanged behaviour, and out of
  scope.
- **A relative `XDG_CACHE_HOME` on Windows** (`C:foo` is relative-to-drive) → `isAbsolute()` from
  `node:path` decides, per platform, rather than a hand-rolled leading-slash test.

## Backward compatibility

- **A user who has not set `XDG_CACHE_HOME` sees no change at all.** Same directory, same files,
  same permissions. This is the overwhelming majority and it must be byte-identical, not merely
  equivalent.
- A user who **has** set it gets their files in the location their system is configured for, one
  refetch of `usage.json`, and no loss of unshipped metrics.
- `setCacheBaseDir()` is unchanged, so every existing test's isolation is unchanged.
- The systemd unit gains a grant and loses nothing.

## Acceptance criteria

- [ ] **A1** — `bun run verify` exits 0, and CI is green.
- [ ] **A2** — With `XDG_CACHE_HOME` unset, `getCacheDir()` returns `<home>/.cache/claudewatch`.
      Asserted against a sandboxed `HOME`, not the developer's.
- [ ] **A3** — With `XDG_CACHE_HOME` absolute, `getCacheDir()` returns `<that>/claudewatch`, and
      `getCachePath()`, `getSpoolPath()` and `getSpoolStatePath()` all sit under it. All four, because
      three of them are derived and a fix to one is not a fix to the others.
- [ ] **A4** — Empty, relative, and trailing-slash values each resolve as B1 states. Three cases,
      three named tests, not one loop over a table.
- [ ] **A5** — `setCacheBaseDir()` still overrides both branches.
- [ ] **A6** — **`scripts/verify.ts`'s `spoolPath()` and core's `getSpoolPath()` return the same
      string** across a matrix of `HOME` × `XDG_CACHE_HOME` (unset / absolute / relative / empty).
      This is the criterion that stops the change creating a new split, and it must fail if either
      side is reverted.
- [ ] **A7** — `cli-ship` drains a legacy spool: given events in `<home>/.cache/claudewatch/` and an
      `XDG_CACHE_HOME` pointing elsewhere, both are shipped and the summary names both.
- [ ] **A8** — `cli-ship` does **not** double-ship when `XDG_CACHE_HOME` resolves to the legacy
      location. The positive precondition is A7's drain firing in the other case.
- [ ] **A9** — `SPEC.md`'s cache-location paragraph and the code agree, checked by quoting the new
      paragraph in `review.md` beside the resolver.
- [ ] **A10** — mutation predictions name a specific `file:testname` **before** the run, one per
      **rule**: the absoluteness check, the empty check, the `claudewatch` suffix, the
      `setCacheBaseDir` precedence, the `verify.ts` mirror, and the drain's `differ` condition.
- [ ] **A11** — `.oxlint-budget.json` unchanged at nine rows / eleven warnings, enforced by
      `lintBudget` rather than asserted.
- [ ] **A12** — the plan-to-diff audit reports no file outside the fence, and `fenceCheck` reports
      zero findings for this loop.
- [ ] **A13** — no test writes into the real `~/.cache/claudewatch`. Every case sandboxes `HOME`.

## Rejected alternatives

**Delete the `SPEC.md` sentence instead.** The cheapest way to make the document true, and defensible
— the intent's title offers it. Rejected because the claim describes the trust boundary: §12 tells a
reader where this tool writes, and "wherever `homedir()` points, ignoring your configuration" is a
worse answer for a tool that a user may run in a container with a read-only `$HOME`. The variable
exists precisely so that case works.

**Honour it on Linux only.** Matches the current sentence, and adds a branch that CI cannot execute.
See B2.

**Migrate the directory on first write.** A move that can fail halfway, race two processes, or
partially copy — for a cache whose entire purpose is to be safely discardable. The spool is the only
file worth carrying, and B4 carries it by shipping rather than by moving.

**Make `verify.ts` import `getCacheDir` from core.** Removes the duplication outright, and breaks
the reason `verify.ts` is standalone: a syntax error in core would stop the gate from starting, so
the failure would arrive as a raw stack trace with no `verify_run` event — losing the record exactly
when it matters. The duplication is deliberate; A6 is the price of keeping it honest.

**Resolve `XDG_STATE_HOME` for the spool.** Arguably more correct under the XDG taxonomy — a spool
of unshipped events is state, not cache. It is also a second relocation, a second migration
question, and a change to what `deploy/` grants. Out of scope by the intent, and worth its own loop.

---

**Next stage:** Build — run `/sdlc-plan 034-xdg-cache-home` to turn this into `plan.md`.
