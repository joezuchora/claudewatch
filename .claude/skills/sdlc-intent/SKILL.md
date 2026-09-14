---
name: sdlc-intent
description: Stage 1 (Plan) of the AI-native SDLC. Turns a raw goal, bug report, or request into a committed intent.md. Use when starting any new piece of work — a feature, a fix, a chore — before any design or code exists. Also use when an incident record calls for a follow-up change.
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
---

# Stage 1 — Plan: write `intent.md`

Capture *what problem exists and what done looks like*, in the user's terms. No solution,
no file names, no design. Those are later stages, and smuggling them in here is the most
common way this stage fails.

## Steps

1. **Pick the ID.** List `sdlc/` and take the next free `<NNN>`; slugify the title.
   Everything for this change lives in `sdlc/<NNN>-<slug>/`.

2. **Interview the requester.** Do not skip this even when the ask seems obvious. Establish:
   - What is actually wrong today, and how you would observe it
   - Who hits it and how often
   - What they would see differently once it is fixed
   - What nearby thing this is explicitly *not* doing

   Ask the questions you cannot answer from the repository. Read `SPEC.md`, `README.md` and
   the relevant source first so you only spend the requester's attention on genuine unknowns.

3. **Write the file** from `.claude/sdlc/templates/intent.md` to
   `sdlc/<NNN>-<slug>/intent.md`. Fill every section. If a section is genuinely empty —
   no open questions, say — write "None" rather than deleting the heading; a reader needs
   to know it was considered.

4. **Make "done" mechanically checkable.** Every outcome must be something a person could
   confirm or refute without reading the diff. Rewrite anything that fails that bar.

5. **Commit it on its own**, before any other work:
   `git checkout -b sdlc/<NNN>-<slug> && git add sdlc/<NNN>-<slug>/intent.md`
   `git commit -m "sdlc(<NNN>): intent — <title>"`

   The separate commit matters: it is what lets a reviewer see the intent as it stood
   before the design rationalized it.

## Done when

`sdlc/<NNN>-<slug>/intent.md` is committed, every outcome is observable, and the open
questions are either answered or explicitly deferred.

## Next

**Stage 2 — Design.** Run `/sdlc-spec <NNN>-<slug>`.
