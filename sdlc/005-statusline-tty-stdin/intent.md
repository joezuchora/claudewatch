# Intent: the statusline must not hang on any stdin state

- **ID:** 005-statusline-tty-stdin
- **Stage:** 1 — Plan
- **Status:** accepted
- **Author:** derived automatically from [`004-statusline-stdin-hang/incident.md`](../004-statusline-stdin-hang/incident.md)
- **Date:** 2026-08-26

> **This intent was drafted from an incident, not from a feature request.** That is the
> Maintain → Plan edge the playbook describes, and this is the first time it has been
> traversed in this repository.

## Problem

The compiled statusline binary blocks forever when stdin is open, silent, and never closed.

`main.ts:75` guards `process.stdin.isTTY`, but that property is `undefined` — not `true` — for
a socket or an inherited pipe. The guard does not fire, `readSync` at `main.ts:82` blocks, and
the process never produces output, never errors, and never exits.

Established by probing the descriptor: without redirection `fd0 -> socket:[3660]`, and the
read blocks; with `< /dev/null` it returns 0 immediately.

The guard tests one member of the failing set. The set is **any stdin that will not reach
EOF** — sockets, unwritten pipes, and some supervisor and CI harnesses, of which a terminal is
merely the case already covered.

## Who is affected

Every user, on first run, at the exact moment they are deciding whether the tool works.
`README.md`'s install section shows the binary being invoked; doing that hangs the terminal.

Nobody hits it during normal operation, because Claude Code pipes stdin and closes it. That
asymmetry is why it has gone unreported: the people who hit it conclude the tool is broken and
have no reason to file a bug about a program that produced no output.

## Why now

It is a silent first-run failure in a tool whose entire value is being glanceable, and the fix
is small. It is also the third instance of one pattern — a defect no test could see because no
test runs the real artifact the way a user runs it — and the smoke test it needs closes that
gap for everything after it.

## What "done" means

- [ ] Running the compiled binary with **any** stdin state — terminal, socket, closed,
      unwritten pipe — prints a status line and exits rather than hanging
- [ ] Running it with piped session JSON behaves exactly as it does today — the rich
      session-aware output is unchanged
- [ ] Running it with stdin closed behaves exactly as it does today
- [ ] A smoke test exercises the **compiled binary** across all three stdin conditions, so
      this class of defect cannot recur silently
- [ ] Exit codes are unchanged in every case

## Explicitly out of scope

- The stdin session protocol itself. It is specified, it works, and Claude Code depends on it.
- Any change to the rich statusline's content or formatting.
- The intermittent `bun run verify` hang. Different symptom, no evidence of a shared cause,
  and conflating them would muddy both. Still tracked separately.

## Open questions

- **TTY detection is definitively insufficient** — that is the defect, not the fix. The
  question is what replaces it: a descriptor-type check (`fstat().isFIFO()`), a bounded read
  with a deadline, or both. Resolved in Design.
- **What deadline is safe** given `SPEC.md §11.7` budgets 50 ms to stdout, when a bounded read
  could add to it? Resolved in Design.
- **Should `SPEC.md §11.4`'s contractual flag list gain `--no-session`?** Resolved in Design.

---

**Next stage:** Design — run `/sdlc-spec 005-statusline-tty-stdin`.
