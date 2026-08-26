# Incident: the statusline binary hangs forever on a non-TTY stdin that never reaches EOF

- **ID:** 004-statusline-stdin-hang
- **Stage:** 6 — Maintain
- **Status:** root cause corrected 2026-08-26 04:10 UTC — see below
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

> **CORRECTED 2026-08-26 04:10 UTC. The first diagnosis in this record was wrong**, and it is
> left visible below rather than edited away, because how it was wrong is the useful part.
>
> **What I originally wrote:** "`main.ts` reads session JSON from stdin unconditionally. When
> stdin is a TTY there is no EOF, so the read never resolves."
>
> **Why that was wrong:** `main.ts:75` already contains `if (process.stdin.isTTY) return null;`.
> The TTY case is handled and always has been. I saw a hang, reached for the most familiar
> explanation, and wrote it down without opening the function — which is precisely what this
> repository's own `incident.md` template warns against two lines from the top: *"Resist
> writing the cause you already suspect; a wrong early theory is sticky."*

**The actual mechanism**, established by probing the file descriptor rather than reasoning
about it:

```
$ bun run probe.ts          # no redirection
fd0 -> socket:[3660] | isTTY=undefined     → readSync blocks forever

$ bun run probe.ts < /dev/null
fd0 -> /dev/null | isTTY=undefined         → readSync returns 0 after 0ms
```

`process.stdin.isTTY` is `undefined` — **not** `true` — when stdin is a socket. The guard at
`main.ts:75` therefore does not fire, and `readSync(0, …)` at `main.ts:82` blocks indefinitely
waiting for bytes on a descriptor that is open, will never be written to, and will never be
closed.

The guard tests for the one non-EOF case its author thought of. The failing set is larger:
**any stdin that is open, silent, and never closed.** In practice that means an inherited
socket, a pipe whose writer never writes, and some supervisor and CI harnesses. A terminal is
one member of that set, and it happens to be the member already handled.

- **Introduced by:** the session-aware rich statusline (`SPEC.md §2.4`), predating the loop
- **Stage that should have caught it:** Design, then Test
- **Why it didn't:** `SPEC.md §2.4` specifies the piped invocation Claude Code uses and names
  no other. The guard was written against the one alternative its author imagined rather than
  against the actual condition — "stdin will not reach EOF" — and no test spawns the compiled
  binary at all, so nothing could observe the difference.

**Directly relevant to shipped work:** `deploy/systemd/*.service` do not set
`StandardInput=null` explicitly. systemd's default is `null`, so those units are not affected
today, but they are one edit away from being so, and the same class of launcher is exactly
where this bites.

## Mitigation

None applied. The failure does not affect ClaudeWatch's actual operation as a status line, so
there is nothing bleeding. Fixing it properly is the follow-up rather than a hotfix.

## Follow-up

| Follow-up | New intent ID | Status |
|---|---|---|
| Bound the stdin read so no descriptor state can hang the binary — TTY detection alone is insufficient | [`005-statusline-tty-stdin`](../005-statusline-tty-stdin/intent.md) | drafted |
| Add a smoke test that runs the **compiled binary** the way a user does, covering TTY stdin, piped stdin, and closed stdin | folded into 005 | drafted |
| Consider whether `SPEC.md §11.4`'s flag contract should gain an explicit non-interactive mode | raised in 005's open questions | open |
| Set `StandardInput=null` explicitly in the systemd units rather than relying on the default | folded into 005 | drafted |

## What we are not changing

The stdin session protocol itself. It is specified, it works, and Claude Code depends on it.
The defect is the absent TTY case, not the design.
