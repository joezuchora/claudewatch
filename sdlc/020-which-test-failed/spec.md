# Spec: record the failing tests in `verify_run`

- **Status:** revised after Stage 2 review — the first draft had three false empirical claims and
  seven acceptance criteria a no-op implementation satisfied
- **Stage:** 2 — Design
- **Reads:** `sdlc/020-which-test-failed/intent.md`
- **Review:** `sdlc/020-which-test-failed/review-spec.md`

## Summary

`scripts/verify.ts` passes `--reporter=junit --reporter-outfile=<temp>` to the `test` step,
parses the resulting XML when that step runs and does not pass, and adds a **byte-bounded**
`failedTests` array to the `verify_run` payload.

This requires an amendment to `SPEC.md` §17. That is the first section below, because without it
the change cannot pass this repo's own review gate.

## The amendment this change requires

The first draft argued the payload rule "does not apply" to `verify_run`. **That argument was
wrong**, and the review took it apart:

- The rules are in **§17 Observability and Debugging** (`SPEC.md:857`, `SPEC.md:859`), not §12.
  All four of the draft's citations pointed at the wrong section.
- §17's text is not scoped to shipped artifacts. It says *"Forbidden in telemetry: … filesystem
  paths, hostnames, usernames …"*.
- The draft's supporting evidence — *"the metrics pipeline types `payload` as
  `Record<string, unknown>`"* — is the **ingest** type, deliberately permissive because it
  accepts untrusted input. The **emitter** type is
  `Record<string, string | number | boolean | null>` at both `telemetry.ts:55` and
  `verify.ts:92`.
- Decisively: `verify.ts:82` and `telemetry.ts:93` resolve to **the same file** —
  `~/.cache/claudewatch/metrics-spool.jsonl` — shipped by the same agent to the same hosted
  service. A path in a `verify_run` event leaves the machine by exactly the route §17 governs.

So this is a **stated amendment**, handled the way `sdlc/003` handled narrowing the no-telemetry
guarantee: dated, written down, propagated to every document that makes the promise. Not an
argument that the rule never applied.

### Amendment text, to be added at `SPEC.md` §17

> **Amendment (2026-08-26, sdlc/020).** Events with `source: 'sdlc'` — process metrics written
> by `scripts/verify.ts`, which never runs in a shipped artifact and observes only this
> repository — may additionally carry **repo-relative** file paths and test identifiers, plus
> the closed enumeration `junitOutfile`.
>
> Unchanged for every event regardless of source: no token, no absolute path, no home
> directory, no hostname, no username, no account identifier.
>
> Unchanged for product telemetry (`source: 'statusline' | 'vscode'`): numbers, booleans, and
> members of closed enumerations only. A free-text payload field there remains a blocking
> review finding.

`SECURITY.md:53` and `deploy/README.md:98` both promise *"No payload can contain … a path"*.
Both are about the product and both stay literally true — but a reader who inspects their own
spool will find repo-relative paths in `source: 'sdlc'` lines. Each gets one clarifying
sentence distinguishing product events from SDLC process events. `REVIEW.md:52` gets the same
carve-out, or this change fails its own security pass.

## Where the code goes

A new module, `scripts/junit.ts`, with `scripts/junit.test.ts` beside it. Not `packages/core` —
this is dev-loop tooling and core ships. `scripts/perf.ts` + `scripts/perf.test.ts` is the
existing precedent for a tested module under `scripts/`, and `scripts/` is typechecked since
`sdlc/018` closed that hole (`tsconfig.json`'s `exclude` is exactly `dist`, `node_modules`,
`packages/core/src/typefixtures`).

> The first draft claimed `verify.ts` "is the thing under test in `verify.test.ts` already".
> **No such file exists.** Two separate arguments rested on it. Neither survives.

## Behavioral contract

### `parseJunitFailures(xml: string, repoRoot: string): FailedTest[]`

```ts
export interface FailedTest {
  file: string | null;   // repo-relative POSIX path, or null (S3)
  name: string;          // decoded once (S5a)
  suite: string | null;  // decoded twice, opaque chain (S5b)
  line: number | null;
  type: string | null;   // the <failure> element's `type`
}
```

One entry per `<testcase>` containing a `<failure>` child, in document order.

### Sanitization

| # | Rule | Why |
|---|---|---|
| S1 | `hostname` is never read. | §17 forbids hostnames. It appears on **every** nested `<testsuite>`, not just the outer one, so "never read" must be a property of the parser rather than a filter applied after. |
| S2 | A `file` that is absolute **and** under `repoRoot` becomes repo-relative, with `/` separators. Comparison uses `path.isAbsolute` semantics, and on Windows is separator-normalized and case-insensitive. | See the correction below. |
| S3 | A `file` that is absolute and **not** under `repoRoot` becomes `null`; the entry is kept. | A test outside the repo has a path we cannot relativize and therefore cannot vouch for. |
| S4 | No `<failure>` text content, `message` attribute, or CDATA is ever read. | The one field genuinely likely to carry user data. Bun does not currently emit it — S4 is what keeps that true if Bun starts. |
| S5a | `name` is XML-decoded **once**. | |
| S5b | `classname` is XML-decoded **twice**. | Bun double-encodes it. See below. |

> **Correction to the intent (M3).** The intent asserted `file` is an absolute path carrying a
> username. **It is not, for tests under the working directory.** Bun 1.3.11 emits
> `file="packages/core/src/cache.test.ts"` — zero absolute paths across all 623 testcases in
> this repo, confirmed twice. The draft generalized from a probe fixture placed in `/tmp`,
> outside cwd, which *does* come out absolute.
>
> S2 and S3 therefore keep a property Bun already provides, rather than fixing an observed leak.
> That is still worth doing — a Bun change would otherwise leak silently — but the spec must not
> claim a hazard it did not observe, and **A2 must use a fixture that actually contains an
> absolute path**, or it tests nothing.

#### Why S5a and S5b differ

A `describe('A & B')` containing `describe('inner < deep')` containing `test('name & <tag>')`
emits:

```xml
<testcase name="name &amp; &lt;tag&gt;" classname="inner &amp;lt; deep &amp;gt; A &amp;amp; B" />
```

`name` needs one decode pass; `classname` needs two. A single uniform rule cannot be correct for
both, and double-decoding `name` would corrupt a test whose source name legitimately contains
`&lt;`.

`classname` is **not a source literal**. It is Bun's ` > `-joined describe chain, **innermost
first** — so `A & B` → `inner < deep` yields `inner < deep > A & B`. The first draft's rationale
("undecoded names do not match source") was wrong: no source string equals the decoded
classname.

`suite` is stored as the decoded chain and treated as **opaque**. It is deliberately not split
on ` > `: after decoding, `describe('a > b')` and nested `describe('b'){describe('a')}` produce
identical values, so the field cannot round-trip. Recorded as a known limitation rather than
papered over.

### Bounding: bytes, not entries

The first draft capped at 20 entries and justified it against the 5MB spool cap. **Wrong
bound.** `telemetry.ts:32` is the binding one:

```ts
/** Hard cap on one serialized line, keeping a single O_APPEND write atomic on POSIX. */
export const MAX_LINE_BYTES = 4096;
```

`telemetry.ts:179` enforces it. **`verify.ts` does not** — and writes to the same file. The
review built a payload from this repo's 20 longest real test names: **5078 bytes**, over the cap.
An oversized line breaks the `>PIPE_BUF` atomicity invariant on a spool the product appends to
concurrently, producing interleaved, corrupt JSONL — silent loss of the durable record this
change exists to protect.

So: **drop entries from the end until the serialized event is ≤ `MAX_LINE_BYTES`.** The constant
is imported from core, never re-declared — re-deriving a familiar number is `sdlc/015`'s root
cause. `failedTestCount` always carries the true total, so truncation is reported rather than
silent.

## Payload changes

Present **iff the `test` step ran and its outcome was `fail` or `timeout`**; absent otherwise,
including when an earlier step failed and `test` never ran (`verify.ts:136` breaks on first
failure).

| Field | Type | Meaning |
|---|---|---|
| `failedTests` | `FailedTest[]` | Byte-bounded. `[]` means "no per-test data recoverable". |
| `failedTestCount` | `number` | True total before truncation. Always present when `failedTests` is. |
| `junitOutfile` | `'present' \| 'absent' \| 'unparseable'` | A closed enumeration, §17-clean. |

`junitOutfile` is what makes the three states distinguishable — it replaces the first draft's
E2/E3/E8, which prescribed **contradictory payloads for the identical filesystem state**.

### `verify.ts`'s local payload type widens; core's does not

`verify.ts:92` is `Record<string, string | number | boolean | null>`. `FailedTest[]` is not
assignable to it, so the first draft **would not have compiled** — a hard failure in the gate's
own runner, on the gate's first step.

Only `verify.ts`'s local annotation widens. `packages/core`'s `MetricEvent.payload`
(`telemetry.ts:55`) is **untouched**: `telemetry.ts:19-23` calls it the security boundary for
product telemetry, and widening it would remove the structural barrier for the events that
actually concern a user. `verify.ts` builds its event as a plain object literal and never
constructs a `MetricEvent`, so the two are already independent.

## Edge cases

| # | Case | Behavior |
|---|---|---|
| E1 | `test` passes | No parse, no new fields. Outfile deleted in a `finally`. |
| E2 | `test` **times out** (SIGKILL) | **No outfile exists** — bun writes the report once, at end of run. `junitOutfile: 'absent'`, `failedTests: []`, `failedTestCount: 0`. See "What this cannot do". |
| E3 | Outfile missing for any other reason | Identical to E2. One rule, keyed on an observable. |
| E4 | Malformed or truncated XML | `junitOutfile: 'unparseable'`, `failedTests: []`. Never throws. |
| E5 | Failure with no `file` attribute | Entry kept, `file: null`. |
| E6 | Nested `<testsuite>` | One level per `describe`; `<testcase>` matched at any depth. |
| E7 | Self-closing `<testcase>` (a pass) | Skipped. Only elements with a `<failure>` child count. |
| E8 | An earlier step failed, `test` never ran | All three fields absent. |
| E9 | `verify.ts` is itself killed mid-run | Outfile may survive in the OS temp dir. It is created `0600` so a stray file is not world-readable. |

## Acceptance criteria

Every criterion pairs a **positive precondition** with its assertion. The first draft's did not,
and the review showed **seven of twelve passed against a `return []` no-op** — the same
"green check on an empty set" defect this repo has now recorded seven times, here in the
acceptance criteria themselves.

| # | Criterion |
|---|---|
| A1 | A fixture with 1 failure yields `length === 1`, and `file`/`name`/`line`/`type` all match expected values exactly |
| A2 | Given `file="/home/testuser/claudewatch/packages/core/src/x.test.ts"` and `repoRoot="/home/testuser/claudewatch"`: `length === 1` **and** `file === 'packages/core/src/x.test.ts'` **and** no returned value contains `testuser` |
| A3 | Given a fixture whose `hostname="HOSTNAME-SENTINEL-9f3a"`: `length === 2` **and** the serialized payload does not contain `HOSTNAME-SENTINEL-9f3a` |
| A4 | Given a `<failure>` with both a `message` attribute and text content, each containing `LEAK-SENTINEL-4c71`: `length === 1` **and** the sentinel appears nowhere in the output |
| A5 | An absolute `file` outside `repoRoot` yields `length === 1` **and** `file === null` |
| A6 | 400 synthetic failures yield `failedTestCount === 400` **and** `failedTests.length < 400` **and** the serialized event ≤ `MAX_LINE_BYTES` |
| A7 | Malformed XML yields `[]`, **and** a well-formed sibling fixture in the same test yields non-empty — so the parser is not simply always empty |
| A8 | `name` decodes once and `classname` twice, asserted against the exact expected strings for a 3-level nested fixture |
| A9 | **A real failing test run end-to-end produces a non-empty `failedTests` naming that test.** The criterion the no-op cannot satisfy |
| A10 | A passing run's payload has exactly today's keys — asserted against an explicit key list, not "no new keys" |
| A11 | `junitOutfile` is `'absent'` when the file is missing, `'unparseable'` when malformed, `'present'` when parsed |
| A12 | Median `testMs` over 10 runs increases by **< 2%** versus the same 10 runs without the reporter flags |
| A13 | The outfile is created mode `0600`, lives outside the repo, and does not survive a run — pass or fail |
| A14 | Console output is byte-identical with and without the reporter flags, after normalizing timing jitter |

## What this cannot do, stated before it is built

**A hanging test step yields nothing.** Bun emits the junit file once, at end of run; SIGKILL
leaves no file. Verified independently twice.

**And the motivating number was stale.** The intent cited "the intermittent ~550s hang".
`verify.ts:49` sets `STEP_TIMEOUT_MS = 300_000` — a 550s step has been impossible since step
timeouts landed. That is a `sdlc/015` repeat: a number carried across documents because it
looked familiar, never re-derived.

What this change *does* cover is what has actually recurred four times: tests that **fail** on
the first run of an iteration. Those runs complete and produce a file. It also covers the
self-inflicted CI failure earlier today, where a subagent's probe fixture was committed and
three tests failed in CI but not locally.

Recovering the hang case needs a different mechanism — SIGTERM with a grace period before
SIGKILL (unverified: Bun may not flush on SIGTERM), capturing the child's stdout instead of
inheriting it, or a per-test heartbeat. Each has its own cost to the console output a human
reads. **Not folded in here.** The hang item stays open.

## Why not each alternative

- **Scrape console output.** Not a contract; changes between Bun versions.
- **Hash test names to numbers.** Preserves the closed-enumeration rule absolutely — but needs a
  lookup table that goes stale the moment a test is renamed, and the amendment above is the
  honest way to buy what the hash was buying dishonestly.
- **Record only the file.** Would have identified none of the four timing failures — four
  different tests, two in the same file.

## Risks

- **`--reporter=junit` could change or disappear.** Then the test step fails outright rather
  than degrading — a red gate, not silent data loss, which is the right direction. A14 pins the
  console behavior.
- **Importing `MAX_LINE_BYTES` from core into `scripts/`** makes the gate's runner depend on
  core's source parsing. Bun imports TS directly so no build is needed, but this is a new
  coupling and the plan must confirm `verify.ts` still starts when core has a type error.
- **A12 is the one criterion measured rather than asserted**, and it now has a number. Prior
  measurement at n=3 showed no detectable cost (7395ms with, 7591ms without — wrong sign for an
  added cost), and the full report is 157,557 bytes.
