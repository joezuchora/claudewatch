# Review findings: let the metrics act, not just display

- **ID:** 009-anomaly-detection
- **Stage:** 5 — Deploy

## Plan-to-diff audit

**Verdict: CLEAN.** All changed files inside the fence.

## Pass 1 — Bugs and logical errors

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | **blocking** | Ordering by `receivedAt` alone made "the latest verify run" **arbitrary**. The store stamps `receivedAt` at ingest, and the agent ships a whole spool as **one batch** — so every event in a batch shares a `receivedAt` and cannot be ordered by it. The detector reported `healthy` with a 550 s hang sitting in the data. | Ordering is now `(receivedAt, ts)`; windows still filter on `receivedAt` per `003`. Regression tests added for both directions. |
| 2 | minor | Unused import in `cli-detect.ts`. | Caught by the lint step. |

**Finding 1 is the significant one, and how it was found matters more than what it was.**
Every fixture in `anomaly.test.ts` hands each event a distinct `receivedAt`, because that is
what a person writing fixtures naturally does. The bug only exists when events arrive the way
they actually arrive — batched. It surfaced the moment the CLI ran against a real store, and
not a moment before.

That is the **fourth** time in this project that running the real thing caught what fixtures
could not: loop 001 (CI split the suite across processes), loop 003 B1 (module tests cannot see
a missing config channel), loop 004 (98.89% coverage on a binary that hangs), and now this.

## Pass 2 — Security and vulnerabilities

No findings. Reads the store, writes Markdown under `sdlc/` and a suppression file under the
user's data directory. No network, no credentials, no execution of anything it reads.

Two deliberate restraints:

- **Nothing is committed or pushed.** An autonomous loop that files its own tickets is one
  that generates work for itself with nobody seeing why. It writes and stops.
- **Suppression state lives outside the repo**, in `~/.local/share/claudewatch-metrics/`. It
  is machine state; committing it would make two machines disagree about what has been raised.

## Pass 3 — Compliance

Zero third-party runtime dependencies preserved. No `any`. Detection has no I/O, so it is
testable without a filesystem — the property that made two-sided boundary testing practical.

## Verification evidence

```
$ bun run verify
verify: pass in 33.5s  [typecheck 2.0s  lint 0.1s  test 31.2s  build 0.2s]
VERIFY EXIT=0
```

`anomaly.test.ts`: **25 pass**, every bound asserted from both sides.

**Against this repository's real metrics store:**

| Condition | Output |
|---|---|
| 3 runs stored | `insufficient data: 3 verify runs, need 20. No verdict.` |
| 26 runs stored, incl. today's 3 red gates | `healthy: 26 verify runs evaluated, no bounds breached.` |
| 25 runs + a seeded 550 s hang | `[high] A verify run took 550.0s against a baseline p95 of 32.3s — 17.0x` → drafted `incident.md` + `intent.md` |
| Same condition, second run | `suppressed (raised within 24h): verify_duration_outlier:5` |

**The second row is the result worth keeping.** Today the gate went red three times; two were
my own test bounds and one was a correction to the other — one underlying cause. A detector
firing per red run would have produced three incident records and taught everyone to ignore
the fourth. This one stayed quiet, correctly, on real data.

The drafts it writes are deliberately hedged: the incident template says *"treat every line
below as a claim to check, not a finding"* and refuses to guess a root cause, citing the three
occasions in this repo where the first theory was wrong.

## Findings deliberately not fixed

1. **The bounds are calibrated against 26 data points from one machine.** They are defensible
   — 4× p95 against an observed max/p95 of 1.3 — but they are not validated across
   environments. First retune should be evidence-driven, and `BOUNDS` plus two-sided tests are
   built to make that cheap.
2. **The detector is not wired into the hourly loop.** `bun run metrics:detect` exists and is
   not called by `deploy/systemd/claudewatch-sdlc-loop.service`. Deliberate: it should be
   watched for a while before it is allowed to generate artifacts unattended.
3. **11 lint warnings** across the tree, several newly surfaced (`unicorn/no-array-sort`,
   `consistent-function-scoping`). Warnings, not errors; out of scope here; growing.
4. Prior follow-ups unchanged: the 51 ms p95, `FailureClass`'s missing timeout, the vscode
   bridge mock, `extension.ts` having no tests.

## Note on process

The design spent most of its effort on **not firing**: a minimum sample, a distinct
`insufficient-data` verdict, fingerprint suppression, and two-sided boundary tests. That was
the right allocation. A monitor's failure mode is not missing an event — it is crying wolf
until nobody looks, and this repo produced a perfect worked example of the temptation on the
same day the detector was written.

---

**Next stage:** Maintain — by the thing built here, for the first time.
