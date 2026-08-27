# Spec: a tripwire for the mock that stubs code under test

- **ID:** 026-mock-topology-guard
- **Stage:** 2 — Design
- **Status:** draft
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

### 2. That mechanism does not reproduce on bun 1.3.11

Built the minimal case — two directories, each with its own `dep.ts`, each test mocking
`'./dep.js'`:

```
both mock './dep.js':   A sees: STUB-A     B sees: STUB-B      2 pass
only A mocks:           A sees: STUB-A     B sees: REAL-B      2 pass
```

**No collision.** Relative specifiers resolve per-importer on bun 1.3.11. Either the stated
mechanism was the wrong explanation for loop 001's 17 failures, or bun's behaviour changed in the
intervening versions — this experiment cannot distinguish those, and does not try to. What it does
settle is the design question:

> **The scan must resolve relative specifiers against the mocking test's own directory**, and count
> importers only there.

The prototype's first cut matched `from './statusbar-bridge.js'` as a bare string across all
packages. On the evidence above that is **wrong** — it would report a violation for two
same-named modules in different packages that never interact. I had reasoned the opposite one step
earlier ("the string matching mirrors how bun resolves") and the experiment reversed it. Recorded
because this is the loop about claims made by reading, and a foundational claim two modules are
named after did not survive being run.

**Mode 2 is therefore out of scope**: it is not reproducible on the toolchain in use. Recorded in
`review.md` as a finding against `sdlc/001`'s stated mechanism, not carried as a requirement here.

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

## Behaviour

`scripts/mock-topology.test.ts` scans every `*.ts` under `packages/*/src` and `scripts/`, skipping
`node_modules`, `dist`, and `typefixtures`.

**Step 1 — find the mocks.** `/mock\.module\(\s*['"]([^'"]+)['"]/g` over every `*.test.ts`,
tolerating whitespace and newlines after the paren, and either quote style. Records
`(specifier, mockingTestFile)`.

**Step 2 — classify.** A specifier beginning `./` or `../` is **local** and resolves against the
mocking test's directory. Anything else is a **bare** specifier.

**Step 3 — the rule.**

> Every mocked module must have **at most one** non-test importer, counted as distinct files, in
> the directory the specifier resolves against — except modules on the **ambient-host allowlist**.

The allowlist is exactly `['vscode']`, and it is an allowlist rather than a shape test on purpose.
Scoping by "starts with `./`" would exempt every bare specifier, including
`mock.module('@claudewatch/core')` — the mock loop 001 exists to prevent, and the one that broke
128 tests. Under this rule that call is caught: `@claudewatch/core` is bare, not allowlisted, and
has many importers.

**Step 4 — counting importers.** Distinct files, `import type` stripped first (type imports are
erased and cannot be contaminated), matching both `from '<spec>'` and `import('<spec>')`. A file
importing from the same module on three separate lines — as `extension.ts` does — is one importer.

**Step 5 — the anti-vacuity assertion.** The discovered specifier set is asserted **exactly**:

```ts
expect(discovered.toSorted()).toEqual(['./core-deps.js', './statusbar-bridge.js', 'vscode']);
```

Measured, not assumed — that is what the prototype found. This is the criterion that matters most,
because everything above is a text scan: a reformatted `mock.module(`, a hoisted specifier, or a
renamed file empties the input and turns an at-most-one check permanently green. An exact-set
assertion fails loudly both when a target *vanishes* and when one is *added* without review.

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

- **A1 — the exact-set assertion exists and is exact.** Not `length >= 2`, not "contains". Mutation:
  break the regex so it matches nothing; A1 must fail. This is the criterion the whole design turns
  on, so it is mutation-tested first.
- **A2 — a second importer on a mocked module fails the test.** Mutation: add a source file
  importing `./statusbar-bridge.js`. Must go red, naming the module and both importers. Verified in
  the prototype (`2 -> statusbar.ts, panel.ts`).
- **A3 — `mock.module('@claudewatch/core')` is caught, not exempted.** Mutation: add that call to a
  test file. Must go red. This is the criterion that distinguishes this design from the one the
  loop-025 review rejected.
- **A4 — `import type` does not count.** Mutation: add a source file whose only reference to a
  mocked module is `import type`. Must stay green. **Predicted result stated before running:
  green.** If it goes red the type-stripping is broken.
- **A5 — a dynamic `import('./X.js')` counts.** Mutation: add a source file whose only reference is
  `await import('./statusbar-bridge.js')`. Must go red.
- **A6 — same-named modules in different packages do NOT collide.** Mutation: add
  `packages/statusline/src/statusbar-bridge.ts` plus an importer. Must stay **green**, because the
  specifier resolves per-directory and bun does not conflate them (measured above). The prototype's
  string-matching version went **red** here, which is the false positive this criterion exists to
  prevent.
- **A7 — `bun run verify` exits 0**, lint at the standing 12.
- **A8 — the test's docstring states the limit.** It counts **direct** importers only. The real
  loop-025 path was `statusbar.ts → tooltip.ts → core-bridge.ts`, which this would not have caught.
  Anyone reading "has exactly one consumer" must not take it as the transitive claim.

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
