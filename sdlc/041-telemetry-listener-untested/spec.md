# Spec: the telemetry listener, tested through the effect it exists to cause

- **ID:** 041-telemetry-listener-untested
- **Stage:** 2 — Design
- **Derived from:** [`intent.md`](./intent.md)

## Summary

Two tests in `extension.test.ts` cover `extension.ts:75-81`: one that the listener is **registered**,
one that firing it **re-runs the gate and pushes the new decision into core**. The stale note above
the `test.todo` is corrected and the todo is deleted. No product source changes.

## What the measurements decided

Run before writing this, against the checked-in tree, by appending a probe to `extension.test.ts`
(which already carries the file's two egress layers) and reverting it afterwards:

| Measured | Result | Consequence for the design |
|---|---|---|
| Does the `typeof === 'function'` guard pass today? | **yes** — `typeof onDidChangeTelemetryEnabled = function` | The `test.todo`'s stated reason is false; the branch is live |
| Is the callback actually handed to the stub during `activate()`? | **yes** — `PROBE callback captured: function` | Registration is observable by overriding the leaf, with no product change |
| Firing the captured callback, with the global switch flipped | **`setTelemetryConfig({"enabled":false})`** | The effect is already logged by the existing bridge mock. **No new observability surface is needed** |
| `setTelemetryConfig` calls visible after `start()` | **`[]`** | `start()` clears `calls` at line 210 to drop activate's initial refresh. A test that wants activate's OWN gate call must drive `activate(ctx)` directly, as the `deactivate` test already does |

**The intent's open question 1 is answered, and the answer is better than the option it proposed.**
It asked whether `telemetryOverride()` was reachable as an observable. It is exported, but the
stronger observable already exists: `recomputeTelemetryGate()` ends by calling `setTelemetryConfig`,
the bridge mock logs every call with its argument, and *that* is the path `SPEC.md §12` cares about —
the one by which the global switch reaches core's call sites, which cannot see `vscode.env`.
Asserting on `telemetryOverride()` would prove the module's own variable moved; asserting on
`setTelemetryConfig` proves the decision **left the module**. A listener that recomputed
`telemetryAllowed` and failed to push it would satisfy the weaker assertion and ship the bug.

**Open question 2 is answered by an existing test, not by new work.** The stub's
`onDidChangeTelemetryEnabled` discards its argument, so a test must override that leaf to capture the
callback. Whether that leaks is settled: it is one of the 13 leaves `sdlc/040`'s A1 walks, overwrites
and asserts restored by identity, and `vscodeStubCover` requires this file's `beforeEach` reset. No
stub change is needed, and none is made — a permanent capture would be shared mutable state for the
benefit of one file.

## Behavior

No behavior changes. `extension.ts` is not touched. What changes is what is asserted about it.

### `extension.test.ts`

Two tests, in a new `describe('the telemetry listener')`:

1. **Registered.** Override `vscodeStub.env.onDidChangeTelemetryEnabled` to capture its callback,
   drive `activate(ctx)`, assert a callback was captured **and** that a disposable was pushed into
   `context.subscriptions` — registration without the push leaks a listener past `deactivate`.
2. **Fires and reaches core.** With the callback captured and the global switch on, drive
   `activate(ctx)`, flip `vscodeStub.env.isTelemetryEnabled` to `false`, invoke the callback, and
   assert the **last** `setTelemetryConfig` call carries `{ enabled: false }`. Then flip back to
   `true`, fire again, and assert `{ enabled: true }` — one direction alone passes against a
   callback hard-wired to a constant.

Both drive `activate(ctx)` directly rather than `start()`, because `start()` clears `calls`.

### The stale note

`extension.test.ts:490-493`'s comment claims the branch is "dead in this file because the `vscode`
stub omits the key". It is not, and has not been since `sdlc/039` added the key. The comment goes and
the `test.todo` with it. The file's header docstring says three gaps and three todos; it becomes two
and two, and the count is restated rather than left to drift — an earlier revision of that same
docstring already drifted once, saying "three gaps" beside four todos.

## Data and types

No new exports, no signature changes, no new file. `extension.test.ts` gains one `describe`; its
per-file floor in `scripts/vscode-stub-cover.test.ts` moves from `{ pass: 20, expects: 41 }` to
whatever the added tests make it, re-recorded in the same commit.

## Edge cases

| Case | Expected |
|---|---|
| A host that does not implement `onDidChangeTelemetryEnabled` | the `typeof` guard is false, nothing is registered, activation succeeds. **Already covered** — this is the arrangement every other file in the package runs under, since only this file overrides the leaf |
| The listener fires before `activate` finishes | not reachable: the callback is only handed out *during* `activate` |
| `isTelemetryEnabled` throws when the listener fires | `recomputeTelemetryGate`'s `try` catches it and `resolveExtensionTelemetry` fails closed. Covered by `telemetry-gate.test.ts`; not re-tested here |
| The overridden leaf leaks into the next test | restored by `resetVscodeStub()`; proven by `sdlc/040` A1, which walks all 13 leaves including this one |
| `deactivate()` runs with the listener registered | the `afterEach` disposes every subscription before `deactivate`, as it already does |

## Backward compatibility

- No product source change; no exported signature change.
- The other six vscode test files are untouched and keep their floors: commands 5, extension 20 (→ higher), manifest 6, statusbar 29, telemetry-gate 7, tooltip 10, vscode-stub 20.
- **Risk named rather than hidden:** these tests override a stub leaf that no other test overrides. If `sdlc/040`'s reset were ever weakened, this file would be the first to leak — which is an argument for the tests, not against them, since the leak would surface as a failure here rather than as telemetry escaping in production.

## Acceptance criteria

- [ ] **A1 — the listener is registered.** `extension.test.ts` › *the telemetry listener* asserts a
      callback was captured during `activate` **and** `context.subscriptions` grew. Verified by `bun test`.
- [ ] **A2 — firing it re-runs the gate and reaches core.** The last `setTelemetryConfig` argument
      follows the global switch in **both** directions (`true → false → true`). One direction alone
      passes against a callback wired to a constant. Verified by `bun test`.
- [ ] **A3 — it discriminates.** Three mutations, each predicted before running: delete the
      `context.subscriptions.push(...)` wrapper; replace the callback with `() => {}`; make the
      `typeof` guard unconditionally false. Each must fail A1 or A2, and the failing test named in
      `review.md`. **A1 and A2 without A3 are not evidence** that the branch is covered.
- [ ] **A4 — the stale note is gone and the count is right.** No occurrence of "stub omits the key"
      remains, the `onDidChangeTelemetryEnabled` `test.todo` is deleted, and the header docstring says
      **two** gaps beside **two** todos. Checked by a test that asserts the todo count in the file
      matches the number the docstring claims, with a positive control proving the pattern matches the
      text the claim actually had.
- [ ] **A5 — nothing else moved.** All seven vscode test files pass run alone; floors re-recorded in
      the same commit if they legitimately rise; `bun run verify` exits 0; `.oxlint-budget.json`
      unchanged.

**Which of these discriminate.** A3 is the whole evidence base — A1 and A2 are assertions that a
working branch works. A4 fails against the tree as it stands. A5 is a fence.

## Rejected alternatives

- **Assert on `telemetryOverride()`.** Measured available and rejected: it proves the module's own
  variable moved, not that the decision reached core. The bug it cannot see — recompute without push —
  is the one `SPEC.md §12` exists to prevent.
- **Make the stub capture the callback permanently.** Shared mutable state added for one file's
  benefit, when a per-test override costs one line and is already proven not to leak.
- **Spy on `recomputeTelemetryGate`.** Not exported, and exporting it to test it would change the
  product to suit the test. The observable effect is available without that.
- **Fold in the two neighbouring `test.todo`s.** Real gaps, different subjects; bundling them makes
  the fence meaningless. They stay, with their reasons — which are still true, unlike this one's.

---

**Next stage:** Build — run `/sdlc-plan 041-telemetry-listener-untested` to turn this into `plan.md`.
