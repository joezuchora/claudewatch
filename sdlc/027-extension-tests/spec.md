# Spec: drive the extension's refresh through what ships

- **ID:** 027-extension-tests
- **Stage:** 2 — Design
- **Status:** accepted (revision 2, after the Stage 2 review)
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

### `doRefresh` does not need exporting — but revision 1 misread its own evidence

**Q1's answer stands. The evidence I gave for it did not.**

Revision 1 printed this and called it "drives the whole missing-credential branch":

```
PROBE_CALLS ["readCache","resolveCredentials","makeErrorSnapshot:missing","writeCache","readCache", ...]
```

`doRefresh` calls `readCache` in exactly two places: `:160` at the top, and **`:254`, inside the
`catch`**. The missing-credential path (`:192-197`) ends at `return` with no second `readCache`.
So that trailing call can only have come from the catch. The branch **threw** — at
`statusBar?.update(snapshot, false)`, because the prototype's fake snapshot met a real
`StatusBarManager` and real `classify` — and the catch-all swallowed it.

I ran the thing, got real output, and read it in the direction I wanted. That is this project's
dominant failure mode, committed in the document reporting the measurement. The Stage 2 reviewer
reproduced both shapes: with `makeErrorSnapshot` returning `null` the log ends at `writeCache`;
with a non-`UsageSnapshot` object the trailing `readCache` appears.

What survives: `activate` **is** drivable under a mocked `vscode`, it registers all three commands,
and `claudewatch.refresh` **does** reach `doRefresh`. No export is needed. What does not survive is
any claim about which branch completed — and it means every snapshot a mock returns must be a real
`UsageSnapshot`, because the status bar is not mockable (see below).

### The single-file probe does not survive a whole-package run

Revision 1 ran one test file. The reviewer put the same probe at
`packages/vscode/src/extension.test.ts` and ran `bun test packages/vscode`:

```
TypeError: undefined is not an object (evaluating 'vscode.env.onDidChangeTelemetryEnabled')
      at activate (extension.ts:75)
 52 pass, 1 fail
```

Verified independently: **neither `tooltip.test.ts` nor `statusbar.test.ts`'s `vscode` stub
provides `env` or `commands`**, and `mock.module('vscode')` is process-wide with last-writer-wins.
`extension.test.ts` yields at its module-scope `await import`, the other files' module scopes
evaluate during that yield, and the winning stub is missing what `activate` reads at `:75` —
outside any try/catch.

So this is order-dependent, which is worse than deterministic, and **A7 as written does not hold**.
The fix is not clever ordering: the three `vscode` stubs must become one shared superset. The
reviewer measured that after adding `env` and `commands` to both existing stubs,
`bun test packages/vscode` goes 54 pass / 0 fail. `tooltip.test.ts` and `statusbar.test.ts` are
therefore **changed files in this loop**, which revision 1 did not have.

The lesson is the same one twice in one document: a single-file run is not evidence about the
suite.

### The status bar is real, and cannot be mocked

`doRefresh` hands every snapshot to `statusBar?.update(...)` — a real `StatusBarManager` reaching
real core through `./statusbar-bridge.js`. `extension.test.ts` **cannot** mock that module:
`statusbar.test.ts` already does, and a second mocker is an R2 violation under loop 026's guard.

So the tests are forced through real `classify`/`evaluate`/`emitProcess`, and:

1. Every snapshot the bridge mock returns must be a genuine `UsageSnapshot` — `makeTestSnapshot`
   from `@claudewatch/core/test-helpers`, as `statusbar.test.ts:2` already does.
2. `emitProcess` writes to `getCacheDir()`. The bridge mock stubs `setTelemetryConfig` to a no-op,
   so `extension.ts`'s consent push never reaches real core, and real core's `processConfig` is
   **whatever the previous test file left** — and `call-sites.test.ts` sets it `true` in several
   `beforeEach`es. One missed `afterEach` and this file writes to the developer's real
   `~/.cache/claudewatch/`.

### `refreshInFlight` DOES leak between tests — revision 1 closed Q2 on a false premise

Revision 1 said the `finally` at `:257` means "it cannot leak between tests. No test-only setter is
needed." **That is wrong**, and it was load-bearing for A3's dedupe case.

The `finally` clears it when the promise *settles*. `activate:103`'s `doRefresh(false)` is
un-awaited and nothing can await it, so a test can end while a refresh is suspended at
`await fetchUsage(...)`. `refreshInFlight` is then `true` entering the next test, and
`deactivate()` does not touch it. The reviewer measured exactly this, **with `deactivate()` in
`afterEach` as A5 prescribes**:

```
test A: slow fetch (200ms), ends while doRefresh is suspended  -> pass
test B: await activate(); expect one fetch                     -> Received: 0
```

The intent asked "what resets it between tests?" and named a real problem. Revision 1 asserted the
problem away. Reopened, and the spec must choose a mitigation because it shapes the whole test
file — see the await-point decision below.

### There is no await point, and the dedupe swallows the manual refresh outright

`:90` registers `() => { doRefresh(true); }` — the promise is discarded, so a test can never await
a refresh. Worse, revision 1's remedy does not work. Measured with a 5ms fetch:

```
await activate(ctx);                       // initial doRefresh suspends in fetchUsage
registered.get('claudewatch.refresh')!();  // dedupe: refreshInFlight === true
fetchCount = 1, delta = 0
```

**A6 said later cases could "subtract" the initial refresh. You cannot subtract — the second
refresh does not happen at all.** A6 solves an off-by-one that exists only for the synchronous
branches, and does nothing for the two fetch branches, which are the ones that suspend.

It also undercuts revision 1's headline: the "successful fetch" case would be driven by
`activate`'s initial refresh, not by the command — so it is *not* exercising "what a user
triggers".

**Decision, stated rather than discovered:** change `:90` to `() => doRefresh(true)`, returning the
promise. `registerCommand` accepts a `Thenable` return, so this is faithful to the host. It **is** a
production change made to suit tests, which A2 must therefore permit explicitly rather than
silently — and the honest framing is that the command currently discards a promise VS Code would
have accepted, which is a small real defect independent of testing.

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

### `packages/vscode/src/extension.ts` — one production change

`:90` becomes `() => doRefresh(true)`, returning the promise instead of discarding it. Justified
above; permitted explicitly by A2.

### `packages/vscode/src/tooltip.test.ts` and `statusbar.test.ts` — the shared `vscode` stub

Both gain `env` and `commands` so that whichever `mock.module('vscode')` wins the process-wide race
is a **superset** of what all three files need. Revision 1 did not have these as changed files, and
without them `activate` throws in a whole-package run.

### `packages/vscode/src/extension.test.ts` *(new)*

A `vscode` mock capturing `registerCommand` handlers; an `extension-bridge.js` mock; an isolated
`HOME` with an expired fixture credential; `ctx.subscriptions` disposed and `deactivate()` in
`afterEach`. Cases drive `activate` and, where the branch allows, the captured command.

## Edge cases

1. **The `vscode` mock is process-wide** and two other files already mock it. Loop 026 allowlists
   `vscode` as an ambient host, so a third mocker does not trip the guard — verified by the
   allowlist test. The intent's earlier concern that divergent stubs break each other was tested
   in loop 026 and found false three ways.
2. **`activate` does `await import('./commands.js')`**, which is a real module import. It resolves
   fine under the mock (the probe registered all three commands), and `commands.ts`'s own
   `await import('@claudewatch/core')` happens inside a function body, so it is not reached.
3. **The polling timer's interval floor is 30s**, so it cannot fire during a test — which is
   exactly why A5 must not assert "no further refresh occurs after deactivate" (see A5).
4. **Every mock return must be a real `UsageSnapshot`.** Revision 1 worried only about
   `makeCacheEnvelope`; the dangerous ones are `makeErrorSnapshot`, `normalize` and `markStale`,
   whose output goes straight into a real `StatusBarManager`. A malformed one throws into the
   catch-all and produces a green, meaningless test — which is precisely what happened to the
   revision-1 prototype.
5. **`deactivate()` disposes almost nothing.** `activate` pushes six disposables (telemetry
   listener, status-bar disposer, three commands, timer disposer, config listener);
   `deactivate` clears only `pollingTimer` and `statusBar`. `telemetryAllowed` also survives, so
   `telemetryOverride()` would report the previous test's consent. `afterEach` must dispose
   `ctx.subscriptions` **before** calling `deactivate()`.
6. **Re-registering a command id is a divergence from the real host.** Real
   `registerCommand` throws when an id is taken and not disposed. Calling `activate` once per test
   works only because the stub is unfaithful — worth knowing, given the selling point is "exercise
   what ships".
7. **`import('./commands.js')` at `:97` is a cache hit**, because `commands.js` is already
   statically imported at `:23`. Revision 1's reasoning ("it resolves fine under the mock") was
   right by accident.

## Acceptance criteria

Revision 1 had eight. The review found one vacuous, one that dropped an intent requirement, one
whose premise was false, and a branch list missing half the branches. Rewritten.

- **A1 — the three-bridge topology holds.** Loop 026's guard green, and **two** assertions in
  `mock-topology.test.ts` updated: the importer set at `:367` (`core-bridge.js` two → one) *and*
  the exact pairs at `:348`, which gains two entries for `extension.test.ts`. Revision 1 named only
  the first and called it "evidence the split happened"; evidence that enumerates half the updates
  is not.
- **A2 — no seam was added to make testing possible**, stated positively because the negative form
  had at least five loopholes (move `doRefresh` to a new module; widen the already-exported
  `telemetryOverride()`; change `activate`'s return type; stash state on `globalThis`; push a
  test-visible object onto `subscriptions`). The checkable form:
  - `extension.ts`'s export list is byte-identical before and after;
  - `activate`, `deactivate` and `telemetryOverride` keep their signatures;
  - the only new module in `packages/vscode/src` is `extension-bridge.ts`;
  - **the one permitted production change is `:90`'s `() => doRefresh(true)`**, named here so it
    cannot be slipped in.
- **A3 — every arm of `doRefresh`, enumerated.** Revision 1 listed seven branches; the reviewer
  found the list omits the catch-all at `:252`, the cooldown write-**suppression** arm (`:171-174`),
  the `|| !creds.accessToken` condition distinct from `authState === 'missing'`, and that "failed
  fetch" is four arms (`policy.presentation !== 'unknown'`, then cached/no-cache, each with a
  `shouldCooldown` split that maps onto SPEC.md §7.2 — `timeout` and `serviceUnavailable` cool
  down, `malformedResponse` and `unexpectedFailure` do not, which loop 010 split out precisely so
  it would not regress). Each arm gets a named mutation, and **any mutation reading "inert" is
  inspected before it is believed** — the clause revision 1 dropped from the intent.
- **A4 — the network is unreachable by construction, not by stub.** `beforeAll` points `HOME` at a
  `mkdtempSync` dir holding an **already-expired** `.claude/.credentials.json` (loop 024's fix), so
  a miss cannot become a live request *even if the bridge mock loses the process-wide race* — which
  B1 proves can happen. The throwing `fetchUsage` is the **second** layer. Revision 1 dropped the
  intent's `HOME` requirement entirely and kept only the stub.
  One stub function with a mode flag, default "throw", so the returning case and the throwing case
  are the same function and one genuinely evidences the other.
- **A5 — `deactivate` clears the timer, asserted on the handle.** Revision 1 said "observe that no
  further refresh occurs", which is unconditionally true given the 30s floor: gut `deactivate`'s
  body and it still passes. Instead, spy `globalThis.setInterval`, capture the handle, and assert
  `clearInterval` was called with **that handle** after `deactivate()` and not before. Mutation:
  deleting `extension.ts:132` must turn it red.
- **A6 — the initial refresh is accounted for by draining, not subtracting.** `activate` performs
  one un-awaited refresh; a later command can be *swallowed* by the dedupe rather than counted, so
  arithmetic does not work. Each case awaits a bounded settle (poll the bridge mock's call log until
  stable, failing explicitly on timeout) before asserting.
- **A7 — `bun run verify` exits 0**, and the vscode suite passes **as `bun test` from the root and
  as `bun test packages/vscode`**, not merely file-by-file. Loop 026's guard green with no
  allowlist entry. The "lint at the standing 12" clause is **dropped**: nothing counts warnings
  mechanically, and a mock-heavy test file is likely to add `consistent-function-scoping` warnings.
  Replacing a promise nobody checks with silence is the honest move.
- **A8 — what stays untested is listed here, with a `test.todo` per uncovered branch** so `bun test`
  prints the gap on every run. Revision 1 said "the test file's docstring says so", which any
  docstring satisfies.
- **A9 — the bridge mock's key set is asserted** (loop 026's A6a pattern). `mock.module` replaces
  wholesale, so an omitted symbol is `undefined` at call time → `TypeError` → the `:252` catch → a
  green, meaningless test. Revision 1 had this only as a Risk; B4 shows it is the failure that
  already happened once.
- **A10 — nothing writes to `~/.cache/claudewatch`.** Real core's telemetry config is whatever the
  previous test file left, and `call-sites.test.ts` sets it enabled. The test file asserts
  `{enabled:false}` or points `setCacheBaseDir` at a temp dir.

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
