# Review: an opt-out for `verify_run` recording

- **Status:** accepted
- **Stage:** 5 — Deploy
- **Gate:** `bun run verify` green in ~11s, 715 tests across 32 files, lint warnings at the
  long-standing 12

## Verdict

**Accepted with two excursions recorded and one criterion unmet.** The change does what the spec
says. The process around it did not go cleanly, and the honest summary of this loop is not the
feature — it is that **four of my own fixes each needed a further fix, and not one of the
follow-ups came from a check that already existed.**

| What I fixed | What was still wrong with the fix | Found by |
|---|---|---|
| Test env inheritance | — | the gate failing for real |
| Mangled test names (`A5<path>`) | The sanitizer became defeatable eleven ways | probing it adversarially |
| That loosening | `.` and `-` before a slash still leaked | the security reviewer |
| That narrowing | No test caught the regression | mutation |

Tests confirm what you thought of. Probing and mutation find what you did not.

## Findings

Both reviewers read `ce30b83..3fb14c0`. That range **predates** the sanitizer hardening in
`af2f418`, so their S1/C1 describes a state that was already fixed when they reported —
corroboration rather than a live defect, and stated here so the record is not read as worse than
it was.

### Plan-to-diff audit — verdict: FENCE VIOLATED

| # | Finding | Resolution |
|---|---|---|
| **C2** | **The mitigation did not mitigate.** The unit comment, the commit message, the spec and the plan all said `Environment=` beats a `~/.profile` export because ExecStart runs a login shell. Exactly backwards: the profile is sourced *after* systemd hands over the environment and overwrites it. The plan called that line "not optional and not deferrable". | **Fixed.** Verified the reviewer's repro, then verified the replacement: an inline assignment on the ExecStart command, which a shell startup file cannot reach. Unit, spec, plan and three docs corrected. |
| A | `scripts/junit.ts` and `junit.test.ts` are **outside the fence**. A describe name I chose (`A5/A6/A7`) forced an edit to a sanitizer `SPEC.md` §17 holds up as a guarantee. | **Recorded, not waived.** This is exactly the coupling a fence exists to surface: a test-name choice inside the fence reached a security boundary outside it. |
| C1/S3 | The test named *"the guard did not just get weaker"* used the three boundaries the loosened regex still honoured. It could not fail. | Already replaced by a 15-case smuggling probe before the reviews landed. |
| B | **A9 has no test.** The docs were written by hand; "revert any doc hunk" is uncaught. | **Not fixed — recorded.** A grep test is cheap but brittle, and adding one under this fence after the fence was already violated is the wrong order. Queued. |
| C3 | A7 covers the failing fixture only; passing-fixture exit-code equality is split across two tests and never compared in one place. | **Not fixed — recorded.** |
| C4 | `SECURITY.md` and `deploy/README.md` said "records nothing unless the variable is set", which is wrong for `=0`/`=off` — those *are* set and record nothing. Only `SPEC.md` documented the unrecognised-value warning. | **Fixed** in all four documents. |
| C5 | Stale claims beside changed code: `verify.ts`'s header still argued *against* opt-in instrumentation — the design that had just shipped. | **Fixed.** |
| — | `parseBooleanEnvValue` is now public API of `@claudewatch/core` via `export *`. The plan authorised the export but not that consequence. | **Recorded.** |
| — | Behaviour preservation of the extraction: confirmed token-for-token, 18 existing tests unchanged. | ✓ |

### Security pass

| # | Sev | Finding | Resolution |
|---|---|---|---|
| S2 | minor | The hardened sanitizer **still leaked**: `foo-/opt/secrets/key` and `report.-/var/secrets/x`. The lookbehind excluded `.` and `-` as well as alphanumerics. | **Fixed** — alphanumerics only. `v1.2/a/b` and `a.b/c/d` stay legible. Then a mutation showed I had closed it *without a test*; added. And a second mutation showed my `/users` case-insensitivity test was inert because the general rule caught it anyway — it now uses `x/users/joe`, which only the home rule reaches. |
| S4 | minor | The unit forcing the switch on means `metrics.env` **can no longer express "off"**. The owner's only opt-out is a unit drop-in, and the docs never said so. | **Fixed** — `systemctl --user edit` documented, with the cost stated plainly: the alternative reintroduces the silent-stop this exists to prevent. Neither choice is free. |
| S5 | minor | A new `JSON.parse(...) as T` — a fresh instance of the standing item. | **Fixed**, narrowed. |
| S6 | info | The warning echoed the **raw env value** — unbounded, unscrubbed — to stderr and thence journald. | **Fixed.** It names the accepted tokens instead, and the test now asserts the value is *absent*; the fixture uses `/home/joe/secret-token` to make the point concrete. |
| S7 | info | The test's child env spread all of `process.env`, leaking `CLAUDEWATCH_TELEMETRY` and `_TIMEOUT_MS` into the fixture — a developer with a short timeout ran a different test than CI. | **Fixed** — allowlist. |
| S8 | info | `tightenMode` ran only on failure, so a passing **opted-out** run left a 0644 file listing every test name until the `finally`. | **Fixed** — unconditional. |

Cleared and worth recording: `record()` is the only writer of a `verify_run` event repo-wide; the
guard genuinely prevents `~/.cache/claudewatch` from being created; the extraction does not touch
product-telemetry consent; the change adds no network call and strictly *reduces* what is written.

## Mutation log

| # | Mutation | Caught by |
|---|---|---|
| Q1–Q6 | helper always true / always false / no trim / no warn / token dropped / core table drifts | A1, A2, A3, A4, A6, A8 |
| Q7 | the guard moved below `mkdirSync` | A5's cache-directory assertion |
| S1–S3 | permissive boundary restored / home rule dropped / scrub everything | the smuggle probe, and its legibility half |
| T1, T3 | **inert on first attempt** — my fix had no test, and the `i`-flag test was covered by another rule | fixed, then T1b/T3b/T4 caught |
| T2 | warn echoes the raw value | A4 |

Two mutations reading "inert" were **real gaps in my tests**, not bad mutations — unlike loop
020, where two were faulty mutations. Both distinctions matter and both are worth keeping.

## What this change does not do

- **No grep test for the documentation criterion** (A9). Reverting a doc hunk goes uncaught.
- **A7 is half-implemented** (C3).
- **The metrics series depends on configuration outside the repository** — the systemd unit on the
  NUC, and this container's Routine prompt. The repo cannot enforce or test either. The best
  available guard is that `metrics:detect` reports its run count, so a flat number is visible;
  a real guard would need the detector to notice its own input drying up.
- **The junit report is still written on an opted-out run.** Contained (0600 in a 0700 temp dir,
  removed in a `finally`), never reaching the spool — but "records nothing" is true of the spool,
  not of the disk. Stated in `CONTRIBUTING.md` terms rather than left for a reader to discover.
