# Review findings: make the extension's telemetry publishable

- **ID:** 006-marketplace-telemetry
- **Stage:** 5 — Deploy
- **Reviewed against:** [`plan.md`](./plan.md) and [`/REVIEW.md`](../../REVIEW.md)

## Plan-to-diff audit

**Verdict: CLEAN.** Every changed file is inside the fence.

Notably, **`packages/core` was not touched** — the fence excluded it precisely so that a need
to change it would surface as a finding rather than a quiet edit. `resolveTelemetryConfig`'s
existing override parameter accepted the gate without modification, which is a small piece of
evidence that loop 003's layering was right.

`manifest.test.ts` was added and was not in the fence. Necessary: two acceptance criteria are
assertions about the published manifest, and there was nowhere to put them. Recorded here.

## Pass 1 — Bugs and logical errors

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | major | Truthiness would have been the natural implementation and is wrong. `'true'`, `1` and `{}` are all truthy; none is a user consenting. | `resolveExtensionTelemetry` requires strict `=== true` on both inputs. Tested against `'true'`, `1`, `{}`, `[]`, `'yes'`. |
| 2 | major | Reading the gate once at activation would keep collecting from a user who turned telemetry off mid-session until reload — technically a violation. | Both `onDidChangeTelemetryEnabled` and `onDidChangeConfiguration` recompute; both disposables go into `context.subscriptions`. |
| 3 | minor | `vscode.env.isTelemetryEnabled` can be absent on an older host, and either read can throw. | Both wrapped; a failed read yields a sentinel that fails closed. An unknown consent state is not consent. |

## Pass 2 — Security and vulnerabilities

The change **narrows** what can be collected and adds no new capability. No network call, no
new I/O, no credential path.

**The decision worth recording:** the global switch gates the *spool write*, not just
shipping. A literal reading of "must not be sent" would permit writing while the switch is
off, provided nothing ships. Rejected — the spool exists to be shipped, and a user who
declined and later enabled telemetry for an unrelated reason would ship a backlog gathered
while they had said no. Global off means nothing is written.

The existing spool is deliberately **not** deleted when the switch flips off. It is the user's
data on their own disk; silently deleting files is a worse behaviour than not writing new ones.

## Pass 3 — Compliance

- No `any` in `telemetry-gate.ts`; `extension.ts` uses narrow structural casts to probe an API
  that may be absent, rather than `any`.
- No domain logic added to a surface — the gate is host-consent resolution, not domain logic,
  and `packages/core` is untouched.
- VS Code bundle still CommonJS: 17 `require`/`module.exports` occurrences.
- `SPEC.md §10.6` amended to state the precedence; §19.1's publisher gate records the proposal
  and that the decision is the maintainer's.

## Verification evidence

```
$ bun run verify
verify: pass in 29.5s  [typecheck 1.9s  lint 0.1s  test 27.4s  build 0.1s]
VERIFY EXIT=0
```

| Criterion | Result |
|---|---|
| Global off + setting on ⇒ no telemetry | **pass** — the case that would have blocked publishing |
| Global on + setting on ⇒ telemetry | pass |
| Global on + setting off ⇒ none | pass |
| Undefined global ⇒ fails closed | pass |
| Non-boolean / thrown ⇒ fails closed | pass |
| Setting tagged `telemetry` + `usesOnlineServices` | pass, asserted against the manifest |
| Manifest listing fields present | pass |
| Category more specific than `Other` | pass |
| `engines.vscode` supports the API (≥1.55) | pass — currently `^1.85.0` |
| Disclosure in the extension README | pass |

## Acceptance criteria not met

- **"Both disposables land in `context.subscriptions`" is not directly asserted.** The plan
  flagged this risk: `statusbar.test.ts` mocks `vscode` process-wide, so a test constructing a
  fake `ExtensionContext` would fight that mock rather than test the code — the residual
  intra-package contamination recorded in loop 003. The registration is three lines of
  straight-line code in `activate`, and `extension.ts` has had no tests since before this loop
  (a loop 001 finding, still open). Recorded rather than faked.

## Findings deliberately not fixed

1. **The extension is not renamed to `claudewatch`.** `joezuchora.claudewatch` is the right
   final ID, but renaming `name` changes extension identity — anyone holding the current
   `.vsix` would see a second, unrelated extension rather than an upgrade. That migration is
   the maintainer's call. Proposal recorded in `SPEC.md §19.1`.
2. **Publishing is not performed.** It needs a Marketplace publisher account.
3. **The remaining loop 003 call sites** (`fetch_result`, `cache_event`, `schema_drift`, and
   VS Code `render`) are still unwired. They are now *safe* to wire, which was the point of
   doing this first — wiring them before this change would have shipped the violation.
4. **`extension.ts` still has no tests** — loop 001's finding. The gate was put in its own
   module so the compliance logic is covered regardless.

## Note on process

This change cost almost nothing because of when it happened. The VS Code call site did not
exist yet, so making the gate correct was a new file and a wiring change rather than an
audit-and-retrofit across live code paths.

That was luck disguised as sequencing: the Marketplace goal surfaced in conversation *after*
loop 003 shipped but *before* its VS Code criterion was wired. Had the order been reversed,
this would have been a compliance retrofit on shipped behaviour, which is the expensive
version.

The transferable point is narrow and real: **when a distribution channel has rules, read them
before wiring the code, not before shipping it.** One search would have caught it in loop 003.

---

**Next stage:** Maintain.
