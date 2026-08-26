---
name: sdlc-incident
description: Stage 6 (Maintain) of the AI-native SDLC. Turns a production signal — a bug report, a CI failure, a user-visible regression — into a committed incident.md, and closes the loop by drafting the follow-up intent.md. Use when something that shipped misbehaves.
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
---

# Stage 6 — Maintain: write `incident.md`, restart the loop

This is the edge that makes the lifecycle a loop. An incident does not end in a ticket
queue; it ends as a new `intent.md`.

## Steps

1. **Record what was observed, before diagnosing.** Open
   `sdlc/<NNN>-<slug>/incident.md` from `.claude/sdlc/templates/incident.md` and fill in
   *What happened*, *Impact*, and the timeline from the actual signal — the issue, the CI
   log, the user's words. Resist writing the cause you already suspect; a wrong early theory
   is sticky and it steers the investigation.

2. **Mitigate first if users are affected.** A rollback or a revert is a mitigation, not a
   resolution. Log it in the timeline and keep going.

3. **Find the root cause.** Trace it to the change that introduced it where you can —
   `git log`, `git blame`, `git bisect`. Then answer the two questions that actually
   improve the process:
   - Which stage *should* have caught this?
   - Why didn't it?

   Answer honestly. "The spec never enumerated this edge case" and "the test existed but
   mocked the very thing that broke" are useful answers. "Human error" is not.

4. **Draft the follow-up.** Each follow-up item becomes a new `intent.md` at Stage 1 — run
   `/sdlc-intent` for each and cross-link the IDs in both directions.

5. **If the stage that missed it can be strengthened**, that is itself a follow-up intent:
   a sharper `REVIEW.md` check, a missing hook, a template section that goes unfilled
   because nobody understands it. This is how the harness improves rather than ossifies.

6. **Commit:** `git commit -m "sdlc(<NNN>): incident — <title>"`

## A note on scope

ClaudeWatch ships no telemetry by design (`SPEC.md §12`, §20), so there is no monitoring to
page anyone. In practice the signal here is a GitHub issue, a CI failure, or a user report.
That is a narrower Maintain stage than a service with production observability would have —
which is a real limitation, not something to paper over.

## Next

**Stage 1 — Plan**, for each follow-up. Run `/sdlc-intent`.
