# Intent: give the tooltip its own bridge, so its tests test something

- **ID:** 025-vscode-bridge-split
- **Stage:** 1 — Plan
- **Status:** accepted
- **Author:** loop 003's residual finding, re-recorded at 008, 009, 010
- **Date:** 2026-08-27

## Problem

`packages/vscode/src/statusbar.test.ts:30` calls `mock.module('./core-bridge.js', ...)`, stubbing
`formatTooltip` to `` `formatted: ${pct}%` ``. Bun applies `mock.module` **process-wide** and
`mock.restore()` does not undo it, so every other test file in that process sees the stub —
including `tooltip.test.ts`, whose subject imports `formatTooltip` from the same module
(`tooltip.ts:3`).

This is the residue of the root cause loop 001 fixed. Loop 001 stopped surface mocks from
reaching `packages/core`; it did not stop two files **inside one package** from sharing one
mocked bridge.

**Verified live today**, not taken from the record. A probe importing `formatTooltip` from
`./core-bridge.js`, run in a copy of the tree outside the repo:

```
probe alone                          → "ClaudeWatch\n\nUsage Windows\nCurrent (5hr): 42% — resets Sat 5:00 PM…"
probe + statusbar.test.ts, one proc   → "formatted: 42%"
```

The consequence is already in the record: loop 002 planned a test for the Opus tooltip row in
`tooltip.test.ts`, **could not write it there**, and moved it to `packages/core/src/format.test.ts`.
That relocation tests the formatter. It does not test `tooltip.ts`'s use of it.

## Who is affected

Nobody's runtime; this is a test-integrity problem. The cost lands on the next person who writes
a `tooltip.test.ts` assertion, believes it exercises the real formatter, and is wrong. Loop 002
hit exactly that and had to reroute. The trap is silent — a stubbed assertion passes.

## Why now

Because the reason this was deferred does not survive checking. Loop 008 recorded:

> Splitting the bridge per consumer would fix it, but that is a **three-module refactor** to
> enable an assertion that was available without it.

Built as a proof of concept in a temp copy before writing this: it is **one new module and one
changed import line**. `tooltip-bridge.ts` (a copy of `core-bridge.ts`), and `tooltip.ts:3`
pointing at it. Result:

```
probe + statusbar.test.ts, after the split → "ClaudeWatch\n\nUsage Windows\nCurrent (5hr): 42%…"
vscode suite after the split               → 49 pass, 0 fail
```

"Three-module refactor" was an estimate carried across four loops (003 → 008 → 009 → 010) that
nobody re-ran. It is the inherited-number failure this repo keeps recording, applied to its own
backlog: the item stayed deferred on a cost that was roughly triple the real one.

The second half of that sentence — "an assertion that was available without it" — is fair and
stays fair. It is the honest limit on this change's value, and the spec must not oversell past
it. See below.

## What "done" means

- [ ] `tooltip.ts` resolves `formatTooltip` through a module no other test file mocks, so
      `tooltip.test.ts` exercises the real formatter.
- [ ] A test proves it: an assertion in `tooltip.test.ts` that **fails against the stub and
      passes against the real formatter**. `toContain('42%')` is not that assertion — the stub's
      output contains `42%` too, which is exactly why the current tests pass either way and
      caught nothing.
- [ ] The whole-suite run and the single-file run of `tooltip.test.ts` agree. Today they do not,
      and nothing reports the disagreement.
- [ ] ~~`statusbar.test.ts` keeps working unchanged; the split must not require touching it.~~
      **Withdrawn at Stage 2.** Written when I believed `tooltip.ts` was the only victim. It is
      not — `extension.ts` imports the same bridge, so there are two. Forbidding a one-line
      change to `statusbar.test.ts`'s mock specifier would have forced the split that fixes one
      of them instead of the split that fixes both. A criterion that rules out the better design
      is a criterion to withdraw, not to satisfy. Replaced by: `statusbar.test.ts` changes by at
      most its mock specifier, and its assertions are untouched.
- [ ] The architecture rule holds: the new module is re-exports only, no domain logic
      (SPEC.md §8.2).

## Explicitly out of scope

- **`extension.ts` has no tests** (loop 001). Adjacent, separate, and larger.
- **Removing `mock.module` from `statusbar.test.ts`.** A plausible alternative fix — let it use
  the real formatter — but it changes what those tests assert, and this loop is about isolation,
  not about rewriting the statusbar suite.
- **The statusline side.** `core-deps.ts` has one consumer and no equivalent collision.
- **Any change to `packages/core`.** The formatter is fine; only the surface's view of it is not.
- **Backfilling the Opus-row test loop 002 relocated.** Once the split lands that test *could*
  move back, but moving it is a separate judgement about where coverage belongs.

## Open questions

1. Does `tooltip-bridge.ts` need the full 22-symbol surface of `core-bridge.ts`, or only
   `formatTooltip`? A narrow module is honest about what the tooltip actually uses; a wide one
   invites the next author to import from whichever bridge they happen to type.
2. Is a third module the right shape at all, or should `core-bridge.ts` be the *tooltip's* and
   `statusbar.ts` get the new one? The mock lives in `statusbar.test.ts`, so naming the mocked
   module `statusbar-bridge.ts` would put the oddity where the oddity is.
3. What stops a future `tooltip.test.ts` from mocking `./tooltip-bridge.js` and recreating the
   problem for a third file? Nothing structural — worth stating rather than pretending the split
   is a permanent fix.
