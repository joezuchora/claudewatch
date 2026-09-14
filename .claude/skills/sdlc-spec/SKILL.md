---
name: sdlc-spec
description: Stage 2 (Design) of the AI-native SDLC. Reads a committed intent.md and produces spec.md — the precise behavioral contract, edge cases, and mechanically checkable acceptance criteria. Use after intent is accepted and before any implementation planning.
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Agent
---

# Stage 2 — Design: write `spec.md`

Turn the intent into a contract precise enough that two people would build the same thing
from it. Still no file-by-file plan — that is Stage 3.

## Steps

1. **Read `sdlc/<NNN>-<slug>/intent.md`.** If its open questions are unanswered, answer them
   now, with the requester if need be. Designing over an unresolved question just relocates
   the ambiguity into the code.

2. **Read the governing spec.** `SPEC.md` is the source of truth for ClaudeWatch's domain.
   Find the sections this change touches and cite them by number. If the change *amends*
   `SPEC.md`, say so explicitly in the spec's Behavior section — an amendment is a decision
   someone must consciously accept, not a side effect.

3. **Read the code you are specifying against.** The contract must fit what exists.

4. **Write the file** from `.claude/sdlc/templates/spec.md` to `sdlc/<NNN>-<slug>/spec.md`.

   Two sections carry the weight:
   - **Edge cases** — enumerate them exhaustively. Each becomes a test in Stage 3. An edge
     case with no testable consequence means the spec is still underspecified.
   - **Acceptance criteria** — each must name *how* it is verified. "Works correctly" is
     not a criterion; "`bun run verify` exits 0" is.

5. **Review it adversarially.** Launch the `spec-reviewer` subagent against
   `intent.md` + `spec.md`. Fix what it finds, or record why you disagree in Rejected
   alternatives. Do not skip this because the spec feels obvious to you — it is cheap here
   and expensive three stages later.

6. **Commit:** `git commit -m "sdlc(<NNN>): spec — <title>"`

## Done when

Every intent outcome maps to at least one acceptance criterion, every criterion names its
verification, and `spec-reviewer` has no unaddressed blocking findings.

## Next

**Stage 3 — Build.** Run `/sdlc-plan <NNN>-<slug>`.
