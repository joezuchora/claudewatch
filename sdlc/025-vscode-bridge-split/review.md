# Review: the mocked module gets exactly one consumer

- **ID:** 025-vscode-bridge-split
- **Stage:** 5 — Deploy
- **Range reviewed:** `a16eb9c..e758f8f`, plus the follow-up commit these findings produced
- **Date:** 2026-08-27

## Verdict

Three reviewers across two stages. Stage 2 returned **five blocking** findings that reshaped the
design before any code was written; Stage 5 returned **three blocking** and one security finding
that contradicted a claim in the implementation commit. All fixed.

The theme of this loop, stated plainly: **five separate times, a claim about this codebase was
made from reading rather than running, and four of them were wrong.** The loop's own subject —
a cost estimate carried four loops without re-running — turned out to be the mildest instance.

## Pass 1 — bugs and logical errors

**A6a was specified and shipped as nothing (BLOCKING, fixed).** The spec required "the stub's key
set is exactly the five `statusbar.ts` imports, asserted as a key set". The implementation shipped
a five-key factory and no assertion. The plan's own Tests table had quietly redefined A6a's
"where" as "`statusbar.test.ts` factory" — i.e. the factory *is* the test, which is inspection.

The plan predicted a surplus key would be inert and said in writing: *"if it does not, A6a is the
vacuous one and I want to know."* The auditor ran it — `formatTooltip: () => 'BOGUS'` added to the
factory gave **50 pass, 0 fail, typecheck clean**. A6a was not vacuous; it was absent. Now
implemented as a real `Object.keys` assertion on the mocked module, and mutation-verified against
that exact surplus key: **1 fail**. A missing key was already caught loudly (the module fails to
load); the surplus direction was the unguarded one, and it is the direction that matters, because
`statusbar-bridge.ts`'s docstring instructs future editors to keep the stub in sync with a rule
nothing was enforcing.

**A7 shipped failing its own grep (BLOCKING, fixed).** The criterion: `core-bridge.ts` must not
contain the substring `statusbar.test.ts can mock`. My rewritten docstring **quoted the old text
verbatim** while explaining that it was wrong, so `grep` returned a hit at `core-bridge.ts:7`. The
property A7 names was satisfied; the check A7 names was red. Recording "A7: pass" against that
would have been exactly the fabricated-evidence failure this loop exists to stamp out. Now
paraphrased; grep clean.

**The plan's mutation 1 could not produce its predicted result (BLOCKING as evidence, corrected).**
The plan said reverting `statusbar.ts` to `./core-bridge.js` makes A2 fail. It does not, and for
two different reasons found independently:

- I ran it and got `Unhandled error between tests` — the stub carries five keys, so `formatTooltip`
  was `undefined` and `tooltip.ts` crashed on load. It failed for the wrong reason.
- The auditor ran it after A8's orphan deletions and got
  `SyntaxError: Export named 'emitProcess' not found` — `statusbar.test.ts` fails to load entirely
  and **all ten tooltip tests, A2 included, pass.**

Either way the mutation tests module resolution, not contamination. **It is recorded as faulty and
not counted.** The evidence that does carry the claim is A3's pre-change table, measured before the
split precisely because it is unrecoverable after — and the auditor independently reproduced the
full pre-change mechanism and got both new assertions failing with `Received: "formatted: 42%"`.

## A3 — the four-cell table

| | `tooltip.test.ts` alone | `statusbar.test.ts` first |
|---|---|---|
| **pre-change** | 10 pass | **1 FAIL** — `Received: "formatted: 42%"` |
| **post-change** | 10 pass | 37 pass |

Only the red cell carries the claim. The single-file pre-change run **passes**, so a criterion
saying merely "run it on the pre-change tree and see it fail" was satisfiable by a trivially green
run — which is why the spec pinned the exact command and argument order.

## Pass 2 — security (SPEC.md §12, §17)

No blocking findings. Three worth recording:

**"Behaviourally identical" was false (fixed, and it bought a test).** The commit claimed the
deleted `realClassify`/`realEvaluate` were equivalent to core's. `evaluate` is character-for-
character equivalent. **`classify` is not**: the local copy had no `tier === 'enterprise'` branch,
which core checks *before* the window test. No assertion changed, because no test in the file sets
an enterprise tier — but that is the point: `statusbar.ts`'s `Enterprise` branch (99-120) had zero
coverage and was **unreachable by construction**, since the stale stub classified every enterprise
snapshot as `Degraded`. Importing the real `classify` makes it reachable, so it now has a test.

That test also caught me doing the thing this whole loop is about. I wrote its expectation from
reading the branch — `$(graph) 0.1%` — and the real output is `$(organization) E 0.15%`. Wrong on
both the icon and the rounding. Recorded in the test's own comment.

**A safety net was removed, and the hazard is forward-looking (recorded, not fixed).** The old
process-wide mock incidentally neutered `resolveCredentials`, `fetchUsage`, `readCache`/`writeCache`
and `setTelemetryConfig` into `undefined` for the whole test process. That net is gone:
`core-bridge.ts` now resolves to the real core in tests. Verified harmless today — no test imports
`extension.ts`, and `@claudewatch/core` has no import-time side effects (every non-test module
checked for top-level I/O). But **an `extension.test.ts` added later without its own mock would
read the real `~/.claude/.credentials.json` and make a live authenticated request** — the loop-024
failure mode, re-armed. Whoever writes that file must mock `./core-bridge.js` in it first.

**§17's closed-enum guarantee is not structural (recorded, out of scope).** `renderEvent` types
`runtimeState` and `tier` as `string`. The guarantee rests entirely on call sites passing
`RuntimeState` and `AccountTier`, and `statusbar-bridge.ts` now sits in that chain. Narrowing those
two parameter types in `packages/core/src/telemetry.ts` would make it structural — a one-line
change in a package this loop's fence forbids touching.

Cleared after active checking: telemetry payload unchanged and verified **in the built bundle**
(`utilizationBucket` still resolves to the real decile implementation, so the raw percentage never
reaches the payload); all six deleted exports unneeded, `emit` included, whose only production
consumer resolves through statusline's separate `core-deps.ts`; the new bridge is re-exports only;
no test-only code in any shipped artifact; VS Code bundle still CJS.

## Pass 3 — compliance

Fence held exactly — five files plus artifacts, zero out-of-scope, zero forbidden files touched,
no vacuous globs. `verify` green, lint at the standing 12. Net **improvement** to SPEC.md §8.2:
16 lines of domain logic deleted from a surface package, and the module added contains none.

## What is NOT done

- **`statusbar.test.ts` now renders real tooltips**, which the intent listed as out of scope. It
  arrives transitively via `buildTooltip` and cannot be avoided without stubbing `tooltip.js` too,
  which is worse. Declared, and covered by A6b — the first assertion in that file's history to read
  `mockItem.tooltip`.
- **A6a compares the stub against a hardcoded list, not against the real bridge's exports.** Under
  the mock, importing the bridge returns the stub, so the real surface is not reachable from that
  file. If someone adds a sixth export to `statusbar-bridge.ts` and a matching sixth key to both
  the factory and A6a's list, nothing objects. It catches drift between factory and expectation,
  not between factory and module.
- **The mock-topology guard is deferred to loop 026** — it failed its own Stage 2 review on four
  counts, including being blind to `mock.module('@claudewatch/core')`, the worst available
  recurrence.
- **`extension.ts` is fixed by construction and verified by nothing** (spec A9). It has no tests;
  loop 001's finding is the only path to verifying it.
- **`commands.ts` bypasses the bridge entirely** with `await import('@claudewatch/core')` — a
  fourth core consumer and a standing violation of `core-bridge.ts`'s stated contract. Found at
  Stage 2, out of scope, still open.
- **Opus tooltip coverage stays in `format.test.ts`.** The obstacle to moving it back is gone, but
  where it belongs is a separate judgement from whether it *can* live here.
- **`~/.cache/claudewatch/metrics.db` is mode 0644** (loop 012's S5), unchanged and unrelated.

## Mutation log

| Mutation | Predicted | Actual |
|---|---|---|
| revert `statusbar.ts` to `core-bridge.js` | A2 fails | **FAULTY** — module fails to load; A2 stays green. Not counted. |
| drop `formatTooltip` from `core-bridge.ts` | typecheck fails | `TS2305` at `tooltip.ts:3` ✓ — proves A8's deletions stopped at the right place |
| blank the tooltip in the vscode mock | A6b fails | 1 fail ✓ |
| add a surplus stub key | **inert** | inert before A6a ✓ (predicted); **1 fail** after ✓ |
| remove a needed stub key | caught by existing tests | module fails to load ✓ |

## Retrospective

Every blocking finding in this loop was a claim made by reading. The deferral cost that started it
(~3× too high). The "17-symbol block" that was 15. "Both fixed" for a file no test imports. "Its
assertions are untouched" for a file whose subject changed. "Behaviourally identical" for two
functions that differ by a whole branch. A predicted mutation result that could not occur. And an
expectation for an enterprise status bar that was wrong twice over.

The counter-practice that worked, every time, was cheap: copy the repo to `/tmp` and run it. Two
minutes settled what four loops had assumed.
