# Review findings: stop spending a minute of every gate run asleep

- **ID:** 011-injectable-timing
- **Stage:** 5 — Deploy
- **Reviewed against:** [`plan.md`](./plan.md) and [`/REVIEW.md`](../../REVIEW.md)
- **PR:** #16
- **Head commit:** see the `sdlc(011)` commit on `claude/ai-sdlc-setup-plan-nqyqbk`

## The measurement

This loop's headline acceptance criterion is a duration, and a claim about a duration is worth
nothing without the measurement beside it. Both numbers were taken on the same machine, in the
same session, minutes apart — the "before" by stashing the change and re-running the gate, not
by quoting a figure from an earlier run.

| | Before | After |
|---|---|---|
| `bun run verify` | **59.5 s** | **5.5 s** |
| — test step | 57.3 s | 3.4 s |
| — typecheck / lint / build | 1.9 / 0.1 / 0.1 s | 1.9 / 0.1 / 0.2 s |
| `contract.test.ts` | 22.05 s | 0.05 s |
| `call-sites.test.ts` | 30.04 s | 2.21 s |
| `client.test.ts` | 4.04 s | 0.15 s |
| Tests | 512 | 529 |

The gate is **10.8× faster** and covers 17 more cases than it did before. `call-sites.test.ts`
keeps 2 s of its old cost on purpose: the test asserting that `durationMs` *excludes* the retry
sleep has to have a retry sleep to exclude, so it still pays the production 2 s and says so in
a comment. That 2 s is now 64% of the entire test step, which is a fair picture of how little
is left.

Nothing was made faster by testing less. The three fast-timing files assert exactly what they
asserted before — same failure classes, same statuses, same attempt counts — and the 17 new
cases are boundary coverage that did not exist.

## Plan-to-diff audit

Output of the `plan-to-diff-auditor` subagent, run against the final diff. Verdict:
**excursions recorded** — no file left the fence, but two citations were wrong.

- **Files changed outside the scope fence:** none. All seven paths are in the fence as amended,
  and the fence is exact paths with no globs, so it is a real fence rather than a vacuous one.
- **Plan items with no corresponding change:** none.

| # | Finding | Resolution |
|---|---|---|
| A1 | The plan and this review both said the `SPEC.md` amendment landed in **§8.3**. It landed at `SPEC.md:909`, which is **§18.3**. §8.3 is a bullet list with no module table and no signature; §18.3 is the only place the signature appears. The edit was in the right place; the citation was not. | **Fixed** in `plan.md` and above. |
| A2 | `SPEC §11.5` — cited as the source of the 5 s hard kill in `client.ts`, `client.test.ts`, `spec.md`, `plan.md` and this review — is **Exit Codes**. The hard kill is §3.1 (line 113) and §11.7 (line 664). A wrong pointer had shipped inside production source. | **Fixed** in all six places. |
| A3 | The plan said `FAST` went to "the eight tests that retry" in `contract.test.ts`; it went to eleven. All eleven genuinely retry — 403 and 404 fall through to `lastError`, and a body that fails `response.json()` throws into the catch — so the additions were in-kind, but the count was wrong. | **Fixed** in `plan.md`, with the reason. |
| A4 | Two new behavioural assertions had ~80× slack: `wall < DEFAULT_RETRY_DELAY_MS` and `wall < DEFAULT_TIMEOUT_MS` would pass even if the override were only partially honoured. | **Fixed.** Both now bound at 1 s against operations that take ~30 ms and ~80 ms — far under the defaults they are distinguishing themselves from, far over anything a loaded runner adds to a test with no real I/O. |
| A5 | `ResolvedTiming` and the `mockNeverSettles` helper are in the diff but not in the plan's Changes list. | Accepted, recorded here. `ResolvedTiming` is the return type of an exported function; the timeout test cannot exist without a signal-honouring mock. Both are necessary-but-unplanned rather than scope creep. |
| A6 | The branch is `claude/ai-sdlc-setup-plan-nqyqbk`, not the `sdlc/<NNN>-<slug>` that `CLAUDE.md` prescribes. | Known and unavoidable: the branch name is fixed by the session's environment, and every loop from 001 has run on it. Recorded so the convention is not silently believed to be holding. |

A1 and A2 are the kind of finding that only an adversarial reader catches: both artifacts and
the source read plausibly, and the numbers were simply wrong. A2 in particular had reached
production source — a future auditor following `§11.5` from `client.ts` would have landed on
Exit Codes and found nothing.

The plan was amended twice mid-review (the `SPEC.md` line, and the clamping in
`resolveFetchTiming`). Both amendments are marked as such in `plan.md` with the finding that
caused them, so the artifact records what happened rather than reading as though it had been
right the first time.

## Pass 1 — Bugs and logical errors

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | nit | A fractional `maxRetries` (e.g. `0.5`) resolves as-is rather than being rounded. | Accepted. The loop condition `attempt <= maxRetries` handles it sanely — `0.5` yields one attempt — and no caller passes a fraction. Rounding would be code that exists only to make a comment unnecessary. |
| 2 | minor | Removing the two `30_000` per-test overrides in `call-sites.test.ts` puts those tests back under Bun's 5 000 ms default. | Accepted deliberately. They now finish in ~100 ms because the abort fires at 40 ms regardless of machine load — the mock rejects *on the abort event*, so the timing is deterministic rather than load-dependent. `sdlc/008` is the reason this was checked rather than assumed. |
| 3 | — | Verified no retrying call site was missed: `contract.test.ts` fell from 22.05 s to 0.05 s, which it could not have done with a 2 s sleep still in it. | No action. |

## Pass 2 — Security and vulnerabilities

Output of the `security-reviewer` subagent. Three informational findings, all acted on.

| # | Severity | Finding | Resolution |
|---|---|---|---|
| S1 | informational | `timeoutMs` had a floor but no ceiling. `fetchUsage(token, { timeoutMs: 600_000 })` was a legal way to hold a bearer-token-carrying request open for ten minutes, past the hard kill SPEC §3.1 and §11.7 state. Latent — no production caller passes options. | **Fixed.** `positiveAtMost` now clamps at `DEFAULT_TIMEOUT_MS`. |
| S2 | informational | Same shape for `maxRetries`: `1e9` would turn the retry loop into an unbounded sequence of authenticated requests, each re-sending the real token. | **Fixed.** `nonNegativeAtMost` clamps at `DEFAULT_MAX_RETRIES`. |
| S3 | informational | `SPEC.md` §18.3 still documented `fetchUsage(token: string)` with fixed timing, so a future §12 auditor reading "5 s timeout" there would not learn an override path exists. | **Fixed.** §18.3 amended, and `SPEC.md` added to the plan's scope fence. |

S1 and S2 turned the change from "defaults you may override" into "**ceilings you may only
tighten**", which is a better invariant than the one the spec originally asked for. Every
override this loop exists to serve asks for *shorter*, so the ceiling costs the change nothing
— and it is now enforced by `looser values are clamped` rather than by nobody having tried.

Standing invariants re-checked this round, with the reviewer's verdicts:

- **Token never leaks** — cleared, traced end to end. `token` reaches exactly one sink, the
  `Authorization` header. The guards take `(value: unknown, ceiling: number)`, never receive or
  close over the token, and cannot put it in a timer or an error message.
- **Attacker-influenced value reaching a timer** — cleared. Only guard outputs reach
  `setTimeout`; nothing from config, env, argv, or the stdin session JSON feeds `FetchOptions`.
- **Telemetry payload leaves stay closed-enumeration or numeric** — cleared. `report()`'s four
  leaves are unchanged; no option value is forwarded into a payload.
- **TLS never disabled, endpoint hardcoded** — cleared. No `rejectUnauthorized`, no custom
  agent, `USAGE_URL` untouched. The 5 s default is now *pinned by a test* rather than being a
  private constant, which is a small improvement.
- **Credentials read-only; atomic writes; `0700`/`0600`** — not reachable by this diff, verified
  rather than assumed: the diff introduces no filesystem call at all.
- **No credential-shaped literals added** — cleared. `'test-token'` and `'sk-ant-oat01-FAKE'`
  are pre-existing and self-evidently synthetic.

## Pass 3 — Compliance

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | — | Domain logic stays in `packages/core`; no surface touched. | Pass. |
| 2 | — | No `any`. The one cast is `as unknown as Parameters<typeof resolveFetchTiming>[0]`, in a test that exists specifically to prove a non-number cannot reach a timer. | Pass. |
| 3 | — | VS Code bundle still CommonJS — checked by grepping the built `extension.js` for `require` / `module.exports` (17 hits), which `verify` does not do for you. | Pass. |
| 4 | — | `resolveFetchTiming` and `ResolvedTiming` become public core API via `export * from './client.js'`. Intended: it is the tested boundary. Surfaces re-bind names explicitly, so neither bridge needed a change. | Pass. |
| 5 | — | Lint warning count unchanged at 12 — verified by stashing and re-linting, not by memory. `mockNeverSettles` was hoisted to module scope to keep it that way. | Pass. |

## Verification evidence

```
$ bun run verify
$ tsc --noEmit
$ oxlint
(12 pre-existing warnings, unchanged — see Pass 3 #5)
bun test v1.3.11 (af24e281)

 529 pass
 0 fail
 1103 expect() calls
Ran 529 tests across 27 files. [3.40s]
$ bun run --filter @claudewatch/core build && ...
@claudewatch/core build:   index.js  34.62 KB  (entry point)
@claudewatch/statusline build:  [137ms] compile  dist/claudewatch
claudewatch-vscode build:   extension.js  53.44 KB  (entry point)

verify: pass in 5.5s  [typecheck 1.9s  lint 0.1s  test 3.4s  build 0.2s]
$ echo $?
0
```

- [x] `bun run verify` exits 0
- [ ] CI green on the PR head commit — pending the push; updated below once the run reports
- [x] Every acceptance criterion in `spec.md` is checked off

## Findings deliberately not fixed

- **Pass 1 #1** (fractional `maxRetries`) — recorded above, not worth code.
- **The 2 s in `call-sites.test.ts`** — load-bearing, not waste. Removing it would leave the
  test asserting nothing.
- **Auditor A7: no test exercises the production 5 s timeout end to end any more.** True, and
  the trade is deliberate. Closing it costs a 5 s test — which would make the gate 8.4 s
  instead of 3.4 s, in a loop whose entire subject is gate time. What replaces it is a
  composition: `resolveFetchTiming()` with no options returns `5000` (pure test, instant),
  `DEFAULT_TIMEOUT_MS` is pinned at `5000` (instant), and a resolved `timeoutMs` demonstrably
  reaches `setTimeout` (the 40 ms behavioural test). Those three together imply the production
  path, and they fail loudly and individually if any link breaks.

  This is *not* the same situation as the retry delay, which does keep a real-timing test —
  there, the test's own subject is that `durationMs` excludes the sleep, so a fast delay would
  make the assertion pass without testing anything. No such trap exists for the timeout.

  Recorded rather than waved away because this repo's own recurring finding (`sdlc/README.md`)
  is that defects hide in the gap between "the composition implies it" and "the real thing was
  run." If a timeout regression ever ships, this paragraph is the first place to look.

## What this loop says about the loop

The measurement is the interesting part, and not for the reason the intent expected.

The intent was "the gate is slow." The gate was slow for a reason nobody had looked at: the
production retry sleep was reachable from tests only by waiting through it, so 48 of every 57
test-seconds were a `setTimeout` doing nothing. That is not a performance problem, it is a
**testability** problem wearing a performance problem's clothes — and the fix was a design
change (timing is a property of a call), not an optimisation.

The second thing worth recording: the security pass improved the *design*, not just the safety.
It arrived expecting to check for token leaks — found none — and instead noticed that the new
parameter was unbounded in the wrong direction. "Defaults you may override" became "ceilings
you may only tighten," which is a stronger contract than the spec asked for and costs nothing.
Adversarial review earning its keep on a change that looked like a test-speed tweak is the
argument for running the pass even when the diff looks boring.

---

**Next stage:** Maintain — nothing to do until production says otherwise.
