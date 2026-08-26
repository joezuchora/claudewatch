# Review findings: give the duration detector a window it actually controls

- **ID:** 012-rolling-baseline
- **Stage:** 5 — Deploy
- **Reviewed against:** [`plan.md`](./plan.md) and [`/REVIEW.md`](../../REVIEW.md)
- **PR:** #16
- **Head commit:** the `sdlc(012)` commits on `claude/ai-sdlc-setup-plan-nqyqbk`

## The headline

This is the first change in the project where the review subagents rejected the **design**
rather than finding defects in the code, and then caught the implementation **overstating
itself**. Both are recorded below, at more length than the code changes, because that is where
the value of this round actually sat.

## Plan-to-diff audit

Verdict: **excursions recorded** — fence intact, every `Changes` entry shipped, two real gaps.

- **Files changed outside the scope fence:** none. All eight paths are in the fence, which is
  path-literal with no globs.
- **Plan items with no corresponding change:** one — `sdlc/README.md` was fenced but never
  scheduled, and it still documented the behaviour this loop deleted.

| # | Finding | Resolution |
|---|---|---|
| A1 | **The commit message's "every new test was checked by mutation" was overstated.** True of `anomaly.test.ts`; false of `detector-input.test.ts`, where 4 of 7 passed unchanged against the pre-change composition. | **Fixed.** Two rewritten to flood the store so they discriminate; the tautology deleted; the dedup test relabelled — it *cannot* discriminate by construction, since it guards a hazard this change introduces, and now says so. |
| A2 | `expect(GENERAL_LIMIT).toBe(1_000)` asserted a literal against the literal one file over. It could not fail for any implementation. | **Fixed.** Test deleted and the constant made module-private — it was a new public symbol the plan never described. |
| A3 | `sdlc/README.md:103-107` asserted as current that "the baseline is **not** rolling: `detectDurationOutlier` builds it from `runs.slice(0, -1)`, every retained run." | **Fixed.** Superseded in place with a dated note; the wrong sentences are left standing, since this is the *second* correction to that bullet and the sequence is the finding. |
| A4 | The anomaly `summary` was rewritten but the plan described only `evidence` changes, and no test asserted the new wording. | **Fixed.** Plan amended; the summary is now asserted verbatim. |
| A5 | The spawn test discriminates against `anomaly.ts`/`cli-detect.ts`, not against the input composition — its fixture has 25 runs and no flood. | Accepted and recorded. It is an end-to-end wiring check, not a regression test for the defect; the two flood tests carry that. |
| — | The auditor reported `git status` showing tracked files as untracked, calling it a stale-index artifact. | Not reproduced. `git status --short` and `git diff HEAD` were clean at the time and after. Recorded as an artifact of the agent's own snapshot, not a repo state. |

## Pass 1 — Bugs and logical errors

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | major | **I wrote a test asserting a *cap* where the design provides a *floor* — twice.** First that the kind-scoped query caps verify runs at 51 (it guarantees a minimum); then that the drift lookback excludes ancient events outright (the general query still sweeps recent ones regardless). | Both **fixed**, both caught by the test failing immediately. Recorded rather than quietly corrected: the same wrong property substituted for the right one twice in one afternoon, which says something about how plausible the wrong one feels. |
| 2 | minor | A block comment containing `sdlc/NNN-*/incident.md` closed itself early on the `*/` and broke the parse. | Fixed. Caught in under a second by the test run — the cheapest possible failure. |
| 3 | — | With only 19 samples the window of 50 is not yet full, so p95 is still the maximum and the pre-011 runs still dominate. | Not a defect. The fix makes the number *legible*, not smaller; it re-anchors as runs accumulate. Stated here so nobody reads the unchanged 270 s wire as the change having failed. |

## Pass 2 — Security and vulnerabilities

Seven findings, no blocking or major. Five acted on.

| # | Severity | Finding | Resolution |
|---|---|---|---|
| S1 | minor | **`evidence.outcome` is unvalidated free text from the ingest endpoint, written verbatim into an `incident.md` a human reads and acts on.** `normalizeIncoming` accepts any object as `payload` without checking leaves. A crafted `verify_run` could write attacker-chosen markdown into a repo file. **This diff increases its reachability** — guaranteeing those events arrive is the whole point of the change. The same applies to the drift `category`, which is worse: it lands in a *fingerprint*, and from there in `suppressions.json`, which gates future detection. | **Fixed.** Both closed to fixed enumerations, falling back to `'unknown'`. This is SPEC.md §12's telemetry rule applied in the opposite direction: on the way out every payload leaf is a number or a member of a closed set, so on the way back in nothing else should be believed either. Tested from both sides, and the tests fail against the old `String(...)`. |
| S2 | minor | `new URL('..', import.meta.url).pathname` never decodes percent-escapes, so a checkout under a directory with a space fails with an opaque `ENOENT`. | **Fixed** — `fileURLToPath`. |
| S3 | minor | `stderr: 'pipe'` set but never read, with `await proc.exited` reached first. A child writing past the pipe buffer deadlocks to the 30 s timeout, and any failure reports nothing about why. | **Fixed.** Both streams read concurrently, and stderr is now part of the assertion, so a failing child says why. |
| S4 | informational | `env: { ...process.env }` hands the child every variable the developer has exported. | **Fixed** — explicit allowlist. The reviewer confirmed the important half was already right: all three `CLAUDEWATCH_*` variables are pinned *after* the spread, so an ambient value cannot redirect the child at the real store or the real repo. |
| S7 | informational | **The fix was half a fix.** `detectDriftSpike` and `detectFetchFailures` still read only from the general 1000-event query, so under exactly the flood this loop's own first test constructs they go blind in the same silent direction. | **Fixed**, not documented. Kind-scoped queries with lookbacks matched to each detector's window — 8 days for drift, 24 h for fetch. Documenting a known blind spot in a monitoring component, inside a loop whose entire subject is that blind spot, was not defensible. The detectors themselves are untouched; only what reaches them. |
| S5 | informational | SQLite creates `metrics.db` at `0644 & ~umask` rather than `0600`. | **Not fixed.** Pre-existing, `store.ts` untouched by this diff, contained by a `0700` parent, and the db holds no credential material. The test's copy lives inside a `mkdtempSync` dir, `0700` by construction. Recorded as a candidate for its own change. |
| S6 | informational | `writeSuppressions` is atomic with correct modes but does no `lstat` on an env-controlled destination; the `incident.md` writes are non-atomic. | **Not fixed.** Pre-existing; this diff adds no write path and changes none. Recorded. |

Standing invariants re-checked, with the reviewer's verdicts:

- **Token never in logs, cache, argv, or an error message** — cleared. The diff adds one
  `console.log` whose argument is four numbers, and no new `throw`.
- **The baseline line and summary cannot carry a path, hostname, or identifier** — cleared and
  traced: `formatBaseline` interpolates four fields, all typed `number`, all derived from
  `BOUNDS` and `durationMs`, which the store coerces through `Number()`.
- **Command injection in the new spawn** — cleared. `Bun.spawn` with an array, no shell, every
  element a string literal, nothing interpolated.
- **Temp-file handling** — cleared. `mkdtempSync` creates a uniquely-named `0700` directory
  atomically, which forecloses the symlink race a fixed name would open.
- **Credentials read-only; TLS; endpoint** — not reachable. `packages/metrics/src` contains no
  `fetch(`, no `https://`, no TLS option, and no reference to `.claude/`.
- **SQL construction** — cleared. `limit` is interpolated in `store.ts`, but both new call
  sites pass compile-time constants and `kind` goes through a bound parameter.

## Pass 3 — Compliance

| # | Finding | Resolution |
|---|---|---|
| 1 | Domain logic placement: this is all in `packages/metrics`, which is a tool, not a surface. `packages/core` untouched. | Pass. |
| 2 | No `any`. `closedValue` takes `unknown` and narrows. | Pass. |
| 3 | VS Code bundle unaffected — no `packages/vscode` change. Verified the build still emits CJS anyway. | Pass. |
| 4 | Missing optional fields omitted, not guessed: `durationBaseline` is absent when there was no honest p95, rather than reported as zero. | Pass. |
| 5 | Lint warning count unchanged. | Pass. |

## Verification evidence

```
$ bun run verify
$ tsc --noEmit
$ oxlint
bun test v1.3.11 (af24e281)

 547 pass
 0 fail

verify: pass in 5.8s  [typecheck 2.0s  lint 0.1s  test 3.4s  build 0.2s]
$ echo $?
0

$ bun run --filter @claudewatch/metrics detect
baseline: p95 67537ms over 19 runs (window 50), threshold 270148ms
healthy: 20 verify runs evaluated, no bounds breached.
```

That second line is the deliverable. The 270 s trip wire was the number `intent.md` could only
*derive* from the code; it is now printed beside the verdict that had been hiding it.

- [x] `bun run verify` exits 0
- [ ] CI green on the PR head commit — pending the push
- [x] Every acceptance criterion in `spec.md` is checked off

### Mutation checks

Each new bound and behaviour was verified by breaking it and watching the right test fail,
rather than by assuming a passing test meant anything:

| Mutation | Tests that failed |
|---|---|
| window → `runs.slice(0, -1)` | `a slow era outside the window does not set the baseline` |
| `minOutlierMs` → 0 | 4, including the 59.5 s stale-tree regression |
| `<=` → `<` | `exactly at the floor does not fire` |
| `closedValue` → `String(...)` | both crafted-payload tests |
| guard on `window.length` not `durations.length` | `18 non-null durations give none` |
| drop the `ts` tiebreak | the ordering test |
| `collectDetectorInput` → `store.query({ limit: 1000 })` | the two flood tests |

## Findings deliberately not fixed

- **S5** (sqlite file mode) and **S6** (`lstat` before rename, non-atomic `incident.md` writes)
  — both pre-existing, neither reachable through anything this diff adds. Recorded above with
  the reasoning; candidates for their own change.
- **The `magnitudeBucket` fingerprint** still spans a decade, so a 150 s blip and a 900 s hang
  share a fingerprint and a 24 h suppression. The 120 s floor keeps firings inside one bucket,
  so this change neither worsens nor improves it. Carried forward from `spec.md`'s open section.
- **`A5`** — the spawn test is a wiring check, not a regression test for the input composition.

## What this loop says about the loop

**A number you derived is not evidence until someone tries to reproduce it from the raw data.**
The 1.43× within-regime spread and the "90-day" desensitisation were both arithmetic I performed
on data I had in front of me, and both were wrong in the direction that made my proposal look
better. Neither survived a reader who recomputed them. That is a sharper claim than "review is
useful" and it is the one worth carrying into the next loop.

**The defect was not where three careful readings looked.** `anomaly.ts` was read closely enough
to produce a spec, a rejected redesign and a corrected intent — and the actual bug was one line
away in a file nobody had opened, because it lived in *how the detector was called*, not in what
it did. This is the fifth instance of the pattern this repository keeps rediscovering, and the
first where the gap was a call site rather than a runtime.

**Fixing half a defect and documenting the other half is a choice, not a scope decision.** S7
would have been easy to accept as out of scope — `intent.md` explicitly fenced the other
detectors out. But the fence was about detector *logic*, and the finding was about their
*input*, which is this loop's whole subject. A monitoring component with a documented blind spot
is a monitoring component nobody should trust.

---

**Next stage:** Maintain — nothing to do until production says otherwise.
