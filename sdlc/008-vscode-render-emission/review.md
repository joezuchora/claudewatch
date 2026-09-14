# Review findings: the extension should report its own renders

- **ID:** 008-vscode-render-emission
- **Stage:** 5 — Deploy

## Plan-to-diff audit

**Verdict: CLEAN.** Three files, all inside the fence.

## Pass 1 — Bugs and logical errors

No findings. The change is one emission at one funnel.

Worth noting what did **not** need doing: `statusbar.ts` needed no consent logic. Loop 007's
process-level config meant the correct behaviour was the default one, and the wrong behaviour
was not expressible at this call site. That is what that design decision was for.

## Pass 2 — Security and vulnerabilities

No findings. Asserted directly: the payload contains the decile `4`, and `JSON.stringify` of
it does not contain the raw `42`.

The consent path is intact — `emitProcess` reads the config `extension.ts` sets from
`recomputeTelemetryGate`, so VS Code's global switch governs this call site exactly as it
governs the other three kinds.

## Pass 3 — Compliance

No domain logic added to a surface — the emission builds its payload with core's builder.
VS Code bundle still CommonJS: 17 occurrences. No `any`. No spec amendment needed;
`SPEC.md §17` already describes this behaviour.

## Verification evidence

```
$ bun run verify
verify: pass in 33.3s  [typecheck 2.0s  lint 0.1s  test 31.1s  build 0.2s]
VERIFY EXIT=0
```

`bun test packages/vscode/`: **49 pass**, including the four new emission cases.

**All four acceptance criteria met.** With this, every criterion from loop 003's original spec
is now either met or explicitly recorded as not — the 003 → 007 → 008 sequence is closed.

## Findings deliberately not fixed

1. **`packages/vscode`'s process-wide bridge mock** — loop 003's residual finding. Splitting
   the bridge per consumer would fix it, but that is a three-module refactor to enable an
   assertion that was available without it. Still open, still recorded.
2. **`extension.ts` has no tests** — loop 001's finding. The emission lives in `statusbar.ts`
   partly because that file is testable and `extension.ts` is not.
3. Prior follow-ups unchanged: the 51 ms p95, `FailureClass`'s missing timeout, the ~26 s of
   real `setTimeout` sleeps.

## Note on process

A one-line emission needed a design stage for exactly one reason: **twelve call sites**. The
obvious implementation — emit where the refresh path updates the bar — would have meant twelve
edits, and loop 007 had already demonstrated in `client.ts` what happens when a multi-exit
function grows an emission per exit.

Finding the funnel took less time than writing this paragraph. Not finding it would have cost
a follow-up loop.

---

**Next stage:** Maintain.
