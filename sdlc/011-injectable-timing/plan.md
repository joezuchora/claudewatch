# Plan: stop spending a minute of every gate run asleep

- **ID:** 011-injectable-timing
- **Stage:** 3 — Build
- **Status:** implemented
- **Derived from:** [`spec.md`](./spec.md)
- **Branch:** `claude/ai-sdlc-setup-plan-nqyqbk`

## Approach

Add an optional `FetchOptions` parameter to `fetchUsage`, defaulted to the current constants,
then pass fast timings from the tests that today sit in a real `setTimeout`. Nothing about the
production path changes: every call site in `packages/statusline` and `packages/vscode` calls
`fetchUsage(token)` with one argument and continues to get 5 s / 2 s / 1 retry.

The saving is entirely in the test suite. Three files carry the cost — `contract.test.ts`
(~18 s), `call-sites.test.ts` (~30 s), `client.test.ts` (~4 s) — because a 5xx, a network
error, or an abort each pays the production retry sleep, and the two abort tests pay two full
5 s timeouts on top.

## Scope fence

```
packages/core/src/client.ts
packages/core/src/client.test.ts
packages/core/src/contract.test.ts
packages/core/src/call-sites.test.ts
SPEC.md
sdlc/011-injectable-timing/spec.md
sdlc/011-injectable-timing/plan.md
sdlc/011-injectable-timing/review.md
sdlc/README.md
```

**Amended during Stage 5.** `sdlc/011-injectable-timing/spec.md` was added because the security
pass changed a design decision, and the spec is where design decisions live — the amendment is
marked as such in the spec rather than backdated into the original text. `SPEC.md` was added in
response to security-pass finding S3: the §18.3 module table documented `fetchUsage(token: string)` with a fixed 5 s
timeout, and leaving it that way would have left a future §12 auditor unable to see that an
override path exists. Amending the plan is the honest move here rather than logging an
excursion, per the template's own instruction.

## Changes

### `packages/core/src/client.ts`
- Export `DEFAULT_TIMEOUT_MS`, `DEFAULT_RETRY_DELAY_MS`, `DEFAULT_MAX_RETRIES` in place of the
  module-private constants, so a test asserting production behaviour cites the real value.
- Add the `FetchOptions` interface and a second, optional parameter to `fetchUsage`.
- Resolve the options in one exported pure function, `resolveFetchTiming`, through two guards:
  `positiveAtMost` for the timeout (zero would abort every request instantly, so it falls back)
  and `nonNegativeAtMost` for the delay and the retry count (zero is exactly what a test asks
  for, so it is honoured). Both reject non-numeric and non-finite input, which keeps `NaN` out
  of `setTimeout`, and both **clamp upward at the default** — see the note below.
- **Amended during Stage 5**, in response to security-pass findings S1 and S2: an override may
  only make timing *tighter*. The defaults are ceilings, not suggestions. An unbounded
  `timeoutMs` would hold a credential-bearing request open past the hard kill SPEC §3.1 and
  §11.7 state, and an unbounded `maxRetries` would turn the retry loop into a flood of authenticated
  requests. Every override this change exists to serve asks for shorter, so the ceiling costs
  it nothing.
- Resolution is a pure function of its input, so it is exported and tested directly. That is
  what lets the boundary cases — clamping, zero, `NaN`, smuggled non-numbers — be covered in
  milliseconds instead of by watching a real timer, which is rather the point of this loop.

### `packages/core/src/client.test.ts`
- Pass `FAST` to the two tests that retry (500, network error).
- Add a `resolveFetchTiming` block covering every boundary the spec names, plus the clamping
  added in Stage 5: defaults, tighter-is-honoured, `timeoutMs: 0` and negative falling back,
  `retryDelayMs: 0` honoured, looser values clamped, `NaN`/`Infinity` falling back, and a
  smuggled non-number falling back.
- Add three behavioural tests proving the resolved values are actually *used* rather than
  merely computed: a delay override that still asserts two attempts, a timeout override that
  still asserts `failureClass: 'timeout'`, and `maxRetries: 0` asserting a single attempt.

### `packages/core/src/contract.test.ts`
- Pass `FAST` to the eleven tests that retry. (The plan first said eight; 403 and 404 fall
  through to `lastError` and retry too, and so does a body that fails `response.json()`.) Assertions are untouched: the 5xx tests still
  assert `serviceUnavailable`, `retries 5xx up to MAX_RETRIES` still asserts `callCount === 2`,
  and both "succeeds on second attempt" tests still assert the retry actually happened.

### `sdlc/README.md`
- The running retrospective, appended to by every loop. Also carries a dated note on the
  "Known defect in the gate itself" section, because that section reasons about a 35–60 s
  baseline this change replaces with a 5.5 s one, and the 550 s hang it tracks is still open.

### `SPEC.md`
- One-line amendment to the §18.3 module table recording the second parameter and the
  tighter-only rule. Added in Stage 5 (finding S3); see the scope-fence note above.

### `packages/core/src/call-sites.test.ts`
- Pass `FAST` to the network-error test and `FAST_TIMEOUT` to the two abort tests, which also
  lets their 30 s per-test overrides go back to the default.
- **Deliberately unchanged:** `a 5xx retries, and durationMs EXCLUDES the 2s retry sleep`. It
  asserts `wall > 1900` and `durationMs < 1000`; a near-zero delay would make that pass
  trivially and the test would stop testing anything. It keeps the production default and pays
  its 2 s, which the spec anticipates.

## Tests

| Spec criterion | Test | File |
|---|---|---|
| No options behaves exactly as before | the whole existing suite, unmodified in its assertions | all three |
| `retryDelayMs` honoured, `attempts: 2` still asserted | `retryDelayMs override is honoured and the retry still happens` | `client.test.ts` |
| `timeoutMs` honoured, `timeout` class still results | `timeoutMs override is honoured and still produces failureClass timeout` | `client.test.ts` |
| `timeoutMs: 0` falls back; `retryDelayMs: 0` does not | `retryDelayMs 0 is honoured, unlike a zero timeout` | `client.test.ts` |
| Non-numeric falls back | `non-finite input falls back…` and `non-numeric input falls back…` | `client.test.ts` |
| Overrides may only tighten (S1, S2) | `looser values are clamped — the defaults are ceilings, not suggestions` | `client.test.ts` |
| The defaults are not quietly shortened | `the production defaults are still the production defaults` | `client.test.ts` |
| Gate test step drops materially | measured, not asserted | `review.md` |
| `bun run verify` exits 0 | the gate | — |

## Verification

```
bun test packages/core/src/client.test.ts packages/core/src/contract.test.ts packages/core/src/call-sites.test.ts
bun run verify
```

Before/after wall time for each of the three files is recorded in `review.md`, since the
headline criterion is a duration and a claim about a duration is worth nothing without the
measurement beside it.

## Risks

- **A fast delay hides a real ordering bug.** A 2 s sleep gives an in-flight mock time to
  settle that a 0 ms one does not. Mitigated by the fact that every mock here resolves
  synchronously, and caught by the gate if not.
- **`timeoutMs: 0` silently meaning "no timeout".** Guarded explicitly and tested; the guard is
  the reason the two helpers differ rather than being one function.
- **Looks fine locally, slow in CI.** The measurement in `review.md` is local; CI's own timing
  is visible on the PR run and is the check that the saving is real rather than machine noise.

---

**Next stage:** Deploy — run `/sdlc-review 011-injectable-timing`.
