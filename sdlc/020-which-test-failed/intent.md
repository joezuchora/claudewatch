# Intent: an intermittent gate failure should name the test that failed

- **Status:** accepted
- **Stage:** 1 — Plan
- **Date:** 2026-08-26

## The problem

`verify_run` records `failedStep: 'test'`. It does not record *which* test.

There have been **four consecutive first-run-of-iteration gate failures** (13:26, 14:22, 15:20,
17:18), each a different tight-timing assertion, all on the first workload after ~50 minutes of
container idle. Every one of those was diagnosed by scrolling terminal output that no longer
exists. The spool — the durable record, the thing the anomaly detector reads, the thing that
survives the container — knows only that *a* test failed.

That is the difference between "the gate is flaky" and "these four failures are the same
phenomenon". The second is a finding. The first is a shrug.

`sdlc/015` and `sdlc/019` were both filed from terminal scrollback that happened to still be on
screen. `sdlc/016` is deliberately unbuilt because it needs recorded distributions rather than
anecdotes. This is the same gap: **the loop cannot reason about its own flakiness because it
does not write down what broke.**

## Who is affected

Whoever debugs an intermittent CI or gate failure — today that is the loop itself. The shipped
product is not affected: `scripts/verify.ts` never runs in a shipped artifact.

## A premise in the queue that turned out to be false

This item was queued with the note: *"Payload rule: closed enumerations or numbers only, so a
raw test name needs design."* That is **wrong for this event kind**, and checking it made the
change simpler.

The closed-enumeration rule is a **product telemetry** invariant (SPEC.md §12), enforced
structurally in `packages/core/src/telemetry.ts` for events emitted from shipped artifacts.
`verify_run` is not one of those. It is written directly by `scripts/verify.ts`, a dev script,
and the metrics pipeline types `payload` as `Record<string, unknown>` with no allowlist. The
`record()` comment in `verify.ts` already says why: *SDLC process metrics contain no user data
and never run in a shipped artifact.*

So a test name — a literal in this repo's own source, identical for every checkout — is not the
hazard the rule exists to stop. It is not user data at all.

## The hazard that IS real, and is not the one the queue named

`bun test --reporter=junit` was probed before this intent was written. Three findings:

1. **`<failure>` carries no message.** Bun emits `<failure type="AssertionError" />` with the
   assertion diff omitted entirely. The thing most likely to contain user data — a diff of an
   actual value, which in this repo routinely includes `homedir()` — never enters the file.
   Verified with a deliberately failing test asserting on `homedir()`.
2. **`file` is an ABSOLUTE path.** `/home/<user>/claudewatch/packages/...`. That carries a
   username, which SPEC.md §12 forbids in any payload. It must be relativized to the repo root,
   and dropped outright if it does not lie under it.
3. **`hostname` is an attribute on every `<testsuite>`.** Also forbidden. It must not be
   carried through.

So the design work this item needs is real, but it is about **paths and hostnames**, not about
test names. Recording the name is the easy part; the part that needs care is everything the
reporter puts next to it.

## What "done" means

- A failing `test` step records enough to identify the test: repo-relative file, test name,
  line, failure type.
- No absolute path, username, or hostname appears in the spool. Demonstrated by asserting
  against a spooled event, not by reading the code.
- The payload stays bounded — a suite-wide breakage must not write a megabyte.
- Console output a human reads is unchanged. (Verified already: passing
  `--reporter=junit --reporter-outfile=…` preserves it.)
- The gate does not fail, slow measurably, or change its exit code because of this recording.
  Recording a metric must never be the reason the gate fails — the existing `record()` contract.

## Explicitly not in scope

- Assertion messages, diffs, stack traces, stdout. Not needed to identify a test, and the one
  category genuinely likely to carry user data.
- Anything for the other four steps. `typecheck`, `lint` and `build` already print a file and
  line, and `perf` is report-only.
- Using this to diagnose the four timing failures. That is the *next* question, and it needs
  data this change has not collected yet — the sdlc/016 discipline.
