# Intent: turning telemetry off mid-session keeps emitting, and no test notices

- **ID:** 042-setting-observable-unfired
- **Stage:** 1 — Plan
- **Status:** accepted
- **Author:** the SDLC loop, from `sdlc/041`'s Stage 5 security pass
- **Date:** 2026-09-07

## Problem

`SPEC.md` §10.6 (line 595) makes three claims about the telemetry gate:

> VS Code's global telemetry setting takes precedence… **The extension setting can only narrow, never
> widen. Both inputs are re-evaluated live.**

`sdlc/041` covered the *global switch's* live re-evaluation — `onDidChangeTelemetryEnabled`, at
`extension.ts:75-81`. The **setting's** half is `extension.ts:115-127`'s `onDidChangeConfiguration`
handler, whose telemetry branch calls `recomputeTelemetryGate()`. Nothing fires it.

Measured against HEAD, by gutting that branch and running the whole package plus the harness:

```
$ bun test packages/vscode/src/ scripts/      # with recomputeTelemetryGate() removed
 428 pass
   0 fail
```

**A user who turns `claudewatch.telemetry.enabled` off mid-session keeps being collected from until
they reload the window**, and every test in this repository stays green while it happens.

That is the *unsafe* direction. The global switch failing open would be caught by `sdlc/041`'s tests;
the setting failing open is caught by nothing. And "narrow, never widen" is specifically a promise
about **this** input — the setting is the only one a user of this extension controls directly.

## Who is affected

Anyone who opts out after activation, which is the normal way people opt out: you notice telemetry
exists, you turn it off, and you expect it to stop. It does not stop until the window reloads. The
`SPEC.md` sentence promising otherwise is published, and `SECURITY.md` and the Marketplace listing
rest on it.

Nobody is affected *today* only in the sense that the code is currently correct — the branch does
call `recomputeTelemetryGate()`. What is missing is anything that would notice if it stopped. Given
`sdlc/041` found the neighbouring listener's `test.todo` explaining itself with a reason that had been
false for two loops, "currently correct and unguarded" is not a comfortable place to leave a
compliance guarantee.

## Why now

- **It is the last unguarded half of a published guarantee.** `telemetry-gate.test.ts` covers the
  decision, `sdlc/041` covers the global switch's observable, and this is the remaining input.
- **It is the direction that leaks.** A regression here emits telemetry from someone who declined.
- **The pattern is established.** `sdlc/041` worked out how to capture a discarded stub callback,
  drive `activate` safely, and assert on `setTelemetryConfig` plus `telemetryOverride()`. This is that
  pattern applied to a second event source, not a new design.
- **Marketplace publication is the standing goal**, and `sdlc/006` classified this guarantee as a
  publishing blocker.

## What "done" means

- [ ] A test captures the `onDidChangeConfiguration` callback, fires it with an event whose
      `affectsConfiguration('claudewatch.telemetry.enabled')` is **true**, and asserts the gate was
      re-evaluated — observed through `setTelemetryConfig` and `telemetryOverride()`, as `sdlc/041`
      established
- [ ] The test discriminates: with `recomputeTelemetryGate()` removed from that branch it **fails**.
      Predicted before running, and the failing test named in `review.md`
- [ ] A test asserts the branch is **conditional** — an event that does not affect
      `claudewatch.telemetry.enabled` does not recompute. Without this, a mutation that drops the
      `affectsConfiguration` check and recomputes unconditionally would pass
- [ ] The `test.todo('activate: the onDidChangeConfiguration handlers …')` is updated or removed, and
      the docstring's `GAPS:` count moves with it — `sdlc/041`'s A4 will fail otherwise, which is the
      guard working
- [ ] Every `packages/vscode/src/*.test.ts` still passes **run alone**, floors re-recorded in the same
      commit
- [ ] `bun run verify` exits 0

## Explicitly out of scope

- **The handler's other two branches.** `refreshIntervalSeconds` → `startPolling()` and the two
  threshold settings → `updateThresholds()` are real gaps in the same function, and bundling all
  three is how a fence stops meaning anything. Stage 2 must state this limit rather than let the
  criteria drift into it. They keep their own `test.todo`.
- **`startPolling`'s 30s floor** — the other surviving `test.todo`, a different subject.
- **Any change to `extension.ts`.** The branch is correct; it is untested. A defect found on the way
  is a separate intent.
- **`commands.ts:11`'s baked build path** — `sdlc/041`'s other recorded finding, filed separately,
  and a product change rather than a test.
- **The Marketplace rename and publishing.** The user's call, both.

## Open questions

1. **What shape does the fired event need?** The handler calls `e.affectsConfiguration(key)`. A test
   must supply an object with that method, and Stage 2 must decide whether it returns a fixed `true`
   or inspects the key — the latter is what makes the conditional-branch criterion meaningful.
2. **Does the stub need to change?** `vscode-stub.ts:159` has `onDidChangeConfiguration: disposable`,
   which discards its callback exactly as the telemetry leaf did. `sdlc/041` settled that a per-test
   override does not leak, because the reset restores all 13 leaves — but that was measured for a
   different leaf, and Stage 2 should confirm rather than assume it transfers.

Both are Stage 2's to settle with measurements.

---

**Next stage:** Design — run `/sdlc-spec 042-setting-observable-unfired` to turn this into `spec.md`.
