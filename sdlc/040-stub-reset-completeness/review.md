# Review: loop 040 — a reset complete by construction, and a gate that requires it

- **ID:** 040-stub-reset-completeness
- **Stage:** 5 — Deploy
- **Commits:** `07c8b52..HEAD` on `claude/ai-sdlc-setup-plan-nqyqbk` (PR #16)
- **Reviewers:** spec-reviewer (Stage 2, twice), plan-to-diff-auditor and security-reviewer (Stage 5, sequentially). All three returned; none is reported here as clean that did not.

## What shipped

`resetVscodeStub()` restores from a load-time recursive snapshot instead of a list of six names,
re-registers `mock.module` so restored top-level leaves reach consumers, and reinstalls mock
implementations from a registry **keyed by the mock object**. `vscodeStubCover` fails a build where a
file imports `vscodeStub` without calling the reset from inside a `beforeEach`. `tooltip.test.ts`
resets. Three docstrings that outran their code are gone.

## Acceptance criteria

| # | Status | Evidence |
|---|---|---|
| A1 | met | `vscode-stub.test.ts` › *restores every leaf* — walks 13 leaves, kind-matched sentinels, asserts the write changed the value and `toBe` identity on the way back, floors at 13 |
| A2 | **met, and it refuted its own prediction** | see "A2 measured nine, not seven" below |
| A3 | met | four fixtures: one-deep, two-deep, mock-with-override (registered and not), array; plus class-instance/`Map`/`null` cases |
| A4 | met | both mock leaves: no recorded calls, current `state.item`, new `configValues`, pre-reset override does not survive |
| A5 | met | one builder, one line different; asserts the reset check's own stderr text |
| A6 | met | positive control from the same builder |
| A7 | met | clean tree exit 0; copy with tooltip's reset removed exit 1 naming `tooltip.test.ts` |
| A8 | met | per-file `pass` **and** `expect()` floors parsed from stderr, `fail=0`, `skip=0`, missing floor is a failure, `files.length >= 7` |
| A9 | met | `pristineLeafPaths()` set-equal to `providedMembers()` under the dotted-boundary prefix rule; three docstring regexes each with a positive control |
| A10 | met | `verify` exit 0 in 23.0s; `.oxlint-budget.json` unchanged at 10 |
| A11 | met | asserts `2 pass` / `0 fail` / `Ran 2 tests across 2 files` from **stderr**, not exit status |
| A12 | met | comment-only and string-literal fixtures both fail the gate |
| A13 | met | unregistered mock throws at first reset; uncoverable container throws at capture |

## A2 measured nine, not seven — and the spec was not amended to match

The spec's A2 predicted the pre-change reset would fail to restore seven leaves "and no others".
Measured against a temp copy with only `resetVscodeStub`'s body reverted:

```
StatusBarAlignment.Right, ThemeColor, MarkdownString, Uri.parse,
env.onDidChangeTelemetryEnabled, commands.registerCommand, workspace.onDidChangeConfiguration,
window.createStatusBarItem, workspace.getConfiguration
```

The last two are the mock leaves the intent counted as **restored**. The old body called
`.mockReset()` and `.mockImplementation()` on whatever object occupied the path and never
**reassigned** the leaf. So it restored those leaves' *contents* and never their *identity*: a test
that REPLACED either mock rather than reconfiguring it left the replacement in place for every file
loaded afterwards.

**The intent's "restores 6 of the stub's 13 leaves" should be read as 6 by contents, 4 by identity.**
Neither the intent, nor the spec, nor two rounds of Stage 2 review caught this, because all three
reasoned about the reset's source rather than running a replacement through it. It makes the loop's
case stronger than it was written.

The spec's A2 text is left as written and the correction lives here. Amending an acceptance
criterion to match the result it produced is how a criterion stops meaning anything.

## Mutations — predictions written before the runs

| # | Mutation | Predicted | Measured |
|---|---|---|---|
| M1 | remove the `mock.module` re-registration | A11 fails; A1 still passes | **exact** — 17 pass, A11 alone fails |
| M2 | revert to the six-leaf reset (= A2) | names seven | **nine** — prediction wrong, see above |
| M3 | shallow capture | A3(b) fails; A1 still passes | **A1 also failed** — prediction wrong |
| M4 | drop the implementation reinstall | A4 fails on both mock leaves | exact, plus A3(c) |
| M5 | accept a reset outside `beforeEach` | the module-scope fixture stops failing | exact, one test |
| M6 | delete the container throw | A3(d) and A13 fail | exact |
| M7 | delete the unregistered-mock throw | A3(c) and A13 fail | exact |
| M8 | remove one file's recorded floor | the run-alone check fails | exact, one test |
| M9 | drop one fixture filter from A11's run | the counts catch it | exact — `Ran 1 test across 1 file`, exit 0 |

**Two predictions were wrong.** M3: I reasoned "today's stub is one-deep, so A1 survives a shallow
capture", confusing one-deep *leaves* with no need to recurse — a shallow capture stores the live
`env`/`window` containers and every nested restore becomes a no-op. M2 is recorded above.

M1, M5, M8 and M9 are the four whose absence would have been **silent**: each removes a guard while
every other assertion stays green. All four discriminate.

## Guards that caught their own author

- **The `expect()` floor.** Restructuring A1 to collect rather than assert in-loop dropped assertions
  61 → 37; the run-alone check went red and the floor was re-recorded in the same change. This is the
  half of A8 that catches a gutted test body, and the first thing it caught was mine.
- **A9's `tooltip.test.ts` assertion** was red until `tooltip.test.ts` was actually edited.
- **`fenceCheck`** rejected the first draft of `plan.md`: its fence heading was not one of the two
  phrases `extractFence` reads, so the loop counted as *uncheckable* and the baseline delta failed the
  gate. Fixed by using the marker rather than by bumping the baseline, so 040 is checked (20 checkable)
  rather than exempted. A mutation confirmed the check is not vacuous: adding `vscode-stub.ts` to the
  not-touched list produced `NEW CONTRADICTION 040-stub-reset-completeness: spec.md requires
  resetVscodeStub() … but plan.md fences packages/vscode/src/vscode-stub.ts`.
- **Two failures found by running rather than reading**: A11's fixture never imported `mock`, and
  A1's string sentinel made the reverted reset throw a `TypeError` instead of reporting leaves.

## Counts

Seven test files, all passing run alone with unchanged counts for the six that existed before:
commands 5, extension 20, manifest 6, statusbar 29, telemetry-gate 7, tooltip 10 — **77** — plus
vscode-stub 18. Together: **95 pass, 0 fail, 3 todo** (the todos pre-date this loop).

## Stage 5 — plan-to-diff audit: EXCURSIONS RECORDED, all fixed

The auditor confirmed nothing outside the fence (five files, all on the ten-path list, none on the
not-touched list) and every promised artefact landed. It found six things inside fenced files, and
all six are fixed in `f68f3a4` rather than accepted:

| Finding | Resolution |
|---|---|
| Run-alone timeout bumped `120_000 → 180_000`, unjustified — the test takes **1.09s** | Reverted. The plan reserved a wall-clock move for this document; a 50% bump is the silent absorption it warned against |
| The same test renamed, staling three by-name citations in `spec.md` and `plan.md` | Original name restored |
| **A plan line ignored** — "reuse `accessParent` for the climb" | Fixed. `beforeEach((() => {…}) as () => void)` and a parenthesised callback were **false negatives**: a file that *does* reset would fail the gate. Fails safe, but a gate that rejects correct code gets deleted |
| **`import * as stub from './vscode-stub.js'` bypassed the check entirely** | Fixed. `resetUsers` now recognises namespace imports for both the import and the `stub.resetVscodeStub()` call form |
| A8's missing-floor branch had no test — deleting its assertion would go unnoticed | `FLOORS` is now asserted set-equal to the discovered file list in both directions |
| Three claims shipping unchecked: deleted-leaf re-add, `Object.create(null)`, A11's `0 skip` | All three tested; A11 now reads **stderr alone**, as the spec measured |

**A trap I walked into while fixing this.** My first namespace test was a CLI fixture and it failed
for a reason unrelated to what it tested: `vscodeInstallers` only recognises a factory whose body is
the bare identifier `vscodeStub`, so `() => stub.vscodeStub` trips the *inline-factory* check first.
Those tests now exercise `resetUsers` directly. **Recorded, not fixed:** a namespace-importing file
therefore cannot satisfy loop 039's installer check either, so it is rejected twice rather than
once. Widening that check is loop 039's fence, not this one's.

The auditor also independently confirmed the two claims most worth attacking: `mock-topology.test.ts`'s
pinned eight-pair inventory is genuinely unchanged (`findMocks` on the new file returns `[]`), and
A2's nine-versus-seven is a **spec** inconsistency rather than an implementation defect — spec A1
mandates an identity check while spec A2 asserts a by-contents result, and the implementation
followed A1.

## Stage 5 — security review: PASS

No blocking and no major findings. The reviewer measured rather than reasoned, with syscall traces
over a sandboxed `HOME` holding a canary token: the whole package run showed **0 opens of
`.credentials.json` and 0 `connect()` calls**, with a positive control proving the detector worked (a
fixture with the bridge mock removed *did* open the canary path). The 70-times-per-run
`mock.module` re-registration neither drops a sibling module's mock nor re-evaluates dependents.
The built bundle contains **0 occurrences** of every symbol this loop added, and `.vscodeignore`
excludes `src/` from the `.vsix`, so the cross-boundary test import reaches nothing shipped.

**One minor finding, fixed.** `restoreLeaves` recursed into `obj[key]` without checking it was still
a container, so a test that deleted or replaced a whole nested object got a bare
`TypeError: undefined is not an object` instead of this module's named error — and because the throw
happened *before* the re-registration, the module namespace was left un-re-synced too, making the
spec's stated limit quietly broader than written. Reproduced, then fixed two ways: the recursion now
throws `restoreLeaves: container at "env" is no longer an object (found undefined)`, and the
`mock.module` call moved into a `finally` so a partial walk still re-syncs what it did restore. **The
spec needed no amendment** — the fix brought the code into line with the limit the spec already
stated, rather than the reverse.

Two informational items also applied: the A11 subprocess now runs with `HOME` pointed into its own
temp tree, and with `timeout: 30_000`, because bun's per-test timeout cannot interrupt a synchronous
spawn and a wedged child would hang the suite rather than fail it.

**Recorded, not fixed (pre-existing):** `scripts/vscode-stub-cover.ts:392` prints an absolute path on
one failure branch. The reviewer traced that it cannot reach the metrics spool — `verify` records
only step names and durations, and `scripts/junit.ts` scrubs paths — and the failure message this
loop added correctly uses `basename`.

## Recorded, not fixed

1. **`window.showErrorMessage` is surplus** — provided by the stub, required by no source file. Pre-existing; the gate reports it as information, not a failure.
2. **The `expect()` floor is sensitive to honest refactors**, as this loop demonstrated on itself. It fails closed and is re-recorded in the same commit, like the lint budget — but it is a maintenance cost worth naming rather than discovering.
3. **`providedMembers()` descends one level**, so A9's oracle would disagree with the reset if a two-deep leaf were ever added. It fails loud, and extending the walker was outside this fence.
4. **No test drives `onDidChangeTelemetryEnabled`** — loop 039's residual, still open as task #39, and explicitly out of scope here.
5. **`packages/vscode/src/vscode-stub.test.ts` imports from `scripts/`.** A deliberate cross-boundary import: A9 needs an oracle it did not write. Test-only, and the security pass confirmed by build that nothing bundled crosses.
6. **Spec A2's literal recipe no longer runs.** That cross-boundary import means a flat two-file temp copy fails with `Cannot find module '../../../scripts/vscode-stub-cover.js'`. The working command mirrors the depth: create `<tmp>/packages/vscode/src` and `<tmp>/scripts`, copy `vscode-stub.ts`, `vscode-stub.test.ts`, `tooltip.test.ts` and `scripts/vscode-stub-cover.ts` into place, symlink the repo's `node_modules`, then run `bun test packages/vscode/src/vscode-stub.test.ts` from `<tmp>`. Recorded here rather than by amending A2, which would look like the implementation had failed.
7. **A namespace-importing test file cannot satisfy loop 039's installer check**, independent of this loop's reset check — see the audit section.
8. **`scripts/vscode-stub-cover.ts:392` prints an absolute path** on the no-stub branch. Pre-existing; confirmed unable to reach the spool.
