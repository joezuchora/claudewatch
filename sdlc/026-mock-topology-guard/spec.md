# Spec: a tripwire for the mock that stubs code under test

- **ID:** 026-mock-topology-guard
- **Stage:** 2 — Design
- **Status:** accepted (revision 2, after the Stage 2 review)
- **Reads:** `intent.md`
- **Date:** 2026-08-27

## What prototyping changed

A working scanner was built and run against the real tree before this document was written. Two
things came out of it that the intent did not have.

### 1. There is a second failure mode, with its own recorded history

`sdlc/001-quality-gate/review.md:33`, finding 2, verbatim:

> After both surfaces were routed through a local module, 17 tests still failed. Both modules were
> named `deps.ts`, so both tests mocked the identical specifier `'./deps.js'`. **Bun keys module
> mocks by specifier string, so the two collided** — each package passed when paired with core
> alone, and only the three-way run failed. Fixed by giving them distinct names.

That is nastier than loop 025's mode: it is invisible to per-package testing and appears only in
the three-way run. The two bridge modules in this repo are named `core-deps.ts` and
`core-bridge.ts` **because of it**.

### 2. The mechanism, measured in three cases — and a reviewer result I could not reproduce

Revision 1 ran one experiment and drew a design rule from it. The Stage 2 reviewer ran the
variant I had not, reported a different mechanism, and that mechanism would have changed the
design. I then ran **their** experiment three times. Full results, all on bun 1.3.11:

| # | Setup | Result |
|---|---|---|
| 1 | Two dirs, each its own `dep.ts`; each test mocks `'./dep.js'` | `A: STUB-A`, `B: STUB-B` — **no leak** |
| 2 | Same, only A mocks | `A: STUB-A`, `B: REAL-B` — **no leak** |
| 3 | **One** `a/dep.ts`; `a/use.ts` imports `'./dep.js'`, `b/use.ts` imports `'../a/dep.js'`; A mocks `'./dep.js'` | `A: STUB-A`, **`B: REAL-SHARED`** — **no leak** |
| 4 | One dir: `dep.ts`, `consumer.ts` importing `'./dep.js'`, `mocker.test.ts` mocking `'./dep.js'`, `victim.test.ts` importing `consumer.js` | **`VICTIM sees: STUB`** — **LEAKS**. Victim alone: `REAL` |

**Case 3 is where the reviewer and I disagree.** They report `B` seeing `STUB-A` and conclude bun
keys mocks by **resolved absolute path**. I ran it in all three load orders — mocker first, victim
first, and bun's own directory ordering — and got `REAL-SHARED` every time. I cannot reproduce
their result and I am not going to adopt a mechanism I could not observe.

Case 3 and case 1 together rule out both simple models: pure path keying is contradicted by 3
(same file, no leak), and pure string keying is contradicted by 1 (same string, no leak). What the
four cases *do* support, without theorising about bun's internals:

> A mock placed on specifier `S` from directory `D` reaches importers that **themselves write `S`
> and resolve it from `D`**. Case 4 is that shape and it is loop 025's shape, reproduced in
> fourteen lines.

**The rule follows the observations, not a model of bun.** Count importers that are in the same
directory as the mocking test *and* write the same specifier. That excludes cases 1-3 (no leak,
must stay green) and includes case 4 (leaks, must go red).

This disagreement is recorded rather than resolved. If the reviewer's result is reproducible on
some configuration, case 3 becomes a false negative for this rule — a hole, not a wrong answer.
A7/A7b are the criteria that pin it: both importers sit in the mocking test's directory and differ
only in the specifier string, so A7's green isolates the disputed property rather than being
explained by directory scoping. (Revision 2 of this spec promised an "A9b" here that was never
written — the plan-to-diff audit found the spec asserting coverage it did not have, in the loop
about tests that claim more than they check.)

### 3. Revision 1 asserted the guard would NOT have caught loop 025. That was false.

Revision 1's A8 required the test's docstring to say the rule "would not have caught" loop 025,
citing the transitive path `statusbar.ts → tooltip.ts → core-bridge.ts`. Checked at `64c087f`, the
commit before loop 025 landed, `./core-bridge.js` had **three** non-test importers:

```
packages/vscode/src/extension.ts
packages/vscode/src/statusbar.ts
packages/vscode/src/tooltip.ts
```

Three is greater than one. **The rule would have gone red on loop 025.** The contamination *path*
was transitive; the *topology* was not, and the rule counts topology. So the guard is two-for-two
on this repo's history — loop 001 via the bare-specifier path, loop 025 via a direct count of 3 —
and revision 1 mandated a docstring teaching the opposite as fact.

That correction came from the reviewer, and it is the strongest argument for building this at all;
revision 1 undersold its own case by inheriting the intent's pessimism.

## Answers to the intent's open questions

**Q1 — where does the check live?** `scripts/mock-topology.test.ts`.

- It must see both packages, and no existing test in `packages/*/src` reaches outside its own
  package. A `scripts/` test is the only place with that scope by convention rather than by
  exception.
- `scripts/` already holds three suites (`perf.test.ts`, `junit.test.ts`, `env.test.ts`) that
  `bun test` picks up, so it joins the gate with no wiring.
- `scripts/` has been inside `bun run typecheck` since loop 018.

**Q2 — should it match dynamic `await import('./X.js')`?** **Yes**, and the reason is not
`commands.ts`. `commands.ts` imports the *package* (`@claudewatch/core`), so matching dynamic
imports changes nothing about it today. The reason is that a dynamic import is a real consumer and
invisible to a static-only scan, so omitting it builds a guard with a documented hole on day one.
Cost is one alternation in the regex.

**Q3 — regex or real parsing?** Regex, with the vacuity risk treated as the primary design
constraint rather than a caveat. TypeScript's compiler API would be exact, but it is a large
dependency for a repo whose stated identity is zero runtime dependencies, and the failure it
prevents (a specifier written as a computed expression) is not a shape anyone writes by accident.
The mitigation is A1's exact-set assertion, and the spec says plainly that it is a mitigation.

## Structure

Two files, because a scanner verified only by hand-editing the tree once is untested code from the
commit it lands in — the exact decay this loop exists to prevent, one level up.

- **`scripts/mock-topology.ts`** exports `analyze(files: ReadonlyArray<{path: string; text: string}>): Violation[]`
  — **pure**, no filesystem, no globs. Every rule lives here.
- **`scripts/mock-topology.test.ts`** does two things: runs `analyze` over the **real tree** and
  asserts no violations plus the exact assertions below; and runs table-driven cases over
  **synthetic in-memory file sets** for every rule.

The synthetic half is what makes A2-A6 and A9 standing tests rather than one-shot mutations, and
it means no criterion requires writing a fixture into the repo — which is how a previous
reviewer's probe file got swept up by `git add -A` and turned CI red.

## Behaviour

The test collects every `*.ts` under `packages/*/src` and `scripts/` **recursively**, skipping
`node_modules`, `dist`, and `typefixtures`, and hands them to `analyze`. Recursive is stated
because `packages/metrics/src` and `scripts/` are the growth areas; a one-level glob would
silently stop seeing new subdirectories.

**Step 1 — find the mocks.** `/mock\.module\(\s*['"]([^'"]+)['"]/g` over every `*.test.ts`,
tolerating whitespace and newlines after the paren, and either quote style. Records
`(specifier, mockingTestFile)`.

**Step 2 — classify.** A specifier beginning `./` or `../` is **local** and resolves against the
mocking test's directory. Anything else is a **bare** specifier.

**Step 3 — the rules.** Two, not one.

> **R1 (topology).** Every mocked module must have **at most one** non-test importer, counted as
> distinct files, among files that are in the mocking test's directory *and* write the same
> specifier — except modules on the ambient-host allowlist. **Bare specifiers are counted across
> the entire scanned tree**, because a bare mock is process-global; revision 1 left that scope
> undefined, which would have let `mock.module('@claudewatch/core')` pass green in a directory
> with one importer while poisoning all 341 core tests.
>
> **R2 (duplicate specifier).** No two test files may mock the same specifier **string** unless it
> is allowlisted.

R2 is the reviewer's suggestion and it is free: the only duplicated string today is `vscode`,
already allowlisted, so the guard still starts green. It earns its place by making the guard
**independent of which keying model is right** — it would have caught loop 001's `'./deps.js'`
under string keying, path keying, or the directory-plus-specifier behaviour measured above. Given
that this spec contains an unresolved disagreement about that very mechanism, a rule that does not
depend on resolving it is worth more than one that does.

The allowlist is exactly `['vscode']`, and it is an allowlist rather than a shape test on purpose.
Scoping by "starts with `./`" would exempt every bare specifier, including
`mock.module('@claudewatch/core')` — the mock loop 001 exists to prevent.

**Step 4 — counting importers.** Distinct files. The matched and excluded forms are enumerated,
because revision 1 said only "`import type` stripped first" and that is wrong for shapes this repo
already uses:

| Form | Counted? |
|---|---|
| `import { x } from '<spec>'` | yes |
| `import '<spec>'` (side-effect only) | **yes** — a real consumer; revision 1 missed it entirely |
| `await import('<spec>')` | yes |
| `export { x } from '<spec>'` / `export * from '<spec>'` | **yes** — loop 001 finding 1 established a static re-export does *not* isolate a mock |
| `import type { X } from '<spec>'` | no — erased |
| `export type { X } from '<spec>'` | no — erased |
| `import { a, type B } from '<spec>'` | **yes** — mixed; only `a` matters |
| `import { type A, type B } from '<spec>'` | **no** — every binding type-qualified |

That last pair is the one revision 1 would have got wrong: `cli-detect.ts:13`, `verify.ts:26` and
`smoke.test.ts:17` all use inline `type` modifiers today, so a naive line-strip both over- and
under-counts.

**Step 5 — the anti-vacuity assertions.** Revision 1 had one, on the specifier set, and it covered
half the risk. There are **two** regexes: discovery and importer-counting. Breaking the second
makes every count 0, zero satisfies at-most-one, and the specifier-set assertion still passes. The
guard would be permanently green with the property false — which is the precise shape this loop is
about, shipped in the document about it.

So both are asserted exactly.

```ts
// (a) discovery: PAIRS, not specifiers. Revision 1 asserted specifiers only, so moving a mock to
// a different test file — or adding a third `mock.module('vscode')` — left the set unchanged.
expect(discovered.toSorted()).toEqual([
  ['packages/statusline/src/main.test.ts',  './core-deps.js'],
  ['packages/vscode/src/statusbar.test.ts', './statusbar-bridge.js'],
  ['packages/vscode/src/statusbar.test.ts', 'vscode'],
  ['packages/vscode/src/tooltip.test.ts',   'vscode'],
]);

// (b) counting: the importer SETS, so a zero fails loudly instead of passing.
expect(importersBySpecifier).toEqual({
  './core-deps.js':        ['packages/statusline/src/main.ts'],
  './statusbar-bridge.js': ['packages/vscode/src/statusbar.ts'],
  'vscode':                [/* the four, listed explicitly */],
});
```

Both sets are measured, not assumed: a repo-wide scan found exactly four `mock.module` call sites,
and every other textual occurrence is prose in a comment with no following `(`+quote. Note (a) is
a list of pairs and needs no dedupe; revision 1's version asserted a deduplicated specifier list
while calling it a prototype result and never mentioning the dedupe step — a half-stated
measurement, in this loop's own spec.

## Edge cases

1. **The test file must not scan itself into a false positive.** It will contain the literal
   `mock.module('./core-deps.js')` inside its own expected-set assertion. It is not a `*.test.ts`
   the scan should treat as a mocker of anything — it must exclude its own path by name.
2. **A mocked module with *zero* non-test importers** passes the at-most-one rule and is almost
   certainly a mistake (nothing under test uses it). Out of scope, but the failure message should
   print the count so a zero is visible rather than silently fine.
3. **`vscode` is allowlisted, not exonerated.** Two hand-maintained stubs exist and diverge. The
   intent records that this is *not* a demonstrated hazard — tested three ways, including a third
   mocking file loaded first, all 53 pass — so the allowlist entry is a real exemption, not a
   deferred bug.
4. **Test-to-test imports.** A `*.test.ts` importing another `*.test.ts` is not counted; only
   non-test files are importers. No instance exists today.

## Acceptance criteria

Revision 1 had eight; the review found three passed with the change deleted and two more passed
while their named property was false. Every criterion below runs against **synthetic file sets**
through `analyze`, so all of them are standing tests, and each green-expected case is paired with
a red control differing by one token.

- **A1 — both exact assertions, on the real tree.** Pairs (a) and importer sets (b) above.
  Mutation: break the discovery regex → (a) fails. Break the counting regex → (b) fails.
  Revision 1's A1 survived the second.
- **A2 — a second importer fails R1.** Synthetic: a mocked module with two same-directory
  importers → one violation naming both.
- **A2b — control.** The same set with one importer → no violation. Isolates the count.
- **A3 — a bare specifier is caught tree-wide.** Synthetic: `mock.module('@claudewatch/core')`
  plus importers in two packages → violation.
- **A3b — control.** A bare mock with exactly **one** importer tree-wide → **no** violation.
  Proves A3's red came from the count, not from "bare and not allowlisted". Revision 1 could have
  passed A3 by flagging every bare specifier unconditionally, never exercising the counting path.
- **A4 — type-only imports do not count**, in all three forms (`import type`, `export type`,
  all-bindings-inline-`type`) → no violation.
- **A4b — control.** Byte-identical files with the `type` keyword removed → violation. Isolates
  the keyword rather than "the file was ignored".
- **A5 — dynamic `import()` counts**, relative and **bare** (revision 1 tested only relative).
- **A6 — side-effect `import '<spec>'` counts**, and **A6b — `export * from '<spec>'` counts.**
  Neither was in revision 1.
- **A7 — measured case 3 stays green.** Two importers of the same physical file via *different*
  specifier strings → no violation, matching the measurement. If the reviewer's contradicting
  result is ever reproduced, this is the criterion that will be wrong, and it is flagged as the
  known hole rather than presented as settled.
- **A8 — measured case 1 stays green.** Same specifier, different directories, different files.
- **A9 — R1's second direction.** Adding `mock.module('./core-bridge.js')` to a vscode test, where
  that module already has two non-test importers, must go red naming `extension.ts` and
  `tooltip.ts`. **This is the literal loop-025 recurrence and revision 1 had no criterion for it**
  — the intent demanded both directions and only one was specified.
- **A10 — R2 fires.** Two test files mocking the same non-allowlisted specifier string → violation,
  regardless of importer counts.
- **A11 — `bun run verify` exits 0**, lint at the standing 12.
- **A12 — the docstring states the real limit.** Not revision 1's false claim about loop 025
  (measured: the rule would have gone red, 3 importers). The honest limit, measured as case 4:
  *a module with exactly one non-test importer still contaminates every test that reaches it
  through that importer.* Out of scope, and named so nobody reads "exactly one consumer" as safety.
- **A13 — scan scope is recursive**, and a `mock.module` outside `packages/*/src` + `scripts/` is a
  documented hole, stated in the docstring rather than left implicit.

## Risks

- **The guard starts green and may never fire.** That is the nature of a tripwire, and it is why A1
  is the first-class criterion: an exact-set assertion fails on regex rot, which is the only way a
  never-firing guard and a broken one look different.
- **A6 asserts a bun behaviour, not a property of this repo.** If a future bun reverts to
  specifier-string keying, A6 becomes wrong and the collision mode returns. The test's docstring
  must name the version measured (1.3.11) so the next person knows what to re-run rather than
  inheriting it.
- **Cost versus value is genuinely arguable.** The property already holds; this buys regression
  protection for a mistake made twice in twenty-six loops. Recorded so the decision is visible: it
  is being built because both instances cost multiple loops to notice, not because either is live.
