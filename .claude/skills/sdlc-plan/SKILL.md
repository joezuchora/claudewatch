---
name: sdlc-plan
description: Stage 3 (Build, planning half) of the AI-native SDLC. Reads spec.md and produces plan.md — the file-by-file change list, the scope fence the diff will be audited against, and the test mapping. Use after the spec is accepted and before writing any code.
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
---

# Stage 3 — Build: write `plan.md`

Translate the contract into a concrete change list, and draw the fence the diff will be
held to.

## Steps

1. **Read `sdlc/<NNN>-<slug>/spec.md`** and the code it touches. Trace the actual call
   paths — a plan written from file names alone will miss the call site that matters.

2. **Prefer what already exists.** Before proposing a new helper, search for one. In this
   repo `packages/core/src/` holds all domain logic and `packages/core/src/test-helpers.ts`
   already provides `makeTestSnapshot`, `makeTestEnterpriseSnapshot`, `makeTestEnvelope`,
   `makeTempCacheDir`, and `setupTestCacheDir`. New code that duplicates one of those is a
   compliance finding in Stage 5.

3. **Write the file** from `.claude/sdlc/templates/plan.md` to `sdlc/<NNN>-<slug>/plan.md`.

   The **scope fence** is the load-bearing section. List every file the change is permitted
   to touch. Be complete and be honest — `plan-to-diff-auditor` compares the real diff
   against this list in Stage 5, and a file that shows up there and not here is a finding
   regardless of whether the change was a good idea.

4. **Map every acceptance criterion to a test.** Fill the table. An unmapped criterion means
   either a missing test or a criterion that was never real; resolve it now, not later.

5. **Respect the architecture rules.** Domain logic goes in `packages/core`; `packages/vscode`
   and `packages/statusline` stay thin rendering layers. If the plan puts logic in a surface,
   it is wrong — move it.

6. **Commit:** `git commit -m "sdlc(<NNN>): plan — <title>"`

## Done when

The scope fence is complete, every acceptance criterion has a test, and the verification
commands are written out exactly as Stage 4 will run them.

## Next

**Stage 3/4 — Build & Test.** Run `/sdlc-implement <NNN>-<slug>`.
