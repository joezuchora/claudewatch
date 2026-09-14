# Incident: <short title>

- **ID:** <NNN>-<slug>
- **Stage:** 6 — Maintain
- **Status:** open | mitigated | closed
- **Detected:** <YYYY-MM-DD HH:MM UTC> — by <how: user report, CI, issue #n>
- **Severity:** <how bad, in user terms>

## What happened

Plain description of the observed behavior. What the user saw, not what you suspect the
cause was — the cause goes below, once it is actually known.

## Impact

Who was affected, for how long, and what they could not do. If the blast radius is
genuinely unknown, write "unknown" rather than a comforting guess.

## Timeline

| Time (UTC) | Event |
|---|---|
| | |

## Root cause

The actual mechanism. Trace it to the change that introduced it where possible — and if
that change went through this loop, name which stage should have caught it. That link is
the whole point of keeping the chain in version control.

- **Introduced by:** <commit / PR / "predates the loop">
- **Stage that should have caught it:** <Plan | Design | Build | Test | Deploy | n/a>
- **Why it didn't:** <the honest answer>

## Mitigation

What was done to stop the bleeding, and when. Distinguish this from the fix — a rollback
is a mitigation, not a resolution.

## Follow-up

Each item becomes an `intent.md` and re-enters the loop at Stage 1. This is the feedback
edge that makes the lifecycle a loop rather than a line.

| Follow-up | New intent ID | Status |
|---|---|---|
| <what needs to change> | `<NNN>-<slug>` | drafted / in flight / done |

## What we are not changing

Deliberate decisions to accept the risk, with reasoning. Being explicit here is what keeps
the next incident review from relitigating it.
