# Contributing to ClaudeWatch

ClaudeWatch develops through an AI-native SDLC: six stages, each ending by committing an
artifact that the next stage reads. The artifacts are Markdown because a human and an agent
must both be able to act on the same file.

```
Plan      →  Design   →  Build        →  Test  →  Deploy      →  Maintain
intent.md →  spec.md  →  plan.md      →  diff  →  review.md   →  incident.md
                          + tests         + PR
```

Everything for one change lives in `sdlc/<NNN>-<slug>/`. The chain is the record: a reviewer
should be able to read it top to bottom and see how a vague request became a specific diff.

## Before you start

```bash
bun install
bun run verify     # typecheck, lint, test, build
```

If `verify` does not pass on a clean checkout, that is a bug — please open an issue.

## The loop

Each stage has a skill that does the work and hands off to the next. Run them in order.

| Stage | Skill | Produces |
|---|---|---|
| 1. Plan | `/sdlc-intent` | `intent.md` — the problem and what "done" means |
| 2. Design | `/sdlc-spec` | `spec.md` — the behavioral contract and acceptance criteria |
| 3. Build | `/sdlc-plan` | `plan.md` — file-by-file changes and the scope fence |
| 3/4. Build & Test | `/sdlc-implement` | the diff, with tests |
| 5. Deploy | `/sdlc-review` | `review.md` — findings from each review pass, and the PR |
| 6. Maintain | `/sdlc-incident` | `incident.md` — and a new `intent.md`, closing the loop |

You do not need an agent to follow this. The templates in `.claude/sdlc/templates/` are
plain Markdown; fill them in by hand if you prefer. The skills are a convenience, not a
requirement.

### Working without the loop

A typo fix, a broken link, a dependency bump — commit it directly with a clear message. The
loop is for changes to behavior. Use judgment; if you are unsure whether a change is
behavioral, it probably is.

## What the stages are actually for

The three that people skip, and why they matter:

- **`intent.md` before `spec.md`.** Writing the problem down before the solution is what
  stops a design from quietly answering a different question than the one asked. Its
  outcomes must be observable by someone who never reads the diff.
- **The scope fence in `plan.md`.** Every file the change is allowed to touch, listed up
  front. CI audits the real diff against it. An excursion is not automatically wrong, but
  it has to be recorded and explained — that is what keeps a small change from growing a
  refactor nobody agreed to.
- **`review.md`, including what you did *not* fix.** A finding you decided to accept is
  useful information. A finding that silently vanished is not.

## Review

Every change is reviewed against [`REVIEW.md`](./REVIEW.md), in three passes: bugs and
logical errors, security and vulnerabilities, and compliance. All three run on every change.

`SPEC.md` is the source of truth for the domain. If your change contradicts it, say so
explicitly in your `spec.md` — an amendment is a decision someone must consciously accept,
not a side effect of an implementation.

CI runs the same passes on your PR, plus the plan-to-diff audit. Those jobs need an
`ANTHROPIC_API_KEY` secret and skip cleanly without one, so forks are not blocked by them.

## Code rules

The short version — full detail is in `CLAUDE.md` and each package's own `CLAUDE.md`:

- Strict TypeScript, ES modules, no `any`
- **All domain logic in `packages/core`.** `packages/statusline` and `packages/vscode` are
  thin rendering layers.
- Timestamps internal as UTC ISO strings
- No access token in logs, cache files, debug output, or process arguments
- Tests colocated as `*.test.ts`, HTTP always mocked, isolated between files
- Every behavior ships with its check, in the same commit

## Commits and PRs

- Conventional commits: `feat:`, `fix:`, `ci:`, `docs:`, `chore:`
- Artifact commits use `sdlc(<NNN>): <stage> — <title>` and land separately from the code,
  so a reviewer can see the intent as it stood before the design rationalized it
- Branch per change: `sdlc/<NNN>-<slug>`
- Never commit directly to `main` — a hook will stop you
- Open PRs as drafts; link the artifact chain in the body

## Reporting bugs

Open an issue. If it describes something that shipped broken, it becomes an `incident.md` at
Stage 6 and re-enters the loop as a new intent — so the more precisely you can describe what
you saw, and what you expected, the faster it moves.

Please do not report security issues in a public issue — see [`SECURITY.md`](./SECURITY.md).
