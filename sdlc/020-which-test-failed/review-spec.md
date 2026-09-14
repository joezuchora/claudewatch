# Stage 2 review: spec-reviewer findings

- **Verdict: revise.** Accepted in full. Every falsifiable claim was re-verified here before
  acting on it; all held.

## What was wrong, and how

Three of the intent's four empirical claims were false or misleading, and seven of twelve
acceptance criteria passed against a `return []` no-op.

| # | Finding | Verified how | Resolution |
|---|---|---|---|
| B1 | The timeout path yields **nothing** — bun writes the junit file once at end of run, so SIGKILL leaves no file. The spec called this "the case the change most exists for". | Independently, before the review returned: a hanging test killed at 3s left no file | Scope narrowed to the `fail` path; "What this cannot do" written before implementation |
| B1b | The motivating "~550s hang" **cannot happen** — `verify.ts:49` sets `STEP_TIMEOUT_MS = 300_000` | `grep` | Corrected in both documents. A familiar number carried across documents, never re-derived — `sdlc/015` again |
| B2 | `FailedTest[]` is **not assignable** to `Record<string, string \| number \| boolean \| null>` (`verify.ts:92`). The design would not have compiled — in the gate's own runner, on the gate's first step | `grep` | Spec now names exactly which type widens (`verify.ts`'s local one) and which does not (core's `MetricEvent`, the product-telemetry security boundary) |
| B3 | The 20-entry cap was justified against the wrong bound. `MAX_LINE_BYTES = 4096` binds, `verify.ts` does not enforce it, and the spool is **shared with product telemetry** — an oversized line breaks `>PIPE_BUF` append atomicity and corrupts the record. 20 real test names measured at **5078 bytes** | `grep telemetry.ts:32,179`; both paths resolve to `~/.cache/claudewatch/metrics-spool.jsonl` | Bound is now byte-based against the imported constant, never re-declared |
| B4 | **Seven of twelve acceptance criteria passed against a no-op.** Every negative/safety criterion was vacuously true on empty output | Read | All fourteen rewritten to pair a positive precondition with the assertion; A9 added, which a no-op cannot satisfy |
| M1 | All four citations of the payload rule pointed at **§12**. The rules are at `SPEC.md:857`/`859`, in **§17** | `grep` | Fixed. `anomaly.ts:143` inherits the same error — recorded, not fixed here |
| M2 | The "the rule does not apply" argument rested on the **ingest** type rather than the emitter type, and ignored that `verify_run` lands in the same spool shipped to the same service | `grep verify.ts:82` vs `telemetry.ts:93` | The spec now carries a **stated §17 amendment** instead of an argument, plus the propagation to `SECURITY.md`, `deploy/README.md`, `REVIEW.md` |
| M3 | `file` is **not absolute** for in-repo tests — zero absolute paths across 623 testcases | Re-ran the full suite: `grep -o 'file="/[^"]*"' \| wc -l` ⇒ `0` | Intent corrected. The claim came from a probe placed in `/tmp`; I generalized from a badly-chosen probe |
| M4 | `classname` is **double**-encoded while `name` is single-encoded; `classname` is a reversed ` > `-joined describe chain, not a source literal | Reviewer's 3-level probe | S5 split into S5a/S5b; `suite` documented as opaque and non-round-trippable |
| M5 | E2, E3 and E8 prescribed **contradictory payloads for the identical filesystem state** | Read | Replaced with one rule keyed on an observable, plus a `junitOutfile` closed enumeration |
| M6 | `verify.test.ts` **does not exist**; two arguments rested on it | `find` | Both dropped; `scripts/perf.test.ts` is the real precedent |
| m1–m6 | Short-circuit ambiguity, `failedTestCount` presence, Windows-blind absolute check, a 2-char hostname making A3 flaky, an unquantified perf threshold, missing `0600` on the outfile | Read | All folded in |

## What survived

Worth recording, because it is a real result rather than a courtesy:

- **`<failure>` carries no message, diff, or CDATA** — for assertion failures *and* thrown
  errors. The reviewer threw `new Error(\`boom in ${homedir()}/secret-project\`)`; neither the
  path nor the message appeared anywhere in the XML.
- **`hostname` is on every nested `<testsuite>`**, which strengthens S1's "never read" framing.
- **Console output is byte-identical** with the reporter flags, verified by diff over the full
  suite rather than by eye.
- **`scripts/` is genuinely typechecked** since `sdlc/018`.
- No existing consumer breaks: `store.ts` and `dashboard.ts` read only `payload.outcome` and
  `payload.failedStep`.

## The meta-finding

The first draft's acceptance criteria were **themselves** an instance of the defect this repo
has now recorded seven times: *a green check on an empty set is indistinguishable from a green
check on a covered one.* I wrote fourteen criteria intended to prove sanitization works, and
seven of them would have passed against a parser that returned nothing at all — while B1 shows
the real timeout path returns exactly that. The suite would have been green with the primary use
case dead.

Writing a criterion that a no-op fails is a different skill from writing one that a correct
implementation passes, and only the first is worth anything.
