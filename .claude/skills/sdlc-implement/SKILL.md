---
name: sdlc-implement
description: Stage 3/4 (Build and Test) of the AI-native SDLC. Reads plan.md and writes the diff plus its tests, staying inside the plan's scope fence and running the verification gate before committing. Use after plan.md is accepted. Supersedes the older "Implement Module" skill.
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Agent
---

# Stage 3/4 — Build & Test: write the diff

Implement exactly what `plan.md` describes, with every behavior shipping alongside its check.

## Steps

1. **Read `sdlc/<NNN>-<slug>/plan.md`.** Work its change list in order. Keep `spec.md` open —
   the plan says what to change, the spec says what the result must do.

2. **Stay inside the scope fence.** If the implementation genuinely needs a file the plan did
   not list, stop and amend `plan.md` in its own commit, with a sentence on why. Do not
   silently widen the change; the audit in Stage 5 will surface it anyway, and an
   unexplained excursion is a worse finding than a planned one.

3. **Write the test with the code, not after it.** Every feature ships with its check.
   In this repo that means:
   - Tests live next to their source as `*.test.ts`
   - Contract tests mock HTTP — never hit the real API
   - Reuse `packages/core/src/test-helpers.ts` rather than hand-rolling fixtures
   - Keep tests isolated; mock state must not leak between files

4. **Honor the code style.** Strict TypeScript with no `any`, ES modules, timestamps internal
   as UTC ISO strings, no access token in any log, cache file, debug output, or process
   argument, atomic writes for cache. These are not preferences — several are security
   invariants from `SPEC.md §12` and are re-checked in Stage 5.

5. **Run the gate:** `bun run verify` (typecheck, lint, test, build). Fix everything it
   reports and re-run until clean. A partial pass is a fail.

6. **For VS Code changes**, confirm the bundle is still CommonJS — grep the built output for
   `require` / `module.exports`. The extension host cannot load ESM.

7. **Check yourself before committing.** Launch `plan-to-diff-auditor` against the working
   diff. Resolve or record what it finds now, while the context is fresh.

8. **Commit** with a conventional message referencing the ID:
   `git commit -m "feat(<area>): <what changed>` … `sdlc: <NNN>"`

## Done when

`bun run verify` exits 0, every acceptance criterion in `spec.md` is demonstrably met, and
the diff sits inside the scope fence or the excursion is written down.

## Next

**Stage 5 — Deploy.** Run `/sdlc-review <NNN>-<slug>`.
