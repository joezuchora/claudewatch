# Review: 038-env-file-secret-window

- **ID:** 038-env-file-secret-window
- **Stage:** 5 — Deploy
- **Derived from:** [`plan.md`](./plan.md)
- **Range reviewed:** `b00bd4e..57a3b5c` (loop 037's retrospective, exclusive, to the security remediation)

## Commits

| Commit | What |
|---|---|
| `94fbcf4` | intent |
| `860c661` | spec, first draft |
| `47802cd` | spec revision 1 — findings from my own measurement, before the reviewer reported |
| `253edb0` | plan, first draft |
| `af9d326` | spec revision 2 + plan revision — the Stage 2 review's blockers, design changed to `mktemp`+`mv`, fence amended |
| `e7758b4` | implementation |
| `677dee2` | bugs pass — the write's exit status was masked on the loopback path |
| `e8dfab5` | review.md, committed as a banner-marked draft |
| `e08aaa2` | plan-to-diff remediation — the design change shipped untested |
| `57a3b5c` | security remediation — two clauses this loop wrote were unarmed |

## Pass 1 — Bugs and logical errors

Reviewed by me, reading the diff against `spec.md` and `SPEC.md`.

### P1-1 · **major** · the write's exit status was masked on the loopback path · **fixed** (`677dee2`)

`{ echo …; echo …; if [ "$lan" = "1" ]; then …; fi; } > "$tmp"` takes its status from the last
command in the group. On the loopback path that is an `if` whose condition is false and whose
status is therefore `0`. A failing `echo` above it — a full disk — would be masked, the
function would print `wrote …` and return success over a truncated file, and the repair branch
would then bless that file as `kept existing` on every later run.

That is the *same* failure mode `mktemp` + `mv` was adopted to close, reintroduced one level
down, in the commit that adopted it. Composed into a variable and written with a single
`printf` instead, whose status is unambiguous. Verified the loopback bytes are byte-identical
to the old form.

**Not covered by a test, deliberately and with the reason recorded:** failing a write *after* a
successful open needs something like `/dev/full`, and the error path calls `rm -f "$tmp"` — a
test that stubbed `mktemp` into `/dev/full` would have the suite delete a device node. The
cheaper mitigation is that the failure mode no longer exists rather than being caught.

### P1-2 · **superseded by S-3** · a parent directory that is itself a symlink is still followed

*Left in place rather than deleted, because the way I got this wrong is the finding.* I recorded
it as a minor about a `chmod` following a link. The security pass measured what actually
happens and it is the secret's **location** that moves, not a mode. Fixed in `57a3b5c`. The
original text follows.



`[ -L "$env_file" ]` guards the env file. It does not guard `~/.config` or `~/.config/claudewatch`
being symlinks, in which case `chmod 700 "$dir"` chmods the target. Guarding the whole path
chain is a materially larger change (a walk, or `realpath` plus an ownership check), and the
reachability is the same as the file case: creating those links requires already owning the
directory. Recorded on the queue rather than smuggled in.

### P1-3 · **nit** · a killed process leaves a stray `.metrics.env.XXXXXX` · **recorded, not fixed**

`mktemp` then `mv` leaves a temp file behind if the process dies between the two. It is `0600`
and contains what the env file would have contained, so it is not an exposure; it is litter.
Cleaning it would need a `trap`, which interacts with the caller's own traps. Recorded.

## Mutation testing

Predictions were written into `plan.md` and committed **before** any mutation ran. Each
mutation's named test was confirmed to exist before its result was scored.

| # | Mutation | Predicted | Observed | Verdict |
|---|---|---|---|---|
| M1 | `mktemp`+`mv` → plain redirect to the destination | only `creates the env file at 0600 even under umask 000` fails | that test **and** `the recorder catches the pre-change form` fail | **prediction wrong** — see below |
| M2 | delete the `[ -L ]` guard | both symlink tests fail | both symlink tests fail | ✓ |
| M3 | refuse only a link that does not resolve | symlink-to-file fails, dangling passes | exactly that | ✓ |
| M4 | `local token="$(…)"` as a one-liner | only the generator test fails | only the generator test fails | ✓ |
| M5 | delete the absolute-path guard | only the relative-path test fails | only the relative-path test fails | ✓ |
| M6 | delete the xtrace suppression | only the `bash -x` test fails | only the `bash -x` test fails | ✓ |
| M7 | repair branch chmods unconditionally | the `0400` test and the `0600` test's `not.toContain('tightened')` half fail | exactly those two | ✓ |
| M8 | `umask 077` around `mkdir`, no leaf `chmod` | only the parent-collateral test fails | only the parent-collateral test fails | ✓ |
| M9 | delete the 32-character length check | **zero** | **zero** | ✓ prediction — and a defect, fixed below |
| M10 | restore the inline block beside the `source` line | the installer test fails | the installer test fails | ✓ |

### M1 · the row names the bare-redirect variant, and the distinction matters

The security pass noted the M1 row does not reproduce under the *umask-subshell* variant. Both
readings are true and they give different answers, which is exactly why the row has to name
which one it means. Measured, both:

| Variant of "stop using `mktemp` + `mv`" | Tests that fail |
|---|---|
| **Bare** `{ … } > "$env_file"` — what the M1 row means | `creates the env file at 0600…` and `the recorder catches the pre-change form` |
| `( umask 077; … > "$env_file" )` — the first draft's design, run as N1 below | `creates the env file at 0600…`, `the destination is written through a temp file…`, `a write that fails after the temp path is chosen…`; the recorder test **passes**, because the umask variant does create at `0600` |

The recorder test keys on `666`, which the umask variant never produces. Two mutations that
sound like the same sentence, different results, and only one of them was the design under
discussion — which is how the untested-design gap below went unnoticed for a whole stage.

### M1 · the prediction was wrong, and the test was better than I predicted

I predicted `the recorder catches the pre-change form` would survive M1, reasoning that it runs
its own frozen fixture. It has two halves — the fixture must record `666`, *and the library
must not* — and the second half is precisely what M1 breaks. I forgot the two-assertion
structure I had deliberately built into that test twenty minutes earlier, and which the plan
describes in the sentence beginning "Both halves in one test". The code is right; the
prediction was wrong in the direction of underestimating the suite, which is the harmless
direction, but it is still a prediction I got wrong about a thing I wrote.

### M1 · two earlier attempts measured my patch, not the code

Before the faithful run, M1 was applied twice incorrectly and reported 10 failures both times.
The first substituted `tmp="$env_file"` while leaving `mv "$tmp" "$env_file"` in place, so
every run died on `mv` refusing to move a file onto itself. The second was meant to remove that
`mv` and did not: the patch script computed the replacement and then wrote the *unmodified*
string back to disk. Both results were facts about a broken mutant, not about the library.

Loop 036 shipped two mutation records that named tests which did not exist. This is the same
class one step earlier — a mutation that was never really applied — and it is only in this
document because the numbers looked wrong enough (10 failures for a one-line change) to check.
A mutation whose blast radius is much larger than its diff is the signal to re-read the patch
before recording the result.

### M9 · predicted zero, returned zero, and the guard is now armed

The 32-character length check had no test that could reach it. The plan predicted zero and said
"if the prediction holds, the fix is a test, not a shrug". `a token too short for the service is
rejected at install time` was added, stubbing `tr` to emit a short string; re-running M9 with it
in place fails that test. The guard is now load-bearing.

## Plan-to-diff audit

Run by the `plan-to-diff-auditor` subagent over `b00bd4e..e8dfab5`. Verdict: **excursions
recorded** — no file outside the fence, and the fence is genuinely constraining (ten explicit
paths, no globs).

### D-1 · **blocking** · the design change shipped completely untested · **fixed** (`e08aaa2`)

The audit swapped the shipped `mktemp` + `mv` back to the first draft's
`( umask 077; … > "$env_file" )` and **all 23 tests passed**. Reproduced before fixing. The
whole justification for spec revision 2 — the partial-write hole — was unarmed.

The cause was one disjunction. A1 asserted the chmod target matched
`.metrics.env.* || the destination`, and the umask design satisfies the second half. Three
tests added; reverting the design now fails three instead of none.

This is the loop's own subject matter, committed by me in the commit that fixed the previous
instance. It is the third occurrence in this loop of *a test named for a guard it does not
exercise* and the first that a reviewer, not I, had to find.

### D-2 · **major** · `A19`'s "the trace really did run" was satisfied by the harness · **fixed** (`e08aaa2`)

`expect(r.stderr).toContain('+')` matched the harness's own pre-call trace lines (`+ umask 022`),
so it would have held against a library that switched xtrace off and never switched it back.
Now asserts a marker traced *after* the call, which is what proves restoration.

### D-3 · **major** · `A22` pinned half the clause it existed to pin · **fixed** (`e08aaa2`)

The new `SPEC.md` sentence makes two claims. Only `created with its final mode` was pinned; the
atomic-write half was unenforced prose — which is precisely how D-1 happened.

### D-4 · **major** · the fence amendment was applied by addition, leaving contradictions · **fixed** (`e08aaa2`)

`plan.md` still specified the `umask` subshell thirty-five lines after superseding it; both
`plan.md` and `spec.md` still said `SPEC.md` and `deploy/README.md` must not be touched, while
the diff touched both. A reader auditing this loop against the plan alone would get whichever
answer they read first. Loop 035's lesson was to amend the fence rather than rationalise
afterwards; I did amend it, and then left the contradicted text standing, which is a different
half of the same failure.

### D-5 · **major** · `plan.md`'s test table named two tests that do not exist · **fixed** (`e08aaa2`)

`the harness catches…` for `the recorder catches…`, and `…sources the library` for
`…calls the library`. Loop 036's recorded defect, recurring in the document that cites it.

### D-6 · **minor** · two unstated consequences · **recorded** (`e08aaa2`)

A relative `$XDG_CONFIG_HOME` now aborts the installer, and the installer is no longer
self-contained. Both follow from the change; neither was written down.

### D-7 · **minor** · `review.md` named an unreachable commit · **fixed**

`6400012` was amended into `47802cd` and survives only in the reflog. A review naming a commit
that is not in the range it reviewed.

## Pass 2 — Security and vulnerabilities

Run by the `security-reviewer` subagent over `b00bd4e..e08aaa2`. Two blocking findings, both
reproduced by me before fixing, and **both were `SPEC.md` §12 clauses added by this loop that
no test exercised**.

### S-1 · **blocking** · the repair branch's "never prints the token" was unarmed · **fixed** (`57a3b5c`)

The *Deployment secrets* clause this loop added to §12 says the repair branch "never reads,
rotates, or prints the token". Making `_cw_repair_mode` `cat` the file into its own success
message left **26/26 green**; so did a stderr variant. The 0644 test already wrote a
recognisable token and asserted the contents were unchanged — and never looked at `stdout` or
`stderr`. Both streams asserted now, on both repair branches.

### S-2 · **blocking** · a comment claimed coverage that was impossible · **fixed** (`57a3b5c`)

The `bash -x` test carried a comment saying it covered "never a process argument", because
xtrace prints the argv of every command. It cannot: the library disables xtrace for exactly the
secret section, so argv is the one thing that trace cannot show. Routing the content through
`/usr/bin/env printf` — a real `execve` argv — left **26/26 green**. The code was safe only
because `printf` and `[` are builtins, and nothing held it there.

The false sentence is deleted, and `the token never becomes a process argument` now interposes
argv-recording wrappers over every external command the secret path can reach. This is the
purest instance of the defect class in the loop: not a weak assertion, but a *claim of coverage
in prose* over a path no test touched.

### S-3 · **major** · a symlinked config directory moves the secret, not just its mode · **fixed** (`57a3b5c`)

I had recorded this as P1-2, a minor, and described it as a `chmod` following a link. That
understated it. Measured: with `$dir` a symlink, `mkdir -p`, `chmod 700`, `mktemp` **and** `mv`
all follow it, so `metrics.env` — token and all — is written inside the link's target. The
realistic trigger is not an attacker: `~/.config` symlinked into a dotfiles repo or a sync root
is an ordinary setup, and it puts a live bearer token under version control. Now refused, with
the resolved path in the message. P1-2 below is superseded by this.

### S-4 · **minor** · the repair branch's `chmod` is still racy · **recorded, not fixed**

Between the `[ -L ]` guard and the `chmod`, a writer to `$dir` can swap the file for a symlink;
`chmod` follows, and bash has no `fchmod`. The reviewer won the race by shadowing `mkdir`. It
needs write access to a `0700` user-owned directory — the user or root — so it is not a
privilege boundary crossing on its own, and S-3's fix removes the one chain that handed `$dir`
to someone else. Recorded rather than papered over: the residual race is real and shell cannot
close it.

### S-5 · **minor** · three temp-file cleanups were untested · **fixed** (`57a3b5c`)

Deleting each `rm -f "$tmp"` individually left the suite green, and the rename- and
chmod-failure temps hold the complete token. Not an exposure — `0600` inside a `0700` directory
— but the design comment claimed nothing is left behind and only the happy path checked.

### S-6 · **minor** · a test name promised a path it does not exercise · **fixed** (`57a3b5c`)

"a write that fails **after the temp path is chosen**" induces an *open* failure, so no temp
file ever exists and the cleanup branch is a no-op. Renamed to what it checks.

### S-7 · **nit** · the `%03d` padding was untested · **fixed** (`57a3b5c`)

Without it a mode-`000` file falls out of the `*00` case and is **loosened to 0600 under a
message reading "tightened"** — the exact inversion the 0400 test exists to prevent.

### S-8 · **nit** · the library header overclaimed · **fixed** (`57a3b5c`)

"Every step checks its own status" is not true of the token generator, which is a pipeline and
needs the caller's `pipefail` to detect a mid-pipeline failure. The call still fails safely,
but through the length check rather than the generator's own branch — which makes that length
check load-bearing beyond what its comment claimed. Both comments corrected.

### S-9 · **informational** · no static analysis covers the new shell library · **recorded, not fixed**

`shellcheck` is not installed and is not a `verify` step; the only check is `bash -n` inside a
test. Thin for a file whose whole job is handling a secret. Adding an optional, skip-if-absent
`shellcheck` step is a harness change and belongs in its own loop — it goes on the queue rather
than being smuggled into this fence.

### S-10 · **informational** · `--lan` is cleartext regardless · **documented** (`57a3b5c`)

The token this loop hardened at rest still crosses the LAN in the clear on every request, over
`http://`. Pre-existing and unchanged by the diff, but the README paragraph this loop rewrote is
exactly where someone would look, so it now says so and points at a TLS-terminating proxy.

### A defect of my own, found while fixing S-7

The test I added to arm the length guard was **flaky**. Its stub for the character filter never
read stdin, so the encoder upstream could take a `SIGPIPE` and fail the pipeline — producing
"could not generate a token" instead of the length message the test asserts. Measured: **1
failure in 400** without a drain, **0 in 400** with one. It flaked on its second run here.

At that rate it would have reddened CI weeks from now and looked exactly like an infrastructure
flake, which this repo's rules say is never a root cause. Fixed by draining stdin in the stub;
25 consecutive clean suite runs after.

## Pass 3 — Compliance

- All domain logic stays in `packages/core` — untouched by this loop; nothing under `packages/`
  is in the diff at all.
- No `any`, ESM, UTC ISO: no TypeScript behaviour changed; the only new `.ts` file is a test.
- VS Code bundle stays CJS: unaffected, and the build ran clean in `verify`.
- **`SPEC.md` amended, consciously.** §12 gains a *Deployment secrets* clause in the style of
  the `sdlc/003` telemetry paragraph. This is a spec amendment and is recorded as one, in the
  spec, the plan's fence amendment, and here.
- **Fence amended mid-loop**, before implementation, to add `SPEC.md` and `deploy/README.md`.
  The reason is in `plan.md`. `.oxlint-budget.json` was fenced pre-emptively against the new
  test file changing the warning set; it did not, and the entry went unused — stated here
  rather than quietly dropped.

## Acceptance criteria

All 23 met. 30 tests in `deploy/env-file.test.ts`; `bun run verify` exits 0.

| Criterion | Test |
|---|---|
| A1 the window is closed | `creates the env file at 0600 even under umask 000` |
| A2 that test discriminates, permanently | `the recorder catches the pre-change form` |
| A3 directory is 0700 | `the config directory ends up 0700` |
| A4 the parent is not collateral damage | `the parent directory is not tightened as collateral`, `a pre-existing parent keeps its own mode` |
| A5 an existing loose file is repaired | `an existing 0644 file is tightened, and the output says so` |
| A6 an existing correct file is left alone | `an existing 0600 file is left alone, contents intact` |
| A7 the token never leaves the file | `the generated token appears in no output stream`, `the token never becomes a process argument` |
| A8 loopback writes no token | `loopback writes neither host nor token` |
| A9 unrecognised `lan` is loopback | `an unrecognised lan value is treated as loopback` |
| A10 a missing path fails loudly | `a missing path argument fails and creates nothing` |
| A11 sourcing is inert | `sourcing the library prints nothing and creates nothing` |
| A12 both shell files parse | `both shell files parse, and the installer calls the library` |
| A13 no real `$HOME` is touched | enforced by `env -i` in the harness, not only by reading |
| A14 the gate is green | `bun run verify` exits 0 |
| A15 symlinked path refused | `a symlinked env path is refused and the target keeps its mode` |
| A16 dangling symlink refused | `a dangling symlink is refused and its target is not created` |
| A17 `set -e` not masked by `local` | `a failing token generator fails the call and leaves no file` |
| A18 relative path refused | `a relative path is refused rather than chmodding the working directory` |
| A19 `bash -x` does not leak | `the token does not leak under bash -x` |
| A20 an owner-only file is not loosened | `an existing 0400 file is not loosened…`, `a mode-000 file is not loosened either` |
| A21 absent `$2` is loopback | `an absent lan argument is treated as loopback` |
| A22 docs and code cannot drift | `the documented invariants still say what the code now does` |
| A23 a failed write leaves no file | `a temp file that cannot be opened leaves no destination file`, `a failing rename leaves no temp file holding the token` |

Three further tests belong to no criterion and are kept: `the destination is written through a
temp file, never opened directly`, `the file contents are exactly what the service parses`, and
`a token too short for the service is rejected at install time`. Each exists because a mutation
returned zero.

**Which of these are evidence and which are fences** is stated in `spec.md`; Stage 5 did not
count a regression guard as proof of the fix.

## Findings recorded and not fixed

| # | What | Why not here |
|---|---|---|
| P1-3 | A killed process leaves a stray `.metrics.env.XXXXXX`. It is `0600`, so litter rather than exposure | Needs a `trap`, which interacts with the caller's own traps |
| S-4 | The repair branch's `chmod` is racy against a swap between guard and call | Bash has no `fchmod`; needs write access to a `0700` user-owned directory. S-3's fix removes the one chain that handed that directory to someone else |
| S-9 | No `shellcheck` over the new library | A harness change; belongs in its own loop and its own fence, not smuggled into this one |
| — | `deploy/README.md:166` claims `metrics.db` is mode `0600`; measured, it is `644` | Harmless today — its directory is `700` — but a shipped document asserting a mode the code does not set is this loop's own defect class one directory over. The remedy is in `packages/metrics/src/store.ts`, outside this fence, and the choice between tightening the file and correcting the sentence is a real decision |
| — | The `bash -x` suppression protects the library, not the installer's own lines | An operator tracing the whole installer still sees everything outside `claudewatch_write_env_file`. Nothing there handles the token, but the boundary is worth stating |

## Queue additions

1. `metrics.db` is `644` while `deploy/README.md` says `0600` — tighten the file or correct the
   sentence, deliberately.
2. An optional `shellcheck` step in `verify`, skipped when the binary is absent.
