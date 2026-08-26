# Spec: the extension should report its own renders

- **ID:** 008-vscode-render-emission
- **Stage:** 2 — Design
- **Status:** accepted
- **Derived from:** [`intent.md`](./intent.md)

## Design decisions

### Emit from `StatusBarManager.update()`, the single funnel

`doRefresh` calls `statusBar?.update()` from **twelve** places. Emitting at each would repeat
exactly the hazard loop 007 hit in `client.ts`, where multiple returns each needed routing
through a `report()` helper or the event would be silently missed on some paths.

`update()` is the one point every render passes through, and it mirrors the statusline's
`output()` — the same architectural shape for the same reason.

### Use `emitProcess`, so the call site holds no consent state

`emitProcess` reads the process config that `extension.ts` pushes in from
`recomputeTelemetryGate` (loops 006 and 007). `statusbar.ts` therefore has **no consent state
of its own to get wrong**, and cannot bypass VS Code's global switch even by mistake.

This is the payoff of loop 007's decision to make consent a process-level property rather than
something each call site resolves.

### The mock becomes the spy

`statusbar.test.ts` mocks `./core-bridge.js` process-wide — loop 003's residual finding, and
the reason 007 deferred this. Here it works in our favour: the mock supplies `emitProcess` as
a recording stub, so the wiring is directly assertable without a VS Code host.

Rejected: splitting the bridge per consumer. It would fix the underlying contamination, but
that is a refactor of three modules to enable one assertion, and the assertion is available
without it. The contamination stays recorded as its own open item rather than fixed in
passing.

### No event on the initializing path

`update(null, …)` renders a placeholder with no snapshot. An event there could carry no
`runtimeState`, `tier`, or bucket — it would assert a render of nothing.

## Edge cases

| Case | Expected |
|---|---|
| `update(null, true/false)` | No event. |
| Degraded snapshot, null utilization | Emits, `utilizationBucket: null`. |
| Consent off | `emitProcess` no-ops; no filesystem access. |
| Repeated identical renders | One event each — `update()` is the funnel, and render *rate* is signal. |

## Backward compatibility

No behaviour change with telemetry off, which is the default. No signature changes. No change
to core, the statusline, or the manifest.

## Acceptance criteria

- [ ] One `render` per `update()` with a snapshot — tested
- [ ] Payload carries `surface: 'vscode'`, state, tier, and a **decile** not the raw figure — tested
- [ ] Initializing path emits nothing — tested
- [ ] Degraded snapshot emits with a null bucket — tested
- [ ] `bun run verify` exits 0

---

**Next stage:** Build.
