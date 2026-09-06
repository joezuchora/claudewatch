# Review: record the failing tests in `verify_run`

- **Status:** accepted
- **Stage:** 5 — Deploy
- **Gate:** `bun run verify` green in 12.2s, 663 tests, lint warnings back to the pre-loop 12

## Mutation log

21 mutations across the loop, 21 caught. The parser and sanitization guards:

| # | Mutation | Check that failed |
|---|---|---|
| N1/N4 | `relativizeFile` returns its input / doesn't null out-of-repo | A2, A5 |
| N2b | hostname read into `suite` | A3 |
| N3b | `<failure>` body read into `type` | A4 |
| N5 | uniform decode (2 passes on `name`) | A8 |
| N6 | bound by entry count instead of bytes | A6, and its negative half |
| N7 | parser always returns `[]` | A1, A2 |
| N8 | `MAX_LINE_BYTES` drifts from core's | the binding test |
| N9 | the self-closing-testcase bug reintroduced | A7 |
| N10 | `line` attribute dropped | A1, A9 |
| N11 | `escapesRoot` never returns true | A5b |
| P1/P2 | `scrubPaths` is identity / loses its UNC branch | S2 |
| P3 | `type` unvalidated | S3 |
| P4 | empty-root guard removed | S4 |
| P5 | `attachFailures` always attaches | A10 |
| P6 | opening-tag check restored | the truncated-report test |
| P7 | `tightenMode` does nothing | A13 |
| P8 | tight bound falls back to coarse | S7 |

**Two mutation attempts reported "not caught" and both were my own fault**, not inert guards:
each used `??` against a non-null value, so neither changed behaviour. A mutation that does not
change behaviour proves nothing, and reporting those as findings would have been false.

## Findings

Both reviewers read commit `aaad3b0` (briefed on a commit range this time, after loop 014's
mid-review commit made both reviewers read a clean tree).

### Plan-to-diff audit — verdict: FENCE VIOLATED

Not by an out-of-scope file. Every path was on the fence. By **a fence item shipped
unimplemented behind a test that only appeared to cover it.**

| # | Finding | Resolution |
|---|---|---|
| B1 | **The outfile is 0644, not 0600.** Bun creates it; nothing ever chmodded it. The claim appeared in a code comment, a test name, and the spec. | **Fixed properly, not by editing the comment.** `tightenMode` now chmods it, and its test asserts bun's 0644 first so the premise is checked rather than assumed. |
| C1 | **A13's test was vacuous.** It created its *own* file with `mode: 0600` and asserted it was 0600 — it tested `fs.writeFileSync` and would have passed with `verify.ts` deleted. It is what hid B1. | Rewritten against a report bun really wrote, driving the real `tightenMode`. P7 confirms it fires. |
| C2/C3 | **A10 and A11 had no test at all.** No `verify.test.ts` existed. | The logic moved into `junit.ts` as pure `attachFailures` / `readJunitReport`, and both are now tested directly. See the recursion note below. |
| D2 | The §17 amendment restricted `source: 'statusline' \| 'vscode'` — **neither is a source.** `MetricSource` is `'product' \| 'sdlc'`; those are `surface` payload values. The one clause keeping the carve-out narrow constrained nothing. | Corrected in all four documents. |
| D3 | **`name`, `suite` and `type` were unsanitized free text** while three documents promised no event carries a path or username. | `scrubPaths` added and applied. Proven end-to-end: a test literally named after `homedir()` records as `a probe named after <path>`. |
| D4 | The amendment authorized **less** than the code emitted — `type` was undocumented. | `type` is now constrained to an identifier and named in all four documents. |
| D5 | `!xml.includes('<testsuites')` misclassifies a truncated report as a clean parse — and the counterexample was in my own test file. | Now checks the **closing** tag. P6 confirms. |
| D6 | "20 realistic entries measure 5078 bytes" was **not reproducible** — actual 4699/4920. I took the figure from the spec review and propagated it into code comments and a commit message without recomputing. | Recomputed and corrected. This is `sdlc/015`'s failure mode with a reviewer's number instead of an old document's. |
| D7 | "Six hostile inputs now null" — the test has **four**. I counted my probe script, not my tests. | Corrected here; the commit message is already in history and cannot be amended. |
| D8 | Two doc comments detached from their symbols by later edits. | Reattached. |

### Security pass

S1 (the `..` escape) it found independently — I had already fixed it, which is a useful
corroboration rather than a duplicate.

| # | Sev | Finding | Resolution |
|---|---|---|---|
| S2 | major | Only `file` was sanitized; `name`/`suite`/`type` were verbatim. **Its follow-up caught a gap in my own fix**: a UNC path `\\server\share\x` embeds a *hostname* and matched neither scrub branch. | Both fixed. P1, P2. |
| S3 | major | `type` is free text from an external tool and unauthorized by the amendment. Probed: bun emits only `AssertionError` even for a custom Error named after a credentials path — so no leak today, but the "defence against a future Bun change" argument used for `relativizeFile` was never made here. | Constrained to an identifier, `other` otherwise. P3. |
| S4 | minor | A `repoRoot` of `/` or `''` makes the prefix check match everything and merely strips the leading slash: `/home/joe/x.test.ts` → `home/joe/x.test.ts`. Unreachable via the gate, reachable via the exported function. | Guarded; `file === root` now nulls rather than returning `''`. P4. |
| S5 | minor | Same as B1. | See above. |
| S6 | minor | `boundBySize` gives up at zero entries **without re-measuring**, and `record()` appended unconditionally — core's `emit` drops the line in that case, `verify.ts` had no equivalent. Unreachable today by arithmetic, not by a check. | The final guard now mirrors `emit`. |
| S7 | info | The halving overshot — 12 entries kept where ~24 fit. | `boundBySizeTight` steps back up. P8. |
| S8 | info | `record()` is unconditional, and this change grew its content from scalar timings to source paths and test names. | **Not fixed — recorded.** An opt-out is a real design question, not a detail to slip in under this fence. |
| S9 | info | The agent ships every spooled line **verbatim, with no redaction**, and a LAN deployment is plaintext. | Documented in `deploy/README.md`: the sanitization here is the only boundary. |

## A bug I introduced while fixing the audit, and how it surfaced

The obvious fix for "A10 and A11 have no test" was a `verify.test.ts` that drives the real gate.
That makes `bun test` spawn `bun run verify`, whose `test` step runs `bun test` — **infinite
recursion**. The gate timed out at two minutes with a tree of nested processes.

Found by running it, not by reading it. The right answer was the refactor anyway: `readJunitReport`
and `attachFailures` moved into `junit.ts` as pure functions, so `verify.ts` orchestrates and
`junit.ts` decides. A script that only orchestrates is easier to trust.

## What this change still does not do

- **A hanging test step yields nothing.** Bun writes the report once, at end of run. Stated in
  the spec before implementation rather than discovered after.
- **No end-to-end test drives the whole gate**, for the recursion reason above. The closest is
  A9, which runs real `bun test` against a temp fixture. The full path was verified by hand twice
  and the transcript is in this loop, but it is not a standing check.
- **`record()` has no opt-out** (S8).
- **`anomaly.ts:143` still cites §12** for rules that live in §17 — same misattribution the spec
  inherited. One line, different file, not this fence.

## Measured, not asserted

- Reporter overhead: **+0.82%** median test-step time over 10 paired runs, against a <2% budget.
- Console output byte-identical with and without the flags, diffed after normalizing timings.
- A failing run's event: **508 bytes**, well inside the 4096 atomic-append cap.
- Passing-run payload keys unchanged; no `HOME`, absolute path, or hostname in any recorded event.
