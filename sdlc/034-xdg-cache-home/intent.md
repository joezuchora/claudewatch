# Intent: honour `$XDG_CACHE_HOME`, or stop claiming to

- **ID:** 034-xdg-cache-home
- **Stage:** 1 — Plan
- **Status:** accepted
- **Author:** carried from `sdlc/003-metrics-telemetry/review.md:128` and
  `sdlc/005-statusline-tty-stdin/review.md:110`, both of which recorded it and neither of which
  fixed it.
- **Date:** 2026-08-28

## Problem

`SPEC.md:491` says, of the cache location:

> On Linux this follows `$XDG_CACHE_HOME` convention (defaults to `~/.cache`).

It does not. `packages/core/src/cache.ts:35-38` is:

```ts
export function getCacheDir(): string {
  if (cacheBaseDir !== null) return cacheBaseDir;
  return join(homedir(), '.cache', 'claudewatch');
}
```

`homedir()` and a literal `.cache`. The environment variable is never read. A Linux user with
`XDG_CACHE_HOME=/data/cache` gets `~/.cache/claudewatch` regardless, and the document tells them
otherwise.

**This is not one file.** `getCacheDir()` is the root for three:

| Path | Consumer |
|---|---|
| `<dir>/usage.json` | the cache envelope every render reads |
| `<dir>/metrics-spool.jsonl` | `telemetry.ts:120` — the product-telemetry spool, and the same file `verify` appends its own gate metrics to |
| `<dir>/metrics-spool.state.json` | `telemetry.ts:124` — the ship cursor |

So the question is not "where does the cache live". It is "where does everything this tool
persists live", and one of those things is a spool with unshipped events in it.

## Who is affected

Linux users who set `XDG_CACHE_HOME`, which is the population that sets it deliberately: people
mounting a cache on tmpfs, excluding caches from backups, or running in a container image that
points caches at a writable volume. For them the tool writes outside the location their system is
configured for, silently. On a container with a read-only `$HOME` and a writable
`$XDG_CACHE_HOME`, the tool cannot write at all — and the failure is a permission error from a
path the user never chose.

The count today is plausibly zero, and saying so is more useful than inventing urgency. The reason
to fix it anyway is the second cost: **`SPEC.md` states something false about the trust boundary.**
§12 governs what this tool writes and where; a reader auditing that section is being told the wrong
answer. This repo has now recorded the divergence twice, in two different loops' review documents,
and shipped it both times.

## Why now

Thirty loops of "recorded, not fixed" is the signal. It was raised in loop 003, raised again in
loop 005, and has sat behind larger work ever since — which is the correct prioritisation right up
until it becomes the thing that proves recorded items never get done.

It is also the right size for the harness as it now stands. Loop 033 put two gates into `verify`,
and this is the first product change they will police: a small, bounded, testable change whose
spec-to-plan and lint-budget compliance are now checked rather than asserted.

## What "done" means

- [ ] With `XDG_CACHE_HOME` set to an absolute path, every file this tool persists is written under
      that path, and a `--debug` run reports the path actually used.
- [ ] With `XDG_CACHE_HOME` unset, behaviour is byte-for-byte what it is today — `~/.cache/claudewatch`.
      No existing user's files move because they upgraded.
- [ ] With `XDG_CACHE_HOME` set to something the XDG spec says to ignore (empty, or a relative
      path), the tool falls back to `~/.cache` rather than writing to a relative path.
- [ ] A user who already has a spool with unshipped events does not lose them. Whatever the answer
      is — migrate, read both, or refuse — it is a stated decision with a test, not an accident.
- [ ] `SPEC.md`'s claim and the code agree, and it is possible to tell which one changed to make
      that true.
- [ ] On Windows, the documented behaviour is whatever the code does, verified rather than assumed.

## Explicitly out of scope

- **`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`.** This tool persists caches and a spool.
  Deciding whether the spool is really "cache" versus "state" under the XDG taxonomy is a genuine
  question and a separate one; the spool lives beside the cache today and this change does not
  relocate it relative to the cache.
- **Changing what is written, or its permissions.** `0700` directory, `0600` spool, atomic writes.
  This changes *where*, and nothing else.
- **`~/.claude/.credentials.json`.** Read-only, owned by Claude Code, not ours to relocate.
- **The `setCacheBaseDir` test override.** It stays; it is how every test isolates itself, and
  removing it would be a much larger change to a lot of test files.
- **Fixing `SPEC.md`'s other claims.** Only §12's cache-location paragraph is in scope.

## Open questions

- **What happens to an existing directory when `XDG_CACHE_HOME` is newly set.** Three defensible
  answers — migrate on first write, read the old location as a fallback and write to the new one, or
  ignore the old one entirely — and they differ in whether a user silently loses unshipped metrics
  events. Design must pick one and say why, and the answer must account for the spool separately
  from the cache: a lost `usage.json` costs one token-bearing refetch, a lost spool costs data that
  cannot be regenerated.
- **Whether `XDG_CACHE_HOME` should apply on Windows.** The XDG basedir spec is a freedesktop
  convention; `SPEC.md` scopes its claim to "On Linux". Honouring the variable everywhere is
  simpler and arguably more useful in WSL and CI; honouring it only on Linux matches the document.
  Design decides, and states which, because "it does whatever `homedir()` did" is how the current
  divergence happened.
- **Whether the resolved directory may appear in `--debug` output.** `main.ts:127` already puts
  `cachePath` there, so an absolute path is evidently already permitted — but that predates §12's
  current wording, and the first done-criterion above asks for the path to be reported. Design must
  confirm against §12 rather than infer permission from the existing call site.

---

**Next stage:** Design — run `/sdlc-spec 034-xdg-cache-home` to turn this into `spec.md`.
