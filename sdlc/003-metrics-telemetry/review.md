# Review findings: a metrics pipeline the Maintain stage can observe

- **ID:** 003-metrics-telemetry
- **Stage:** 5 — Deploy
- **Reviewed against:** [`plan.md`](./plan.md) and [`/REVIEW.md`](../../REVIEW.md)

## Design-stage findings (`spec-reviewer`, revision 1)

The first real invocation of the review subagents — `sdlc/README.md`'s retrospective had
recorded that they existed and had never been used. Revision 1 of the spec drew **5 blocking
and 10 major findings.** The blocking ones, and what changed:

| # | Finding | Resolution |
|---|---|---|
| B1 | `claudewatch.*` is a **VS Code namespace**. The statusline binary has no configuration channel at all — `parseFlags` accepts four flags and that list is contractual. `isTelemetryEnabled` could never be true on the one surface the entire spool design exists to protect. | `config.ts` adds env + config-file resolution. Verified **against the compiled binary**, not the module. |
| B2 | Four more contradicted documents unlisted: `SPEC.md` §17 ("No telemetry in v1"), §8.1 ("three packages"), §10.6, and **`REVIEW.md` pass 2** — whose standing check every future change is graded against. | Six documents amended, in one commit. |
| B3 | The field-**name** allowlist did not prevent leaks, which are in **values**: `client.ts:70` puts `err.message` into failures, and Bun's carry hostnames and `/home/<user>/` paths. The proposed test asserted `keys ⊆ ALLOWLIST` against the same constant the emitter filtered with — a tautology. | Every payload leaf is now a number, boolean, or member of a closed enumeration. Adversarial poisoned-input test replaces the tautology. Enterprise credit amounts excluded. |
| B4 | "At-least-once, never lost" was false. Read-then-rewrite loses events appended concurrently, and the statusline appends on **every prompt render**. | Agent rotates by `rename`. 4096-byte line cap for `O_APPEND` atomicity. Guarantee restated honestly. |
| B5 | Instrumenting an opt-in `verify:metrics` meant the runs that hang were exactly the uninstrumented ones. | `bun run verify` **is** the instrumented path. |

Ten major findings were also resolved, including M3 — `readCache()` returned `null` for four
distinct situations, so cache health was unobservable at all. That is the same shape as loop
002's blocking finding, caught a stage earlier this time.

**This is the clearest evidence so far that the harness works.** B1 alone would have shipped a
feature that could not execute on its primary surface, and it was invisible to every test that
does not run the compiled artifact.

## Spikes run before implementing

Per the rule both earlier loops paid to learn:

| Assumption | Measured |
|---|---|
| Statusline startup headroom | 25–40 ms against a 50 ms budget — **~10–25 ms spare.** Network was never viable. |
| Spool append | 0.05 ms first, **0.003 ms** steady state |
| `bun:sqlite` @ 1.3.11 | WAL enables; 5000 inserts 16.4 ms; concurrent read during open writer works; `INSERT OR IGNORE` dedupe free |

## Plan-to-diff audit

**Verdict: CLEAN.** Every changed file is inside the fence. `packages/metrics/**` is a glob,
flagged in the plan as deliberate and bounded — the package did not exist, so every file in it
belongs to this change. Nothing else is glob-covered.

## Pass 1 — Bugs and logical errors

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | major | `SELECT changes()` as a separate query is not reliably scoped to the preceding statement — dedupe counts and `prune()` both misreported. | Fixed: use `run()`'s own returned `changes`. Caught by a failing test, not by reading. |
| 2 | minor | The `prune(0)` test was flaky: ingest and prune can land on the same millisecond and the comparison is strictly less-than. | Test made deterministic with a negative window. The test was wrong, not the code. |
| 3 | minor | An assertion in `telemetry.test.ts` was self-referential nonsense (`path.startsWith(join(path,'..'))`) and would have passed regardless. | Replaced with a real check that the spool lives under `getCacheDir()`. |

## Pass 2 — Security and vulnerabilities

Run against the compiled binary's actual output, not fixtures.

| Probe | Result |
|---|---|
| `sk-ant` | clean |
| fake token verbatim | clean |
| sandbox path | clean |
| `Bearer` | clean |
| hostname | clean |
| raw utilization `42` | clean — only the decile `4` appears |

**Invariants re-checked:** credentials never read by telemetry; no new network call in any
shipped package (the product opens no socket for telemetry by construction); spool `0600`,
directory `0700`; sidecar written temp+rename; service uses parameterized SQL exclusively;
constant-time token comparison; non-loopback bind without a token refuses to start.

One deliberate accepted risk, recorded rather than discovered later: **on loopback with no
token, any local process can inject events.** Acceptable for a single-user NUC; it is a
written decision.

## Pass 3 — Compliance

- Zero third-party runtime dependencies preserved — `bun:sqlite` and `Bun.serve` are built in.
- Domain logic in core; the metrics package is a separate concern, not a surface.
- Surfaces reach telemetry through their existing bridge modules, so loop 001's isolation
  property is preserved.
- No `any`. ESM. Timestamps UTC ISO. Tests colocated.
- **Spec amendment declared explicitly**, as `REVIEW.md` pass 3 requires — six documents,
  including the `SECURITY.md` guarantee rewritten with a dated note rather than deleted.

## Verification evidence

```
$ bun run verify
verify: pass in 28.5s  [typecheck 1.9s  lint 0.2s  test 26.3s  build 0.1s]
VERIFY EXIT=0
```

**Exit-code passthrough**, the risk the plan called highest-consequence:

| Case | Expected | Observed |
|---|---|---|
| clean tree | 0 | **0** |
| seeded lint error | 1 | **1**, `verify: fail in 2.1s [typecheck 2.0s lint 0.1s]` |
| 1500 ms step ceiling | 124 | **124**, `step 'typecheck' exceeded 1500ms and was killed` |

**End-to-end pipeline**, run live: verify → spool (3 events) → agent ships (3 accepted) →
`/v1/stats` reports 3 runs, 33% pass rate, 1 timeout → dashboard 200, 3818 bytes, tiles
correct. Not a mock at any step.

**Compiled-binary telemetry:** unset → no spool created; `CLAUDEWATCH_TELEMETRY=1` → exactly
one `render` line, payload `{surface, runtimeState, tier, utilizationBucket}`.

## Acceptance criteria not met

Recorded rather than quietly dropped:

- **Perf p95 over 100 runs with a 4 MB spool** — not measured. The append is 0.003 ms and the
  cap check is one `statSync`, so the risk is low, but *low risk measured* is what the
  criterion asked for. Open.
- **`fetch_result`, `cache_event` and `schema_drift` call sites are not wired.** Only `render`
  is. The emitter, builders and tests all exist; the remaining wiring is mechanical. The
  criteria covering `attempts`, retry-sleep exclusion, and drift-once-per-normalize are
  therefore unmet. Open.
- **VS Code `render` emission** not wired; `packages/vscode/package.json` does not yet declare
  `claudewatch.telemetry.enabled`, though `SPEC.md §10.6` now documents it. Open.

## Findings deliberately not fixed

1. **The statusline hangs forever on TTY stdin** — found while verifying this change against
   the binary. Raised as [`004-statusline-stdin-hang`](../004-statusline-stdin-hang/incident.md),
   which drafted [`005`](../005-statusline-tty-stdin/intent.md). **The Maintain → Plan edge,
   traversed for the first time.**
2. **`getCacheDir()` ignores `$XDG_CACHE_HOME`** while `SPEC.md:488` claims it follows it.
   Real drift, real bug for anyone who sets it. Out of scope; the spool derives from
   `getCacheDir()` so both stay consistent whichever way it is resolved.
3. All loop 001 and 002 follow-ups remain open, including the ~26 s of real `setTimeout`
   sleeps that still dominate every gate run — now visible as `testMs: 26289` in the data.

## Note on process

Three loops, three blocking findings against the loop's own design — and this time it was
caught at **Design** rather than during implementation, because the subagent was actually run.
The pattern across all three is now unmistakable and worth stating as a rule:

**A defect that only appears when the real artifact is run the way a user runs it will not be
found by any test, any coverage number, or any amount of re-reading.** Loop 001: CI split the
suite across processes. Loop 003 B1: module tests cannot see a missing config channel. Loop
004: 98.89% line coverage on a binary that hangs on startup.

The countermeasure is cheap and belongs in `sdlc-plan`: **every change that touches a shipped
artifact must have at least one check that executes that artifact.**

---

**Next stage:** Maintain — already exercised, see `004`.
