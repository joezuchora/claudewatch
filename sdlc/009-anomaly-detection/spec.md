# Spec: let the metrics act, not just display

- **ID:** 009-anomaly-detection
- **Stage:** 2 — Design
- **Status:** accepted
- **Derived from:** [`intent.md`](./intent.md)

## Summary

`packages/metrics` gains a **pure detector** over stored events and a CLI that turns a breach
into a drafted `incident.md` plus a derived `intent.md`. Detection is separated from writing so
the bounds are testable without a filesystem.

## Design decisions

### Reluctance is the primary design property

Today's three red gates were one underlying cause and two of my own test bounds. A detector
firing per red run would have produced three incidents and trained everyone to ignore the
fourth. **A false positive costs more than a miss here**, because the mechanism's whole value
is that a raised incident means something.

Three guards, all required:

1. **Minimum sample.** No verdict until **20** `verify_run` events exist. Below that the
   detector returns `insufficient-data` — a distinct outcome, never "healthy".
2. **Sustained, not instantaneous.** A single breach never raises. A bound must be exceeded by
   **at least 2 events within the evaluation window**, except for the hang detector, where one
   event of the right magnitude is the signal.
3. **Suppression by fingerprint.** Each anomaly has a stable fingerprint (kind + a coarse
   bucket of its magnitude). A fingerprint raised within the last **24 h** is suppressed.

### The bounds

| Detector | Bound | Window | Rationale |
|---|---|---|---|
| `verify_duration_outlier` | a run exceeding **4×** the baseline p95 | latest run vs prior ≥20 | The 550 s hang against a ~30 s norm is 18×. 4× is far outside observed spread (max/p95 = 1.3 today) yet catches a real stall. Single-event, by design — a hang is not a trend. |
| `verify_pass_rate` | pass rate **< 70%** over the last 10 runs | last 10 | Below this the gate is not a gate. Needs ≥10 runs. |
| `schema_drift_spike` | **≥3** `schema_drift` events in 24 h when the prior 7 days had none | 24 h | `SPEC.md §3.1` calls the endpoint undocumented and best-effort; drift appearing from nothing is the case worth waking for. |
| `fetch_failure_rate` | **>50%** of `fetch_result` failing, ≥6 events | 24 h | Distinguishes a broken endpoint from ordinary flakiness. |

Every threshold is a constant in one exported object, so tuning is a one-line diff and a test,
not a hunt.

### Detection is pure; writing is a CLI

`detect(events, now, suppressions): AnomalyResult` takes an array and returns a verdict. No
clock, no filesystem, no store. Every bound is then testable by constructing events, which is
how a threshold gets tuned without a live system.

`cli-detect.ts` reads the store, calls `detect`, and writes drafts. Rejected: detection inside
the server (couples bounds to HTTP and makes them untestable without a running service).

### A draft is a draft — nothing is committed

The CLI writes `sdlc/<NNN>-<slug>/incident.md` and a derived `intent.md`, prints what it did,
and **stops**. It does not `git add`, commit, push, or open anything.

An autonomous loop that commits its own incident reports is a loop that can generate work for
itself indefinitely without a human ever seeing why. The drafts are picked up by the next
iteration, which reviews them like any other artifact.

### Suppression state lives beside the store

`~/.local/share/claudewatch-metrics/suppressions.json`, `0600`, atomic temp+rename. Not in the
repo — it is machine state, not project state, and committing it would make two machines
disagree about what has been raised.

## Behavior

`detect` returns one of:

- `{ status: 'insufficient-data', have, need }` — fewer than the minimum. **Not healthy.**
- `{ status: 'healthy', evaluated }` — bounds evaluated, none breached.
- `{ status: 'anomalies', anomalies: Anomaly[] }` — one or more breaches, each with kind,
  fingerprint, severity, a human summary, and the evidence that triggered it.

Suppressed anomalies are reported separately (`suppressed: Anomaly[]`) rather than silently
dropped — a detector that hides its own decisions cannot be debugged.

## Edge cases

| Case | Expected |
|---|---|
| Empty store | `insufficient-data`, never `healthy`. |
| Exactly 19 runs | `insufficient-data`. At 20, evaluation begins. |
| All runs identical duration | p95 == p50; no outlier. No division by zero. |
| One 550 s run among 30 × ~30 s | **Raises `verify_duration_outlier`.** The case this exists for. |
| The same 550 s condition next hour | Suppressed by fingerprint; reported as suppressed. |
| Pass rate 69% over 10 runs | Raises. At 70%, does not. |
| 2 drift events in 24 h | Does not raise — bound is ≥3. |
| Drift present in prior 7 days | Does not raise; it is not a spike, it is the norm. |
| Suppression file missing or corrupt | Treated as empty. Never blocks detection. |
| Clock skew in stored `ts` | Windows use `receivedAt`, as `003` specified. |
| A slug collision with an existing `sdlc/` directory | The CLI picks the next free `NNN` and says which. |

## Acceptance criteria

- [ ] Below the minimum sample, `insufficient-data` — never `healthy` — tested
- [ ] A 550 s run among ~30 s runs raises `verify_duration_outlier` — tested
- [ ] A run at 3.9× p95 does **not** raise; 4.1× does — tested at the boundary
- [ ] Pass rate 69% raises, 70% does not — tested at the boundary
- [ ] 2 drift events do not raise; 3 do — tested at the boundary
- [ ] Drift present in the baseline period suppresses the spike verdict — tested
- [ ] A repeat fingerprint within 24 h is suppressed and **reported as suppressed** — tested
- [ ] The same fingerprint after 24 h raises again — tested
- [ ] A corrupt suppression file does not block detection — tested
- [ ] The CLI writes `incident.md` and `intent.md` and commits nothing — tested
- [ ] `bun run verify` exits 0

Every boundary is tested from both sides. A threshold tested only from the firing side is a
threshold nobody has checked for false positives.

## Rejected alternatives

- **Fire on every red run.** What today would have produced: three incidents, one cause.
- **Statistical process control (3σ).** Assumes a distribution these durations do not have —
  they are bimodal by construction, fast or hung.
- **Auto-commit the drafts.** A loop that files its own tickets unattended.
- **Detect inside the server.** Couples bounds to HTTP; untestable without a running service.

---

**Next stage:** Build — run `/sdlc-plan 009-anomaly-detection`.
