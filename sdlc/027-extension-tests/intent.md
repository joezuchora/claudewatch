# Intent: the extension's refresh logic has never been tested

- **ID:** 027-extension-tests
- **Stage:** 1 — Plan
- **Status:** accepted
- **Author:** loop 001's oldest open finding, re-recorded at 008, 009, 010, 014
- **Date:** 2026-08-27

## Problem

`packages/vscode/src/extension.ts` is 270 lines and has **no tests**. No `*.test.ts` in the package
imports it. Recorded as a follow-up since loop 001 and re-recorded four times since.

The untested part that matters is `doRefresh` (`:152`), which is the extension's entire runtime
decision tree: in-flight dedupe, the cache-fresh short circuit, the cooldown branch (which
**writes the cache**), credential resolution, the fetch, and every failure mapping. Loop 014's
`policy.presentation` work is load-bearing on branches in here that nothing exercises.

Three things make it untestable today, and they compound:

1. **`doRefresh` is not exported.** Only `activate`, `deactivate` and `telemetryOverride` are.
2. **It reads module-level mutable state** — `refreshInFlight`, `statusBar`, `pollingTimer`,
   `telemetryAllowed` — set by `activate`, which registers commands, pushes disposables, starts a
   timer and `await import`s a second module.
3. **Mocking its dependency now fails the gate.** `extension.ts` reaches core through
   `./core-bridge.js`, which `tooltip.ts` also imports. Run against loop 026's guard, a
   hypothetical `extension.test.ts` mocking it produces:

   ```
   R1  ./core-bridge.js
       mocked by packages/vscode/src/extension.test.ts but imported by 2 non-test files
       [extension.ts, tooltip.ts]
   ```

That third point is loop 026's guard doing its job on the very next item after it shipped, which
is worth stating plainly: it converted an invisible hazard into a red gate *before* anyone wrote
the test that would have silently stubbed `formatTooltip` for `tooltip.test.ts` all over again.

## Who is affected

Nobody's runtime — this is coverage, not a defect. The cost is that the extension's decision tree
is a place where changes cannot be checked. It is also the file that would have paid for loop
025's finding: **the process-wide mock that used to blanket `core-bridge.js` incidentally neutered
`resolveCredentials`, `fetchUsage` and `readCache` for the whole test process.** That accident is
gone, so the first `extension.test.ts` written without its own mock will resolve the developer's
real `~/.claude/.credentials.json` and make a live authenticated request — the loop-024 failure
mode, re-armed and pointed at the one file nobody has tested.

## Why now

Because the two obstacles that made this expensive are gone or converted:

- Loop 025 established the pattern (a per-consumer bridge) and proved the cost: one new module and
  one changed import line, not the "three-module refactor" the backlog claimed for four loops.
- Loop 026 turned "you might silently stub someone else's dependency" from a thing you have to
  remember into a thing the gate says out loud, with the offending importers named.

## What "done" means

- [ ] `doRefresh`'s branches are tested: in-flight dedupe, fresh-cache short circuit, the cooldown
      branch **including its cache write**, missing credentials, invalid credentials, a successful
      fetch, and a failed fetch.
- [ ] The tests spawn nothing and reach no network. Demonstrated, not asserted: a fixture
      credential that is already expired (per loop 024) plus an isolated `HOME`, so a miss cannot
      become a live request even if a branch is wrong.
- [ ] `bun run verify` stays green **including loop 026's guard**. If the guard goes red, the fix
      is to give `extension.ts` its own bridge — not to add an allowlist entry. An exemption here
      would be the guard's first use being to route around itself.
- [ ] Every new test fails when the branch it names is broken. Mutation-tested, results predicted
      first, and any "inert" result inspected before it is believed.
- [ ] What remains untested is written down. `activate` registers commands and starts a timer;
      full coverage of it is not the goal and pretending otherwise would be worse than the gap.

## Explicitly out of scope

- **`activate` and `deactivate` end to end.** They touch the VS Code API surface directly
  (`registerCommand`, `onDidChangeTelemetryEnabled`, `context.subscriptions`). Some of that will be
  reachable incidentally; chasing all of it is a different, larger change.
- **`commands.ts`'s `await import('@claudewatch/core')` bypass** — a standing loop-025 finding,
  adjacent and separate.
- **Refactoring `doRefresh` into smaller units.** Tempting, and it would make coverage easier, but
  it changes production code to suit a test rather than testing what ships. If a seam is genuinely
  required to reach a branch, that is a spec decision with its own justification, not a default.
- **The polling timer's scheduling.** Real-time behaviour; loop 019 already recorded what testing
  ambient time costs.

## Open questions

1. Does `doRefresh` need exporting, or can its branches be driven through `activate` plus the
   registered `claudewatch.refresh` command? The second tests what ships; the first is far simpler.
   Whichever is chosen, the reason belongs in the spec, because "export it for the test" is exactly
   the shape that gets waved through.
2. Module-level `refreshInFlight` persists across tests in one process. What resets it between
   cases without exporting a setter that exists only for tests?
3. Does the new bridge split leave `core-bridge.ts` with a single consumer, and is a module named
   for one consumer still the right shape when the package now has three of them
   (`statusbar-bridge`, `core-bridge`, and whatever this becomes)?
