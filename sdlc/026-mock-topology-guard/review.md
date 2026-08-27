# Review: a tripwire for the mock that stubs code under test

- **ID:** 026-mock-topology-guard
- **Stage:** 5 — Deploy
- **Range reviewed:** `9291d2d..73d68a6`, plus the follow-up commit these findings produced
- **Date:** 2026-08-27

## Verdict

Two reviewers at Stage 2 and Stage 5, plus the loop-025 review that spawned this one. The Stage 2
pass returned five blocking findings that rewrote the design; the Stage 5 security pass returned
none blocking and one real defect; the plan-to-diff audit — which reported after the first draft of
this file and is folded in below — returned **two blocking findings, both of them uncovered code
inside the guard built to prevent uncovered code.**

## Pass 1 — bugs and logical errors

**The security pass found a live one: the directory walk followed symlinks (fixed).**
`collect` used `statSync`, which resolves symlinks. Reproduced in a temp tree, both halves:

```
src/leak.ts -> /tmp/…/secret.json      → read verbatim: "SECRET-CONTENT-SHOULD-NOT-BE-READ"
src/sub/loop -> ../../src              → recursed to depth 60 before I stopped it
```

So a committed symlink `packages/core/src/x.ts -> ~/.claude/.credentials.json` would pull the
credential file into the test process on every `bun run verify`, and a directory symlink would
hang or OOM the gate. It needs repo write access, and the content cannot reach output (see Pass 2),
so it is exposure-in-memory plus a denial of service rather than disclosure — but it is the only
place this change can reach a credential at all.

Fixed with `lstatSync` and an outright skip. The repo has zero tracked symlinks, so it costs
nothing. Mutation-verified: removing the skip line fails the new test.

**And fixing it exposed a second defect, in my own code.** After switching the import to
`lstatSync`, `realTree` still called `statSync` — and its `catch { /* no src */ }` **silently
swallowed the resulting ReferenceError**, so the walk collected zero packages and the real-tree
assertions failed with an empty set instead of an error naming the cause. I spent three steps
looking at the regex before finding it.

That catch-all was mine, added in the same commit. Replaced with `existsSync + lstatSync`, and the
reason is in the source: *a catch that hides a programming error is worse than no catch.* The
episode is also a point in the guard's favour — the exact-set assertions caught a silent
collection failure that an `at-most-one` check alone would have passed, since zero importers
satisfies at most one. That is the failure mode A1(b) was added for, arriving unprompted.

**`MOCK_CALL` was exported with the `g` flag (fixed, advisory).** A global regex carries
`lastIndex` between calls, so a future `MOCK_CALL.test(x)` consumer would silently skip matches.
`findMocks` was already building its own global copy, so nothing was broken today.

## Pass 2 — security (SPEC.md §12, §17)

No blocking findings. This is test tooling: the two new files contain no `process.env`, no
`homedir`, no `fetch`, no `exec`/`spawn`, no `JSON.parse`, and no write syscall. The entire
trust-boundary surface was the directory walk above.

Cleared after active checking, not assumed:

- **Content exposure.** Every assertion compares `Violation` objects (rule, specifier, detail,
  paths) or arrays of paths and specifiers. **No assertion compares file text**, so a failing
  real-tree assertion prints a bounded structure, never source bodies — which is why the
  `sk-ant-oat01-*-NOT-REAL` fixtures in three core test files are read into memory but cannot
  reach CI logs.
- **ReDoS and pattern injection.** The escape set covers every metacharacter special outside a
  character class; a specifier of `(a+)+$` is matched literally rather than compiled. Timings
  stayed linear on pathological inputs (200 KB of leading whitespace: 0.38 ms; 50 000 brace
  bindings: 14.7 ms). Whole-repo `analyze`: 3.6 ms over 73 files.
- **Shipped artifacts.** Build entrypoints are explicit per package, nothing outside `scripts/`
  imports these files, and `vsce package` cannot reach `scripts/`. Neither file can enter any
  dist.
- **The gate and the spool.** The junit report still lands in a `0700` mkdtemp outside the repo and
  is deleted in `finally`; the payload gains nothing; every new test and describe name was checked
  against `scrubPaths` and none is path-shaped. Telemetry still opt-in and off by default.

Recorded, not fixed: a broken symlink or unreadable file used to throw an ENOENT carrying an
**absolute path** into CI logs. The `try { … } catch { continue; }` per entry closes that too.

## Pass 1b — the plan-to-diff audit

The fence was clean: three files added, none existing touched, no globs. Both blocking findings
were about the guard failing its own standard.

**B1 — a branch of `lineImportsValue` had zero coverage (fixed).** The auditor replaced

```ts
return /^\s*import\s+[A-Za-z_$*]/.test(line);   // default/namespace alongside all-type braces
```

with `return false` and **all 23 tests stayed green**. I reproduced it: 24 pass, 0 fail. The branch
was *correct* — `import Def, { type A } from 'x'` does import `Def` at runtime — but
correct-and-untested is exactly the state this loop exists to prevent, sitting inside the analyzer
built to prevent it. Now covered, and the mutation fails.

**B2 — a wrapped `import type` was counted as a value importer (fixed).** `lineImportsValue` works
per line, and in

```ts
import type {
  A,
} from './dep.js';
```

the line carrying the specifier is `} from './dep.js';` — no brace group, no leading `import type`,
so both guards miss it. Measured: `analyze` returned a violation naming the type-only file. That is
a straight deviation from the spec's own Step 4 table, and it is live-shaped — `main.ts:31` and
`extension.ts:20` are wrapped-import tails today (value imports, so right by luck).

Fixed with `normalizeForScan`, which also closes two smaller false positives the auditor found: a
commented-out import counted as real, and so did prose. **This module's own docstring came within
one word of tripping it** — line 10 reads `mocked './core-bridge.js', which three files imported`;
had it read `imported from './core-bridge.js'`, the analyzer would have counted its own header as a
third importer and A1(b) would have been red.

**Advisories, all fixed:** the test named "prose mentioning mock.module in a comment is not a mock"
used `a/x.ts`, so `findMocks` bailed on `isTestFile` before the regex was consulted — green for a
reason unrelated to its name. A7 put its two importers in different directories, so directory
scoping alone explained the green and the disputed property was never load-bearing; both now sit in
the same directory differing only in specifier string, with A7b as the red control. A13's
"recursive" was unexercised — the auditor made `collect` non-recursive and all 23 tests stayed
green, because the only subdirectory under a scanned root is `typefixtures`, which the walk skips.

**Corrected in the spec:** revision 2 promised an "A9b" criterion that was never written. The audit
found the spec asserting coverage it did not have — in the loop about tests that claim more than
they check.

**Recorded, not fixed:** a `mock.module('../bridge.js')` from a subdirectory is effectively
unguarded, because R1 can only count files in that subdirectory writing the same `'../'` string.
The hole is in the rule, not the implementation. Now named in the analyzer's docstring, per this
loop's own principle that holes go in the source rather than staying implicit.

## Pass 3 — compliance

Fence held: exactly the two declared new files plus this loop's artifacts. `scripts/verify.ts`,
`package.json` and `tsconfig.json` untouched — the test joins the gate because `bun test` already
collects `scripts/*.test.ts`. Domain logic stayed out of surfaces; this adds none anywhere.
`verify` green, lint at the standing 12.

## What is NOT done

- **`MOCK_CALL` is exported but no test asserts on it.** The suite reaches it through `findMocks`,
  which is the equivalent affordance; the export is now decorative.
- **Multi-statement lines undercount.** `import { type A } from './d.js'; import { b } from './d.js';`
  returns false — the first brace group wins. Contrived, nobody writes it, and the direction is the
  silent one, so it is recorded rather than dismissed.
- **A7 encodes a disputed measurement.** I measured no leak when one file is reached by two
  different specifier strings; the Stage 2 reviewer measured a leak and concluded resolved-path
  keying. Three load orders on bun 1.3.11 said otherwise and neither of us could reproduce the
  other. If their result is right, A7 is a **false negative** — the guard has a hole there, not a
  wrong answer. R2 exists partly so the guard does not depend on resolving it.
- **The guard counts DIRECT importers.** A module with exactly one non-test importer still
  contaminates every test reaching it through that importer — measured, and out of scope. Stated
  in the analyzer's docstring so "exactly one consumer" is not read as safety.
- **Discovery only sees `packages/*/src` and `scripts/`.** A `mock.module` anywhere else is
  invisible. Documented hole.
- **Regex, not a parser.** A computed or concatenated specifier is invisible. Mitigated by the
  exact-set assertions, not fixed.
- **The guard starts green and may never fire.** Accepted deliberately: it would have gone red on
  both historical incidents — loop 001 via the bare-specifier path, loop 025 via a direct count of
  three on `core-bridge.js`.

## Mutation log

| Mutation | Predicted | Actual |
|---|---|---|
| break the discovery regex | A1(a) pairs fail | 11 fail ✓ |
| break the importer regex | A1(b) sets fail | 11 fail ✓ — the assertion revision 1 of the spec omitted |
| delete the R2 branch | A10 fails | 1 fail ✓ |
| empty the ambient allowlist | real tree red (`vscode` has 4 importers) | 3 fail ✓ — **faulty shape named in advance:** staying green would have meant the real-tree half was not calling the rule |
| remove the symlink skip | the symlink test fails | 1 fail ✓ |
| gut the default/namespace branch | **was INERT — a real gap** | 1 fail ✓ after the fix |
| remove the wrapped-brace collapse | fails | 1 fail ✓ |
| remove comment stripping | fails | 1 fail ✓ |
| make `collect` non-recursive | **was INERT — a real gap** | 1 fail ✓ after the fix |

## Retrospective

This loop set out to build a guard against a silent failure and, in the building, produced one:
a catch-all that swallowed a ReferenceError and turned a broken walk into an empty result set.
The thing that caught it was the criterion added because the *first* version of this spec had
omitted it — an exact-set assertion, where an at-most-one check would have passed on zero.

The other durable finding is not about this repo. Two competent reviews measured the same bun
behaviour and disagreed, each reproducibly. Where that happens, the useful move was not to pick a
winner but to add a rule (R2) whose correctness does not depend on who is right.
