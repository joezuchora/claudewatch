# Plan: a tripwire for the mock that stubs code under test

- **ID:** 026-mock-topology-guard
- **Stage:** 3 — Build (planning half)
- **Status:** accepted
- **Reads:** `spec.md` (revision 2)
- **Date:** 2026-08-27

## Approach

The scanner is pure and the test drives it two ways. That split is not stylistic — it is what
turns thirteen criteria from one-shot manual mutations into standing tests, and it is the reason
no criterion needs a fixture written into the repo.

1. **`scripts/mock-topology.ts`** — `analyze(files)` over an in-memory list of `{path, text}`.
   No filesystem, no globs, no `import.meta.dir`. Returns `Violation[]`.
2. **`scripts/mock-topology.test.ts`** — real-tree half (walk, `analyze`, assert `[]` plus the two
   exact assertions) and synthetic half (table-driven cases, every rule, red and green paired).

Order: `analyze` first with its synthetic table, because that is where every rule can be proven
red *and* green. The real-tree assertions come last and are expected green from the first run —
they are the regression anchor, not the proof.

## Scope fence

| Path | Why |
|---|---|
| `scripts/mock-topology.ts` | **new** — the pure analyzer |
| `scripts/mock-topology.test.ts` | **new** — real-tree + synthetic cases |

Two new files, nothing else. **Explicitly not touched:** every existing source and test file,
`SPEC.md` (impact assessed as none), `scripts/verify.ts` (the test joins the gate through
`bun test`, which already collects `scripts/*.test.ts` — no wiring needed), `package.json`,
and `tsconfig.json`.

If the diff touches anything beyond those two files, that is an excursion and `review.md` must
explain it.

## Changes

### `scripts/mock-topology.ts` *(new)*

```ts
export interface SourceFile { path: string; text: string }
export interface Violation { rule: 'R1' | 'R2'; specifier: string; detail: string; files: string[] }
export const AMBIENT_ALLOWLIST = ['vscode'] as const;
export function findMocks(files): Array<{ testPath: string; specifier: string }>
export function findImporters(files, specifier, fromDir): string[]
export function analyze(files: readonly SourceFile[]): Violation[]
```

- **Discovery** — `/mock\.module\(\s*['"]([^'"]+)['"]/g` over `*.test.ts` only. Tolerates
  whitespace and newline after the paren, and either quote style.
- **R1** — local specifiers count importers in the mocking test's directory that write the same
  specifier; bare specifiers count **tree-wide**. Allowlisted specifiers are skipped. Violation
  when the count exceeds one.
- **R2** — two or more distinct test files mocking the same non-allowlisted specifier string.
- **Importer matching** — the eight-form table from the spec, including side-effect
  `import '<spec>'`, `export … from`, dynamic `import()`, and the inline-`type` rule (a specifier
  counts unless *every* binding on the line is type-qualified).

Both regexes are exported so the test can assert on them directly rather than only through
`analyze`'s output.

### `scripts/mock-topology.test.ts` *(new)*

- **Synthetic half:** a table of cases, each a small `SourceFile[]` with an expected violation
  list. Every rule gets a red case and a green control differing by one token.
- **Real-tree half:** walks `packages/*/src` and `scripts/` recursively (skipping `node_modules`,
  `dist`, `typefixtures`), excludes its own path from discovery, asserts `analyze(...)` returns
  `[]`, and asserts the two exact sets.

## Tests

| Criterion | Case | Expect |
|---|---|---|
| A1 | real tree; pairs and importer sets | exact match |
| A2 / A2b | two importers / one importer | red / green |
| A3 / A3b | bare specifier, two importers / one | red / green |
| A4 / A4b | `import type`, `export type`, all-inline-`type` / same minus the keyword | green / red |
| A5 | dynamic `import()`, relative **and bare** | red |
| A6 / A6b | side-effect `import '<spec>'` / `export * from` | red / red |
| A7 | same file via two different specifier strings | **green** (the measured case; the disputed one) |
| A8 | same specifier, different dirs, different files | green |
| A9 | mock a module that already has two importers | red, naming both |
| A10 | two test files mocking the same string | red (R2) |
| A11 | `bun run verify` | exit 0, lint at 12 |
| A12 / A13 | docstring states the transitive limit and the scope hole | present |

## Verification

1. The synthetic table is the proof; it runs on every `bun test`.
2. Mutations against the **real-tree half**, each predicted before running:
   - break the discovery regex → **A1(a) must fail**. Revision 1's design survived this; the
     pairs assertion should not.
   - break the importer-counting regex → **A1(b) must fail**. This is the one revision 1 missed
     entirely: counts silently become 0, and 0 satisfies at-most-one.
   - delete `analyze`'s R2 branch → **A10 must fail**.
   - delete the allowlist → **predicted: A1 real-tree goes red**, because `vscode` has four
     importers. A faulty-looking result would be it staying green, which would mean the real-tree
     half is not actually calling the rule.
3. `bun run verify` exits 0, lint at the standing 12.
4. Stage 5: `plan-to-diff-auditor` and `security-reviewer` on the commit range, briefed not to
   write into the tree.

## Risks

- **The analyzer is new code whose own bugs are silent.** That is why the synthetic table is the
  primary artifact and the real-tree run is secondary. If only one half can be trusted, it should
  be the half with red cases in it.
- **A7 encodes a disputed measurement.** I measured no leak across three load orders; the Stage 2
  reviewer measured a leak. If they are right, A7 is a false negative and the guard has a hole
  rather than a wrong answer. The test's docstring must say so and name bun 1.3.11.
- **Regex over source text.** A computed or concatenated specifier is invisible. Mitigated, not
  fixed, by A1's exact assertions.
- **The guard starts green and may never fire.** Accepted: it would have gone red on both
  historical incidents (loop 001 via the bare path, loop 025 via a count of 3), which is the
  case for building it.
