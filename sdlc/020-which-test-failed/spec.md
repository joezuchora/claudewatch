# Spec: record the failing tests in `verify_run`

- **Status:** revised — E2 was false; see "What this cannot do"
- **Stage:** 2 — Design
- **Reads:** `sdlc/020-which-test-failed/intent.md`

## Summary

`scripts/verify.ts` passes `--reporter=junit --reporter-outfile=<temp>` to the `test` step,
parses the resulting XML when that step fails, and adds a bounded `failedTests` array to the
`verify_run` payload. Every value in it is sanitized: repo-relative paths only, no hostname, no
assertion text.

## Where the code goes

A new module, `scripts/junit.ts`, holding the parse and the sanitization. Not
`packages/core` — this is dev-loop tooling, not product domain logic, and `packages/core`
ships. Not inline in `verify.ts` — it needs its own tests, and `verify.ts` is the thing under
test in `verify.test.ts` already.

`scripts/` is typechecked and linted since `sdlc/018` closed that hole.

## Behavioral contract

### `parseJunitFailures(xml: string, repoRoot: string): FailedTest[]`

```ts
export interface FailedTest {
  file: string | null;   // repo-relative POSIX path, or null (see F3)
  name: string;          // the testcase's `name` attribute
  suite: string | null;  // the testcase's `classname`, or null when empty
  line: number | null;   // the testcase's `line`, or null when absent/unparseable
  type: string | null;   // the <failure> element's `type`, or null when absent
}
```

Returns one entry per `<testcase>` that contains a `<failure>` child, in document order.

### Sanitization, which is the point of the module

| # | Rule | Why |
|---|---|---|
| S1 | `hostname` is never read. | SPEC.md §12 forbids hostnames in payloads. It is an attribute on every `<testsuite>`, so "never read" must be a property of the parser, not a filter applied afterwards. |
| S2 | An absolute `file` under `repoRoot` becomes repo-relative with `/` separators. | `/home/<user>/claudewatch/packages/core/src/x.test.ts` carries a username. |
| S3 | A `file` **not** under `repoRoot` becomes `null` — the entry is kept, the path is dropped. | A test outside the repo (a temp probe, a linked workspace) has a path we cannot relativize and therefore cannot vouch for. Dropping the path while keeping the name loses the least. |
| S4 | No `<failure>` text content, `message` attribute, or CDATA is read. | The one field genuinely likely to carry user data. Bun does not currently emit it — S4 is what keeps that true if Bun starts. |
| S5 | XML entities in `name`/`classname` are decoded (`&amp;` `&lt;` `&gt;` `&quot;` `&apos;`). | `classname` arrives as `isInCooldown &amp;gt; cooldown`. Undecoded names do not match source. |

### `MAX_RECORDED_FAILURES = 20`

`parseJunitFailures` returns everything it finds; **`verify.ts` truncates.** A suite-wide
breakage (600+ failures) must not write a megabyte into a 5MB-capped spool.

When truncated, the payload also carries `failedTestCount` — the true total. A silently capped
list reads as "20 tests failed"; `sdlc/013`'s rule is that a bound which drops data says so.

## Payload changes

`verify_run.payload` gains, **only when the `test` step did not pass**:

| Field | Type | Meaning |
|---|---|---|
| `failedTests` | `FailedTest[]` | Up to `MAX_RECORDED_FAILURES` entries. |
| `failedTestCount` | `number` | Total failures found, before truncation. |

Absent entirely on a passing run — the existing "missing optional fields are omitted, not
guessed" rule (SPEC.md §3.3), and it keeps the common case byte-identical.

## Edge cases

| # | Case | Behavior |
|---|---|---|
| E1 | `test` step passes | No junit parse, no new fields. The XML file is still written by bun; it is deleted. |
| E2 | `test` step **times out** (SIGKILL at the step ceiling) | **No outfile exists.** Bun writes the junit XML once, at the end of a run; a SIGKILLed process writes nothing. Verified directly: a hanging test killed at 3s left no file. `failedTests` is therefore omitted on a timeout, and the run records `outcome: 'timeout'` exactly as it does today. See "What this cannot do" below — this is a limitation, not a behavior. |
| E3 | Outfile missing entirely | `failedTests` omitted. Not an error. |
| E4 | Malformed / truncated XML | `[]`. Never throws. |
| E5 | A failure with no `file` attribute | Entry kept, `file: null`. |
| E6 | Nested `<testsuite>` elements | Bun nests one level per `describe`. The parser matches `<testcase>` elements regardless of depth. |
| E7 | `<testcase>` self-closing (a pass) | Not a failure; skipped. Only elements with a `<failure>` child count. |
| E8 | Zero failures but a non-zero exit (a crash before any test ran) | `failedTestCount: 0`, `failedTests: []`. Distinguishes "the runner died" from "tests failed" — itself a useful signal. |

## Acceptance criteria

Each is mechanically checkable.

| # | Criterion | Check |
|---|---|---|
| A1 | A failing test's repo-relative file, name and line reach the payload | Seed a failing fixture, run the parser, assert the entry |
| A2 | **No absolute path reaches the payload** | Assert no returned `file` contains `repoRoot`, starts with `/`, or matches `homedir()` |
| A3 | **No hostname reaches the payload** | Assert the serialized payload does not contain the `hostname` attribute value present in the input XML |
| A4 | **No assertion text reaches the payload** | Feed XML whose `<failure>` has both a `message` attribute and text content; assert neither appears anywhere in the output |
| A5 | A path outside the repo root is dropped, not relativized | `file: null`, entry retained |
| A6 | Truncation is reported, not silent | 25 failures ⇒ `failedTests.length === 20` and `failedTestCount === 25` |
| A7 | Malformed XML yields `[]` and does not throw | Truncated, empty, and non-XML inputs |
| A8 | Console output is unchanged by the reporter flags | Compare `bun test` stdout with and without them |
| A9 | A passing run's payload is byte-identical to today's | No new keys on `outcome: 'pass'` |
| A10 | The gate's own exit code is unaffected | A parse that throws internally must not change the step's outcome |
| A11 | Entities in names are decoded | `&amp;gt;` ⇒ `>` |
| A12 | The temp outfile does not survive the run | It is written under the OS temp dir, not the repo, and removed |

## Why not each alternative

- **Scrape the console output.** The format is not a contract and changes between Bun versions.
  The junit reporter is a declared output format with a schema.
- **Hash the test name to a number.** This was the design the queue implied. It preserves the
  closed-enumeration rule absolutely — but that rule does not apply here, and a hash is
  unresolvable without shipping a lookup table that goes stale the moment a test is renamed.
  Rejected as complexity bought for a constraint that is not real.
- **Record only the file, not the name.** Cheaper, and would have identified none of the four
  timing failures — they were four different tests, and two were in the same file.

## What this cannot do, stated before it is built

**A hanging test step yields nothing.** The intent said the timeout case was "the case the
change most exists for". That was written before the case was tested, and it is false: bun
emits the junit file at the end of a run, so SIGKILL at the step ceiling leaves no file. The
intermittent ~550s hang — the thing that motivated queueing this item — is **not** made
reconstructable by this change.

What this change does cover is the case that has actually recurred four times: a test that
*fails* on the first run of an iteration. Those runs complete, so they produce a file.

Recovering the hang case needs a different mechanism (capturing the child's stdout rather than
inheriting it, or a per-test heartbeat), which is a separate design with its own cost to the
console output a human reads. It is not folded in here. `sdlc/017` and the hang item stay open.

This paragraph exists because the alternative was shipping a change whose stated purpose it
does not serve, and discovering that the next time the gate hangs.

## Risks

- **`--reporter=junit` is a Bun feature that could change.** If the flag disappears, the test
  step fails outright rather than degrading. Mitigation: A8 pins the console behavior, and
  `verify.test.ts` runs the real step. A version bump breaking this is a red gate, not a silent
  data loss — which is the right failure direction.
- **Writing the outfile costs time on every run, including passing ones.** The `test` step is
  ~7.5s of a ~13s gate; an XML write of a few hundred KB should be immaterial, but this is
  exactly the assumption `sdlc/013` says to measure rather than assert. **Measure before and
  after, and record the number in review.md.**
- **E2's truncated-XML path is the one that matters most and is hardest to trigger on demand.**
  It must be tested with a hand-truncated fixture rather than by hoping for a real timeout.
