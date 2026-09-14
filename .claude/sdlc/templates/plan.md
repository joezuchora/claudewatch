# Plan: <short title>

- **ID:** <NNN>-<slug>
- **Stage:** 3 — Build
- **Status:** draft | accepted | implemented
- **Derived from:** [`spec.md`](./spec.md)
- **Branch:** `sdlc/<NNN>-<slug>`

## Approach

Two or three sentences on the shape of the implementation. Enough that a reviewer can
disagree with the direction before any code exists.

## Scope fence

Every file this change is permitted to touch. The `plan-to-diff-auditor` subagent compares
the actual diff against this list, so it must be complete and it must be honest — a file
that turns up in the diff and not here is a finding, whether or not the change was correct.

Globs are allowed where the set is genuinely open-ended (e.g. `packages/*/src/**/*.test.ts`),
but prefer explicit paths.

```
<path>
<path>
```

## Changes

One entry per file. Say what changes and why, not line numbers — those go stale before
the PR is even opened.

### `<path>`
- <what changes, and which spec behavior or acceptance criterion it serves>

## Tests

Every behavior in the spec ships with its check. List them against the spec's acceptance
criteria so the mapping is visible; an unmapped criterion means either a missing test or a
criterion that was never real.

| Spec criterion | Test | File |
|---|---|---|
| <criterion> | <test name> | <path> |

## Verification

The exact commands that prove this works, in order. These are what the Test stage runs.

```
bun run verify
```

## Risks

What could go wrong, and what would catch it. Include the "this looked fine locally and
broke in CI" cases specifically.

---

**Next stage:** Build/Test — run `/sdlc-implement <NNN>-<slug>` to write the diff.
