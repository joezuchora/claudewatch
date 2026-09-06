# Intent: make the extension's telemetry publishable

- **ID:** 006-marketplace-telemetry
- **Stage:** 1 — Plan
- **Status:** accepted
- **Date:** 2026-08-26

## Problem

The longer-term goal is publishing ClaudeWatch to the VS Code Marketplace, with product
telemetry as a first-class use case. As designed in loop 003, the extension's telemetry
**would not be publishable**.

VS Code's [telemetry guidance for extension authors][vsc] is explicit:

> Extension authors must respect the user's choice by utilizing the `isTelemetryEnabled` and
> `onDidChangeTelemetryEnabled` API. If `isTelemetryEnabled` reports false, even if your
> setting is enabled, telemetry must not be sent.

Loop 003 gates emission on `claudewatch.telemetry.enabled` alone. A user who has set
`telemetry.telemetryLevel: "off"` globally — the setting VS Code presents as *the* control —
would still be collected from. That is the specific behaviour the guidance forbids, and it is
the kind of thing that gets an extension pulled rather than politely reviewed.

Two further gaps, smaller but on the same path:

- **The custom setting is untagged.** Guidance says extension telemetry settings should carry
  `tags: ["telemetry", "usesOnlineServices"]`, which is how VS Code surfaces them in its
  telemetry UI and how enterprise policy tooling finds them. Untagged, the setting is
  invisible to the people most likely to care.
- **The manifest is not publish-ready.** No `keywords`, `bugs`, or `homepage`; `categories` is
  the generic `["Other"]`. `SPEC.md §19.1` still lists "finalize extension ID and publisher
  naming" as an open release gate.

[vsc]: https://code.visualstudio.com/api/extension-guides/telemetry

## Who is affected

- **Users who have turned VS Code telemetry off globally** and would reasonably expect that to
  be the end of the conversation. Today it would not be.
- **Publishing.** This is a gate, not a nicety.
- **Enterprise users**, whose administrators manage telemetry centrally and whose tooling
  looks for the tags this setting does not have.

## Why now

Loop 003's `review.md` lists "VS Code render emission" as an unmet criterion. Wiring it before
this change would ship the violation. Doing this first costs nothing, because the call site
does not exist yet — the ordering is free only if taken now.

## What "done" means

- [ ] With VS Code telemetry off globally, **no telemetry is emitted**, regardless of the
      extension's own setting
- [ ] Turning VS Code telemetry off **while the extension is running** stops emission without
      a reload
- [ ] The extension's setting is discoverable as a telemetry setting in VS Code's own UI
- [ ] What is collected, and what is not, is stated where a prospective user reads it before
      installing
- [ ] The manifest carries what the Marketplace listing needs

## Explicitly out of scope

- **Actually publishing.** That needs a publisher account and is the user's call, not
  something to be done on their behalf.
- Choosing the final publisher name — proposed here, decided by the user.
- The remaining loop 003 call sites (`fetch_result`, `cache_event`, `schema_drift`). This
  change makes the gate correct; wiring comes after.
- `@vscode/extension-telemetry`. It targets Azure Monitor; ClaudeWatch ships to a service the
  user hosts, and adding a dependency would break `packages/core`'s zero-runtime-dependency
  property for no gain here.

## Open questions

- **Does the global setting gate the spool write, or only the shipping?** Resolved in Design.
  It determines whether "not sent" is honoured literally or in spirit.
- **What is the extension ID and publisher?** Proposed in Design; the user decides.

---

**Next stage:** Design — run `/sdlc-spec 006-marketplace-telemetry`.
