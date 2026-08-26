# Intent: the statusline must not hang when run interactively

- **ID:** 005-statusline-tty-stdin
- **Stage:** 1 — Plan
- **Status:** accepted
- **Author:** derived automatically from [`004-statusline-stdin-hang/incident.md`](../004-statusline-stdin-hang/incident.md)
- **Date:** 2026-08-26

> **This intent was drafted from an incident, not from a feature request.** That is the
> Maintain → Plan edge the playbook describes, and this is the first time it has been
> traversed in this repository.

## Problem

The compiled statusline binary reads session JSON from stdin unconditionally. When stdin is a
terminal there is no EOF, so the read never resolves and the process hangs indefinitely — no
output, no error, no exit.

`SPEC.md §2.4` specifies the piped invocation Claude Code uses and never names the interactive
one, so nothing in the spec, the tests, or CI covers it.

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

- [ ] Running the compiled binary in a terminal with no piped input prints a status line and
      exits, within the `SPEC.md §11.7` budget
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

- **Should there be an explicit non-interactive flag** (`--no-session`), or is TTY detection
  sufficient on its own? Resolved in Design. `SPEC.md §11.4`'s flag list is contractual, so
  adding one is an amendment rather than an implementation detail.
- **Is a bounded stdin read a better fix than TTY detection**, given a pipe that is opened but
  never written would hang identically? Resolved in Design.

---

**Next stage:** Design — run `/sdlc-spec 005-statusline-tty-stdin`.
