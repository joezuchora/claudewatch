# Spec: drive the extension's refresh through what ships

- **ID:** 027-extension-tests
- **Stage:** 2 — Design
- **Status:** draft
- **Reads:** `intent.md`
- **Date:** 2026-08-27

## What the prototype settled

Built in a copy of the tree outside the repo, before writing any of this.

### The bridge split works and the guard goes green

`extension.ts`'s sixteen core imports move to a new `extension-bridge.ts`. Measured with loop
026's own `findImporters` against the modified tree:

```
./core-bridge.js       -> [tooltip.ts]
./extension-bridge.js  -> [extension.ts]
./statusbar-bridge.js  -> [statusbar.ts]
```

Three bridges, one importer each, `bun run typecheck` clean. That answers **Q3**: the shape is
consistent rather than proliferating — every bridge is named for the single consumer that mocks
it, which is the invariant loop 026 enforces. A package-wide bridge plus a guard exemption is the
design loops 025 and 026 already rejected.

### `doRefresh` does NOT need exporting

**Q1, answered by running it.** A probe mocked `vscode` and `extension-bridge.js`, called
`activate` with a stub context, and invoked the captured command:

```
PROBE_REGISTERED  ["claudewatch.refresh","claudewatch.openDashboard","claudewatch.diagnostics"]
PROBE_HAS_REFRESH true
PROBE_CALLS       ["readCache","resolveCredentials","makeErrorSnapshot:missing","writeCache","readCache",
                   "readCache","resolveCredentials","makeErrorSnapshot:missing","writeCache","readCache"]
```

The registered command reaches `doRefresh` and drives the whole missing-credential branch. So the
tests exercise **what ships** — the command a user actually triggers — rather than a symbol
exported to make testing possible. "Export it for the test" is the shape the intent warned gets
waved through, and it is not needed.

`fetchUsage` was never called, which is the network-safety property demonstrated rather than
asserted.

### The sequence appears twice, and that is a design constraint

`activate:103` calls `doRefresh(false)` — un-awaited — as an "Initial fetch", then `startPolling()`
installs a real `setInterval`. So every `activate()` in a test performs a refresh the test did not
ask for, and leaves a live timer behind.

Two consequences the spec must handle rather than discover later:

1. **Assertions must be written against the state after `activate` settles**, not against a call
   log that begins empty. A test that counts calls will count the initial refresh too.
2. **`deactivate()` must run in `afterEach`.** It is exported, clears `pollingTimer` and disposes
   `statusBar`. Without it each test leaks a 30-second interval into the process.

### `refreshInFlight` self-clears

**Q2 largely dissolves.** `doRefresh` sets it at `:157` and clears it in a `finally` at `:257`, so
it cannot leak between tests. No test-only setter is needed — which is the honest answer, since
the intent's question presupposed a problem that turns out not to exist.

The residue is real though: because `activate`'s initial refresh is **not awaited**, a command
invoked immediately after `activate` can land while the first is still in flight and be swallowed
by the dedupe. That is exactly how the dedupe branch gets tested, and exactly what makes a
carelessly written test flaky.

## Behaviour

### `packages/vscode/src/extension-bridge.ts` *(new)*

Value re-binding of the sixteen symbols `extension.ts` imports, plus the three types. Same
construction as the other two bridges, same reason (`export … from` keeps the mock linked to the
original module — loop 001, at the cost of 127 tests).

### `packages/vscode/src/extension.ts`

Import specifiers only: `'./core-bridge.js'` → `'./extension-bridge.js'` on the two value-import
statements and the type-import line. No logic changes.

### `packages/vscode/src/core-bridge.ts`

Drops the sixteen symbols only `extension.ts` used, keeping `formatTooltip` for `tooltip.ts`. Its
docstring names its now-single consumer.

### `packages/vscode/src/extension.test.ts` *(new)*

A `vscode` mock capturing `registerCommand` handlers; an `extension-bridge.js` mock standing in
for core; `deactivate()` in `afterEach`. Each case drives `activate` then the captured
`claudewatch.refresh`.

## Edge cases

1. **The `vscode` mock is process-wide** and two other files already mock it. Loop 026 allowlists
   `vscode` as an ambient host, so a third mocker does not trip the guard — verified by the
   allowlist test. The intent's earlier concern that divergent stubs break each other was tested
   in loop 026 and found false three ways.
2. **`activate` does `await import('./commands.js')`**, which is a real module import. It resolves
   fine under the mock (the probe registered all three commands), and `commands.ts`'s own
   `await import('@claudewatch/core')` happens inside a function body, so it is not reached.
3. **The polling timer's interval floor is 30s**, so it cannot fire during a test — but it keeps
   the process alive. `deactivate()` is the fix, not a fake timer.
4. **`makeCacheEnvelope` is called by `writeCacheFromSnapshot`**, so a mock returning a malformed
   envelope makes the write path lie. The mock must return something envelope-shaped.

## Acceptance criteria

- **A1 — the three-bridge topology holds.** After the split, loop 026's guard is green **and** each
  of the three bridges has exactly one non-test importer, asserted in `mock-topology.test.ts`'s
  real-tree half (which already pins `core-bridge.js` at two — that assertion must be updated to
  one, and the update is itself the evidence the split happened).
- **A2 — no export was added to make testing possible.** `git diff` shows no new `export` on
  `doRefresh`, `startPolling`, `writeCacheFromSnapshot`, or the module-level state.
- **A3 — branches covered, each failing when broken.** In-flight dedupe, fresh-cache short circuit,
  the cooldown branch **including its cache write**, missing credentials, invalid credentials,
  successful fetch, failed fetch. Mutation-tested, results predicted first.
- **A4 — the network is unreachable, demonstrated not asserted.** The `extension-bridge` mock's
  `fetchUsage` throws if called, and every non-fetch case asserts it was not called. The two fetch
  cases assert the mock's return reached the status bar. **Positive precondition in the same test:**
  a case that *does* reach `fetchUsage` proves the throw-on-call would have fired for the others.
- **A5 — `deactivate()` runs in `afterEach`**, and a test asserts `pollingTimer` is cleared by
  observing that no further refresh occurs after deactivate.
- **A6 — the initial refresh is accounted for.** A test asserts `activate` alone performs exactly
  one refresh, so later cases can subtract it rather than being silently off by one.
- **A7 — `bun run verify` exits 0**, lint at the standing 12, and loop 026's guard green **without
  an allowlist entry**. If the guard needs an exemption, the design is wrong.
- **A8 — what stays untested is written down.** `activate`'s config-change handlers, the polling
  interval's scheduling, and `commands.ts` are out of scope; the test file's docstring says so.

## Risks

- **The `extension-bridge` mock is large** (sixteen symbols). `mock.module` replaces the module
  wholesale, so an omitted symbol is `undefined` at call time rather than a compile error — the
  same trap loop 025 recorded. Loop 026's A6a pattern (assert the stub's key set) applies here and
  should be reused.
- **The split touches the file with no tests, to enable testing it.** Circular in the ordinary
  way: the split lands unverified, then the tests verify what it enabled. `typecheck` and the
  existing suite are the only guards until the tests exist, which is an argument for doing both in
  one change rather than splitting the loop.
- **A2 is a negative on a diff**, mechanically checkable but easy to satisfy by moving logic into
  an already-exported function. The reviewer should look for that shape specifically.
