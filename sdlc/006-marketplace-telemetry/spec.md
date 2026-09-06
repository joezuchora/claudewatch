# Spec: make the extension's telemetry publishable

- **ID:** 006-marketplace-telemetry
- **Stage:** 2 — Design
- **Status:** accepted
- **Derived from:** [`intent.md`](./intent.md)

## Summary

Extension telemetry becomes the logical AND of VS Code's global switch and ClaudeWatch's own
setting, re-evaluated live. The setting is tagged so VS Code and enterprise tooling can see
it. The manifest and README gain what a Marketplace listing requires.

## Design decisions

### The global setting gates the spool write, not just shipping

The guidance says telemetry "must not be sent". Loop 003's architecture separates *writing to
a local spool* from *an agent shipping it*, so a literal reading would permit writing while
the global switch is off, as long as nothing ships.

**Rejected.** The spool exists to be shipped; data written there is collected data that has
not moved yet. A user who turns telemetry off and later enables it for an unrelated reason
would ship a backlog gathered while they had said no. Honouring the switch in spirit is also
simpler to explain in `SECURITY.md`, and a security claim nobody can restate accurately is
not worth making.

So: **global off ⇒ nothing is written.**

### Gate shape: `isTelemetryEnabled && claudewatch.telemetry.enabled`

Both must be true. Neither alone is sufficient. Concretely, VS Code's switch can only ever
*subtract* — it can never turn telemetry on for a user who did not ask for it.

The extension resolves this and passes an explicit override into
`resolveTelemetryConfig({ enabled })`, which loop 003 already supports as the highest-priority
input. **No change to `packages/core` is required.** That the seam already exists is a small
piece of evidence the layering is right.

### Live re-evaluation, not activation-time

`vscode.env.onDidChangeTelemetryEnabled` and `workspace.onDidChangeConfiguration` both
recompute the gate. Reading once at activation would leave a user who turns telemetry off
mid-session still being collected from until reload — technically a violation, and exactly the
kind of "we honour your setting (eventually)" behaviour the guidance exists to prevent.

Both disposables are registered in `context.subscriptions`.

### `packages/statusline` is unaffected

The statusline is not a VS Code extension, is not distributed through the Marketplace, and has
no access to `vscode.env`. Its gate stays as loop 003 built it. Worth stating so nobody
"fixes" it later for symmetry.

### Extension ID and publisher — proposed, not decided

`SPEC.md §19.1` lists this as an open gate. Publishing requires a Marketplace publisher
account, which is the user's to create.

- **Proposed publisher:** `joezuchora` — matches the GitHub owner already in `repository`, and
  a personal project is easier to verify under a personal publisher than an invented org.
- **Proposed extension ID:** `joezuchora.claudewatch` (from `publisher` + `name`), which means
  renaming `name` from `claudewatch-vscode` to `claudewatch`. The `-vscode` suffix is
  redundant in a VS Code marketplace and appears in the user-visible ID.

**The rename is deferred, not applied.** It changes the extension identity: anyone with the
current `.vsix` installed would see a second, unrelated extension rather than an upgrade. That
is a decision with a migration consequence and it belongs to the user, so this change records
the proposal and leaves `name` alone.

## Behavior

| VS Code global | `claudewatch.telemetry.enabled` | Result |
|---|---|---|
| off | false | no telemetry |
| off | **true** | **no telemetry** — the case the guidance is about |
| on | false | no telemetry (the default) |
| on | true | telemetry |

Changing either input takes effect immediately.

## Edge cases

| Case | Expected |
|---|---|
| `vscode.env.isTelemetryEnabled` unavailable (older host) | Treated as **false**. Fail closed: an unknown consent state is not consent. `engines.vscode` is `^1.85.0` and the API predates it, so this is defensive only. |
| Global switch flips off mid-session | Emission stops on the next render, no reload. |
| Extension setting flips while global is off | Still nothing. |
| Global on, setting flips true mid-session | Emission begins on the next render. |
| Spool already holds events, user turns global off | Existing spool is **not** deleted — it is the user's data on their own disk, and silently deleting files is worse than not writing new ones. No new events are written; the agent is theirs to run or not. |
| Reading either setting throws | Treated as false. |

## Data and types

No new types. `packages/core` is untouched — the extension passes an override into the
existing `resolveTelemetryConfig`.

Manifest additions: `keywords`, `bugs`, `homepage`, `galleryBanner`, `categories` gains
`"Visualization"` alongside `"Other"`, and the telemetry setting gains
`tags: ["telemetry", "usesOnlineServices"]` plus a `markdownDescription` linking the
disclosure.

## Backward compatibility

- **A user who changes nothing sees no change.** Both inputs default to a state that produces
  no telemetry.
- No change to `packages/core`, the statusline, the cache, exit codes, or the API contract.
- **`name` and `publisher` are unchanged**, so the extension identity is stable and no
  installed copy is orphaned.

## Acceptance criteria

- [ ] Global off + setting on ⇒ `resolveTelemetryConfig` receives `enabled: false` — tested
- [ ] Global on + setting on ⇒ `enabled: true` — tested
- [ ] Global on + setting off ⇒ `enabled: false` — tested
- [ ] `isTelemetryEnabled` absent ⇒ `enabled: false` (fail closed) — tested
- [ ] Either setting throwing ⇒ `enabled: false` — tested
- [ ] `onDidChangeTelemetryEnabled` and `onDidChangeConfiguration` both re-evaluate, and both
      disposables land in `context.subscriptions` — tested
- [ ] The setting declares `tags: ["telemetry","usesOnlineServices"]` — asserted against the
      manifest
- [ ] Manifest carries `keywords`, `bugs`, `homepage`, and a non-generic category — asserted
- [ ] The extension README states what is and is not collected
- [ ] `bun run verify` exits 0

The first five are asserted against a **pure function** taking both inputs, so they run
without a VS Code host. The regression this protects against is a boolean expression, and a
boolean expression is exactly what should be tested directly.

## Rejected alternatives

- **Gate only the agent, keep writing the spool.** Literal compliance, and it accumulates data
  the user declined to give.
- **Read the gate once at activation.** Simpler; violates the guidance for anyone who changes
  their mind mid-session.
- **Adopt `@vscode/extension-telemetry`.** Targets Azure Monitor, adds a runtime dependency,
  and ClaudeWatch ships to a service the user hosts.
- **Rename `name` to `claudewatch` now.** Correct destination, but it silently orphans
  installed copies. The user's call.

---

**Next stage:** Build — run `/sdlc-plan 006-marketplace-telemetry`.
