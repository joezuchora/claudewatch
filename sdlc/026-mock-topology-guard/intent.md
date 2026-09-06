# Intent: a tripwire for the mock that stubs code under test

- **ID:** 026-mock-topology-guard
- **Stage:** 1 — Plan
- **Status:** accepted
- **Author:** deferred out of loop 025's Stage 2 review
- **Date:** 2026-08-27

## Problem

Bun applies `mock.module` process-wide and `mock.restore()` does not undo it. So when a test
mocks a module that **more than one source file imports**, it stubs the others' dependency too —
silently, in a green suite.

This is not hypothetical. It has happened twice in this repo:

- **Loop 001:** a surface test mocked `@claudewatch/core` and broke 128 of 341 tests in
  `packages/core` itself. Hidden for a while because CI ran each package in its own process.
- **Loop 025:** `statusbar.test.ts` mocked `./core-bridge.js`, which three files imported. For
  four loops `tooltip.test.ts` asserted against `formatted: 42%` — a stub — while reading as a
  passing test suite. Loop 002 hit the wall, could not write a planned test there, and relocated
  it. Loops 003, 008, 009 and 010 each re-recorded the finding without fixing it.

Both were found by a person noticing, years of loop-iterations apart. Nothing in the gate looks
for the shape.

## The property, and its status today

> A module that any test mocks should have **at most one** non-test importer in its package.

Measured now, not assumed:

| Module | Mocked by | Non-test importers | Holds? |
|---|---|---|---|
| `./core-deps.js` | `main.test.ts:34` | 1 (`main.ts`) | ✅ |
| `./statusbar-bridge.js` | `statusbar.test.ts:28` | 1 (`statusbar.ts`) | ✅ |
| `./core-bridge.js` | *nothing* | 2 (`extension.ts`, `tooltip.ts`) | ✅ vacuously — unmocked |
| `vscode` | `statusbar.test.ts:85`, `tooltip.test.ts:19` | 4 | ambient host module; must be mocked |

**The property holds everywhere.** Loop 025 was the last violation and closed it. So this loop
builds a **tripwire for a recurrence**, not a fix for a live defect — and that must be said
plainly, because a guard whose subject is already clean is exactly the kind that can ship
vacuous and never be noticed.

## An inherited claim, tested and rejected

Loop 025's Stage 2 review argued the two `vscode` stubs are a live hazard:

> "The custom-threshold tests at `statusbar.test.ts:224-246` pass only because `statusbar.test.ts`
> sorts before `tooltip.test.ts`. A new `panel.test.ts` mocking `vscode` would load first and
> silently break them."

Tested three ways in a copy of the tree outside the repo:

```
statusbar.test.ts then tooltip.test.ts   → 39 pass, 0 fail
tooltip.test.ts then statusbar.test.ts   → 39 pass, 0 fail   (reversed: no change)
a third vscode-mocking file, sorted FIRST → 53 pass, 0 fail  (the reviewer's exact scenario)
```

**The claim is false as stated.** Load order does not decide those tests, and a divergent third
stub does not break them. Recording it because it would otherwise have justified scope in this
loop — a reviewer's finding is still a claim nobody checked, and this repo has now been wrong in
both directions.

What survives from that review is the *design* argument, which stands on its own: scoping the
rule to `'./…'` specifiers would exempt `mock.module('@claudewatch/core')` — precisely loop 001's
128-test failure — so the scope must be an explicit ambient-host allowlist, not a spelling test.

## Who is affected

The next person to add a `mock.module` — or to add a second importer to a module that is already
mocked. Neither action looks dangerous, and the feedback is a green suite testing a stub. Loop
025 cost four loops of re-recording and one relocated test before anyone ran it.

## Why now

The property is clean for the first time, so a guard added now starts from green and any red it
ever shows is a real regression. Adding it while `core-bridge.js` was still violating would have
meant either shipping it red or writing an exemption on day one.

## What "done" means

- [ ] A test fails when a module that is mocked gains a second non-test importer, and when a
      second importer's module gains a mock. Both directions, because both are how it recurs.
- [ ] **The test cannot pass by finding nothing.** This is the criterion that matters most: it is
      a static scan, and a reformatted `mock.module(`, a double-quoted specifier, or a hoisted
      constant would empty its input and turn it permanently green. It must assert on the exact
      set of mock targets it discovered, so a target *disappearing* is as loud as one misbehaving.
- [ ] `mock.module('@claudewatch/core')` — loop 001's actual failure — is caught, not exempted by
      a rule that only looks at `'./…'` specifiers.
- [ ] The scan ignores `import type` (erased; cannot be contaminated) and counts **distinct
      files**, not import statements. `extension.ts` imports from `core-bridge.js` on three lines
      and is one importer.
- [ ] Every claim above is demonstrated by a mutation that is **run**, with its result predicted
      first, and the faulty-vs-real ambiguity resolved by inspecting what the mutation did.

## Explicitly out of scope

- **Transitive contamination.** The real loop-025 path was `statusbar.ts → tooltip.ts →
  core-bridge.ts`; a direct-importer count would not have seen it. Computing the transitive
  importer set is a materially bigger change, and a direct-import tripwire that says so honestly
  is worth more than a transitive one that arrives two loops later. The spec must state this
  limit in the test's own docstring, so nobody reads "has exactly one consumer" as the
  transitive claim.
- **Unifying the two `vscode` stubs.** A real duplication, not a demonstrated hazard (above).
- **`commands.ts`'s `await import('@claudewatch/core')` bypass** — a standing finding from loop
  025. Whether the scan should match dynamic imports at all is a spec question; fixing
  `commands.ts` is not this loop's job.
- **`extension.ts` has no tests** (loop 001). Adjacent and larger.

## Open questions

1. Where does the check live — a `*.test.ts` inside a package, or a `scripts/` check the gate
   runs? It spans two packages, which no existing test does.
2. Should it match dynamic `await import('./X.js')`? `commands.ts` is the only instance and it
   imports the package, not a bridge — so matching it changes nothing today, which is an argument
   both ways.
3. Is regex over source text good enough, or does this need real parsing? Regex is what makes
   the vacuity risk sharp; the exact-set assertion is the mitigation, but it is a mitigation and
   not a fix.
