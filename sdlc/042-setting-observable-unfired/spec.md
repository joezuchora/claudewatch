# Spec: the setting's own observable, and proof the branch is conditional

- **ID:** 042-setting-observable-unfired
- **Stage:** 2 — Design
- **Derived from:** [`intent.md`](./intent.md)

## Summary

Three tests in `extension.test.ts` cover `extension.ts:115-127`'s telemetry branch: the handler is
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
| Firing with `affectsConfiguration: (k) => k === 'claudewatch.telemetry.enabled'` | **`setTelemetryConfig({"enabled":false})`** | The effect is observable through the existing bridge mock |
| Firing with `affectsConfiguration: () => false` | **`[]` — no call at all** | **The conditional is observable.** A3 is possible, and without it a mutation dropping the guard would pass |
| Does the overridden leaf come back after `resetVscodeStub()`? | **yes**, pristine function | Confirmed **for this leaf**, not transferred from `sdlc/040`'s proof about a different one |

**Open question 1 is answered, and the answer decides A3.** The event object needs one method,
`affectsConfiguration`. It must **inspect its key** rather than return a fixed `true` — a fixed `true`
makes A3 impossible, because the non-affecting case cannot then be expressed.

**Open question 2 is answered by measurement rather than by inheritance.** `sdlc/040` proved the reset
restores all 13 leaves; that covers this one, and the probe confirms it directly instead of arguing
the general result applies.

## Behavior

No behavior changes. `extension.ts` is not touched.

The guarantee under test is `SPEC.md` §10.6 (line 595): *"The extension setting can only narrow, never
widen. Both inputs are re-evaluated live."* `sdlc/041` covered the global switch's live
re-evaluation; this covers the **setting's**, which is the direction that leaks.

### `extension.test.ts` — three tests in one new describe block

All three drive `activate(ctx)` directly (never `start()`, which clears `calls`) and `await flush()`.
The override returns a `SENTINEL` disposable so registration is asserted by identity.

1. **Registered.** The callback is captured and `ctx.subscriptions` contains the sentinel.
2. **An affecting change re-runs the gate, in both directions.** Seed the setting `true`, activate,
   then flip it `false` and fire with an affecting event: both observables read `{ enabled: false }`.
   Flip back to `true`, fire again: both read `{ enabled: true }`. One direction alone passes against
   a handler wired to a constant.
3. **A non-affecting change does not re-run the gate.** Positive precondition **in the same test**:
   an affecting event produces exactly one `setTelemetryConfig` call; a non-affecting event produces
   **zero**. Without the precondition, "zero calls" passes for any reason the fire did nothing —
   including a broken capture.

### The `test.todo`

`test.todo('activate: the onDidChangeConfiguration handlers (interval, thresholds, telemetry)')`
names three branches. This loop covers one. The todo is **reworded, not deleted**, to name the two
that remain (`refreshIntervalSeconds` → `startPolling`, the thresholds → `updateThresholds`), so the
`GAPS: 2` count stays correct and `sdlc/041`'s A4 stays green. Deleting it would drop the count to 1
while two gaps remain, which A4 would catch — that is the guard working, and the spec says so rather
than discovering it.

## Data and types

No new exports, no signature changes, no new file, **no stub change**. `extension.test.ts` gains one
`describe` and one reworded todo string.

## Edge cases

| Case | Expected |
|---|---|
| An event affecting a *different* `claudewatch.*` key | no recompute — covered by A3, whose `affectsConfiguration` inspects the key |
| An event affecting the telemetry key while the global switch is off | `{ enabled: false }` — the AND still holds; not separately tested, because `telemetry-gate.test.ts` covers the decision and A2 covers the wiring |
| The overridden leaf leaking to the next test | restored — measured for this leaf, and `sdlc/040` A1 walks all 13 |
| `deactivate()` with the handler registered | `afterEach` disposes every subscription before `deactivate`, as it already does |
| The other two branches of the same handler | **not covered**, by decision. The todo names them |

## Backward compatibility

- No product source change. No exported signature change. No stub change.
- The six other vscode test files are untouched and keep their floors.
- `extension.test.ts` moves from `{ pass: 24, expects: 56 }` to a **derived** `{ pass: 27, expects: 64 }`:
  test 1 contributes 2 (callback is a function, `toContain(sentinel)`), test 2 contributes 4 (two
  directions × two observables), test 3 contributes 2 (the affecting precondition, then zero).
  24 + 3 = 27; 56 + 8 = 64.
  **The floor is `>=`, so an under-prediction is invisible forever** — `sdlc/041` learned that the
  hard way. A mismatch at Stage 4 is a finding to investigate, not a number to overwrite.
- `GAPS: 2` is unchanged, deliberately.

## Acceptance criteria

- [ ] **A1 — the handler is registered.** The captured callback is a function **and**
      `expect(ctx.subscriptions).toContain(sentinel)`. Identity, not length.
- [ ] **A2 — an affecting event re-runs the gate, both directions, both observables.** `true → false`
      and `false → true`, each asserting the last `setTelemetryConfig` argument (read with
      `calls.findLast`, not `filter().at(-1)`, which would add a lint warning) **and**
      `telemetryOverride()`.
- [ ] **A3 — a non-affecting event does not re-run it.** Exactly one `setTelemetryConfig` call after
      an affecting event; **zero** after a non-affecting one, in the same test. This is the criterion
      that stops a mutation dropping the `affectsConfiguration` guard from passing, and it is only
      expressible because the probe showed the non-affecting case produces no call at all.
- [ ] **A4 — it discriminates.** Four mutations of `extension.ts`, **each predicted before running**:
      (1) delete `recomputeTelemetryGate()` from the telemetry branch → A2; (2) drop the
      `affectsConfiguration` guard so it recomputes on every config change → A3; (3) delete the whole
      `context.subscriptions.push` for this handler → A1; (4) register the handler but discard its
      disposable, pushing a decoy → A1. Failing test named per mutation in `review.md`.
      **These predictions are NOT yet measured** — they cannot be until the tests exist. `sdlc/041`
      stated a mutation-to-criterion mapping it had not run and was wrong twice; this spec labels
      them as predictions and Stage 4 records what actually happened, including any that miss.
- [ ] **A5 — the todo is reworded and the count still holds.** The `onDidChangeConfiguration` todo
      names the two remaining branches; `GAPS: 2` is unchanged; `sdlc/041`'s A4 passes.
- [ ] **A6 — nothing else moved.** All seven vscode test files pass run alone; floors as derived or
      the miss investigated; `bun run verify` exits 0; `.oxlint-budget.json` unchanged.

**Which of these discriminate.** A4 is the evidence base. A3 fails against a plausible wrong
implementation that A2 alone would accept. A1 and A2 are assertions that a working branch works —
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
