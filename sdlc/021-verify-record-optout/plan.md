# Plan: an opt-out for `verify_run` recording

- **Status:** accepted
- **Stage:** 3 — Build (planning half)
- **Reads:** `spec.md` (revised), `review-spec.md`

## Scope fence

```
scripts/env.ts                                       (new)
scripts/env.test.ts                                  (new)
scripts/verify.ts
packages/core/src/config.ts                          (export parseBooleanEnvValue)
packages/core/src/config.test.ts
deploy/systemd/claudewatch-sdlc-loop.service         (Environment= line AND the stale comment)
deploy/README.md
SPEC.md                                              (§17)
SECURITY.md
CONTRIBUTING.md
sdlc/021-verify-record-optout/{plan,review}.md
sdlc/README.md
```

**The unit-file change is not optional and not deferrable.** A default flip without
`Environment=CLAUDEWATCH_VERIFY_METRICS=1` stops the hourly series with no error and no gap
marker. Both land in the same commit or neither does.

**Not touched:** `.github/workflows/ci.yml`. CI never reaches the store — `record()` writes to
`homedir()` on an ephemeral runner and nothing ships it — so leaving the variable unset there is
correct, and adding it would imply CI data exists.

## File-by-file

### `packages/core/src/config.ts`

Extract the token table into an exported `parseBooleanEnvValue(raw: string): boolean | null` and
have `fromEnv` call it. **Behaviour must not change** — `resolveTelemetryConfig`'s tri-state
precedence (env → file → disabled) depends on the `null`, so the extraction returns `null` for
unrecognised exactly as today.

This is the only reason the change touches `packages/core` at all: without an exported parser,
`scripts/env.test.ts` could only compare a hand-copied table against itself.

### `scripts/env.ts` (new)

```ts
export const VERIFY_METRICS_ENV = 'CLAUDEWATCH_VERIFY_METRICS';
export function shouldRecordVerifyMetrics(
  env: Record<string, string | undefined>,
  warn: (msg: string) => void = (m) => process.stderr.write(`${m}\n`),
): boolean
```

Own copy of the token table — `verify.ts` must not import `packages/core` (`sdlc/020`: a syntax
error there would stop the gate before it could report the syntax error). `warn` is injected so
A4 can assert the stderr line without capturing a real stream.

A new file rather than an addition to `junit.ts`: that module is a junit XML parser, and an
environment helper has no cohesion with it.

### `scripts/verify.ts`

1. `import { shouldRecordVerifyMetrics } from './env.js'`.
2. **First statement of `record()`:** `if (!shouldRecordVerifyMetrics(process.env)) return;` —
   before `mkdirSync`, which currently runs at line 141 before any early return. A guard beside
   `appendFileSync` would still create `~/.cache/claudewatch` and fail E2.
3. Rewrite the comment at lines 99–103. It currently reads *"SDLC process metrics are always
   recorded … they need no consent gate"* — false since `sdlc/020` changed the payload, and
   doubly false after this change.

### `deploy/systemd/claudewatch-sdlc-loop.service`

- Add `Environment=CLAUDEWATCH_VERIFY_METRICS=1` **after** `EnvironmentFile=`, so it wins over
  both the file and any ambient login-shell export. The unit runs `bash -lc`.
- Fix the comment claiming the loop "records a `verify_run` event whatever the outcome".

### Documentation

`SPEC.md` §17, `SECURITY.md`, `deploy/README.md`, `CONTRIBUTING.md` each state the variable, the
default, and how to switch it on. `CONTRIBUTING.md` matters most — it is where a contributor is
told to run the gate, and the population this loop protects.

## Test mapping

| Criterion | Test | Mutation that must break it |
|---|---|---|
| A1 | `unset means off, and =1 records` | make the helper always return `true` |
| A2 | `each token maps as documented` (per-value) | drop any single token from the table |
| A3 | `case and whitespace ignored` | remove `.trim()` or `.toLowerCase()` |
| A4 | `unrecognised is off AND warns; =1 is on and silent` | drop the `warn` call |
| A5 | `disabled: no spool, no cache dir` | move the guard below `mkdirSync` |
| A6 | `enabled: exactly one event` | make the helper always return `false` |
| A7 | `same exit code both ways, and spool differs` | — (pairs A5/A6; alone it is vacuous) |
| A8 | `agrees with core's parseBooleanEnvValue` | change either table |
| A9 | `docs and the unit file` (grep) | revert any doc hunk |

A5–A7 spawn `scripts/verify.ts` against a **fixture repo**: a temp dir with a `package.json`
whose `typecheck`, `lint`, `test`, `build`, `perf` scripts are all no-ops, `cwd` set there, and
`HOME` + `USERPROFILE` pointed at a second temp dir. `STEPS` is a module-level const with no
injection point, so all five must exist. The fixture's `test` script is `bun -e ''`, not
`bun test` — which is what stops this recursing the way `sdlc/020`'s attempt did.

## Risks

- **The `config.ts` extraction is a refactor of shipped product code** for a dev-script's benefit.
  It must be behaviour-preserving; `config.test.ts` already covers `resolveTelemetryConfig`'s
  precedence and must pass unchanged. If it cannot be done cleanly, fall back to duplicating the
  table with a comment — but then A8 is weaker and the review must say so.
- **A9 is a grep test**, which is brittle and only proves a string is present, not that the prose
  is correct. Stated here so `review.md` cannot present it as more than it is.
- **E2 is the criterion most likely to be got wrong**, and the mutation for it (moving the guard
  down two lines) is the one most likely to be missed by eye.

## Out of scope, recorded

- Retention or redaction on the service side. `deploy/README.md` already records that the agent
  ships lines verbatim.
- Product telemetry consent — already off by default.
- Making the junit report conditional on the switch. The spec takes the trade deliberately: a
  disabled run still writes a transient report under `$TMPDIR`. Revisiting that is its own loop.
