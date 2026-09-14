# Intent: §12's surfaced-error clause is satisfied by accident, not by construction

- **ID:** 029-surfaced-error-guard
- **Stage:** 1 — Plan
- **Status:** draft
- **Author:** loop 028's security pass
- **Date:** 2026-08-27

## Problem

`SPEC.md §12` states two clauses this repo has never checked:

> - It must redact sensitive values from all surfaced errors
> - It must not include tokens in issue templates, screenshots, or debug output

There is **no redactor anywhere in the tree** and **no test for either clause**.
`packages/core/src/security.test.ts` has 14 tests covering the cache, the token, file modes and the
telemetry payload; not one covers a surfaced error.

## What the exposure actually is — measured, not assumed

Loop 028 shipped a characterization test that documented a §12 violation and **pinned a threat that
cannot occur**: it asserted a credential path and an `sk-ant-` token reach a modal via `readCache`
throwing, when `readCacheResult` wraps both `readFileSync` and `JSON.parse` and never opens the
credential file. That mistake is the reason this intent leads with measurements.

Every message that can reach a surfaced error, traced and measured:

| Source | Content | Measured |
|---|---|---|
| `client.ts:91,95,99,102` — HTTP failures | **constants**: `Authentication failed (401)`, `Rate limited (429)`, `Server error (${status})`, `Unexpected status ${status}` | read; no interpolation but the status code |
| `client.ts:200` — network failure | `err.message`, **uncontrolled** | bun 1.3.11 emits `"Unable to connect. Is the computer able to access the url?"` for connection-refused, TLS failure and timeout alike. No URL, no host, no proxy credentials — verified with `HTTPS_PROXY` set |
| `commands.ts:27` — the diagnostics modal | `err.message` from `readCache`/`formatTooltip` | the one reachable throw is `undefined is not an object (evaluating 'snapshot.fiveHour.utilizationPct')` |
| `format.ts:369` | `enterprise.disabledReason` — free text from the API | unconstrained; reaches **every** surface, not just errors |

**So nothing sensitive reaches a surfaced error today.** The invariant holds — and it holds because
of choices nobody wrote down as choices: that HTTP messages are constants, and that this runtime's
network errors happen to be generic.

## Why that is the problem rather than the reassurance

Compliance that is accidental is compliance that a one-line change removes silently. Adding a
response body to an error message, or surfacing `err.message` from a throw site nearer the token,
would breach §12 and **nothing in the gate would notice** — no test, no type, no lint rule.

This is the same shape as loop 014 (a `FailureClass` decision the compiler did not enforce) and
loop 026 (a mock topology nothing checked). Both were fixed by making the guarantee structural.

## The trap this loop must avoid

**Do not build a redactor against a fiction.** A `sk-ant-` stripper would defend a path no message
currently travels, and would be loop 028's error repeated one level up — defence-in-depth is only
depth if there is a first layer to be deep behind. Two facts constrain any redaction design:

- The diagnostics modal's **first field is `__filename`**, an absolute path containing the user's
  home directory, displayed **by design** and sanctioned by `§17` ("credential file path (not
  contents)"). A redactor that strips paths from the error string while the headline field is an
  absolute path would be incoherent.
- The larger uncontrolled surface is not an error path at all: `disabledReason` is interpolated
  verbatim on the **success** path into the status bar tooltip and the statusline.

## Who is affected

- **The user**, if a future change makes a surfaced error carry something it should not.
- **Anyone reading `SPEC.md §12`** and reasonably assuming the gate backs it — the same false
  assumption loop 028 found behind "no `any`".
- **The Marketplace goal**: an extension that displays error text to users is exactly the surface a
  store review would ask about.

## What "done" means

1. Every path by which text reaches a user-visible surface is **enumerated in one place**, with what
   may and may not appear on it.
2. A test that **fails** when a new sensitive value reaches any of those paths — demonstrated by
   seeding one and watching the gate go red, both halves shown.
3. A decision, recorded with its reasoning, on whether a redactor earns its place given that no
   current path carries anything sensitive — and if it does not, saying so plainly rather than
   building one for appearances.
4. `SPEC.md §12` gains a line pointing at the enforcing test, so the clause and its check are not
   discoverable only by grep.

## Not in scope

- Changing what any surface displays. `disabledReason` keeps rendering; this loop constrains what
  *may* reach it, not what does.
- The `__filename` field in the diagnostics modal — sanctioned by §17, and out of scope.
- `writeCache`'s missing `lstat`-before-write, noted by loop 028's security pass as pre-existing.

## Next stage

`/sdlc-spec` — the design question is whether the guard is a runtime test over real call sites, a
type-level constraint on what a surfaced message may be, or both.
