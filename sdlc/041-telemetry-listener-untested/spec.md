# Spec: the telemetry listener, tested over both its inputs and both its observables

- **ID:** 041-telemetry-listener-untested
- **Stage:** 2 — Design
- **Status:** revision 2 — draft REJECTED on three blocking findings; revision 1 REJECTED on a
  criterion that cannot pass, plus three numbers and mappings it stated without running
- **Derived from:** [`intent.md`](./intent.md)

## Summary

Four tests in `extension.test.ts` cover `extension.ts:75-81`: the listener is **registered** (asserted
by disposable identity), firing it **re-runs the gate over both its inputs and pushes the result into
core**, the **missing-key host** path is exercised, and the file's own gap count is **machine-checked**
rather than restated. The stale note goes and its `test.todo` with it. No product source changes.

## What the measurements decided

The first draft was **rejected**, and the finding that matters most is that its own key measurement
measured a constant.

| Measured | Result | Consequence |
|---|---|---|
| Does the `typeof === 'function'` guard pass today? | **yes** | The `test.todo`'s stated reason is false; the branch is live |
| Is the callback handed to the stub during `activate()`? | **yes** — captured | Registration is observable with no product change |
| `extension.ts:50-52` calls `.get<boolean>('telemetry.enabled')` with **no default argument** | stub returns `defaultValue` = `undefined` | — |
| `resolveExtensionTelemetry(true, undefined)` | **`false`** | **The AND is unconditionally false in this file unless `configValues` is seeded** |
| `resolveExtensionTelemetry(true, true)` | `true` | A2 must seed the setting or it asserts against a constant |
| First draft's "proof" that firing works: `setTelemetryConfig({"enabled":false})` | that `false` was the **constant** | The draft's central measurement would have produced identical output against a callback hard-wired to `false`, or against no callback at all |
| Removing only the telemetry `subscriptions.push` | `activate` still pushes **6** of 7 disposables | `subscriptions.length > 0` does **not** discriminate. Assert **identity** |
| `grep -rn "telemetryOverride"` across the tree | **one hit — its own definition** | It has zero product callers, despite its docstring and `sdlc/007`'s spec describing a call site |

**The first draft's central argument was right in its conclusion and wrong in its reasoning.**
It rejected `telemetryOverride()` on the grounds that `setTelemetryConfig` is strictly stronger.
Measured, they catch **disjoint** mutants: a listener that recomputes without pushing is caught only
by `setTelemetryConfig`; one that pushes a locally-computed value without updating `telemetryAllowed`
is caught only by `telemetryOverride()`. Asserting both costs one line. The genuinely decisive fact —
that `telemetryOverride` is currently **dead** — went unstated, which is why the draft could argue
about its strength without noticing it has no callers.

## Behavior

No behavior changes. `extension.ts` is not touched. What changes is what is asserted about it.

The guarantee under test is **`SPEC.md` §10.6 Settings** (line 595): *"VS Code's global telemetry
setting takes precedence… The extension setting can only narrow, never widen. Both inputs are
re-evaluated live."* The first draft cited §12, which is the trust boundary and says nothing about
this. A2 covers the **live re-evaluation** half of that clause for the global switch;
`onDidChangeConfiguration`'s half stays deferred, and this spec says so rather than implying full
coverage.

### `extension.test.ts` — four tests in one `describe('the telemetry listener')`

All four drive `activate(ctx)` directly (never `start()`, which clears `calls` at line 210) and
`await flush()` afterwards, because `activate` fires an un-awaited `doRefresh(false)`.

1. **Registered, by identity.** The override returns a **sentinel** disposable; the test asserts
   `expect(ctx.subscriptions).toContain(sentinel)`. Not `.length`, not `toBeGreaterThan` — measured,
   deleting the telemetry push leaves six other disposables and a length assertion passes.
2. **Fires, over both ANDed inputs, on both observables.** Seed
   `resetVscodeStub().configValues['telemetry.enabled'] = true` first — without it the AND is
   constant `false`. Then assert the truth table at the callback:

   | setting | switch | expected |
   |---|---|---|
   | `true` | `true` | `{ enabled: true }` |
   | `true` | `false` | `{ enabled: false }` |
   | `false` (seeded explicitly) | `true` | `{ enabled: false }` — the *narrow, never widen* clause |

   Row 3 seeds the setting to `false` rather than leaving it unseeded. Both produce `false`, but only
   the explicit seed distinguishes *the user turned it off* — which is what the *narrow, never widen*
   clause is about — from *the stub was never seeded*.

   Each row asserts **both** the last `setTelemetryConfig` argument and `telemetryOverride()`. Read
   the last call with `calls.findLast(...)`, not `calls.filter(...).at(-1)`: the latter adds a
   `unicorn(prefer-array-find)` warning and reddens `lintBudget`.
   Varying only the switch leaves a mutant that drops the setting from the AND invisible; measured,
   such a mutant passes the whole package green.
3. **A host without the key.** Two halves in one test, so the negative has a positive control and no
   magic number. First with the leaf present: drive `activate`, record `withKey =
   ctx.subscriptions.length`, assert `toContain(sentinel)`. Then dispose, `deactivate()`, reset,
   `delete` the leaf, drive `activate` again, and assert `not.toContain(sentinel)` and
   `length === withKey - 1`. That activation *resolves* is checked by the `await` — a rejection fails
   the test — not by an assertion, which is why test 3 contributes three `expect()` calls, not four. **Not `toBe(6)`** — a hard-coded count breaks the day anything else
   in `activate` pushes a disposable, and the next person bumps it to 7 and silently empties the
   assertion. That is this repo's documented failure mode.
   The first draft called this path "already covered" and it is covered by nothing: the stub defines
   the key for every file, and `extension.test.ts` is the only file that imports `extension.js` at all.
4. **The gap count is machine-checked.** See A4.

### The stale note and the gap count

The comment above the `onDidChangeTelemetryEnabled` `test.todo` claims the branch is dead "because the
`vscode` stub omits the key". It has been false since `sdlc/039` added the key. The comment and the
todo go.

The header docstring says three gaps beside three todos and becomes **two and two** — but it is not
enough to restate a count that already drifted once. The docstring gains one canonical machine-readable
line, `GAPS: 2`, and a test parses it. Prose keeps its words; the assertion never reads them.

## Data and types

No new exports, no signature changes, no new file. `extension.test.ts` gains one `describe`, one
docstring line (` * GAPS: 2`), and one import — `readFileSync` from `fs`, which A4 needs to read the
file back. Revision 1 enumerated the change and omitted the import.

## Edge cases

| Case | Expected |
|---|---|
| A host that does not implement `onDidChangeTelemetryEnabled` | guard false, nothing registered, activation succeeds — **covered by test 3**, which this spec adds rather than claiming pre-existing |
| Setting on, switch off | `{ enabled: false }` — covered by A2's row 2 |
| Setting off, switch on | `{ enabled: false }` — covered by A2's row 3, the *narrow, never widen* clause |
| Setting unseeded (`undefined`) | `false`, and this is the default state of every other test in the file |
| `isTelemetryEnabled` throws when the listener fires | caught by `recomputeTelemetryGate`'s `try`, fails closed. Covered by `telemetry-gate.test.ts`; not re-tested |
| The overridden leaf leaks to the next test | restored by `resetVscodeStub()`; proven by `sdlc/040` A1, which walks all 13 leaves including this one (re-verified: `LEAF COUNT = 13`, `HAS env.onDidChangeTelemetryEnabled = true`) |
| `deactivate()` with the listener registered | `deactivate` clears only `pollingTimer` and `statusBar` and never touches `context.subscriptions`; the `afterEach` disposes them. The first draft said the leak was "past `deactivate`", which is wrong — it is past *host* disposal |

## Backward compatibility

- No product source change; no exported signature change.
- The six other vscode test files are untouched: commands 5, manifest 6, statusbar 29, telemetry-gate 7, tooltip 10, vscode-stub 20.
- `extension.test.ts` moves from `{ pass: 20, expects: 41 }` to `{ pass: 24, expects: 56 }`, and its
  `test.todo` count from 3 to 2. **Both numbers are derived, not guessed.**
  `pass`: bun reports todos separately, so deleting a todo does not move `pass`; 20 + 4 tests = **24**.
  `expects`: test 1 contributes 2 (callback captured, `toContain(sentinel)`), test 2 contributes 6
  (three rows × two observables), test 3 contributes 3 (`toContain` with the key, `not.toContain`
  without it, `length === withKey - 1`), test 4 contributes **4** (the equality plus
  A4's three controls). 41 + 15 = **56**.
  Revision 2 said 55 by counting test 4's controls as two — the derivation was written when A4 had
  two and was not updated when the third was added. **Third wrong value for this number**, and the
  first that the `>=` floor would never have surfaced.
  Revision 1 asserted `56` with no derivation and it **missed by two** — measured 54 against the
  weaker test 3, 55 against the stronger one. Worse, the floor is `>=`
  (`scripts/vscode-stub-cover.test.ts:114-117`), so an over-prediction reddens the gate and gets
  edited down while an **under**-prediction is invisible forever. "A prediction that misses is a
  signal" only holds in one direction, which is why the number now comes from a per-test count that a
  reader can check rather than from a total that only the author could have produced.
- **Risk named:** these tests are the only ones that override this stub leaf. If `sdlc/040`'s reset were weakened, this file surfaces it first — an argument for the tests, since the alternative is telemetry escaping in production.

## Acceptance criteria

- [ ] **A1 — the listener is registered, asserted by identity.** `expect(ctx.subscriptions).toContain(sentinel)` where `sentinel` is the disposable the test's override returned. A length or non-empty assertion does **not** satisfy A1; measured, it survives deleting the push.
- [ ] **A2 — firing re-runs the gate over both inputs, on both observables.** The three-row truth table above, each row asserting the last `setTelemetryConfig` argument **and** `telemetryOverride()`. Requires seeding `configValues['telemetry.enabled'] = true`.
- [ ] **A3 — it discriminates.** **Seven** mutations of `extension.ts`, each predicted before running,
      each named with the criterion it must break, and **every test evidenced by at least one**:
      (1) delete the `subscriptions.push` wrapper → **A1 and test 3's first half**;
      (2) push a decoy disposable instead → **A1 and test 3's first half**;
      (3) replace the callback with `() => {}` → **A2**;
      (4) force the `typeof` guard false → **A1, A2, and test 3's first half**;
      (5) drop `settingEnabled` from the AND → **A2 row 3**;
      (6) push a local value to core without updating `telemetryAllowed` → **A2's `telemetryOverride()`
          half**, which is the mutant `setTelemetryConfig` alone cannot see;
      (7) **delete the `typeof` guard entirely**, registering unconditionally → **test 3**. This is the
          mutation test 3 uniquely kills, and without it test 3 ships with no evidence that it
          discriminates anything — the standard A3 imposes on A1 and A2. It is also the realistic
          edit: someone tidying a cast-heavy `typeof` check on a key the stub always supplies, which
          is verbatim the scenario `intent.md` names as this loop's reason.
      Failing test named per mutation in `review.md`. **A1 and A2 without A3 are not evidence.**

      **Why test 3 appears against three mutations, and why revision 2 said it appeared against
      none.** Test 3 *was* vacuous under mutation 4 — in its single-half `toBe(6)` form, where
      "nothing registered" is what the mutant does anyway. The two-half shape introduced for C7 adds
      a positive control: the first half asserts `toContain(sentinel)` **with the key present**, and
      that is exactly what mutations 1, 2 and 4 break. The vacuity finding was measured against the
      design C7 replaced and then carried onto the design that fixes it. This is the strongest
      argument *for* the two-half shape, and revision 2 recorded it as an argument against.
- [ ] **A4 — the gap count is computed, not restated.** The docstring gains ` * GAPS: 2`, parsed by
      `/^ \* GAPS: (\d+)$/m`. The actual count is `/^test\.todo\(/gm` over
      `readFileSync(import.meta.path)`.
      **The `^` anchor is what stops the test counting itself** — its own regex sits indented inside a
      `const` and never matches at column 0. Revision 1 said the mechanism was assembling the pattern
      as `'test' + '.todo('`, and that was wrong twice over: measured, un-assembling it changes
      nothing (the test still passes), and the concatenation adds two `eslint(no-useless-concat)`
      warnings to a file that currently has zero, which reddens `lintBudget` and makes A4 and A5
      unsatisfiable together. **Use the anchored literal.** The
      `scripts/vscode-stub-cover.test.ts` analogy does not transfer: that dodge exists because
      `mock-topology.ts` scans for an *unanchored substring*.
      Two controls: the claimed-count regex must extract `3` from a **synthetic** fixture string
      ` * GAPS: 3` (there is no historical `GAPS:` line — the old docstring said "THREE" in prose),
      and the actual count is asserted `> 0` so an unmatched pattern cannot be green-forever. A third
      pins the anchor itself: the pattern must **not** match the docstring's own prose mentions of
      `test.todo`.
- [ ] **A5 — nothing else moved.** All seven vscode test files pass run alone; the predicted floors above are met or the miss is investigated and recorded; `bun run verify` exits 0; `.oxlint-budget.json` unchanged.

**Which of these discriminate.** A3 is the evidence base. A4 and test 3 fail against the tree as it
stands. A1 and A2 are assertions that a working branch works — necessary, and not sufficient alone.

## Rejected alternatives

- **Assert only on `setTelemetryConfig`.** The first draft's position, measured wrong: a mutant that
  pushes correctly while leaving `telemetryAllowed` stale passes it and fails `telemetryOverride()`.
  They are disjoint, not ordered.
- **Assert only on `telemetryOverride()`.** Equally partial, and it is a dead export — see below.
- **Vary only the global switch.** Measured: a mutant dropping the setting from the AND ships the whole
  package green, inverting `SPEC.md:595`'s *narrow, never widen* clause.
- **Make the stub capture the callback permanently.** Shared mutable state for one file's benefit; a
  per-test override is proven not to leak.
- **Spy on `recomputeTelemetryGate`.** Not exported; exporting it to test it changes the product to
  suit the test.
- **Fold in the two remaining `test.todo`s.** Different subjects; their stated reasons are still true,
  unlike this one's.

## Recorded, not fixed

- **`telemetryOverride()` has zero callers in the product.** One occurrence tree-wide: its own
  definition. Its docstring says it is "handed to core's `resolveTelemetryConfig`", and
  `sdlc/007-telemetry-call-sites/spec.md:34` describes `setTelemetryConfig(telemetryOverride())` at
  activation. That call site does not exist. This loop **pins** the function's behaviour in A2 rather
  than deleting or wiring it, because either would be a product change this intent forbids. It is a
  separate item: an exported public contract nothing uses, sitting one function above this loop's
  subject.
- **`onDidChangeConfiguration`'s telemetry branch** is the other half of `SPEC.md:595`'s live
  re-evaluation clause and stays deferred, with its `test.todo` and a reason that is still true.
- **Line citations** in `intent.md` are off by a few lines (the file is 490 lines; the comment is
  487-489). Corrected here by citing symbols rather than numbers.

---

**Next stage:** Build — run `/sdlc-plan 041-telemetry-listener-untested` to turn this into `plan.md`.
