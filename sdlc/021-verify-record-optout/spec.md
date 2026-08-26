# Spec: an opt-out for `verify_run` recording

- **Status:** draft
- **Stage:** 2 — Design
- **Reads:** `sdlc/021-verify-record-optout/intent.md`

## The decision, first

**`CLAUDEWATCH_VERIFY_METRICS=0` disables recording. The default stays ON.**

The mechanism is ten lines. The default is the whole design, so it is argued here rather than
assumed.

### Why not off-by-default, which is the reflexive answer

Product telemetry is off by default and that is right — it observes *a user*, who did not ask to
be observed, in software they installed. None of that applies here:

- `scripts/verify.ts` runs only when someone types `bun run verify` in a clone of this repo.
- It observes the repository, not the person.
- It writes to a local file. Nothing transmits it unless the same person also runs the agent and
  configures an endpoint, both of which are separate, deliberate acts.
- Off-by-default would mean the loop that generated 103 recorded runs, the rolling p95 baseline,
  and the entire premise of `sdlc/016` would have produced **nothing**, and nobody would have
  noticed until they went looking for history that was never written.

The asymmetry that matters: a product default that over-collects harms a user who never chose.
A dev-script default that under-collects silently destroys the only evidence the project has
about its own behaviour, and the destruction is invisible.

### Why an opt-out is still required

"It only runs when you type the command" is an argument about *reach*, not about *consent*. A
contributor who clones this repo to fix a typo did not sign up to have their failing test names
written to disk, and they should not have to read `scripts/verify.ts` to find that out. The
honest position is: on by default, documented, and one environment variable away from off.

### Rejected alternatives

| Alternative | Why not |
|---|---|
| Reuse `CLAUDEWATCH_TELEMETRY` | Conflates two different things. `CLAUDEWATCH_TELEMETRY=1` would then also switch on the gate's recording for someone who only wanted product telemetry, and `=0` would silently disable the loop's data collection for the repo owner. One switch, two audiences, opposite defaults — a guaranteed surprise in both directions. |
| A `--no-metrics` CLI flag | `verify` is invoked by CI, by the hook, and by `bun run` with no arg passthrough. An env var reaches all three; a flag reaches none of them without editing call sites. |
| A config-file key | `~/.config/claudewatch/config.json` is *product* configuration and is read by the shipped binary. Adding a dev-script key there mixes two audiences in one file. |
| Off by default with an opt-in | See above. It is the choice that looks responsible and costs the project its only evidence. |

## Behavioral contract

### `shouldRecordVerifyMetrics(env): boolean`

Lives in `scripts/junit.ts` beside the other pure helpers, so it can be tested without executing
the gate — the recursion lesson from `sdlc/020`.

| `CLAUDEWATCH_VERIFY_METRICS` | Result | Why |
|---|---|---|
| unset | `true` | The documented default. |
| `0`, `false`, `no`, `off`, `""` | `false` | Matches `config.ts`'s `fromEnv` vocabulary exactly, so two switches in the same project do not disagree about what "off" looks like. |
| `1`, `true`, `yes`, `on` | `true` | Explicit on. |
| anything else | `true` | **Falls back to the default rather than guessing** — the same rule `config.ts` uses. A typo'd value must not silently disable collection; the failure mode of a wrong guess here is invisible data loss. |

Case-insensitive, whitespace-trimmed, like `config.ts`.

### What the opt-out does and does not change

- **Does:** skip the write in `record()`. Nothing is appended to the spool.
- **Does not:** change the exit code, the console output, the step list, the timings, or the
  junit outfile handling. `--reporter=junit` still runs and the report is still parsed — it costs
  +0.82% and removing it conditionally would create a second code path that only some people
  execute, which is how untested branches happen.

That last point is a deliberate trade: a fractionally slower gate for one code path instead of
two.

## Edge cases

| # | Case | Behavior |
|---|---|---|
| E1 | Disabled, and the test step fails | Gate exits non-zero exactly as before. Nothing recorded. |
| E2 | Disabled, and the spool does not exist | No directory is created. Currently `record()` calls `mkdirSync` before the size check, so a disabled run must not create `~/.cache/claudewatch` at all. |
| E3 | Enabled but the spool is at the 5 MB cap | Unchanged — the existing size check already returns early. |
| E4 | The variable is set to `off` in CI | CI records nothing. Acceptable; CI runs are already indistinguishable from local ones in the store, and nothing depends on them. |
| E5 | Set to a nonsense value like `maybe` | Records. Falls back to the default, does not guess. |

## Acceptance criteria

Every criterion pairs a positive precondition with its assertion — `sdlc/020`'s audit found seven
that a no-op satisfied, so this is now a standing rule rather than a reminder.

| # | Criterion |
|---|---|
| A1 | Unset ⇒ `true`; and a run with it unset writes exactly one `verify_run` event |
| A2 | Each of `0 false no off ""` ⇒ `false`, and each of `1 true yes on` ⇒ `true` — asserted per value, not on a representative |
| A3 | Case and whitespace are ignored: `" OFF "` ⇒ `false`, `"On"` ⇒ `true` |
| A4 | An unrecognised value ⇒ `true`, **and** the same fixture with `0` ⇒ `false`, so the fallback is not just "always true" |
| A5 | **Disabled: a real gate run writes no spool file AND creates no `~/.cache/claudewatch` directory** (E2) |
| A6 | **Enabled: the same real gate run writes exactly one event** — the positive half A5 needs to not be vacuous |
| A7 | Disabled and enabled runs produce the **same exit code** on both a passing and a failing gate |
| A8 | The vocabulary matches `config.ts`: for every string in a shared table, `fromEnv`-style parsing agrees |

A5–A7 drive the real script in a sandboxed `HOME`, spawned as a subprocess with a fixture — never
by importing `verify.ts`, which executes on import, and never by running the full gate from
inside `bun test`, which recurses.

## Risks

- **The opt-out is the kind of switch that gets set once and forgotten**, after which the loop's
  data quietly stops. Mitigation: `metrics:detect` already reports the evaluated run count, so a
  frozen count is visible in the one place someone looks. Worth stating in the review rather than
  building alerting for a one-person repo.
- **E2 is the criterion most likely to be got wrong**, because `mkdirSync` currently runs before
  any early return. It needs the guard at the top of `record()`, not next to the write.
