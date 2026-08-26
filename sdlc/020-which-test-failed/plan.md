# Plan: record the failing tests in `verify_run`

- **Status:** accepted
- **Stage:** 3 — Build (planning half)
- **Reads:** `sdlc/020-which-test-failed/spec.md` (revised), `review-spec.md`

## Scope fence

The plan-to-diff auditor compares the diff against exactly this list.

```
scripts/junit.ts                      (new)
scripts/junit.test.ts                 (new)
scripts/verify.ts
SPEC.md                               (§17 amendment)
SECURITY.md                           (one clarifying sentence)
deploy/README.md                      (one clarifying sentence)
REVIEW.md                             (the carve-out, or the security pass blocks this change)
sdlc/020-which-test-failed/{plan,review}.md
sdlc/README.md
```

**Not touched, deliberately:** `packages/core/src/telemetry.ts`. Its `MetricEvent.payload` type is
the product-telemetry security boundary; this change must not widen it. Only `verify.ts`'s local
annotation moves.

## File-by-file

### `scripts/junit.ts` (new)

Exports `FailedTest`, `parseJunitFailures(xml, repoRoot)`, `boundBySize(entries, event, maxBytes)`,
and re-exports nothing from core except the imported `MAX_LINE_BYTES`.

Parsing is a hand-rolled scan, not a regex soup and not a dependency:
`packages/core` forbids third-party runtime deps and `scripts/` should hold the same line. The
input is Bun's own output, not arbitrary XML — but the parser must still not throw on anything.

Key implementation points, each traceable to a spec rule:

- **S1** — the parser reads `name`, `classname`, `file`, `line` from `<testcase>` and `type` from
  `<failure>`. There is no code path that reads `hostname`. Not a filter, an absence.
- **S2/S3** — `relativizeFile(file, repoRoot)`: not absolute ⇒ returned unchanged (the common
  case, since Bun already emits repo-relative); absolute and under root ⇒ relativized with `/`;
  absolute and outside ⇒ `null`. Windows: separator-normalize and compare case-insensitively.
- **S4** — the `<failure>` scan reads the `type` attribute only. It never touches text content,
  `message`, or CDATA.
- **S5a/S5b** — `decodeEntities(s, passes)`; `name` gets 1, `classname` gets 2.

### `scripts/junit.test.ts` (new)

One test per acceptance criterion A1–A11, A13. Fixtures are string literals in the test file
except A9, which runs a real failing test in a temp directory.

**A9 must not put a failing fixture inside the repo.** That is not a hypothetical: earlier today
a subagent wrote a probe fixture into `packages/core/src/`, `git add -A` committed it, and CI went
red on a Markdown-only commit. The fixture goes in `mkdtempSync(join(tmpdir(), …))`, following
`perf.test.ts`'s sandbox pattern.

### `scripts/verify.ts`

1. Import `MAX_LINE_BYTES` from `../packages/core/src/telemetry.js` and
   `parseJunitFailures` + `boundBySize` from `./junit.js`.
2. `runStep` gains an optional `outfile` so the `test` step can pass
   `--reporter=junit --reporter-outfile=<path>`; the path is `mkdtempSync` under `tmpdir()`,
   created `0600`, removed in a `finally`.
3. Widen the local payload annotation to admit the array. **`packages/core` untouched.**
4. `record()` adds `failedTests` / `failedTestCount` / `junitOutfile` iff the `test` step ran and
   its outcome was `fail` or `timeout`, then drops entries until the serialized line is
   ≤ `MAX_LINE_BYTES`.

### Documentation

`SPEC.md` §17 gets the amendment drafted in the spec. `SECURITY.md:53`, `deploy/README.md:98` and
`REVIEW.md:52` each get one sentence distinguishing product events from `source: 'sdlc'` process
events. Without the `REVIEW.md` change the security pass blocks this change by its own rule.

## Test mapping

| Criterion | Test | Mutation that must break it |
|---|---|---|
| A1 | `parses a single failure with all fields` | drop the `line` attribute read |
| A2 | `an absolute in-repo path is relativized` | make `relativizeFile` return its input |
| A3 | `hostname never reaches the output` | read `hostname` into the entry |
| A4 | `no failure message or CDATA is read` | read `<failure>` text content |
| A5 | `an out-of-repo absolute path is nulled, entry kept` | return the path instead of `null` |
| A6 | `400 failures are bounded by bytes, count reported` | bound by entries (20) instead of bytes |
| A7 | `malformed yields [], well-formed sibling does not` | `return []` unconditionally |
| A8 | `name decodes once, classname twice` | one uniform decode pass |
| A9 | `a real failing run names the failing test` | `return []` unconditionally |
| A10 | `a passing run's payload keys are exactly today's` | emit the fields unconditionally |
| A11 | `junitOutfile reflects absent / unparseable / present` | hard-code `'present'` |
| A13 | `outfile is 0600, outside the repo, and removed` | drop the `finally` |
| A12, A14 | measured in review.md, not unit tests | — |

A12 (median `testMs` +<2%) and A14 (console byte-identical) are **measurements**, run once and
recorded. Stating that here so review.md cannot later present them as passing tests.

## Risks

- **Importing core source into `scripts/`** is a new coupling. `verify.ts` runs before `build`,
  so it must import from `../packages/core/src/telemetry.js` (Bun resolves TS directly), not from
  the built package. **Verify `verify.ts` still starts when core has a deliberate type error** —
  if it does not, the gate cannot report its own first-step failure, which is worse than the
  problem being solved. If that check fails, fall back to declaring the constant in `junit.ts`
  with a test asserting it equals core's.
- **A9 is the criterion that makes the rest non-vacuous**, and it is also the slowest and the one
  that touches the filesystem. If it proves flaky it must be fixed, not deleted.
- **The `finally` cleanup runs on the normal path only.** If `verify.ts` is itself killed, the
  outfile survives — hence `0600` and a temp dir, per E9.

## Out of scope, recorded

- The **`git add -A` hazard** that caused today's CI red. It belongs to the harness
  (`.claude/agents/*`, or a staging discipline), not to `verify.ts`, and folding it in here would
  put two unrelated changes behind one fence. Filed as its own item.
- `anomaly.ts:143` repeats the §12/§17 misattribution. One-line fix, different file, not this
  change's business.
- Recovering the timeout case. Needs SIGTERM-with-grace or stdout capture; separate design.
