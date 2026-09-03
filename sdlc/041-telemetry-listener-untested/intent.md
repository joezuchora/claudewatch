# Intent: the branch that honours VS Code's telemetry switch mid-session is untested, and its "why not" note is stale

- **ID:** 041-telemetry-listener-untested
- **Stage:** 1 — Plan
- **Status:** accepted
- **Author:** the SDLC loop, from `sdlc/039`'s and `sdlc/040`'s recorded-and-not-fixed lists
- **Date:** 2026-09-03

## Problem

`extension.ts:75-81` subscribes to VS Code's `onDidChangeTelemetryEnabled` and re-runs
`recomputeTelemetryGate()` when it fires. That subscription is the *live* half of the compliance
guarantee `sdlc/006` was opened for — VS Code's own guidance is that an extension must honour
`isTelemetryEnabled` **and** `onDidChangeTelemetryEnabled`, so that a user who turns telemetry off
mid-session stops being collected from without reloading the window.

`telemetry-gate.test.ts` covers the decision itself thoroughly: seven cases over
`resolveExtensionTelemetry`, including both fail-closed paths. **Nothing covers the wiring.** If the
callback were `() => {}`, or the subscription were dropped, or the disposable never pushed, every
test in this repository would still be green.

**And the note explaining why it is untested is no longer true.** `extension.test.ts:493` says:

> `test.todo('activate: the onDidChangeTelemetryEnabled listener')`
> — extension.ts:76-80. **Dead in this file because the `vscode` stub omits the key**, so the
> `typeof === 'function'` guard is false and the listener is never registered.

Measured today:

```
$ bun run scratch/probe.ts
typeof onDidChangeTelemetryEnabled = function
guard `=== function` would be: true
```

`sdlc/039`'s Stage 5 security pass added `onDidChangeTelemetryEnabled` to `vscode-stub.ts:132` when
the coverage walker's blind spot for cast-wrapped reads was fixed. The guard has been **true** ever
since, so the listener *is* registered on every `activate()` in that file — and the sentence
explaining its absence has been false for two loops while sitting directly above the `test.todo` that
cites it. That is this repo's dominant failure mode in miniature: a claim made by reading, left in
place while the thing it describes changed underneath it.

## Who is affected

Nobody today, and it would be inventing urgency to say otherwise: the decision function is correct
and well-tested, and the subscription is three lines that currently do the right thing.

Who it affects is specific. This is a **Marketplace compliance** property, and the extension is meant
to be published. A future edit to `activate()` — reordering registrations, refactoring the
`context.subscriptions` pushes, tightening the `typeof` guard — could silently drop the listener, and
the failure would be invisible: telemetry keeps flowing from a user who turned it off, the extension
still works, every test stays green, and the first signal would be a Marketplace review or a user
report. `sdlc/006` classified this exact guarantee as a **publishing blocker**.

## Why now

Three reasons, none of them urgent and all of them cheap:

1. **The blocker is asymmetric.** Every other half of the §12/§20 telemetry guarantee is enforced by
   a test or the type system. This one is enforced by nothing.
2. **The stale note is itself the bug this repo keeps paying for.** Leaving it costs nothing today
   and misleads the next reader, who will believe the branch is unreachable.
3. **The obstacle is gone.** The note was written when the stub lacked the key. It does not now, so
   the test that was impossible in `sdlc/039` is ordinary work in this one.

## What "done" means

- [ ] A test drives `activate()` and asserts the listener is **registered** — that the disposable
      lands in `context.subscriptions`, not merely that `activate` did not throw
- [ ] A test **fires** the registered callback and asserts the gate was **re-evaluated**, observed
      through a value the callback changes rather than through a spy on the callback itself
- [ ] The test discriminates: with the subscription removed, or its callback replaced by a no-op, it
      **fails** — demonstrated by mutation, with the prediction written before the run
- [ ] `extension.test.ts:490-493`'s stale note is corrected or removed, and the `test.todo` is either
      implemented or restated with a reason that is true
- [ ] Every `packages/vscode/src/*.test.ts` still passes **run alone**, with the per-file floors from
      `sdlc/040` respected and re-recorded in the same commit if they legitimately move
- [ ] `bun run verify` exits 0

## Explicitly out of scope

- **Any change to `extension.ts`'s behaviour.** This loop adds a test for a branch that already
  works. If the test finds a defect, that is a separate intent with its own spec — recorded, not
  fixed here.
- **The other two `test.todo`s** at `extension.test.ts:490-491` (`onDidChangeConfiguration`
  handlers, and `startPolling`'s 30s floor). Real gaps, different subjects, and bundling them would
  make the fence meaningless.
- **`telemetry-gate.ts` itself.** Its decision function is covered; nothing here changes it.
- **The Marketplace rename and publishing.** The user's call, both.

## Open questions

1. **Can the callback's effect be observed without a spy?** `recomputeTelemetryGate()` writes
   `telemetryAllowed` and pushes it into core via `setTelemetryConfig`. `telemetryOverride()` is
   exported and returns `{ enabled: telemetryAllowed }`, so there is a public read — but Stage 2 must
   check whether it is reachable in the test's module graph, and whether asserting through it is
   genuinely stronger than asserting the callback ran.
2. **Does firing the callback require the stub's disposable to record the callback?** The stub's
   `onDidChangeTelemetryEnabled` currently discards its argument
   (`(_cb: () => void) => disposable()`). Capturing it is a stub change, and `sdlc/040`'s reset now
   restores every leaf — so Stage 2 must confirm a captured callback does not leak between files.

Both are Stage 2's to settle with measurements, not mine to guess here.

---

**Next stage:** Design — run `/sdlc-spec 041-telemetry-listener-untested` to turn this into `spec.md`.
