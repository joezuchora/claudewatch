# Review: 042-setting-observable-unfired

- **ID:** 042-setting-observable-unfired
- **Stage:** 5 — Deploy
- **Range reviewed:** `d854d59..8b6ecaa` (the plan commit exclusive, through Stage 5's first fix)
- **Reviewers:** `plan-to-diff-auditor`, then `security-reviewer` — run **sequentially**, never
  concurrently, each briefed on a commit range rather than "the uncommitted diff", and each asked to
  re-check that `HEAD` had not moved before reporting. Both confirmed it had not.

## Verdict

Both passes returned. The auditor's verdict is **EXCURSIONS RECORDED** — no fence violation, no file
from the "explicitly not touched" list touched, no plan item missing, with two unplanned in-fence
edits it judged necessary rather than creep. The security pass returned **one minor finding, three
informational, nothing blocking**. The minor one is fixed in `9283fd4`; one informational is filed as
a follow-up; the other two are recorded here as deliberate.

## Acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| A1 | the handler is registered | **met** | Box initialised `{ cb: undefined }`, so the first assertion can fail; asserts `toBeDefined()` **and** `toContain(SENTINEL)` by identity. Mutation 4 — registration kept, `subscriptions.push` dropped — fails this test alone |
| A2 | an affecting event re-runs the gate, both directions, both observables | **met** | Global switch seeded `true`; `true→false→true`, each direction asserting `calls.findLast(...)` and `telemetryOverride()`. `findLast`, not `filter().at(-1)`, as the criterion requires and as the budget enforces |
| A3 | a different-key event does not re-run it | **met** | From a cleared log: one call after an affecting event, zero after a `claudewatch.warningThresholdPct` event, same test. The different-key form is what catches mutation 3 |
| A4 | it discriminates | **met** | Seven mutations, predicted before running, re-run by this stage rather than inherited. See below |
| A5 | the todo is reworded and the count still holds | **met** | Two `test.todo` lines remain, `GAPS: 2` unchanged, sdlc/041's A4 green |
| A6 | `verify` exit 0, floors and budget hold | **met** | Exit 0 across all eight steps. `extension.test.ts` measures **exactly** 28 pass / 66 expects. `.oxlint-budget.json` unchanged |

## Mutations — predicted, then measured, then measured again

Predictions were written down before the runner executed. The runner reverts `extension.ts` after
each mutation and asserts byte-equality with the original before exiting.

| # | Mutation of `extension.ts` | Predicted | Measured | Failing test |
|---|---|---|---|---|
| 1 | gut `recomputeTelemetryGate()` from the branch | 25 / 3 | **25 / 3** | tests 2, 3, 4 |
| 2 | drop the `affectsConfiguration` guard | 27 / 1 | **27 / 1** | test 3 |
| 3 | widen the guard to `warningThresholdPct` | 27 / 1 | **27 / 1** | test 3 |
| 4 | keep registration, drop `subscriptions.push` | 27 / 1 | **27 / 1** | test 1 |
| 5 | delete the registration statement | 24 / 4 | **24 / 4** | all four |
| 6 | constant `setTelemetryConfig({ enabled: false })` | 26 / 2 | **26 / 2** | test 2 + sdlc/041's listener test |
| 7 | catch → `settingEnabled = true` | 27 / 1 | **27 / 1** | test 4 |

Seven for seven on both the count and the named test — the first loop this session where every
prediction held. Run twice: once against the Stage 4 implementation, and again after the security
fix restructured test 4 around a `try`/`finally`, because a `finally` that swallowed a failing
assertion would have quietly turned test 4 into a decoration. Identical both times. The auditor also
re-ran all seven independently in a throwaway copy and reproduced every count and every name.

## The one prediction that did not hold

The spec called mutation (7) the **silent** one: it "survives at 28 pass / 0 fail" if the global seed
is missed, "the only failure mode in this spec that ships green rather than loudly". The plan
repeated it and told this stage to run it deliberately rather than assume the seed had landed. Doing
that turned up a correction:

    mutation 7, seed present:  27 pass / 1 fail  — "a setting read that throws is not consent"
    mutation 7, seed removed:  27 pass / 1 fail  — "an affecting event re-runs the gate, both directions"

**Half the claim holds and half does not.** Test 4 does go vacuous without the seed — it stops
failing under the very mutation it exists to catch. But the file does not ship green: test 2 fails in
its place. The reason is structural, not luck. The Stage 2 reviewer measured its own implementation,
which seeded per test; this one puts all three setup steps in a shared `arm()`, so removing the seed
removes it from every test at once, and test 2's second direction asserts `{ enabled: true }`, which
is unreachable with the global switch off.

Worth stating plainly, because the silence was the stated reason for naming the seed under two
criteria rather than one: **a shared setup converted a silent failure mode into a loud one.** The
vacuity the spec warned about is real and the seed is still load-bearing; the silence was a property
of the reviewer's implementation, not of the design. The auditor independently reproduced this and
agreed the correction runs in the right direction.

This is the third loop in a row whose most useful finding came from re-running an inherited
measurement instead of quoting it.

## Findings — plan-to-diff audit

| # | Finding | Resolution |
|---|---|---|
| 1 | **Two in-fence edits the plan did not enumerate**, against a plan whose Changes section says "Nothing else": the header docstring rewording, and hoisting `configEvent` to module scope | **Both accepted.** The docstring sentence became false the moment this loop landed, four lines above a machine-checked count, in the paragraph that carries its own warning that it has drifted before. The hoist is the plan's own instruction being obeyed — "if the budget moves, a construct the spec ruled out was used; fix the construct". The auditor reproduced the alternative and confirmed `lintBudget` exits 1 with `configEvent` inside the describe |
| 2 | **Cosmetic:** the docstring edit left a 114-char line mid-paragraph where the block wraps at 100, and the reworded todo was 146 chars — the longest line in the file | **Fixed** in `8b6ecaa`. The paragraph now separates the standing gap list from the two branches that have come off it; the todo moved to a wrapped call. Notable near-miss: the obvious rewrap is a two-literal concatenation, which `eslint(no-useless-concat)` would have charged to the budget. Measured, then avoided |
| 3 | A4's per-mutation record lived only in the commit message; the spec asks for the failing test named per mutation **in `review.md`** | **Resolved by this document** — that was always Stage 5 work, outside the audited range |
| 4 | Fence honesty: five literal paths, no globs | Noted. The check is not vacuous |

## Findings — security pass

| Sev | Finding | Resolution |
|---|---|---|
| **minor** | Test 4 installs a `getConfiguration` that **throws**, and it is the last test in the file. The file's `afterEach` disposes subscriptions and calls `deactivate()` but never resets the stub, so the throwing leaf stayed installed on the process-wide stub until the *next* file's `beforeEach`. Safe today only because the cover gate forces a `beforeEach` reset in every importer and no vscode test file reads config at module scope — but a throwing leaf is a worse class of residue than the value mutations this file already left: it would turn a future module-scope `getConfiguration` into an import-time throw in an unrelated file, and this file would stay green while that happened | **Fixed** in `9283fd4`: captured and restored in a `finally`, scoped to test 4, rather than widening the file's `afterEach`. Re-verified two ways — all seven mutations re-run unchanged (so the `finally` does not swallow a failure), and `bun test src/extension.test.ts src/statusbar.test.ts` in one process gives 57 pass / 0 fail |
| informational | **The sibling catch has no test.** This loop closes the fail-closed case for the *setting* read. The *global* read's `catch { globalEnabled = null }` has no equivalent at any level — nothing makes `vscode.env.isTelemetryEnabled` throw, so mutating that catch to `= true` is unobservable to the whole suite. That is exactly the asymmetry test 4 exists to remove on the other branch | **Filed as a follow-up**, not folded in: `extension.ts` is on this loop's untouched list and the intent's rule is that a defect found on the way is a new intent, not a widened fence. Recorded as a known gap below |
| informational | `configEvent` models `affectsConfiguration` as exact string equality, so no test can express a multi-key event or VS Code's section-prefix semantics. The leak direction — a *missed* recompute — is pinned by test 2; a *spurious* recompute is fail-safe, because the gate re-reads both inputs | **Accepted.** Noted here so a future test does not claim section-level coverage on this model |
| informational | The "global switch off, setting on ⇒ disabled" cell is not re-pinned through *this* listener; it is covered through the other listener and purely in `telemetry-gate.test.ts`. Both listeners funnel into the same `recomputeTelemetryGate()` | **Accepted.** The widen direction is pinned once, not twice, and that is sufficient |

Invariants re-checked and cleared: no token created, read, formatted or serialised anywhere in the
diff; both egress layers hold for all four new tests (the mocked module is `./extension-bridge.js`,
which is the one `extension.ts` actually imports — `core-bridge.js` is not imported by it at all, and
no new test opts into a real fetch); the telemetry spool stays redirected to a temp dir, measured by
comparing the real `~/.cache/claudewatch/metrics-spool.jsonl` byte-for-byte and by mtime across two
runs; core's telemetry config is never written by this file, because `setTelemetryConfig` here is a
mocked bridge symbol that only appends to a log; no transport, TLS, filesystem, or command-execution
surface appears in the diff; the three casts the new code contains are all on values the test
constructed one line earlier, so no new `JSON.parse(...) as T`.

## Known gaps, stated rather than discovered later

- **The global read's `catch` is fail-closed by inspection, not by check.** Filed as a follow-up.
  Symmetric with test 4, and cheap: a getter on `vscodeStub.env.isTelemetryEnabled` that throws.
- **The other two `onDidChangeConfiguration` branches** (`refreshIntervalSeconds` → `startPolling`,
  the thresholds → `updateThresholds`) remain uncovered, by decision. The todo names them, which is
  why it was reworded rather than deleted.
- **The docstring's count tracks todo *lines*, not gaps.** Two lines now name three uncovered
  branches. The spec permits splitting the reworded todo one-per-branch provided `GAPS` follows to 3;
  this loop did not, so the plain reading of the paragraph drifts one further from its count. Carried
  forward deliberately, as the spec allowed.

## Gate

`bun run verify` exit 0 at every commit in the range — typecheck, lint, lintBudget, fenceCheck,
vscodeStubCover, test, build, perf. `.oxlint-budget.json` unchanged. CI green on `9b65797` and
`8b6ecaa`. No VS Code bundle format check was needed: no product source changed, so the CJS bundle is
byte-identical in shape to the last loop's.

---

**Next stage:** Maintain — nothing shipped broken, so no `incident.md`. The follow-up above is a new
intent, not an incident.
