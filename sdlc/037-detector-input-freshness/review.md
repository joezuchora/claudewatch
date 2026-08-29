# Review: the detector reports its input's freshness, and says what it cannot judge

- **ID:** 037-detector-input-freshness
- **Stage:** 5 — Deploy
- **Reads:** the diff `42dbc6f..d56bd47`, `plan.md`, `REVIEW.md`
- **Date:** 2026-08-29

## Summary

Shipped. Both reviewers returned; neither returned clean.

`metrics:detect` now prints three ages on every verdict, above the `insufficient-data` exit. Live
against the real store:

```
input: newest arrived 9s ago; newest verify run arrived 9s ago, emitted 39s ago
baseline: p95 29651ms over 50 runs (window 50), threshold 120000ms
healthy: 320 verify runs evaluated, no bounds breached.
```

**The honest headline is that this loop shipped the same defect class three times, and caught it
once itself.** A test named for a guard that does not exercise it — M9 in the implementation commit,
which I found; the `Number.isFinite` test in that *same commit*, which the audit found; and a
security guard left inline in `main()` where no test could reach it, which the security pass found
after I had already been corrected on exactly that in the same file.

| Stage | Found | Outcome |
|---|---|---|
| 2 — spec review | 3 blocking, 10 major | M1 measured on the wrong column; the decline re-argued |
| 5 — plan-to-diff | 1 vacuous test, 1 false comment, 1 ladder bug, 2 hygiene | all fixed |
| 5 — security | 1 major with a live exploit, 4 minor | fixed and mutation-verified |

## Commits

| Commit | What |
|---|---|
| `f49bda6` | intent |
| `7aaefde` | spec |
| `f47f48d` | spec revision after the Stage 2 review |
| `42dbc6f` | plan |
| `7eb68a1` | implementation |
| `2c83423` | plan-to-diff remediation |
| `d56bd47` | security remediation |

## Pass 1 — Bugs and logical errors

### The Stage 2 review: the loop's central number was measured on the wrong column

`M1 — the arrival distribution` was the **`ts`** distribution. Every window in `anomaly.ts` filters
on `receivedAt`, so a staleness bound would be evaluated on the arrival clock — the one row not
measured. Against arrivals, six hours is **2.08×** the observed maximum, not 6×, and there is one gap
over two hours, not zero.

That changed the decline's argument, not its conclusion. **The retrospective form of the bound is
constructible**, and the two clocks are what decide it:

> A hole in `receivedAt` that is **filled with `ts` values** is a shipping outage — events kept being
> emitted and spooled. A hole in **both** is an absence: `Persistent=true` fires one catch-up run on
> boot and the hole contains zero `ts` values.

Not built, on evidence rather than principle: **the measured host has no systemd** (`ls
/run/systemd/system` — absent), so its 60-minute arrival cadence is the hourly SDLC routine, not
`claudewatch-ship.timer`'s five minutes. A threshold from that data would be a fabricated baseline.
Loop 036's *"deferred, not declined"* is now answered with the specific form named.

The review also caught that I had **inverted my own evidence**: zero firings on known-good data is
the *precondition* for shipping a bound in a module whose docstring opens *"RELUCTANCE IS THE
POINT"*, not a reason against one.

### B-1 (fixed) — a test named for a guard that did not exercise it

`an unparseable timestamp is excluded from the max` listed the **good** event first, so deleting the
`Number.isFinite` guard left it green. Named for the guard, did not touch it.

**And the comment I wrote in the same commit was false in the dangerous direction.** I had claimed a
*mixed* population is safe without the guard, reasoning that NaN never wins a comparison. True — but
`newest === null ||` short-circuits and admits NaN unconditionally, so the **first** event sets
`newest` regardless of whether it parsed. Measured: bad-first → `NaN`, good-first → correct.

> **The comment has now been wrong twice, in opposite directions, and the second was worse.** The
> original over-claimed ("one NaN poisons the whole result" — this is not `Math.max` and the damage
> is order-dependent). My correction under-claimed, and a reader who believed it had a stated licence
> to delete a live guard. `store.query` does not order by parseability, so bad-first is reachable the
> moment one malformed `ts` lands ahead of a good one.

Fixed by putting the bad event first; M3 now fails 2 where it failed 1. The later-position case is
kept as its own test, because a reader should be able to see both halves stated.

### B-2 (fixed) — the ladder carried out of its own bands

`Math.round` produced `60s`, `3599999 → 60m`, `86399999 → 23h 60m`, `31535999999 → 364d 24h`. None
is in the spec's pinned ladder, and `23h 60m` is reachable for roughly **1.7% of all ages** against a
moving clock. My test was named *"the ladder is exactly what the spec pinned"* and asserted only
interior points, so it never saw an edge. `Math.floor` throughout; the four edges are now asserted;
a new M10 mutation kills exactly that test.

### B-3, B-4 (fixed) — two hygiene findings

The subprocess sandbox set the three env vars the plan's risk note named and missed
**`CLAUDEWATCH_REPO`**, the only one gating writes into the working tree. And `arrival-dist.ts`
contained a **fourth copy of the percentile rule**, two hundred lines from `anomaly.ts`'s docstring
explaining why there should not be a third.

> The second is the one worth keeping. This loop draws the reuse-versus-preference distinction
> **correctly** for `formatAgeMs` — deliberately *not* shared with `agent.ts`'s `formatAge`, because a
> unit ladder is a preference — and then got it backwards one file over, for a rule. Getting a
> principle right in one place is not evidence of applying it in the next.

## Pass 2 — Security and vulnerabilities

### F1 (MAJOR, fixed) — the replacement instrument was forgeable

The census line was the **first human-facing print site for `kind` anywhere in the repo**. Before
this diff there were only `=== 'verify_run'` comparisons and bound SQL parameters. `kind` is free
text: `normalizeIncoming` accepts any string with no charset or length bound, and `POST /v1/events`
binds loopback **with no token by default**.

Reproduced, escapes shown with `cat -v`:

```
kinds: ^[[2J^[[1;1Hkinds: verify_run=99999^[[8m LEAK-/home/joe/.credentials.json=1 verify_run=2
```

On a terminal that clears the screen, homes the cursor, prints a forged census, and conceals the gap
lines the operator ran the script to read.

> **This script exists because the first spec draft trusted a measurement whose provenance it had not
> checked. An instrument that anyone able to write one row can forge is not an improvement on that.**

Fixed by scrubbing and length-bounding at the read — reusing `scrubControls` from `fence-check.ts`
rather than writing a third copy, which is the same reuse argument this file's own header already
makes for `percentile`, and which I had got wrong one commit earlier.

**The guard was inline in `main()`**, exactly as untestable as the clock pairing before
`distributionsFor` — the same lesson, twice, in one file. Extracted as `formatCensus`; M11 (drop the
scrub) and M12 (drop the validation) each now fail a test that did not previously exist.

### F2–F4 (MINOR, fixed)

- **Two `.all() as T` assertions** on rows from a database whose contents arrive over HTTP. SQLite
  applies per-value type affinity, so `TEXT NOT NULL` does not guarantee a string. Now validated,
  dropping rows that fail rather than coercing them.
- **The header claimed "Read-only" flatly.** SQLite enforces that for *contents* — an INSERT fails, a
  missing file is not created, both verified — but a WAL open creates `<path>-shm` and `<path>-wal`
  at the umask default. Measured: `0644`, 32 KiB and 64 KiB, left after `close()`. Claim corrected
  rather than softened away. `immutable=1` would avoid them and is deliberately not used: it assumes
  a quiescent database, and this runs by hand against a live one.
- **A second write path in the test sandbox.** `writeSuppressions()` resolves
  `CLAUDEWATCH_SUPPRESSIONS ?? dirname(defaultDbPath())` and was contained only by `HOME` flowing
  through `os.homedir()`. On Windows `homedir()` reads `USERPROFILE`, which the replacement `env`
  drops. Latent, not live; now explicit.

### Cleared, and stated as cleared

**The freshness line itself is clean, and structurally so:** `formatAgeMs` consumes wire timestamps
as **numbers** behind `Number.isFinite`, so no wire string reaches stdout on that path — the
`ts`-verbatim concern is real for `store.ts` and does not apply here. The `payload` column is never
read by the new script (both SQL statements verified). Importing `percentile` from `anomaly.js`
drags no side effect — `strace` shows the only project file opened is `anomaly.ts`, whose sole import
is a type. No token, no path, no hostname in any output. No new write except the test's `mkdtemp`.
No `fetch`, no TLS constant, no `execSync`. `ANOMALY_KINDS`'s union-to-derived change is
behaviour-preserving.

## Pass 3 — Compliance

| Rule | Verdict |
|---|---|
| Domain logic in `packages/core` | N/A — this is metrics tooling under `source: 'sdlc'` |
| No `any` | Clean; the validators narrow from `unknown` |
| ESM, strict TS | Clean |
| UTC ISO internally | Unchanged; ages are internal millisecond numbers, never displayed raw |
| Reuse before adding | **Failed once and fixed**: the percentile copy (B-4). `scrubControls` reused rather than copied. |
| VS Code bundle CJS | N/A |

## Acceptance criteria

| # | Verdict |
|---|---|
| A1 | **MET** — verify pass, CI green on every pushed commit |
| A2 | **MET** — three named tests, each with a population where the other ages differ |
| A3 | **MET** — the drained-backlog discriminator, as a test |
| A4 | **MET** — fixture is synthetic; the live store has never held a non-`verify_run` event |
| A5 | **MET after remediation.** Initially **FAILED**: "every ladder boundary" asserted only interior points, and the band edges rendered outside the ladder. |
| A6 | **MET** — result half plus three subprocess tests |
| A7 | **MET** — status unchanged at `healthy`, age rendered `365d 0h` |
| A8 | **MET, and load-bearing.** M7 confirms: a fifth member fails exactly one test and `typecheck` stays green, because nothing switches exhaustively on `AnomalyKind`. The Stage 2 reviewer's redundancy suggestion was wrong on this codebase. |
| A9 | **MET, weakly.** A single-event fixture where all three ages coincide. It satisfies the criterion as written and establishes nothing beyond it — recorded rather than claimed as strong. |
| A10 | **MET** — twelve mutations, tabulated below |
| A11 | **MET** — 8 rows / 10 warnings. The gate rejected the first A7 fixture for `oxc(no-map-spread)`, the risk the plan named; the code changed, not the record. |
| A12 | **MET** — no file outside the fence; `fenceCheck` zero findings; `unresolvedSymbols` 14, exactly as the plan predicted |
| A13 | **MET, with one shortfall.** The script reproduces M1 on both clocks; it does **not** print the span, so M1's "3.00 days" is still a pasted number. |

**Two plan-committed test names do not exist**: `null renders never, not 0s` and `a negative age
clamps to 0s`. Both assertions exist, folded into other tests. Coverage is real; the names the plan
committed to grepping for are not — which is the check loop 036 added, defeated by renaming rather
than by absence.

## The mutation record

| # | Predicted | Actual | Verdict |
|---|---|---|---|
| M1 | 2 | 3 | under (the extra is A2's own positive precondition) |
| M2 | 1 | 3 | under — **and the plan demanded one of them**: *"if A2's third test does not also fail, my fixture is not varying the two clocks"*. It did. |
| M3 | 1 | 1 | count right, **reasoning wrong, and the surviving test was vacuous** |
| M4 | 1 | 1 | exact |
| M5 | 2 | 1 | over — the plan gave the reason in advance |
| M6 | 1 | 3 | under |
| M7 | 1 | 1 | exact, **and `typecheck` stayed green** — the row that justifies A8 |
| M8 | 1 | 2 | under |
| M9 | 1 | **0** → fixed → 2 | **the finding of the implementation** |
| M10 | — | 1 | added at Stage 5 for the ladder fix |
| M11 | — | 1 | added at Stage 5 for the scrub |
| M12 | — | 1 | added at Stage 5 for the validation |

The audit independently re-ran all nine originals and confirmed no row recorded as correct was
incorrect. It also ran the **inverse** of M9, which the plan did not list, confirming the fix is
symmetric rather than aimed at one direction.

## Recorded, not fixed

- **The retrospective hole detector.** Constructible, discriminator named, deferred for want of a
  host where `claudewatch-ship.timer` is enabled. `AnomalyKind` unchanged and A8 enforces it.
- **`metrics:detect` still reports `healthy` on a store that stopped growing a year ago.** This loop
  adds a fact, not a verdict. That was the intent's headline and it remains open by design.
- **`RETENTION_DAYS = 90` erases the number in the worst case.** After a 90-day outage `prune()`
  empties the store and the headline degrades from `91d 0h` to `never`, with `detect` flipping to
  `insufficient-data`. Accepted; `store.ts` fenced.
- **A9 is weak** — a single-event fixture where all three ages coincide.
- **A13 does not print the span**, so one of M1's two headline figures is still hand-pasted.
- **The `unknown` ladder rung** is not in the spec's B3 table and guards an input the shipped call
  graph cannot produce. Kept because `formatAgeMs` is exported; recorded as unplanned.
- **`arrival-dist.ts` has no `LIMIT`** on its row query, unlike `store.query`'s clamp to 1000.
  Bounded in practice by retention.
- **`evaluated` is window-dependent**, varying with how much other-kind traffic crowds the
  1000-event general window.
- **Cross-host clock skew** between store host and detector host. Single box today.

---

**Next stage:** Maintain — the retrospective lands in `sdlc/README.md`. No incident: nothing shipped
broken, and the forgeable-instrument path was closed before merge.
