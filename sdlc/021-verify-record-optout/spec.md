# Spec: an opt-out for `verify_run` recording

- **Status:** revised — the first draft's default was wrong, and its argument rested on a premise
  I falsified by reading my own deployment
- **Stage:** 2 — Design
- **Reads:** `intent.md`
- **Review:** `review-spec.md`

## The decision, revised

**`CLAUDEWATCH_VERIFY_METRICS` controls recording. The default is OFF.** The systemd unit that
drives the hourly loop sets it to `1` explicitly, so the continuous series is unaffected.

The first draft said on-by-default. That was wrong, and the way it was wrong is worth recording.

### The premise that collapsed

The draft's first bullet:

> `scripts/verify.ts` runs only when someone types `bun run verify` in a clone of this repo.

`deploy/systemd/claudewatch-sdlc-loop.service:20` runs `bun run verify` **hourly, unattended**.
I wrote that unit. It is the invocation path that produces most of the recorded data, and the
draft's entire "reach is bounded by a deliberate human act" argument does not survive it.

### The counterfactual that was a strawman

> Off-by-default would mean the loop that generated 103 recorded runs ... would have produced
> **nothing**.

Only if the person who built the loop, owns the machine, and wrote the unit would never add one
line switching it on. The unit already carries `EnvironmentFile=-%h/.config/claudewatch/metrics.env`
and `deploy/install-nuc.sh` already writes `CLAUDEWATCH_*` lines into that file.

**Off by default plus one `Environment=` line preserves the entire hourly series** — the
continuous data, the rolling p95 baseline, `sdlc/016`'s premise, all of it. What it costs is
ad-hoc local runs by the owner, recoverable with one `export`. What it buys is that a contributor
who clones this repo to fix a typo is not silently recorded.

The intent asked *"what is the right default, and who is the person choosing?"* and observed that
owner and contributor have different answers. The draft then gave the owner's answer to both
populations, on the strength of a counterfactual that assumed the owner helpless. That is
self-serving reasoning, and it is what the review was asked to look for.

### Why explicitly ON in the unit, not merely inherited

The unit runs `bash -lc` — a **login shell**. An `export CLAUDEWATCH_VERIFY_METRICS=0` in
`~/.profile`, or a line in `metrics.env`, would otherwise silently kill the unattended series with
no error and no gap marker. `Environment=` in the unit beats the inherited value, so the series
cannot be switched off by an ambient export. This line is worth having under *either* default; it
is what makes off-by-default costless.

### Rejected alternatives

| Alternative | Why not |
|---|---|
| Reuse `CLAUDEWATCH_TELEMETRY` | One switch, two audiences, opposite concerns. `=1` would switch on the gate's recording for someone who wanted only product telemetry, and `=0` would disable the loop's collection for the owner. Surprising in both directions. |
| A `--no-metrics` CLI flag | **Not for the reasons the first draft gave** — it claimed `bun run` swallows arguments and that a hook invokes `verify`; both are false. `bun run verify --no-metrics` does reach `process.argv`, and the `PostToolUse` hook runs `bun run typecheck`. The real reason: the three call sites are `.github/workflows/ci.yml:29`, `claudewatch-sdlc-loop.service:20`, and interactive/agent invocation. A flag has to be added to each one and remembered every time; an environment variable is a property of the machine a clone runs on, set once. |
| A config-file key | `~/.config/claudewatch/config.json` is *product* configuration, read by the shipped binary (`config.ts:28`). A dev-script key there mixes two audiences in one file. |
| On by default | See above. |

## Behavioral contract

### `shouldRecordVerifyMetrics(env): boolean`

Lives in a new `scripts/env.ts`. **Not** in `junit.ts` — that file is a junit XML parser, and an
environment-variable helper has no cohesion with it; the testability motive does not justify
widening it into a miscellany.

| `CLAUDEWATCH_VERIFY_METRICS` | Result |
|---|---|
| unset | `false` — the default |
| `1`, `true`, `yes`, `on` | `true` |
| `0`, `false`, `no`, `off`, `""`, whitespace-only | `false` |
| anything else | `false`, **and one line to stderr** |

Case-insensitive, whitespace-trimmed.

The unrecognised case now falls back to *not recording*, which is the fail-closed direction for a
consent switch. But it fails closed against the person who was trying to switch it **on** —
someone typing `=enabled` gets silence and no data. So it also prints:

```
verify: unrecognised CLAUDEWATCH_VERIFY_METRICS=<value>, not recording
```

Only when the variable is set and unparseable. This amends the intent's "prints the same output"
to *"prints the same output when the variable is unset or recognised"* — stated here rather than
changed silently.

### Sharing the vocabulary with `config.ts`, mechanically

`config.ts`'s `fromEnv` is **not exported**, and `verify.ts` must not import `packages/core`
(a syntax error there would stop the gate before it could report the syntax error — `sdlc/020`).

So: **export `parseBooleanEnvValue(raw: string): boolean | null` from `packages/core/src/config.ts`**
and have `fromEnv` call it. `scripts/env.ts` keeps its own copy of the table; `scripts/env.test.ts`
imports the core function and asserts the two agree across every token. The *test* imports core,
the *gate* does not — exactly the `MAX_LINE_BYTES` precedent at `scripts/junit.test.ts:7`.

Without this, A8 could only compare a hand-copied table against itself: green by construction,
and still green after `config.ts` changed. That is the vacuity class `sdlc/020`'s audit exists to
catch.

### What the opt-out does and does not change

- **Does:** skip everything in `record()`. The guard is the **first statement in the function**,
  before `mkdirSync` — `verify.ts:141` currently creates `~/.cache/claudewatch` before the size
  check, so a guard next to `appendFileSync` would still create the directory and fail E2.
- **Does not:** change the exit code, console output, step list, or timings.

### The junit report is still written, and that is a real cost

A disabled run **still** passes `--reporter=junit`, still writes an XML report naming failing
tests, describe chains and file paths to `mkdtempSync(join(tmpdir(), 'claudewatch-verify-'))`,
still chmods it `0600`, still parses it, and still deletes it in a `finally`.

The first draft justified this as avoiding "a second code path". That was wrong twice: the parse
branch at `verify.ts:193` is *already* conditional on the test step failing, and the +0.82% figure
is **of the test step**, per `sdlc/020/review.md:97` — not of the whole gate, which has five
steps.

The honest statement of the trade: **a fractionally slower test step, and a transient junit
report under `$TMPDIR` naming the contributor's failing tests, in exchange for one code path
instead of a conditional on an already-conditional branch.** Taken deliberately. The report is
0600 in a 0700 directory and removed in a `finally`; the spool is the durable artifact and that
is what the switch governs.

## Edge cases

| # | Case | Behavior |
|---|---|---|
| E1 | Disabled, test step fails | Same exit code, same output. Nothing recorded. |
| E2 | Disabled, spool absent | **`~/.cache/claudewatch` is not created.** The guard is the first statement in `record()`. |
| E3 | Enabled, spool at the 5 MB cap | Unchanged — the existing size check returns early. |
| E4 | CI | CI never reaches the store anyway: `record()` writes to `homedir()` on an ephemeral runner and nothing ships it. The variable is simply unset there, so CI records nothing, which is the status quo in effect. |
| E5 | `=maybe` | Not recorded, one stderr line. |
| E6 | `=0` in `metrics.env` on the NUC | The unit's `Environment=` wins, so the hourly series survives an ambient opt-out. |

## Acceptance criteria

| # | Criterion |
|---|---|
| A1 | Unset ⇒ `false`, **and** a fixture run with `=1` writes exactly one `verify_run` event — so "unset means off" is not satisfied by an always-off no-op |
| A2 | Each of `1 true yes on` ⇒ `true` and each of `0 false no off "" "   "` ⇒ `false`, asserted per value |
| A3 | Case and whitespace ignored: `" ON "` ⇒ `true`, `"Off"` ⇒ `false` |
| A4 | `=maybe` ⇒ `false` **and** emits the stderr line; `=1` in the same test ⇒ `true` and emits nothing |
| A5 | **Disabled: a real fixture gate run writes no spool AND creates no `~/.cache/claudewatch`** |
| A6 | **Enabled: the same fixture run writes exactly one event** — A5's non-vacuous half |
| A7 | Disabled and enabled runs produce the same exit code on a passing and a failing fixture, **and** in the same test the disabled spool is absent while the enabled spool is present |
| A8 | `shouldRecordVerifyMetrics` agrees with core's exported `parseBooleanEnvValue` across the full token table, with the test importing core directly |
| A9 | Docs, asserted by grep: `"always recorded"` is gone from `verify.ts`; `CLAUDEWATCH_VERIFY_METRICS` appears in `SPEC.md` §17, `SECURITY.md`, `deploy/README.md`, `CONTRIBUTING.md`, and the unit file; and the unit file no longer claims every firing records an event |

### The A5–A7 fixture, specified

The first draft said "spawned as a subprocess with a fixture — never by running the full gate from
inside `bun test`, which recurses", which forbids in one clause what it requires in the other.
Resolved:

A temp directory containing a `package.json` whose `typecheck`, `lint`, `test`, `build` and `perf`
scripts are all no-ops (`bun -e ''`, or `exit 1` for the failing case). `verify.ts` is spawned with
`cwd` set there and `HOME` overridden to a second temp dir. `STEPS` is a module-level const with no
injection point, so every one of the five must be defined or the run dies on a missing script.

This does not recurse: the fixture's `test` script is a no-op, not `bun test`.

**Platform:** A5's directory assertion holds on Linux and macOS. `record()` uses `os.homedir()`,
which follows `USERPROFILE` on Windows, so the test overrides both.

## Risks

- **A default flip is a behaviour change for exactly one machine**, and it must not land without
  the unit-file line in the *same commit* — otherwise the hourly series goes flat until someone
  notices. `metrics:detect`'s run count is the only signal, and only if someone looks.
- **`deploy/README.md:25` and the unit-file comment both say every firing records an event.** That
  becomes conditional. Both are in A9.
- **E2 remains the criterion most likely to be got wrong**, because `mkdirSync` runs before any
  early return today.
