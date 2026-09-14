# Spec: create the metrics env file already protected, and repair it if it is not

- **ID:** 038-env-file-secret-window
- **Stage:** 2 — Design
- **Status:** draft
- **Derived from:** [`intent.md`](./intent.md)

## Summary

The env-file section of `deploy/install-nuc.sh` moves into a sourceable shell library so it
can be exercised without systemd. The file is created with `umask 077` in effect, so it is
`0600` from birth rather than `0600` after the fact; its containing directory is set to `0700`;
and the branch that finds an existing file stops reporting `kept existing` over a
world-readable secret and tightens the mode instead. The installer's observable behaviour is
otherwise unchanged.

## Behavior

### The library

A new file `deploy/lib/env-file.sh` is sourced, not executed. It defines exactly one public
function:

```
claudewatch_write_env_file <env_file_path> <lan>        # lan is "0" or "1"
```

It has no top-level side effects — sourcing it must create nothing and print nothing, so a
test can source it and then choose what to call. It does not read `$ENV_FILE`, `$LAN`, or any
other caller variable; everything it needs arrives as an argument. It prints progress with its
own `printf '  %s\n'` helper, matching the `say` format the installer already uses, rather
than depending on a `say` the caller may or may not have defined.

### What the function does

0. **Refuse a symlink at the env-file path**, before deciding which branch to take. If
   `[ -L "$env_file" ]`, print a message on stderr and return non-zero without creating,
   writing, or chmodding anything.

   This is not defensive garnish; it is required twice over, and one of the two is a hole this
   change would otherwise *open*. Measured:

   | Fact | Consequence |
   |---|---|
   | `[ -f ]` is **true** for a symlink to a regular file | The repair branch's `chmod 600` acts on the link's **target**. Measured: `chmod 600` through a link set a `0644` victim file to `0600`. That is an arbitrary-file chmod primitive that does not exist in today's script, because today's repair branch does nothing. |
   | `[ -f ]` is **false** for a dangling symlink, `[ -L ]` is true | Today's script therefore takes the *create* branch and the redirect **follows the link and creates its target**. Measured: the write landed in the link's target path, token and all. This one is pre-existing. |

   `REVIEW.md` Pass 2 already requires "symlink targets checked with `lstat` before write" as
   standing policy. `[ -L ]` is `lstat` in shell; `[ -f ]` is `stat`, and the difference is the
   whole finding.

   The threat model is honest about its own limits: creating that symlink requires write access
   to `~/.config/claudewatch`, which is `0700`-or-tighter and owned by the user, so an attacker
   who can do it can usually do worse directly. The guard is cheap, the policy already demands
   it, and the alternative is shipping a fix that adds a way to chmod any file on the box.

1. `dir=$(dirname "$env_file")`; `mkdir -p "$dir"` under the **ambient** umask, then
   `chmod 700 "$dir"`.

   The umask is deliberately *not* changed around the `mkdir`. Measured: `umask 077` in
   effect for `mkdir -p ~/.config/claudewatch` sets **`~/.config` itself** to `0700` — but
   **only when `mkdir` is the thing that creates it**. Re-measured after review: a
   pre-existing `~/.config` at `0755` is left at `0755`. The first draft stated the
   consequence more broadly than the measurement supported, which on a machine that has ever
   run a desktop session means not at all. The collateral damage is real but confined to a
   fresh account, which is exactly the case a first install hits. Locking down a directory this tool does not own, as a side effect of protecting
   one file inside it, is a worse outcome than the defect. `chmod` on the leaf alone leaves the
   parent at `0755` (measured).

   The directory is therefore `0755` briefly before it becomes `0700`. That window exposes
   nothing: it exists only before the env file has been created, and the env file — the only
   secret involved — is `0600` from its own first instant. The invariant that matters is about
   the file, and the directory is defence in depth, not the barrier.

2. If the env file does **not** exist: generate the token when `lan` is `1`, write into a
   `mktemp` file in the destination directory, `chmod 600` it, and `mv` it into place. Prints
   `wrote <path>`.

   **Revised from the `umask 077` subshell of the first draft**, on review. Two measurements
   decided it. `mktemp` creates at `0600` even under an ambient `umask 000`, and `mv` preserves
   that — so the mode is still a property of creation, with no umask manipulation at all. And a
   plain `> "$env_file"` truncates at open time, *before* the first line is written: measured,
   a failure partway through leaves a header-only file on disk. Under the repair branch below
   that file is `0600`, so every future run would print `kept existing` over an env file with
   no token in it, and the operator's only route out would be a manual deletion nothing tells
   them to make. The rename means the destination is either absent or complete.

   This is also the atomic write `CLAUDE.md` and `SECURITY.md` already require of every other
   private file the project writes. The first draft departed from that convention for the one
   file holding a bearer token, without noticing it was departing.

   `chmod 600` on the temp file follows, redundantly — see *Rejected alternatives*.

3. If the env file **does** exist: read its current mode. If it is already `600`, print
   `kept existing <path>` exactly as today. If it is anything else, `chmod 600` it and print
   `tightened permissions on <path> (was <mode>)`. The file's *contents* are not touched on
   this branch — in particular an existing token is neither read, re-generated, nor logged.

### The token

Generation is unchanged: `head -c 48 /dev/urandom | base64 | tr -d '/+=' | head -c 48`. It is
assigned to a function-local variable inside the subshell that writes it, so it is not exported,
not passed as an argument to any command, and not in the environment of anything the installer
runs later. It is written to the file and nowhere else.

Two shell mechanics govern how it must be written, both measured rather than assumed:

- **`local` swallows `set -e`.** In `bash`, `local TOKEN="$(cmd)"` takes its exit status from
  `local`, not from `cmd`, so a failing generator is silently ignored; a plain
  `TOKEN="$(cmd)"` aborts under `set -e` as intended. Measured both ways. The extraction into
  a function is exactly what introduces this risk — the current inline code is a plain
  assignment and is safe — so the function must declare and assign on separate lines:
  `local TOKEN; TOKEN="$(...)"`. An implementation that writes the one-liner has quietly
  removed an existing protection while appearing to preserve the code.
- **The generator pipeline is safe only because 48 is small.** `... | tr -d '/+=' | head -c 48`
  ends in a `head` that closes the pipe; under `pipefail` a `SIGPIPE` in `tr` would fail the
  pipeline and, under `set -e`, abort the installer. Measured: 0 failures in 300 runs at the
  real 48-byte input, and 20 failures in 20 runs when the input is raised to 100000 bytes. The
  current size is safe and stays unchanged, but the margin is a property of the constant, not
  of the code, so it gets a comment saying so. Raising 48 for "more entropy" would make the
  installer fail intermittently, which is precisely the kind of change that looks obviously
  safe.

`SPEC.md §12` — no access token in logs, cache files, debug output, or process arguments —
governs. The first draft said this change "amends nothing in that section". **It now does amend
it**, and review was right that declining to was the wrong call: §12's only file-mode clause
covers the telemetry spool, added by an explicit recorded amendment in `sdlc/003`, and nothing
in it covers the installer's env file — so without an amendment this loop's invariant would
live only in `sdlc/038-*/spec.md`, where a future installer edit could violate nothing.
`SECURITY.md`'s scope names the install scripts, which makes the gap louder. One sibling
paragraph is appended to §12 in the same commit, in the `sdlc/003` style, and pinned by a test.

A third mechanic, found on review: **`bash -x` prints the token.** Measured — an assignment
from a command substitution emits two trace lines carrying the value, and an operator debugging
a failed install with `bash -x ./deploy/install-nuc.sh --lan` is the exact situation §12's
"debug output" clause is about. xtrace is therefore suppressed across the secret-handling
section and restored exactly as found. This also gives the intent's "never a process argument"
clause its only mechanical check, since xtrace prints the argv of every command it runs.

### The installer

`deploy/install-nuc.sh` sources the library and calls the function in place of its current
inline block. Its output for the two cases that already existed (`wrote …`, `kept existing …`)
is byte-identical. The new `tightened permissions on …` line appears only in a case that
previously printed the misleading `kept existing`.

## Data and types

No TypeScript types change. Nothing is added to any package's public surface.

Reading a file's mode uses GNU `stat -c '%a'`. That is not portable to BSD/macOS `stat -f`,
and it does not need to be: the script's own preflight requires `systemd`, and it already
depends on GNU-only `grep -oP` at its final line. The dependency is pre-existing and is
recorded here so it is a decision rather than an accident.

The shell contract is the only new interface, and it is positional:

| Position | Meaning | Absent |
|---|---|---|
| `$1` | absolute path of the env file to create or repair | a programming error — the function fails with a message and a non-zero status rather than defaulting to a path |
| `$2` | `1` to bind LAN and generate a token, anything else for loopback-only | treated as `0`; the loopback default is the safe one, so an unrecognised value must not silently enable LAN |

The file's own content model is unchanged: a comment line, `CLAUDEWATCH_METRICS_ENDPOINT`,
and — under `--lan` only — `CLAUDEWATCH_METRICS_HOST` and `CLAUDEWATCH_METRICS_TOKEN`. A
missing optional line stays absent rather than being written empty, per the project rule that
missing optional fields are omitted, not guessed.

## Edge cases

| Case | Expected behavior |
|---|---|
| Ambient `umask 000`, file does not exist | File is `0600` at the instant `chmod` is called, not merely after it |
| Ambient `umask 022`, file does not exist | Same — `0600` at creation |
| Directory `~/.config` does not exist | It is created at the ambient umask (`0755`), **not** `0700`; only the `claudewatch` leaf becomes `0700` |
| Directory exists at `0755` | Becomes `0700` |
| Env file exists at `0644` | Becomes `0600`; output says `tightened permissions`, names the old mode |
| Env file exists at `0600` | Unchanged; output says `kept existing`; no `tightened` line |
| Env file exists with a token in it | Contents untouched, token not read or printed; only the mode is considered |
| `lan=1` | Output contains no occurrence of the token that was written to the file, on stdout or stderr |
| `lan=0` | No `CLAUDEWATCH_METRICS_TOKEN` and no `CLAUDEWATCH_METRICS_HOST` line is written at all |
| `lan` is `""`, `2`, or `yes` | Treated as loopback-only; no token generated |
| Env file path is a symlink to a regular file | Non-zero exit, message on stderr; the link's target is **not** chmodded and **not** written |
| Env file path is a dangling symlink | Non-zero exit; the target path is **not** created |
| Env file path is a symlink to a directory | Same refusal; caught by the same `[ -L ]` check before any branch |
| Env file path exists but is a directory | Non-zero exit rather than a confusing redirect failure |
| Token generator fails | Non-zero exit propagates; no partial file is left behind |
| `$1` empty or missing | Non-zero exit, message on stderr, no file created anywhere |
| Library sourced but no function called | Nothing created, nothing printed |

## Backward compatibility

- **A NUC that already ran the old script** keeps its env file and its token. The only change
  it will see on a re-run is that a too-permissive file gets tightened and says so. No token is
  regenerated, so nothing that already authenticates against the service stops working.
- **The installer's contract** — flags, exit codes, the order of its printed sections — does
  not change. `--lan` and `--help` behave as before.
- **The systemd units** read the env file by path; neither the path nor the variable names
  change.
- **`deploy/README.md`** — the draft of this spec asserted it "documents the flags, not the
  file's permissions". That was wrong, and checking rather than assuming is what caught it.
  Line 64 reads: *"Secrets live in `~/.config/claudewatch/metrics.env` (mode `0600`), never in
  the unit files, which are world-readable."* The README already states the invariant this
  change enforces.

  **Superseded in Stage 5.** This paragraph concluded the README "therefore needs **no edit**",
  and that conclusion did not survive the review that put the file in scope two sections
  earlier — it was left standing because the amendment was applied by addition, so the committed
  spec asserted both that the README was in scope and that it must not be touched. The README
  *is* edited: it now says which `0600` it means, states the directory mode, and describes the
  repair branch. The plan-to-diff audit also found that edit wider than the amendment's stated
  reason, which was only about the ambiguous `0600`. The three added claims are each true of the
  new code and inside the loop's subject, but the reason given was narrower than the diff taken,
  and that is recorded rather than smoothed over.

This change is not breaking.

## Acceptance criteria

- [ ] **A1 — the window is closed.** A test runs the function under `umask 000` with a stub
      `chmod` earlier on `PATH` that records the target's mode *before* delegating to the real
      `chmod`; the recorded mode is `600`. Verified by `bun test`.
- [ ] **A2 — that test discriminates, permanently.** A **standing** `bun test` runs the
      pre-change block, frozen verbatim as a fixture, through the *same* recorder harness and
      requires it to record `666`, then requires the library to record no `666`. Both halves in
      one test, so deleting either is visible in the diff.

      Restated after review, which was right to reject the first version: "verified by running
      it against the old code and recording both numbers in `review.md`" is a one-time human
      observation that evaporates the moment the old code is deleted. After the commit nothing
      in the repo could ever fail it again — which is the shape of defect this loop exists to
      avoid, written into the criterion meant to prevent it. The fixture is a frozen artifact,
      not live code; it is not called by anything and must not be "kept up to date".
- [ ] **A3 — the directory is `0700`.** Verified by `bun test` on a sandbox path, with the
      child's umask **pinned to `022`**. Unpinned, a developer whose own umask is `077` gets a
      `0700` directory from the unfixed `mkdir` alone and the criterion passes against the
      defect — on precisely the machines most likely to run it.
- [ ] **A4 — the parent is not collateral damage.** After a run that creates
      `<sandbox>/.config/claudewatch/metrics.env`, `<sandbox>/.config` is **not** `0700`.
      Verified by `bun test`, umask pinned to `022`, and **`<sandbox>/.config` must not exist
      before the run** — the shortcut only locks a directory it creates, so a test helper that
      pre-created the tree would let the shortcut pass the criterion named after it. A second
      case covers the other side: a pre-existing `0755` parent stays `0755`.
- [ ] **A5 — an existing loose file is repaired.** Pre-create at `0644`, run, assert mode
      `0600` and that stdout matches `tightened permissions`. Verified by `bun test`.
- [ ] **A6 — an existing correct file is left alone.** Pre-create at `0600` with known
      contents, run, assert mode `0600`, contents byte-identical, stdout contains
      `kept existing` and not `tightened`. Verified by `bun test`.
- [ ] **A7 — the token never leaves the file.** With `lan=1`, read the token back out of the
      written file, **assert it is at least 32 characters**, and only then assert that string
      appears in neither stdout nor stderr. Verified by `bun test`. Two vacuity traps, one
      caught in the first draft and one caught on review: asserting the output lacks the
      literal `CLAUDEWATCH_METRICS_TOKEN` would pass on a script that printed the bare value,
      and asserting the absence of an extraction that silently returned `""` is
      `not.toContain('')`, which is true of everything.
- [ ] **A8 — loopback writes no token.** With `lan=0`, the file contains no
      `CLAUDEWATCH_METRICS_TOKEN` and no `CLAUDEWATCH_METRICS_HOST`. Verified by `bun test`.
- [ ] **A9 — an unrecognised `lan` is loopback.** `lan="yes"` writes no token. Verified by
      `bun test`.
- [ ] **A10 — a missing path argument fails loudly.** Non-zero status, and the **specific**
      message `env-file: no path given` on stderr, asserted in a shell run **without `set -u`**.
      Verified by `bun test`. Under `set -u` a bare `$1` already prints `unbound variable` and
      exits 1, so the looser criterion the first draft wrote is satisfied by a library
      containing no validation whatsoever; the test also asserts `unbound variable` is *not*
      what came back.
- [ ] **A11 — sourcing is inert.** Sourcing the library and doing nothing else prints nothing
      and creates nothing. Verified by `bun test`.
- [ ] **A12 — both shell files parse.** `bash -n deploy/install-nuc.sh` and
      `bash -n deploy/lib/env-file.sh` exit 0, and the installer actually sources the library.
      Verified by `bun test`. The installer cannot be run end-to-end here — it requires
      `systemctl`, which this host lacks — so a syntax check plus a source-line assertion is
      the honest substitute, and its weakness is recorded rather than dressed up as coverage.
- [ ] **A13 — no real `$HOME` is touched.** Every test operates under a `mktemp -d` sandbox
      passed as an explicit path; none reads or writes `$HOME`, `~/.config`, or
      `~/.local/share`. Verified by reading the test file in Stage 5 review.
- [ ] **A15 — a symlinked env path is refused on the repair branch.** Pre-create a regular
      file at `0644` and a symlink to it at the env path; run; assert non-zero exit, a message
      on stderr, and that the victim's mode is **still `0644`**. Verified by `bun test`. This
      criterion fails against a fix that adds the repair branch without the `[ -L ]` guard —
      i.e. against the most likely implementation of this very spec.
- [ ] **A16 — a dangling symlink is refused on the create branch.** Symlink the env path at a
      non-existent target; run; assert non-zero exit and that the target path was **not**
      created. Verified by `bun test`. This one fails against the *current* script too, which
      writes the token through the link.
- [ ] **A17 — `set -e` is not masked by `local`.** With a stubbed generator forced to fail, the
      function exits non-zero and leaves no env file. Verified by `bun test`. Written because
      the natural one-line `local TOKEN="$(...)"` passes every other criterion here while
      silently discarding the failure.
- [ ] **A18 — a relative path is refused, not resolved.** `dirname "metrics.env"` is `.`, so
      an unguarded `chmod 700 "$dir"` sets the **caller's working directory** to `0700` and
      returns success — the repo root, if a test ran from there. The test runs from a sandbox
      directory pre-set to `0755` and asserts it is still `0755`. Verified by `bun test`.
- [ ] **A19 — `bash -x` does not leak the token.** The child runs under `bash -x`; the token is
      absent from stderr **and** the trace is asserted to have actually run. Verified by
      `bun test`. Covers the intent's "not a process argument" clause, which had no check at all
      in the first draft.
- [ ] **A20 — an owner-only file is not loosened under a message claiming the opposite.** A file
      at `0400` would get `chmod 600` and the line `tightened permissions` under the first
      draft's rule — a loosening described as its opposite. The repair now fires only when group
      or other bits are set. Verified by `bun test`.
- [ ] **A21 — an absent second argument is loopback.** The Data-and-types table promised it;
      under the installer's `set -u` a bare `$2` aborts instead, so only `${2:-0}` delivers it.
      Verified by `bun test`.
- [ ] **A22 — the docs and the code cannot drift.** `deploy/README.md` and `SPEC.md` are pinned
      by phrase, in the style already established at `scripts/env.test.ts:324`. Verified by
      `bun test`.
- [ ] **A23 — a failed write leaves no file behind.** With the generator stubbed to fail, the
      call is non-zero and no env file exists. Verified by `bun test`.
- [ ] **A14 — the gate is green.** `bun run verify` exits 0, and the `oxlint` warning set is
      unchanged against `.oxlint-budget.json`.

## Which criteria are evidence, and which are fences

Review's `m3`, accepted: a spec this careful about A1-versus-A2 should say which criteria
actually fail against the defect, so Stage 5 does not count a regression guard as proof.

- **Fail against the current script — evidence:** A1, A2 (the window itself), A3, A4 (directory
  modes), A5 (there is no repair branch today), A16 (dangling symlink), A19 (xtrace), A20, A22,
  A23.
- **Fail against the most likely *implementation of this spec*, not against the old script:**
  A10, A15, A17, A18. A different and equally necessary thing to check.
- **Pass against the current script too — regression fences:** A6, A7, A8, A9, A11, A12, A13,
  A21. They stay, and they are not proof.

## Rejected alternatives

- **Just move `chmod 600` before the redirect.** It cannot work: the file must exist for
  `chmod` to act on it, and creating it is what exposes it. A `touch`-then-`chmod`-then-`>`
  ordering *would* work — measured, a truncating redirect onto an existing `0600` file
  preserves `0600` — but it states the invariant in three steps that must stay in that order,
  and a later edit that moves the write above the `chmod` reopens the hole silently. `umask`
  makes the mode a property of the creation itself.
- **Drop the trailing `chmod 600` once `umask` guarantees the mode.** Rejected. It is the
  mechanism that repairs an existing file, so it has to stay for that branch anyway; and one
  independent restatement of a security invariant is worth its line. The cost is that the
  final mode is `0600` on both the fixed and the broken code, which is why A1 observes
  creation rather than the end state — a cost paid deliberately, not overlooked.
- **`install -m 600 /dev/null "$env_file"` then append.** Correct about the mode, but it turns
  a `>` into a `>>` whose correctness depends on the preceding `install` having truncated, and
  it is not atomic — a failure partway still leaves a partial file at the destination.
  `mktemp` + `mv` gives the mode *and* the atomicity, and is the convention the rest of the
  project already follows.
- **Keeping the `umask 077` subshell instead of `mktemp`.** It closes the window and nothing
  else. It leaves the partial-write hole, and it departs from `CLAUDE.md`'s atomic-write rule
  for the one file in the project that holds a bearer token. Rejected on review, having been
  the first draft's whole design.
- **Keep the code inline in `install-nuc.sh` and test the whole script.** The script's
  preflight requires `systemctl`; this host has none, and stubbing `systemctl`,
  `loginctl`, `daemon-reload` and three `enable --now` calls to reach line 42 would make the
  test a fiction about a script it never really ran. Extracting the section is what makes an
  honest test possible, and it is the smallest extraction that does.
- **Port the fix to the Windows and macOS install paths too.** Out of scope per `intent.md`:
  POSIX modes do not carry over, and neither script generates a token, so there is no secret
  to expose.
- **Resolve the symlink and operate on its target instead of refusing.** It sounds
  accommodating and it is the wrong call: the whole reason the path is checked is that the
  target is not necessarily a file this tool should be writing a secret into or chmodding.
  Following it "helpfully" is the vulnerability, not the mitigation. Refusing costs an
  operator who deliberately symlinked their env file one manual step, and tells them why.
- **Regenerate the token when tightening a loose file.** A file that was world-readable may
  have been read, so rotation is arguably the safer default. Rejected because a script that
  silently invalidates a working credential during what the user asked to be an idempotent
  re-run causes an outage to fix a hypothetical. `intent.md` puts rotation out of scope and
  leaves the decision with the operator.

## What the gate does not check here

`scripts/fence-check.ts` extracts backticked tokens from `##`–`####` headings only. This spec's
headings carry no backticks, so the spec-to-plan gate has nothing to compare and reports clean
without having looked at anything. `bun run verify` going green is therefore not evidence of
fence coverage for this loop, and Stage 5 must not read it as such. Confirmed by running it: 18
checkable, no finding naming `038`.

## A method note, since measurements are load-bearing here

One first-round measurement was contaminated and would have been reported as fact. A
partial-write reproduction written as `( set -euo pipefail; { echo header; false; echo never; }
> f ) || true` printed `never`, appearing to show that `set -e` does not abort inside a redirect
group. It does — the `|| true` was the cause, because `set -e` is suppressed throughout a
compound command that is the left operand of `||`. Re-run without it: status 1, and the file
left holding `header` alone.

That is not a footnote. The same mechanism is why the library checks every command's status
explicitly rather than trusting the caller's `set -e`: the public wrapper calls the
implementation as the left operand of `||` in order to capture its status, which disables
`set -e` for the entire call.

## Adjacent finding, recorded and not fixed here

`deploy/README.md:166` states the metrics store is *"(SQLite, WAL, mode `0600`)"*. Measured on
this host: `metrics.db` is **`644`**. The exposure is nil today because its directory is `700`
(measured), which is exactly the asymmetry that makes the env file the urgent one — that file
sits in a `0755` config directory instead. But a shipped document asserting a file mode the
code does not set is the same defect class as the one this loop is fixing, one directory over.

Not fixed here: the remedy lives in `packages/metrics/src/store.ts`, well outside this fence,
and the choice between tightening the file and correcting the sentence is a real decision
rather than a typo. It goes on the queue.

---

**Next stage:** Build — run `/sdlc-plan 038-env-file-secret-window` to turn this into `plan.md`.
