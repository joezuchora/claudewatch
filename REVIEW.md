# Review policy

Every change to ClaudeWatch is reviewed in three passes before it merges. The passes run in
order, and each runs on every change — including the ones that look trivial, because "it
looked trivial" is when things get through.

Findings are recorded in the change's `sdlc/<NNN>-<slug>/review.md`, including the ones
deliberately not fixed. A silently dropped finding defeats the point of writing them down.

**Severities:** `blocking` (must fix before merge) · `major` (fix, or record why not) ·
`minor` · `nit`.

---

## Pass 1 — Bugs and logical errors

Reviewed by the engineer, against `spec.md` and `SPEC.md`.

- **Contract drift.** Does the diff still honor the API contract in `SPEC.md §3`? The
  `anthropic-beta: oauth-2025-04-20` header is required. Unknown response fields are
  ignored, not rejected. Missing optional fields are **omitted, not guessed** (§3.3).
- **Enterprise variant (§3.5).** Rolling windows are `null` and `extra_usage` carries the
  credit pool. `monthly_limit` and `used_credits` are **currency minor units** — any
  arithmetic or display treating them as whole units is a blocking finding.
- **Runtime states (§7).** All seven states — Initializing, Healthy, Stale, Degraded,
  AuthInvalid, NotConfigured, HardFailure — must remain reachable and correctly handled.
  A new failure mode that collapses into an existing state is a design decision, not an
  accident: it should appear in `spec.md`.
- **Primary window rule (§5.3).** Primary utilization is the *highest* across supported
  windows. Changes here alter what every user sees; verify against both the standard and
  enterprise fixtures.
- **Time handling (§6).** Internal timestamps are UTC ISO strings; conversion to local
  happens only at display. Check reset-boundary and clock-skew behavior.
- **Cache semantics (§9).** Stale-while-error, the 600s TTL, the 5-minute cooldown after
  429/5xx/network, in-flight deduplication, single retry with 2s delay (401 and 429 are
  **not** retried), and corruption → delete + refetch rather than a stuck failure loop.
- **Exit codes (§11.5).** 0 success, 1 fetch failed, 2 config error, 3 runtime failure.
- **Error paths.** Every `catch` either handles or deliberately propagates. No swallowed
  errors, no `catch {}`.

## Pass 2 — Security and vulnerabilities

Run the `security-reviewer` subagent. Authoritative invariants are `SPEC.md §12`.

- **No token leakage** into logs, cache files, `--debug` output, error messages, process
  arguments, or committed fixtures.
- **Credentials are read-only.** `~/.claude/.credentials.json` is never written, refreshed,
  or moved.
- **Transport.** Hardcoded `https://`, TLS verification never disabled, 5s timeout intact.
- **Filesystem.** Atomic writes (temp + rename), directories `0700`, files `0600`, symlink
  targets checked with `lstat` before write.
- **Telemetry stays local and opt-in.** The product transmits nothing but requests to the documented usage endpoint. Telemetry is written to a local spool and is off by default with no default destination. Verify against the diff: no new network call in `packages/core`, `packages/statusline` or `packages/vscode`; telemetry still defaults off; and **every payload leaf is a number, a boolean, or a member of a closed enumeration.** A free-text payload field is a blocking finding — the leak vector is the value, not the key.

**Standing items** from `docs/audit-report.md`, open and re-checked whenever the diff comes
near them:

| Item | Location | Status |
|---|---|---|
| `execSync` interpolates a path not provably under program control | `packages/statusline/install/install.ts` | open, informational |
| Non-atomic write to `~/.claude/settings.json` during install | `packages/statusline/install/` | open, informational |
| `JSON.parse(...) as T` on data crossing a trust boundary | multiple | open, informational |

A diff that touches one of these must re-evaluate it rather than inheriting the existing
verdict. A diff that *adds a new instance* of one is a `major` finding, not informational.

## Pass 3 — Compliance

Architecture and conventions, from `CLAUDE.md` and `SPEC.md §8.2`.

- **All domain logic lives in `packages/core`.** `packages/statusline` and `packages/vscode`
  are thin rendering layers. Business logic in a surface is a blocking finding — it is the
  one architectural rule this project is built around.
- **No `any`.** Strict TypeScript throughout.
- **ES modules** in source. The VS Code extension *bundle* must be CommonJS
  (`--format cjs --external vscode`); the extension host cannot load ESM.
- **Timestamps** internal as UTC ISO strings.
- **Tests ship with the code**, colocated as `*.test.ts`, HTTP always mocked, isolated so
  mock state cannot leak between files. Reuse `packages/core/src/test-helpers.ts` rather
  than hand-rolling fixtures.
- **Reuse over addition.** A new helper duplicating an existing one in `packages/core` is a
  finding.
- **Spec amendments are explicit.** A change that contradicts `SPEC.md` without saying so in
  its `spec.md` is blocking, regardless of whether the change itself is good.

---

## Plan-to-diff audit

Alongside the three passes, every change is audited against its own plan. The
`plan-to-diff-auditor` subagent compares the diff to the scope fence in
`sdlc/<NNN>-<slug>/plan.md` and reports both directions: files changed outside the fence,
and plan items with no corresponding change.

An excursion outside the fence is not automatically a defect — but it must be recorded in
`review.md` with a justification, and if it was substantial, `plan.md` should be amended
rather than quietly outgrown.

## Verification gate

No change is reviewable until `bun run verify` exits 0. The command runs typecheck, lint,
test, and build. `review.md` records the actual output, not a claim about it.
