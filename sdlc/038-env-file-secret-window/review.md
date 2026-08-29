# Review: 038-env-file-secret-window

> **STATUS: DRAFT — THIS LOOP IS NOT CLOSED.** Pass 2 (security) has not run and the
> plan-to-diff audit has not reported. The presence of this file must **not** be read as the
> loop being finished; the convention in `sdlc/README.md` that a `review.md` means a closed
> loop does not hold until the two sections below marked *filled in once it reports* are
> filled in and this banner is gone. Committed in this state only because it is real work that
> should not sit untracked.

- **ID:** 038-env-file-secret-window
- **Stage:** 5 — Deploy
- **Derived from:** [`plan.md`](./plan.md)
- **Range reviewed:** `b00bd4e..677dee2` (loop 037's retrospective, exclusive, to the bugs-pass commit)

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

### P1-2 · **minor** · a parent directory that is itself a symlink is still followed · **recorded, not fixed**

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

## Pass 2 — Security and vulnerabilities

Run by the `security-reviewer` subagent. **Filled in below once it reports.**

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

**Filled in below once both subagents report.**

## Findings recorded and not fixed

**Filled in below.**
