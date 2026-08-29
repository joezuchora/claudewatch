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
   effect for `mkdir -p ~/.config/claudewatch` sets **`~/.config` itself** to `0700`, not just
   the leaf. Locking down a directory this tool does not own, as a side effect of protecting
   one file inside it, is a worse outcome than the defect. `chmod` on the leaf alone leaves the
   parent at `0755` (measured).

   The directory is therefore `0755` briefly before it becomes `0700`. That window exposes
   nothing: it exists only before the env file has been created, and the env file — the only
   secret involved — is `0600` from its own first instant. The invariant that matters is about
   the file, and the directory is defence in depth, not the barrier.

2. If the env file does **not** exist: generate the token when `lan` is `1`, and write the file
   inside a `( umask 077; { ...; } > "$env_file" )` subshell. Measured: this yields mode `0600`
   at creation even under an ambient `umask 000`. A subshell is used so the umask cannot leak
   into the rest of the installer. `chmod 600 "$env_file"` follows, unconditionally — see
   *Rejected alternatives*. Prints `wrote <path>`.

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
  safe. `SPEC.md §12` — no access token in
logs, cache files, debug output, or process arguments — governs; this change amends nothing in
that section, it brings a file that was already covered by its intent into compliance with it.

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
  change enforces. It therefore needs **no edit** — but for the opposite reason to the one
  given: not because it is silent, but because this change is what finally makes it true. The
  document was accurate about the intent and inaccurate about the artifact, on both the
  creation window and the repair branch that never repaired anything.

This change is not breaking.

## Acceptance criteria

- [ ] **A1 — the window is closed.** A test runs the function under `umask 000` with a stub
      `chmod` earlier on `PATH` that records the target's mode *before* delegating to the real
      `chmod`; the recorded mode is `600`. Verified by `bun test`.
- [ ] **A2 — that test discriminates.** The same test, run against the pre-change inline block,
      records `666` and fails. Verified by running it against the old code and recording both
      numbers in `review.md`. A test that cannot fail against the defect it names is the exact
      failure this repo has shipped in five of the last six loops; A1 without A2 is not
      evidence.
- [ ] **A3 — the directory is `0700`.** Verified by `bun test` on a sandbox path.
- [ ] **A4 — the parent is not collateral damage.** After a run that creates
      `<sandbox>/.config/claudewatch/metrics.env`, `<sandbox>/.config` is **not** `0700`.
      Verified by `bun test`. This criterion fails if the implementation takes the obvious
      `umask 077; mkdir -p` shortcut.
- [ ] **A5 — an existing loose file is repaired.** Pre-create at `0644`, run, assert mode
      `0600` and that stdout matches `tightened permissions`. Verified by `bun test`.
- [ ] **A6 — an existing correct file is left alone.** Pre-create at `0600` with known
      contents, run, assert mode `0600`, contents byte-identical, stdout contains
      `kept existing` and not `tightened`. Verified by `bun test`.
- [ ] **A7 — the token never leaves the file.** With `lan=1`, read the token back out of the
      written file and assert that string appears in neither stdout nor stderr. Verified by
      `bun test`. Asserting merely that the output lacks the literal `CLAUDEWATCH_METRICS_TOKEN`
      would pass on a script that printed the raw value alone, so the assertion is on the
      token's own text.
- [ ] **A8 — loopback writes no token.** With `lan=0`, the file contains no
      `CLAUDEWATCH_METRICS_TOKEN` and no `CLAUDEWATCH_METRICS_HOST`. Verified by `bun test`.
- [ ] **A9 — an unrecognised `lan` is loopback.** `lan="yes"` writes no token. Verified by
      `bun test`.
- [ ] **A10 — a missing path argument fails loudly.** Exit status non-zero, message on stderr.
      Verified by `bun test`.
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
- [ ] **A14 — the gate is green.** `bun run verify` exits 0, and the `oxlint` warning set is
      unchanged against `.oxlint-budget.json`.

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
- **`install -m 600 /dev/null "$env_file"` then append.** Correct and atomic about the mode,
  but it turns a `>` into a `>>` whose correctness depends on the preceding `install` having
  truncated, and it adds a coreutils dependency the script does not otherwise have.
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
