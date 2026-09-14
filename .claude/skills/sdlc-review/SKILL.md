---
name: sdlc-review
description: Stage 5 (Deploy) of the AI-native SDLC. Runs the REVIEW.md passes and the plan-to-diff audit against a finished change, records findings in review.md, and opens the PR. Use once implementation is complete and the verification gate passes.
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Agent
---

# Stage 5 — Deploy: review and ship

Review is the bottleneck in an AI-native lifecycle, because generation stopped being one.
Treat this stage as the real work, not the paperwork after it.

## Steps

1. **Confirm the gate is green.** Run `bun run verify` and keep the actual output — it goes
   into `review.md` as evidence. A claim that it passed is not evidence.

2. **Run the plan-to-diff audit.** Launch `plan-to-diff-auditor` with `plan.md` and the full
   branch diff (`git diff main...HEAD`). Record both directions: files changed outside the
   fence, and plan items with no corresponding change.

3. **Run the review passes** defined in `/REVIEW.md`, in order:
   - **Pass 1 — bugs and logical errors.** Do this one yourself, reading the diff against
     `spec.md`.
   - **Pass 2 — security and vulnerabilities.** Launch the `security-reviewer` subagent.
   - **Pass 3 — compliance.** Architecture rules, code style, and the repo's own conventions.

   Run every pass even when the diff looks trivial. The passes exist because "it looked
   trivial" is exactly when things get through.

4. **Write `sdlc/<NNN>-<slug>/review.md`** from `.claude/sdlc/templates/review.md`. Record
   every finding and its resolution — including findings you decided *not* to fix, with the
   reason. A silently dropped finding defeats the purpose of writing them down.

5. **Fix the blocking findings** and re-run the gate. Then update `review.md` with the fix
   commits.

6. **Open the PR** as a draft, using `.github/pull_request_template.md`. Link the artifact
   chain in the body so a reviewer can walk `intent.md → spec.md → plan.md → diff → review.md`
   without hunting for it.

7. **Drive it to green.** CI red on your own PR is work now, not later.

## Done when

`review.md` is committed with every pass recorded, no blocking finding is unresolved, CI is
green, and the PR links its chain.

## Next

**Stage 6 — Maintain.** Nothing to do until production says otherwise. If it does, run
`/sdlc-incident`.
