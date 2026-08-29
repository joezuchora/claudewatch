# Plan: the detector reports its input's freshness, and says what it cannot judge

- **ID:** 037-detector-input-freshness
- **Stage:** 3 — Build
- **Reads:** `sdlc/037-detector-input-freshness/spec.md`
- **Date:** 2026-08-29

## Scope fence

Five paths, one package plus one script. No product surface, no `deploy/`, no `SPEC.md`.

| Path | Change | Criterion |
|---|---|---|
| `packages/metrics/src/anomaly.ts` | `InputFreshness`; `measureFreshness`; `formatFreshness`; `ANOMALY_KINDS` as a value with `AnomalyKind` derived from it; `freshness` on all three `DetectResult` variants | A2–A9 |
| `packages/metrics/src/anomaly.test.ts` | every criterion except A6's CLI half and A13 | A2–A5, A7–A9 |
| `packages/metrics/src/cli-detect.ts` | render the line **above** the `insufficient-data` exit at `:176` | A6 |
| `scripts/arrival-dist.ts` | **new** — both clocks, plus the kind census | A13 |
| `scripts/arrival-dist.test.ts` | **new** — so the script is not a second `cli-ship.ts` | A13 |

**Explicitly not touched:** `packages/metrics/src/detector-input.ts`,
`packages/metrics/src/store.ts`, `packages/metrics/src/server.ts`,
`packages/metrics/src/dashboard.ts`, `packages/metrics/src/agent.ts`,
`packages/metrics/src/cli-ship.ts`, `packages/metrics/src/types.ts`,
`packages/core/src/telemetry.ts`, `packages/core/src/client.ts`,
`packages/statusline/src/main.ts`, `packages/vscode/src/extension.ts`,
`scripts/verify.ts`, `scripts/fence-check.ts`, `scripts/lint-budget.ts`,
`SPEC.md`, `CLAUDE.md`, `REVIEW.md`, `.oxlintrc.json`,
`deploy/systemd/claudewatch-sdlc-loop.timer`, `deploy/systemd/claudewatch-ship.timer`,
`deploy/README.md`, `sdlc/fence-baseline.json`.

> **`store.ts` is on the negative fence deliberately.** The spec's `RETENTION_DAYS = 90` edge case is
> *accepted, not fixed* — after a 90-day outage the store empties and this loop's headline degrades
> to `never`. A reader who expects that to have been handled should find the file named here.

> **`package.json` is absent from both sides, and `arrival-dist` gets no `scripts` entry.** Adding
> one would make the token script-name-resolvable (loop 036's Rule 3) and would put `package.json` in
> play, where `inFence`'s basename-tail match covers all five committed manifests — the trap loops
> 033 and 035 both paid for. Invoked as `bun run scripts/arrival-dist.ts <dbPath>`; the path is the
> interface.

> No bare directory entries anywhere, and no `except` clause.

**Heading-token check, run before writing this fence.** Loop 037's `spec.md` yields three backticked
heading tokens: `detect()` and `detect` both resolve to `packages/metrics/src/anomaly.ts`, which is
on the **positive** side so neither fires; `insufficient-data` classifies `not-a-symbol` via the
hyphen — loop 035's recorded S-5 false negative, still unfixed. **`unresolvedSymbols` stays 14 and
`sdlc/fence-baseline.json` needs no edit**, which is why it is on the negative fence.

**On `sdlc/README.md`:** Stage 6's retrospective lands in its own commit after `review.md`.

## Changes

### 1. `anomaly.ts` — `ANOMALY_KINDS` as a value (A8)

```ts
export const ANOMALY_KINDS = [
  'verify_duration_outlier', 'verify_pass_rate', 'schema_drift_spike', 'fetch_failure_rate',
] as const;
export type AnomalyKind = typeof ANOMALY_KINDS[number];
```

**A8 is not redundant with A12, and I checked rather than assumed.** `AnomalyKind` appears in exactly
two places (`anomaly.ts:55` declaration, `:62` as `Anomaly.kind`) and **there is no exhaustive switch
on it anywhere**. So adding a fifth member typechecks silently and no existing test notices. A8 is
the only mechanical thing that would catch it. `BOUNDS` has ten keys today, pinned the same way.

The review's suggestion that A8 might be redundant was reasonable and is wrong on this codebase.

### 2. `anomaly.ts` — `measureFreshness` (A2, A3, A4, A9)

```ts
export interface InputFreshness {
  newestArrivalAgeMs: number | null;      // any kind, by receivedAt
  newestRunArrivalAgeMs: number | null;   // verify_run, by receivedAt
  newestRunEmittedAgeMs: number | null;   // verify_run, by ts
}
export function measureFreshness(events: readonly StoredEvent[], now: number): InputFreshness;
```

Three fields because two varied by clock **and** population, so a difference had two causes. Each age
is `now - max(parsed timestamps)`, with `Number.isFinite` filtering unparseable values out of the max
rather than letting one `NaN` poison it — the guard `anomaly.ts:131` already applies for the same
reason. `null` when the population is empty **or** every member's timestamp is unparseable.

Negative ages (emitter skew, sdlc/003) are **kept raw on the result** and clamped only at render, so
a test can see the sign.

### 3. `anomaly.ts` — `formatFreshness` (A5)

The ladder is pinned in the spec, so this is transcription rather than design: `null → never`,
negative → `0s`, `<60s → Ns`, `<60m → Nm`, `<24h → Nh Mm`, `>=24h → Nd Mh`.

Deliberately **not** `agent.ts`'s `formatAge`: that one has no day unit and renders a 365-day age as
`8760h 0m`. Recorded in the spec's *Rejected alternatives* so the next reader does not "fix" it.

### 4. `anomaly.ts` — `freshness` on `DetectResult`

All three variants. `detect` computes it once from its `events` argument before branching, so
`insufficient-data` carries it too — which is where a pipeline that broke early lands.

No consumer constructs a `DetectResult` (the type appears only inside `anomaly.ts`), so this is
source-compatible by inspection; `typecheck` covers only `detect`'s own three return sites.

### 5. `cli-detect.ts` — one line, above the early exit (A6)

`cli-detect.ts:176-180` returns and `process.exit(0)`s **before** `formatBaseline` and the suppression
lines. The freshness line goes above line 176 or `insufficient-data` will not carry it. Order:
freshness, then `baseline:`, then `suppressed`, then the verdict.

### 6. `scripts/arrival-dist.ts` — the re-runnable measurement (A13)

```
bun run scripts/arrival-dist.ts /root/.local/share/claudewatch-metrics/metrics.db
```

Prints the gap distribution on **both** clocks and a kind census. **This is the artifact the intent
asked for and the first spec draft did not deliver** — and it exists because the first draft's
central number was measured on the wrong column. A pasted table cannot be re-run; a script can.

Read-only (`new Database(path, { readonly: true })`), takes the path as an argument with no default,
and prints nothing but numbers and kind names — no path echo, per §12.

### 7. `scripts/arrival-dist.test.ts` — because an untested script is a known gap here

`cli-ship.ts` went four loops with no test file and it took loop 036 *needing* a subprocess to close
it. This script's distribution maths is exactly the kind that is silently wrong, so it ships with a
test: a synthetic event list with known gaps, asserted percentile-by-percentile, plus the empty and
single-event cases.

The distribution function is exported and takes an array, so the test needs no database.

## Test mapping

| Criterion | Test |
|---|---|
| A2 | `anomaly.test.ts` — three: `the arrival age is the newest event of any kind`, `the run arrival age ignores other kinds`, `the run emitted age uses ts, not receivedAt` |
| A3 | `a drained backlog reads as fresh arrival, old emission` — one `receivedAt`, `ts` spanning hours. **B4's discriminator, as a test.** |
| A4 | `an input with no verify_run reports a fresh arrival and null run ages` — fixture is synthetic; the live store has never held a non-`verify_run` event |
| A5 | `formatFreshness renders every ladder boundary` + `null renders never, not 0s` + `a negative age clamps to 0s` |
| A6 | `insufficient-data carries freshness` (on the result) + `cli-detect prints the line before the insufficient-data exit` (subprocess) |
| A7 | `a 365-day-old store is still healthy, and says so` — status unchanged, age rendered `Nd Mh` |
| A8 | `ANOMALY_KINDS is exactly the four current members` + `BOUNDS has exactly its ten current keys` |
| A9 | `a population with a known newest age yields exactly that age` |
| A10 | the table below |
| A11 | the gate enforces it |
| A12 | the Stage 5 audit and `fenceCheck` |
| A13 | `arrival-dist.test.ts` — `both clocks are reported` + `the percentiles match a known distribution` + `an empty input does not divide by zero` |

### Mutation predictions — written before the run (A10)

**Every named test below is one this plan commits to writing. Loop 036 recorded two predictions
against tests that did not exist; the check is to grep for the name before scoring the row.**

Traced for early returns: `measureFreshness` has no ordered guard chain — the three ages are computed
independently — so per-rule prediction is sound here, unlike `classifyToken` in loop 035. Where I
expect no cross-cutting failure I say so, because that is a prediction too.

| # | Mutation | Predicted |
|---|---|---|
| M1 | `measureFreshness`: drop the `kind === 'verify_run'` filter on the run ages | **2** — A2's `the run arrival age ignores other kinds` and A4. Not A3 (its fixture is all `verify_run`, so the filter is a no-op there). |
| M2 | `newestRunEmittedAgeMs` computed from `receivedAt` instead of `ts` | **1** — A3 only. A2's third test uses the same fixture shape, so if it does *not* also fail, my fixture is not varying the two clocks and the test is weaker than its name. |
| M3 | drop the `Number.isFinite` filter | **1** — a `NaN` fixture makes the max `NaN`; A5's `null` case is unaffected because the population is non-empty. |
| M4 | `formatFreshness`: remove the negative clamp | **1** — A5's clamp assertion. |
| M5 | move the `<24h` ladder boundary to `<48h` | **2** — A5's boundary test and A7 (a 365-day age still renders `Nd Mh`, but a 30-hour one would flip). If A7 does not fail, its fixture is far enough out that the boundary cannot reach it, which is fine and worth recording. |
| M6 | `null` renders `0s` instead of `never` | **1** — A5. |
| M7 | add a fifth member to `ANOMALY_KINDS` | **1** — A8 only, **and nothing else in the repo**. Verified: no exhaustive switch on `AnomalyKind`, so `typecheck` stays green. This is the row that justifies A8 existing. |
| M8 | move the freshness render below `cli-detect.ts:176` | **1** — A6's subprocess half. The result-side half still passes, which is the point of having both. |
| M9 | `arrival-dist`: report `ts` for both clocks | **1** — A13's `both clocks are reported`. **This is the first draft's actual defect, as a mutation.** |

## Risks

- **`anomaly.test.ts` carries an `oxlint` budget row** (`oxc(no-map-spread)`, count 1) and its
  fixture helpers (`ev()`, `baselineRuns`) do not vary `ts` — every baseline run shares one. Extending
  them is budget-relevant, and A11 pins the budget at 8 rows / 10 warnings. If the extension trips a
  new warning, the fix is the code, not the record.
- **`AnomalyKind` changes from a hand-written union to a derived type.** Members are identical and A8
  proves it; `typecheck` proves nothing here, which is exactly why A8 is not redundant.
- **A6's subprocess half needs a sandboxed store.** `HOME` and `XDG_CACHE_HOME` to a `mktemp -d`,
  and `CLAUDEWATCH_METRICS_DB` to a scratch file — never `~/.cache/claudewatch/`, never the real
  metrics DB, which `cli-detect.ts:171` would otherwise open.
- **`arrival-dist.ts` opens a SQLite database.** Read-only, path from argv, no default — so it cannot
  be run accidentally against the live store by a test.

## Out of scope, recorded

- **The retrospective hole detector.** Constructible, its discriminator named in the spec's B4
  (*a hole in `receivedAt` filled with `ts` values is a shipping outage; a hole in both is an
  absence*). Not built: every arrival number available comes from a host with no systemd, so its
  threshold would be fabricated. `anomaly.ts` keeps `AnomalyKind` unchanged and A8 enforces that.
- **`RETENTION_DAYS = 90` erasing the freshness number** after a 90-day outage. Accepted, recorded,
  `store.ts` fenced.
- **Cross-host clock skew** between the store host and the detector host. Single box today.
- **`evaluated` being window-dependent**, and the dropped `inputEvents` that pinned at 1000.
- **loop 035's S-5**: a hyphenated token (`insufficient-data`) lands in the unasserted `notASymbol`
  bucket. This loop's own spec is an instance of it.

---

**Next stage:** Build/Test — run `/sdlc-implement 037-detector-input-freshness`.
