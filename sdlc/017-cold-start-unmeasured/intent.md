# Intent: nothing measures the cold path a returning user actually pays

- **ID:** 017-cold-start-unmeasured
- **Stage:** 1 — Plan
- **Status:** draft
- **Author:** follow-up from [`sdlc/015-perf-gate-incident`](../015-perf-gate-incident/incident.md), second occurrence
- **Date:** 2026-08-26

## Problem

Every performance number this project has ever recorded is a **warm** number. `SPEC.md §11.7`'s
method says so explicitly — five discarded warm-ups before any timed sample — and that is the
right way to measure steady-state latency.

It is not what a user experiences. The statusline is a **99.3 MB** compiled binary that Claude
Code executes on every prompt. A user who returns after an idle period pays a cold exec, and on
2026-08-26 at 15:20 one such exec **exceeded five seconds** — 100× the warm p50 — caught only
because `sdlc/013`'s security pass insisted on a per-sample timeout that then fired.

Three consecutive gate runs, each the first workload after ~50 minutes of host idle, were
markedly slower across the whole test step (10.4 / 13.4 / 11.2 s against ~7 s). The warm budget
was met throughout. Nothing in the spec, the tests, or the budget looks at the other path.

## Who is affected

Anyone whose editor sits idle and then renders a prompt — which is the normal way this tool is
used, not an edge case. The cost is a multi-second statusline on the first prompt back.

Unquantified, and that is the point: one accidental observation is not a measurement.

## Why now

Because the observation exists and will otherwise be forgotten. It was recorded in an incident
about something else, by a guard built for a third reason.

Not urgent: no user has reported it, and the warm path — which dominates once you are working —
is fine.

## What "done" means

- [ ] The cold path is either **measured**, with a stated method, or `SPEC.md §11.7` says
      plainly that it is unmeasured, as it now does for the cache-miss and timeout rows
- [ ] If measured, the number is derived from more than one host and more than one session —
      `sdlc/015`'s root cause was calibrating an instrument from a single afternoon
- [ ] Whether a 99 MB artifact is itself the finding is examined rather than assumed

## Explicitly out of scope

- **Shrinking the binary.** `sdlc/013` measured `--minify` and `--bytecode` at under 2 ms of
  warm difference and rejected both. Whether either helps the *cold* path is a genuinely
  different question with genuinely different evidence — and answering it is this loop's job
  only if the cold path turns out to matter.
- **A cold-path budget in the gate.** `sdlc/015` is the record of what enforcing an
  environment-sensitive budget does to a gate.

## Open questions

- **Can cold start even be measured here?** Dropping the page cache needs privileges this
  container lacks. Measuring it may require a different host, or measuring the proxy —
  first-exec-after-N-minutes-idle — which is not the same thing and should not be called it.
- **Is 99 MB unusual for `bun build --compile`?** It embeds the runtime. If that is simply what
  a compiled Bun binary costs, the finding is about the deployment model, not about this code.
- **Does the VS Code extension share the problem?** It is a bundled CJS extension inside an
  already-running host, so probably not — which would mean the two surfaces have materially
  different cold behaviour, and only one of them is budgeted.

---

**Next stage:** Design — but only if the cold path is worth a number. It may be enough for
§11.7 to say it is unmeasured and why.
