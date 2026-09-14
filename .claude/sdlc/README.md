# The SDLC harness

Six stages, each ending by committing an artifact that the next stage reads:

```
Plan      →  Design   →  Build        →  Test  →  Deploy      →  Maintain
intent.md →  spec.md  →  plan.md      →  diff  →  review.md   →  incident.md
                          + tests         + PR
```

Everything for one change lives in `sdlc/<NNN>-<slug>/`. The chain is the record: a reviewer
reads it top to bottom and sees how a vague request became a specific diff.

## What's here

| Path | What it is |
|---|---|
| `templates/` | The five artifact skeletons. Repo-agnostic. |
| `../skills/sdlc-*` | One skill per stage. Each hands off to the next. |
| `../agents/` | `spec-reviewer`, `plan-to-diff-auditor`, `security-reviewer`. |
| `../../REVIEW.md` | The review policy — three passes, run on every change. |
| `../../.github/workflows/review.yml` | The passes and the plan-to-diff audit, in CI. |

## Lifting this into another repo

Copy `.claude/sdlc/`, `.claude/skills/sdlc-*`, `.claude/agents/`, `REVIEW.md`, and
`.github/workflows/review.yml`. Then change these five things — they are the entire
repo-specific surface:

1. **The gate command.** Everything says `bun run verify`. Point it at whatever your repo's
   equivalent is. If your repo does not have one, build it first — the loop's verification
   step is otherwise unenforceable, and that was this repo's own loop 001.
2. **`REVIEW.md` pass 1.** Rewrite around your domain's invariants. Ours cites `SPEC.md`
   section numbers; yours will cite something else.
3. **`REVIEW.md` pass 2 and `security-reviewer`.** Ours encodes this project's trust
   boundaries — OAuth token handling, TLS, cache file permissions. Replace wholesale with
   yours. **This is the one you must not skip**: a security pass inherited from another
   codebase checks the wrong things and gives false confidence.
4. **`REVIEW.md` pass 3.** Your architecture rules. Ours is "all domain logic in one package,
   surfaces stay thin".
5. **The governing-spec reference.** The skills point at `SPEC.md` as the source of truth.
   Point them at yours, or delete the references if you have none.

`ANTHROPIC_API_KEY` must be set as a repository secret for the CI review jobs. They are gated
on it and skip cleanly without one, so forks are not blocked.

## What actually earned its keep

From two real loops in this repo (see `sdlc/README.md` for the full retrospective):

- **The scope fence in `plan.md`** is the highest-value artifact. Both loops escaped their
  fence, both times for good reasons, and both times the escape was worth seeing. It converts
  "the diff got bigger" from something you notice at review into something you decide.
- **Writing the spec's edge cases before implementing** paid for itself twice, in an unexpected
  way: both loops produced a *blocking finding against their own spec*. The value was not
  that the design was right. It was that the design was specific enough to be proven wrong in
  minutes instead of shipping as ambiguity.
- **`review.md`'s "findings deliberately not fixed" section** is where the honesty lives. It
  is what stops a review from being a rubber stamp, and it is the section most likely to be
  quietly skipped.

## What to watch for

- **`intent.md` can degenerate into a restated title.** If its "what done means" bullets are
  not observable by someone who never reads the diff, the stage did nothing.
- **A fence of broad globs is not a fence.** `packages/**` permits everything.
- **Stage skipping compounds.** Skipping Design to "just write the plan" moves the ambiguity
  into the plan, where it is harder to see.

## A design rule both loops paid for

**A spec's edge-case table must be checked against the code paths that guard those cases, not
only against the intended behavior.**

Loop 002's spec asserted "Opus present, others null → Opus is primary". True as intent, and
impossible in practice: a `No valid usage windows found` guard intercepted the case before
selection ran. The table described the destination without checking the road.

Loop 001 hit the same shape from the other direction: its design named a module-mocking
strategy that Bun's actual behavior did not support, and no amount of re-reading the spec
would have revealed it — only running it did.

**Corollary:** a design decision resting on an assumption about third-party runtime behavior
should be spiked *before* it is specified, not after.
