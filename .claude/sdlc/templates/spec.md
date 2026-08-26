# Spec: <short title>

- **ID:** <NNN>-<slug>
- **Stage:** 2 — Design
- **Status:** draft | reviewed | accepted
- **Derived from:** [`intent.md`](./intent.md)

## Summary

One paragraph: what the system will do differently once this ships.

## Behavior

The contract, precisely. Inputs, outputs, states, and the rules connecting them.
Where the repo already has a governing spec (`SPEC.md`), cite the section rather than
restating it — and call out explicitly if this change *amends* that spec, because that
is a decision someone must consciously accept.

## Data and types

New or changed types, fields, and their optionality. State what happens when an optional
field is absent — the project rule is that missing optional fields are **omitted, not
guessed**.

## Edge cases

Enumerate them. Each one becomes a test in the Build stage, so an edge case with no
testable consequence is either not an edge case or the spec is underspecified.

| Case | Expected behavior |
|---|---|
| <case> | <behavior> |

## Backward compatibility

What existing behavior must not change. Name the specific users, files, or cached data
that would break if it did. If this change *is* breaking, say so and justify it here.

## Acceptance criteria

Each must be mechanically checkable — a test, a command's exit code, a visible output.
"Works correctly" is not an acceptance criterion.

- [ ] <criterion> — verified by <how>
- [ ] <criterion> — verified by <how>

## Rejected alternatives

What else was considered and why it lost. Recording this is what stops the same debate
reopening in three months.

---

**Next stage:** Build — run `/sdlc-plan <NNN>-<slug>` to turn this into `plan.md`.
