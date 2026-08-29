# Plan: extract the env-file writer, create it protected, refuse symlinks

- **ID:** 038-env-file-secret-window
- **Stage:** 3 — Build
- **Status:** draft
- **Derived from:** [`spec.md`](./spec.md)
- **Branch:** `claude/ai-sdlc-setup-plan-nqyqbk` (this repo's single working branch, not a per-loop branch)

## Approach

Lift lines 40–57 of `deploy/install-nuc.sh` into `deploy/lib/env-file.sh` as one sourceable
function, and have the installer source and call it. The extraction is not tidying — it is the
only way to test the section on a host with no systemd, which is what makes the security claim
checkable at all. Inside the function: refuse a symlinked path before branching, `mkdir` at the
ambient umask then `chmod 700` the leaf only, write the file inside a `( umask 077; … )`
subshell, and tighten an existing file instead of reporting `kept existing` over it.

**One design tension, decided rather than glossed.** The create branch keeps its trailing
`chmod 600` even though `umask 077` already guarantees the mode. That redundancy has a real
cost: it makes the obvious test — assert the final mode is `0600` — pass against the broken
code, which is exactly this repo's recurring defect. The alternative, dropping the `chmod` so
that a plain final-mode assertion becomes discriminating, was considered and rejected: it would
make the test blind to a `touch`-then-`chmod` rewrite, which has a window and ends at `0600`
just the same. The security claim is *"never observable at another mode"*, and only observing
the creation itself tests that claim. So the redundancy stays and the test interposes a stub
`chmod` on `PATH` that records the mode before delegating. The price is a coupling the tests
depend on — the library must call bare `chmod`, not `/bin/chmod` — recorded under Risks.

## Scope fence

```
deploy/lib/env-file.sh
deploy/install-nuc.sh
deploy/env-file.test.ts
deploy/README.md
SPEC.md
.oxlint-budget.json
sdlc/038-env-file-secret-window/intent.md
sdlc/038-env-file-secret-window/spec.md
sdlc/038-env-file-secret-window/plan.md
sdlc/038-env-file-secret-window/review.md
```

**Fence amended after the Stage 2 review, before any implementation.** `deploy/README.md` and
`SPEC.md` were on the "explicitly not touched" list of the first draft and are now in scope.
The reason is spelled out in `spec.md`: §12 has no clause covering the installer's env file, so
without an amendment this loop's invariant would exist only inside `sdlc/038-*/` where nothing
could violate it; and the README's line 64 already asserted `mode 0600` without saying which
`0600` it meant. Loop 035's lesson was that stepping outside a fence and rationalising it
afterwards is the violation — amending the fence first, in writing, with the reason, is the
procedure that lesson asks for.

`.oxlint-budget.json` is on the fence because a new TypeScript test file may change the
`oxlint` warning set, and loops 033 and 035 both stalled on discovering that after the fact.
If the set turns out unchanged, the entry goes unused and `review.md` says so — an unused
fence entry is a smaller sin than a diff that steps outside one.

**Explicitly not touched:** `packages/**` (nothing in the product changes), `deploy/README.md`
(its `mode 0600` claim at line 64 becomes true rather than needing an edit — see `spec.md`
*Backward compatibility*), `deploy/systemd/**`, `scripts/**`, `SPEC.md`, `CLAUDE.md`, and the
Windows/macOS install paths.

## Changes

### Design changed after review: `mktemp` + `mv`, not a `umask 077` subshell

The first draft's whole mechanism was `( umask 077; { … } > "$env_file" )`. It closes the
window and nothing else. Review found that a plain redirect truncates at open time, so a
failure partway leaves a header-only file — which the new repair branch would then bless as
`kept existing` on every future run, with no token in it. `mktemp` creates at `0600` under an
ambient `umask 000` (measured) and `mv` preserves it, so the mode is still a property of
creation, and the rename makes the destination either absent or complete. It is also the atomic
write `CLAUDE.md` and `SECURITY.md` already require of every other private file here; the first
draft departed from that convention for the one file holding a bearer token without noticing.

### `deploy/lib/env-file.sh` (new)

- A sourceable library with no top-level side effects, defining `claudewatch_write_env_file`
  and a private `_cw_say` printing in the installer's existing `  %s\n` format. Sourcing it
  must print nothing and create nothing — A11.
- Argument validation: `local env_file="${1:-}"`, empty is a non-zero return with a message on
  stderr, so the function is safe under `set -u` and does not fall back to a default path — A10.
- `local lan="${2:-0}"`, and only the exact string `1` enables LAN. Anything else is
  loopback — A9.
- `[ -L "$env_file" ]` refused **before** the existence branch, so it covers both a link to a
  real file and a dangling one — A15, A16.
- `[ -e "$env_file" ] && [ ! -f "$env_file" ]` refused too, so a directory at the path gets a
  clear error rather than a confusing redirect failure.
- `mkdir -p "$dir"` at the ambient umask, then `chmod 700 "$dir"` — A3 and A4 together. The
  umask is deliberately not raised around the `mkdir`; `spec.md` records the measurement
  showing that would set `~/.config` itself to `0700`.
- Token generation as `local TOKEN; TOKEN="$(…)" || return 1` — declared and assigned on
  separate lines, because `local TOKEN="$(…)"` takes its status from `local` and discards the
  failure (measured). The explicit `|| return 1` makes the failure path deterministic whether
  or not the caller set `-e` — A17.
- A comment on the generator recording that the pipeline is safe only because 48 bytes is
  small enough that `tr` finishes before `head` closes the pipe, with the 0/300 and 20/20
  measurements, so nobody raises the constant for "more entropy" and gets an intermittent
  installer failure.
- The write inside `( umask 077; { … } > "$env_file" )` — A1.
- The repair branch: read the mode with `stat -c '%a'`; `600` prints `kept existing <path>`
  unchanged; anything else `chmod 600` and prints `tightened permissions on <path> (was <mode>)`
  — A5, A6. Contents are never read on this branch, so an existing token is never loaded into
  a variable.

### `deploy/install-nuc.sh`

- Source the library after `REPO_DIR` is resolved, and replace the inline block at lines 40–57
  with a single call passing `"$ENV_FILE"` and `"$LAN"`. Nothing else in the script changes —
  same flags, same order, same output for the two cases that already existed.

### `deploy/env-file.test.ts` (new)

- A `spawnSync('bash', …)` harness matching the house style already used by
  `scripts/env.test.ts` and `scripts/junit.test.ts`. Each case gets its own `mkdtempSync`
  sandbox and an explicit path argument; no test reads or writes `$HOME` — A13.
- The interposition helper writes a stub `chmod` into the sandbox's `bin/`, earlier on `PATH`,
  recording `<mode> <path>` pairs — pairs, not bare modes, because the directory's `chmod` also
  passes through the stub and position alone would not say which line is the file's.

## Tests

| Spec criterion | Test | File |
|---|---|---|
| A1 | `creates the env file at 0600 even under umask 000` | `deploy/env-file.test.ts` |
| A2 | `the harness catches the pre-change form` | `deploy/env-file.test.ts` |
| A3 | `the config directory ends up 0700` | `deploy/env-file.test.ts` |
| A4 | `the parent directory is not tightened as collateral` | `deploy/env-file.test.ts` |
| A5 | `an existing 0644 file is tightened, and the output says so` | `deploy/env-file.test.ts` |
| A6 | `an existing 0600 file is left alone, contents intact` | `deploy/env-file.test.ts` |
| A7 | `the generated token appears in no output stream` | `deploy/env-file.test.ts` |
| A8 | `loopback writes neither host nor token` | `deploy/env-file.test.ts` |
| A9 | `an unrecognised lan value is treated as loopback` | `deploy/env-file.test.ts` |
| A10 | `a missing path argument fails and creates nothing` | `deploy/env-file.test.ts` |
| A11 | `sourcing the library prints nothing and creates nothing` | `deploy/env-file.test.ts` |
| A12 | `both shell files parse, and the installer sources the library` | `deploy/env-file.test.ts` |
| A15 | `a symlinked env path is refused and the target keeps its mode` | `deploy/env-file.test.ts` |
| A16 | `a dangling symlink is refused and its target is not created` | `deploy/env-file.test.ts` |
| A17 | `a failing token generator fails the call and leaves no file` | `deploy/env-file.test.ts` |
| A13 | not a test — read in Stage 5 review | `review.md` |
| A14 | not a test — the gate | `bun run verify` |

**A2 is a standing test, not a one-off measurement.** It embeds the pre-change four lines
verbatim as a fixture, runs them through the same interposition harness, and asserts the
recorded mode is `666`. Without it, a harness that silently stopped interposing — a stub that
is no longer found on `PATH`, a `chmod` call that moved — would leave A1 asserting against
whatever it happened to collect. A test that cannot demonstrate it detects the defect is the
failure mode this repo has shipped repeatedly; A2 is that demonstration, kept runnable.

## Verification

```
bash -n deploy/lib/env-file.sh && bash -n deploy/install-nuc.sh
bun test deploy/env-file.test.ts
bun run verify
```

Then, and separately from the criteria, the mutation predictions — each written down **before**
running, per the discipline from loops 033–037:

| # | Mutation | Prediction |
|---|---|---|
| M1 | Replace `mktemp` + `mv` with a plain `> "$env_file"`, keeping the trailing `chmod 600` | `creates the env file at 0600 even under umask 000` fails, recording `666`. `the recorder catches the pre-change form` still passes. `a failing token generator…` still passes, because generation happens before the write either way |
| M2 | Delete the `[ -L ]` guard | `a symlinked env path is refused…` and `a dangling symlink is refused…` both fail |
| M3 | Change `[ -L ]` to `[ -f ]` in that guard | Only the **dangling** case fails. `[ -f ]` is true for a link to a regular file, so the symlink-to-file test still passes — the mutation is half-caught, and the half it misses is the one the old script already had |
| M4 | Write `local token="$(…)"` as a one-liner | `a failing token generator fails the call and leaves no file` fails, nothing else |
| M5 | Delete the absolute-path guard | `a relative path is refused rather than chmodding the working directory` fails |
| M6 | Delete the xtrace suppression | `the token does not leak under bash -x` fails, nothing else |
| M7 | Make the repair branch `chmod 600` unconditionally, dropping the `*00` case | `an existing 0400 file is not loosened…` fails, and `an existing 0600 file is left alone…` fails on its `not.toContain('tightened')` half |
| M8 | Raise `umask 077` around the `mkdir` and drop the leaf `chmod 700` | `the parent directory is not tightened as collateral` fails. `the config directory ends up 0700` passes, and `a pre-existing parent keeps its own mode` passes — the shortcut only harms a directory it creates |
| M9 | Delete the 32-character token length check | **Zero tests fail.** Predicted before running and recorded as such: nothing in the suite produces a short token, so this guard ships unarmed. If the prediction holds, the fix is a test, not a shrug |
| M10 | Restore the inline block in the installer alongside the `source` line | `both shell files parse, and the installer calls the library` fails on its `not.toContain('> "$ENV_FILE"')` half |

A mutation whose result differs from its prediction is a finding about the test, not a
correction to the prediction, and goes in `review.md` either way. Each mutation is verified to
name a test that actually exists before its result is scored — loop 036 recorded two mutation
results against tests that did not exist.

## Risks

- **The tests depend on the library calling bare `chmod`.** PATH interposition is what makes
  the creation mode observable; a future edit hardening the library to `/bin/chmod` would make
  A1 and A2 silently stop testing anything real. A2 is the mitigation: it would keep asserting
  `666` against its fixture and fail the moment interposition stopped working.
- **`stat -c` is GNU-only.** Already true of this script via `grep -oP`, and the installer
  requires systemd anyway. It would break a macOS port that does not exist.
- **`bun test` discovery.** `deploy/` is not currently a test root, but `scripts/*.test.ts` is
  discovered from the repo root today, so default discovery already walks outside `packages/`.
  Verified before relying on it; if it turns out otherwise the file moves to `scripts/` and
  `review.md` records the move.
- **CI has no `bash -n` step of its own** — A12 runs it from inside `bun test`, so it runs in
  CI by virtue of being a test rather than a workflow change. That is deliberate: adding a
  workflow step would put `.github/` outside the fence for no gain.
- **Looked fine locally, breaks in CI:** the likeliest candidate is a sandbox path assumption —
  a `mktemp -d` under a CI runner whose `TMPDIR` has a different mode, which would break A4's
  parent-mode assertion if it asserted an exact number. A4 therefore asserts the parent is
  **not** `700`, not that it is `755`.

---

**Next stage:** Build/Test — run `/sdlc-implement 038-env-file-secret-window` to write the diff.
