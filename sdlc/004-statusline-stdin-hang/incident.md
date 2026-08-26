# Incident: the statusline binary hangs forever when stdin is a terminal

- **ID:** 004-statusline-stdin-hang
- **Stage:** 6 — Maintain
- **Status:** open
- **Detected:** 2026-08-26 03:38 UTC — while verifying loop 003's telemetry against the
  compiled binary
- **Severity:** High for first-run experience. The tool appears completely broken, silently.

> **This is the first real exercise of the Maintain stage.** Every prior loop ended by noting
> that ClaudeWatch produced no signal an incident could be raised from. This one was found by
> running the shipped artifact rather than its tests.

## What happened

Running the compiled statusline binary directly in a terminal produces **no output and never
exits**. It does not error, print, or time out. It hangs until killed.

```
$ ./claudewatch
   (nothing, forever)

$ ./claudewatch < /dev/null
   ⊙ 42% resets thu 12:00 am · 7d 18% resets thu 12:00 am
```

The only difference is whether stdin is closed.

Observed under a 20-second bound: exit code 124 (killed) with stdin attached to a terminal,
exit code 0 with `< /dev/null`. Reproduced every time.

## Impact

Anyone who installs ClaudeWatch and runs the binary once to check it works — the most natural
possible first action, and the one `README.md`'s install section invites by showing the
command — gets a hung terminal with no output and no error to search for.

It does not affect ClaudeWatch running *as* a Claude Code status line, because Claude Code
pipes session JSON on stdin and closes it. So the failure is invisible to normal operation and
maximally visible during first-run verification. That combination is why nobody has reported
it: the people who hit it have no reason to think the tool ever worked.

Blast radius: every user on every platform. Duration: since `SPEC.md §2.4`'s stdin session
feature shipped.

## Timeline

| Time (UTC) | Event |
|---|---|
| 03:38 | Binary invoked in a sandbox HOME to verify loop 003's telemetry; command hit the 2-minute tool timeout with no output |
| 03:39 | Re-run under a 20 s bound — exit 124, no spool, no stdout |
| 03:40 | Re-run with `< /dev/null` — exit 2 (no credentials in sandbox), immediate |
| 03:40 | Fixture with credentials and a fresh cache, `< /dev/null` — exit 0, correct output. Root cause localized to stdin handling |

## Root cause

`main.ts` reads session JSON from stdin unconditionally on its normal path. When stdin is a
TTY there is no EOF, so the read never resolves and the process waits indefinitely.

`SPEC.md §2.4` specifies session data arriving as piped stdin JSON, and `§11.7` budgets 50 ms
from start to stdout. Neither says what happens when stdin is a terminal — the spec assumed
the Claude Code invocation path and never named the interactive one.

- **Introduced by:** the session-aware rich statusline (`SPEC.md §2.4`), predating the loop
- **Stage that should have caught it:** Design, then Test
- **Why it didn't:** the spec described only the piped invocation, so no acceptance criterion
  covered a TTY stdin. The test suite mocks `main()`'s dependencies and never spawns the
  compiled binary, so no test could observe it. `docs/audit-report.md` reports 98.89% line
  coverage — this path is *covered* and still broken, because coverage measures lines
  executed, not conditions the program is run under.

**The generalizable lesson**, and the reason this belongs in the record: loop 001 found a
defect CI could not see because it ran each package in a separate process. Loop 003's B1 found
a defect module tests could not see because the statusline has no config channel. This is the
third instance of the same shape — **a defect invisible to every test that does not run the
real artifact the way a user runs it.**

## Mitigation

None applied. The failure does not affect ClaudeWatch's actual operation as a status line, so
there is nothing bleeding. Fixing it properly is the follow-up rather than a hotfix.

## Follow-up

| Follow-up | New intent ID | Status |
|---|---|---|
| Detect a TTY stdin and skip the session read, so the binary renders and exits | [`005-statusline-tty-stdin`](../005-statusline-tty-stdin/intent.md) | drafted |
| Add a smoke test that runs the **compiled binary** the way a user does, covering TTY stdin, piped stdin, and closed stdin | folded into 005 | drafted |
| Consider whether `SPEC.md §11.4`'s flag contract should gain an explicit non-interactive mode | raised in 005's open questions | open |

## What we are not changing

The stdin session protocol itself. It is specified, it works, and Claude Code depends on it.
The defect is the absent TTY case, not the design.
