# Spec: the setting's own observable, and proof the branch is conditional

- **ID:** 042-setting-observable-unfired
- **Stage:** 2 — Design
- **Status:** revision 1 — first draft REJECTED. The measurements were right; the write-up omitted
  the setup they were performed with, so the spec forbade what the probe did.
- **Derived from:** [`intent.md`](./intent.md)

## Summary

Four tests in `extension.test.ts` cover `extension.ts:115-127`'s telemetry branch: the handler is
**registered**, an event that **affects** `claudewatch.telemetry.enabled` re-runs the gate and pushes
the result into core, and an event that **does not** affect it leaves the gate alone. The
`onDidChangeConfiguration` `test.todo` is reworded to name the two branches still uncovered; the
`GAPS: 2` count does not move. No product source change.

## What the measurements decided

Run before writing this, in an isolated copy of the tree, by appending a probe to `extension.test.ts`
(which carries the file's two egress layers) and discarding the copy afterwards:

| Measured | Result | Consequence for the design |
|---|---|---|
| Gutting `recomputeTelemetryGate()` from the telemetry branch, whole package + harness | **428 pass, 0 fail** | The gap is real and total. This is the loop's reason |
| Is the callback captured by overriding `workspace.onDidChangeConfiguration`? | **yes** — `typeof = function` | Same capture pattern as `sdlc/041`; no stub change needed |
| Does the returned disposable land in `context.subscriptions`? | **yes** — `includes(SENTINEL)` | A1 can assert identity, as `sdlc/041` A1 does |
| `activate()` itself calls `recomputeTelemetryGate()` (`extension.ts:72`) | **one `setTelemetryConfig` already logged** before any fire | **Every count in A3 is measured from a cleared baseline.** Without clearing, "one call after the affecting fire" is 2 and A3 fails against correct source |
| The stub's `env.isTelemetryEnabled` default | **`false`**, and `resolveExtensionTelemetry` is `globalEnabled === true && settingEnabled === true` | **A2 must seed the global switch `true`** or both directions read `false` and the second one never discriminates |
| Firing with an affecting event, **switch seeded `true`, log cleared** | `{ enabled: false }` after flipping the setting off, `{ enabled: true }` after flipping it back | The effect is observable through the existing bridge mock, and the two directions differ |
| Firing a **different-key** event, log cleared | **`[]` — no call at all** | **The conditional is observable.** A3 is possible, and without it a mutation dropping the guard would pass |
| Does the overridden leaf come back after `resetVscodeStub()`? | **yes**, pristine function | Confirmed **for this leaf**, not transferred from `sdlc/040`'s proof about a different one |

**Open question 1 is answered, and the answer decides A3.** The event object needs one method,
`affectsConfiguration`, and it must **inspect its key** — in both directions. A fixed `true` makes the
non-affecting case inexpressible; a fixed `false` makes it *too weak*, because it does not distinguish
"this key is unaffected" from "nothing is affected", so a mutation that widens the guard to a second
key survives. A3's non-affecting event is therefore a **different-key** event
(`(k) => k === 'claudewatch.warningThresholdPct'`), not an all-false one.

**What the first draft got wrong, and it is not the measurements.** Rows 3-6 were probed with a
cleared call log and a seeded global switch. The write-up recorded the *numbers* and dropped the
*setup*, and then §Behavior banned `start()` "because it clears `calls`" — forbidding the very step
the probe relied on. So the table was unreproducible under the spec's own rules, and A2 could not pass
against correct source because the switch defaults to `false`. That last one is the error
`extension.test.ts:544-548` already records from `sdlc/041` — *"an unseeded stub returns `undefined`
and the AND is a constant `false`"* — committed one input over, in the loop written to that standard.
A measurement is not transferable without the conditions it was taken under.

**Open question 2 is answered by measurement rather than by inheritance.** `sdlc/040` proved the reset
restores all 13 leaves; that covers this one, and the probe confirms it directly instead of arguing
the general result applies.

## Behavior

No behavior changes. `extension.ts` is not touched.

The guarantee under test is `SPEC.md` §10.6 (line 595): *"The extension setting can only narrow, never
widen. Both inputs are re-evaluated live."* `sdlc/041` covered the global switch's live
re-evaluation; this covers the **setting's**, which is the direction that leaks.

### `extension.test.ts` — four tests in one new describe block

All four drive `activate(ctx)` directly and `await flush()`. The override returns a `SENTINEL`
disposable so registration is asserted by identity, and the capture box is initialised
`{ cb: undefined }` — initialising it with a no-op makes A1's `typeof` assertion true even when
registration never happened, which is a decorative assertion, not a check.

**Two setup steps are mandatory and were missing from the first draft:**

- **Seed `vscodeStub.env.isTelemetryEnabled = true`.** The stub's default is `false` and the gate ANDs
  both inputs, so without it every row of A2 reads `{ enabled: false }` and the second direction
  proves nothing.
- **Clear `calls` after `activate`/`flush`.** `activate` calls `recomputeTelemetryGate()` itself, so
  an uncleared log already holds one `setTelemetryConfig` entry and A3's counts are off by one.
  Either `calls = []` explicitly, or capture first and then `await start()`, which does the same.

1. **Registered.** The callback is captured and `ctx.subscriptions` contains the sentinel.
2. **An affecting change re-runs the gate, in both directions.** Seed the setting `true`, activate,
   then flip it `false` and fire with an affecting event: both observables read `{ enabled: false }`.
   Flip back to `true`, fire again: both read `{ enabled: true }`. One direction alone passes against
   a handler wired to a constant.
3. **A different-key change does not re-run the gate.** Positive precondition **in the same test**:
   from a cleared log, an affecting event produces exactly one `setTelemetryConfig` call; then, from a
   cleared log again, an event affecting `claudewatch.warningThresholdPct` produces **zero**. Without
   the precondition, "zero calls" passes for any reason the fire did nothing — including a broken
   capture. A **different-key** event rather than an all-false one, so that a guard widened to a
   second key is caught: an all-false event returns false for the telemetry key too and the widened
   guard survives it.
4. **A failed setting read is not consent.** `recomputeTelemetryGate` wraps the setting read in a
   `try`/`catch` that sets `settingEnabled = null` — the "never widen" half of §10.6, four lines from
   this loop's subject. Override `workspace.getConfiguration` to throw, fire an affecting event, and
   assert both observables read `{ enabled: false }`. Changing that catch to `= true` currently passes
   the whole package, so this is the same unguarded-guarantee shape the intent objects to, inside the
   loop that cites it.

### The `test.todo`

`test.todo('activate: the onDidChangeConfiguration handlers (interval, thresholds, telemetry)')`
names three branches. This loop covers one. The todo is **reworded, not deleted**, to name the two
that remain (`refreshIntervalSeconds` → `startPolling`, the thresholds → `updateThresholds`), so the
`GAPS: 2` count stays correct and `sdlc/041`'s A4 stays green. Deleting it would drop the count to 1
while two gaps remain, which A4 would catch — that is the guard working, and the spec says so rather
than discovering it.

## Data and types

No new exports, no signature changes, no new file, **no stub change**. **Two files change:**
`packages/vscode/src/extension.test.ts` gains one `describe` and one reworded todo string, and
`scripts/vscode-stub-cover.test.ts` gains the new floor numbers. The first draft named only the
first, which would have let a plan fence omit the second — a spec-to-plan contradiction `fenceCheck`
cannot catch, because it reads headings and the file is never named in one.

## Edge cases

| Case | Expected |
|---|---|
| An event affecting a *different* `claudewatch.*` key | no recompute — covered by A3, whose non-affecting event **is** such an event (`claudewatch.warningThresholdPct`). The first draft claimed this row while specifying an all-false event, which does not cover it: a guard widened to a second key survives an all-false event |
| An event affecting the telemetry key while the global switch is off | `{ enabled: false }` — the AND still holds; not separately tested, because `telemetry-gate.test.ts` covers the decision and A2 covers the wiring |
| The overridden leaf leaking to the next test | restored — measured for this leaf, and `sdlc/040` A1 walks all 13 |
| `deactivate()` with the handler registered | `afterEach` disposes every subscription before `deactivate`, as it already does |
| The other two branches of the same handler | **not covered**, by decision. The todo names them |
| The setting read **throwing** | `{ enabled: false }` — covered by test 4. Measured: changing that catch to `= true` passes the whole package today |

## Backward compatibility

- No product source change. No exported signature change. No stub change.
- The six other vscode test files are untouched and keep their floors.
- `extension.test.ts` moves from `{ pass: 24, expects: 56 }` to a **derived** `{ pass: 28, expects: 66 }`:
  test 1 contributes 2 (callback is defined, `toContain(sentinel)`), test 2 contributes 4 (two
  directions × two observables), test 3 contributes 2 (the affecting precondition, then zero), test 4
  contributes 2 (both observables read `false` after the read throws). 24 + 4 = 28; 56 + 10 = 66.
  The Stage 2 reviewer independently measured the three-test form at exactly `27 / 64`, so the
  per-test derivation is sound and test 4 adds the fourth pass and two assertions.
  **The floor is `>=`, so an under-prediction is invisible forever** — `sdlc/041` learned that the
  hard way. A mismatch at Stage 4 is a finding to investigate, not a number to overwrite.
- `GAPS: 2` is unchanged, deliberately.

## Acceptance criteria

- [ ] **A1 — the handler is registered.** The capture box is initialised `{ cb: undefined }` so the
      first assertion can fail; the callback is **defined** **and**
      `expect(ctx.subscriptions).toContain(sentinel)`. Identity, not length.
- [ ] **A2 — an affecting event re-runs the gate, both directions, both observables.** **Seeds
      `vscodeStub.env.isTelemetryEnabled = true`** — without it the AND is constant `false` and the
      second direction proves nothing, which is why the first draft's row 4 recorded `false` for a
      direction that should read `true`. Then `true → false` and `false → true`, each asserting the
      last `setTelemetryConfig` argument (read with `calls.findLast`, not `filter().at(-1)`, which
      would add a lint warning) **and** `telemetryOverride()`.
- [ ] **A3 — a different-key event does not re-run it.** **From a cleared log** — `activate` logs one
      `setTelemetryConfig` of its own, so an uncleared baseline makes this criterion fail against
      correct source — exactly one call after an affecting event, then **zero** after an event
      affecting `claudewatch.warningThresholdPct`, in the same test. This is the criterion that stops
      a mutation dropping the `affectsConfiguration` guard, and the different-key form additionally
      stops one that *widens* it to a second key, which an all-false event does not.
- [ ] **A4 — it discriminates.** **Seven** mutations of `extension.ts`, each predicted before running:
      (1) delete `recomputeTelemetryGate()` from the telemetry branch → **A2 and A3** (the reviewer
      measured this; the first draft predicted A2 alone);
      (2) drop the `affectsConfiguration` guard entirely → A3;
      (3) **widen** the guard to also match `claudewatch.warningThresholdPct` → A3, and *only* under
      the different-key form — measured to survive an all-false event;
      (4) keep the registration but drop its `context.subscriptions.push` → A1;
      (5) delete the registration statement outright → A1, A2 and A3 (distinct from (4), which the
      first draft conflated);
      (6) wire the handler to a constant `setTelemetryConfig({ enabled: true })` → A2, which is the
      mutation justifying two directions rather than one;
      (7) change the setting read's `catch` to `settingEnabled = true` → A4's own test.
      Failing test named per mutation in `review.md`.
      **These predictions are NOT yet measured** — they cannot be until the tests exist. `sdlc/041`
      stated a mutation-to-criterion mapping it had not run and was wrong twice; this spec labels
      them as predictions and Stage 4 records what actually happened, including any that miss.
- [ ] **A5 — the todo is reworded and the count still holds.** The `onDidChangeConfiguration` todo
      names the two remaining branches; `GAPS: 2` is unchanged; `sdlc/041`'s A4 passes.
      **The number tracks `test.todo` LINES, not gaps** — after this loop two lines name three
      uncovered branches, so the docstring's plain reading drifts further from its count. Splitting
      the reworded todo into one line per branch is allowed provided `GAPS` follows to 3.
- [ ] **A6 — nothing else moved.** All seven vscode test files pass run alone; floors as derived or
      the miss investigated; `bun run verify` exits 0; `.oxlint-budget.json` unchanged.

**Which of these discriminate.** A4 is the evidence base, and its predictions are **still unmeasured**
— they cannot be run until the tests exist, except (1) and (3), which the Stage 2 reviewer measured
and which are recorded above as measured. A3 fails against two plausible wrong implementations that
A2 alone would accept. A1 and A2 are assertions that a working branch works —
necessary, not sufficient alone.

## Rejected alternatives

- **Cover all three branches of the handler.** Two are different subjects (`startPolling`,
  `updateThresholds`), and bundling them makes the fence meaningless. They keep their todo.
- **Delete the `test.todo` outright.** Two of its three named gaps remain; deleting it would make
  `GAPS: 2` wrong and `sdlc/041`'s A4 would fail — correctly.
- **`affectsConfiguration: () => true`.** Simpler, and it makes A3 inexpressible, which removes the
  only criterion that catches a dropped guard.
- **Change the stub to capture the callback permanently.** Shared mutable state for one file's
  benefit; the per-test override is measured not to leak.
- **Assert only `setTelemetryConfig`.** `sdlc/041` measured that it and `telemetryOverride()` catch
  disjoint mutants. Both, for the same reason.

---

**Next stage:** Build — run `/sdlc-plan 042-setting-observable-unfired` to turn this into `plan.md`.
