# Intent: three test files document a mock model I cannot reproduce

- **ID:** 039-vscode-stub-model
- **Stage:** 1 — Plan
- **Status:** draft
- **Author:** the SDLC loop, from queue item "make the vscode stubs an actual superset, or share one"
- **Date:** 2026-08-29

## Problem

Four files under `packages/vscode/src/` each call `mock.module('vscode', …)` with their own
partial stub. Three of them carry a comment asserting how bun combines those stubs:

> `mock.module('vscode')` is process-wide, and the merge is a per-key COMPOSITE — NOT
> last-writer-wins.

The queue item that opened this was "make the stubs an actual superset, or share one". Checking
that framing before designing to it produced three measurements, and the third is the reason
this is a loop rather than a chore:

| Measured | Result |
|---|---|
| Each of the five `packages/vscode/src/*.test.ts` files run **alone** | All pass — 5, 20, 29, 10, 6 |
| Top-level keys defined by each of the four stubs | **Identical**: `window`, `workspace`, `commands`, `env`, `Uri`, `StatusBarAlignment`, `ThemeColor`, `MarkdownString` |
| Sub-keys of `window` | **Divergent**: `extension` defines three (`createStatusBarItem`, `showInformationMessage`, `showErrorMessage`), `statusbar` and `tooltip` define one |
| Two files mocking one **bare** specifier with different keys, run together | Each file saw **only its own** — no composite, and no cross-file key |

So the first half of the queue item is already satisfied — the stubs *are* a top-level superset
of one another — and the model the comments describe **did not reproduce** in the simplest
experiment I could build. A fourth, cruder probe suggested that a *bare* specifier may not leak
to a non-mocking file at all, where `sdlc/025`'s incident (a **local** specifier, `./core-bridge.js`)
demonstrably did. If that distinction is real it matters well beyond these four files, because
`scripts/mock-topology.ts` — the guard loop 026 built — reasons about local specifiers and
deliberately ignores bare ones.

I am not asserting the comments are wrong. My probes used a specifier with no real module behind
it, which is not identical to `vscode`'s shape, and bun's file ordering is not guaranteed. What I
am asserting is narrower and sufficient: **three files in the shipping package document a
mechanism that the obvious experiment contradicts, and nothing in the repo settles which is
right.** A future change to those stubs will be designed against whichever the author reads
first.

## Who is affected

Nobody today: every test passes alone and together, and no assertion currently depends on the
merge. This is preventive, and saying otherwise would be inventing urgency.

It matters because of where it sits. `packages/vscode` is the package headed for the
Marketplace, so it is the package whose test suite will change most often from here. A suite
whose semantics are documented incorrectly is one where the next author's correct-looking change
fails for a reason the comments actively mislead them about — and `sdlc/025` is the precedent:
`tooltip.test.ts` asserted against a leaked stub for four loops while reading as green.

## Why now

The queue item has been open since loop 027 on a framing that measurement has now partly
dissolved. Either it gets restated on evidence or it should be closed; carrying it in its
current form is the worst of the three.

There is also a cheap-to-check reason to do it before more vscode work rather than after: every
future test file added to this package copies one of these four stubs, so the duplication and the
possibly-wrong comment both propagate.

## What "done" means

- [ ] The merge behaviour of `mock.module` for a **bare** specifier across multiple files is
      settled by a committed, re-runnable experiment — not by a comment, and not by my word
- [ ] Where that experiment disagrees with the comments in `statusbar.test.ts`,
      `tooltip.test.ts` and `commands.test.ts`, the comments are corrected or the experiment
      shows why they were right after all
- [ ] The bare-versus-local distinction is either confirmed and written into
      `scripts/mock-topology.ts`'s docstring next to the two holes already recorded there, or
      shown not to exist
- [ ] Whatever restructuring the evidence supports — one shared stub, or four kept deliberately
      separate with a check that they agree — is done for a stated reason, and the option not
      taken is recorded
- [ ] Every `packages/vscode/src/*.test.ts` still passes **alone** as well as together, and that
      is checked by something other than me remembering to check it
- [ ] `bun run verify` exits 0

## Explicitly out of scope

- **Any change to `packages/vscode/src/*.ts` production code.** This is about the test
  scaffolding. If the investigation turns up a product defect it gets recorded, not fixed here.
- **`scripts/mock-topology.ts`'s rules.** Its docstring may gain a measured fact. Changing R1 or
  R2 is a separate loop with its own fence — loop 026 built them against specific observations
  and they should not be edited as a side effect of this.
- **The Marketplace rename and publishing.** The user's call, both of them.
- **The two known holes already recorded** in `mock-topology.ts` (the subdirectory `../` case,
  and discovery not seeing outside `packages/*/src` and `scripts/`).
- **Making `vscode` a real typed dependency** rather than a hand-written stub. A larger and
  genuinely different design question.

## Open questions

1. **Does the bare/local distinction hold for `vscode` specifically?** My probe used a specifier
   with nothing behind it. `vscode` is also unresolvable at test time, which is suggestive but
   not the same as verified. Stage 2 must answer this with the real specifier.
2. **Where did the "per-key COMPOSITE" claim come from?** It reads like something that was
   measured rather than assumed. If there is a shape in which it *is* true, that shape needs to
   be found before the comments are called wrong — this repo has twice corrected a claim into a
   worse one.
3. **Is bun's inter-file ordering stable enough to build a check on?** If a test that asserts
   isolation can itself be order-dependent, the check has to be a separate per-file invocation
   rather than an assertion inside the suite.

None of these block Stage 2; all three *are* Stage 2.

---

**Next stage:** Design — run `/sdlc-spec 039-vscode-stub-model` to turn this into `spec.md`.
