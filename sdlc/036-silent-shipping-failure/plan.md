# Plan: a failing shipper says why, and cannot fail silently

- **ID:** 036-silent-shipping-failure
- **Stage:** 3 — Build
- **Reads:** `sdlc/036-silent-shipping-failure/spec.md`
- **Date:** 2026-08-29

## Scope fence

Ten paths. Two packages, because B5's extraction lives in `packages/core` — declined in the first
draft of the spec, and the Stage 2 review showed that declining it made A4 unsatisfiable.

| Path | Change | Criterion |
|---|---|---|
| `packages/core/src/types.ts` | `TransportMessage` as `Extract<SurfaceableMessage, …>` | B5, m-1 |
| `packages/core/src/client.ts` | extract `classifyFetchError(err, timedOut)`; `fetchUsage` calls it | B5, A5 |
| `packages/core/src/client.test.ts` | the mapping's three legs, now against an exported function | A5 |
| `packages/metrics/src/types.ts` | `ShipFailure`, `SpoolErrno`; `ShipResult` **moves here** from `agent.ts` | B2, B4, n-1 |
| `packages/metrics/src/agent.ts` | narrowed `try`, prune reorder, spool guards, request timeout, backlog fields | A2–A11 |
| `packages/metrics/src/agent.test.ts` | every criterion except A4/A12 | A2, A3, A6–A11, A13 |
| `packages/metrics/src/cli-ship.ts` | grouped reasons, conditional loss line, wrapped `ship()` calls, header comment | B6, B7, A10 |
| `packages/metrics/src/cli-ship.test.ts` | **new** — the subprocess tests | A4, A12 |
| `deploy/README.md` | the `journalctl -u claudewatch-ship` runbook line | B7 |
| `.oxlint-budget.json` | **only if** the diff moves the warning set; the gate decides, not me | A15 |

**Explicitly not touched:** `packages/metrics/src/anomaly.ts`, `packages/metrics/src/cli-detect.ts`,
`packages/metrics/src/store.ts`, `packages/metrics/src/server.ts`, `packages/metrics/src/dashboard.ts`,
`packages/core/src/telemetry.ts`, `packages/core/src/snapshot.ts`, `packages/core/src/cache.ts`,
`packages/core/src/format.ts`, `packages/core/src/credentials.ts`,
`packages/statusline/src/main.ts`, `packages/vscode/src/extension.ts`, `scripts/verify.ts`,
`scripts/fence-check.ts`, `scripts/lint-budget.ts`, `SPEC.md`, `CLAUDE.md`, `REVIEW.md`,
`deploy/systemd/claudewatch-ship.service`, `deploy/systemd/claudewatch-ship.timer`,
`deploy/install-nuc.sh`.

> **`anomaly.ts` and the two `claudewatch-ship` units are on the negative fence on purpose.** They
> are what the spec declines: the `source: 'sdlc'` staleness bound (deferred with its measurement
> named) and `SuccessExitStatus=0 1` (B9). A reader who expects this loop to have touched them should
> find them named here rather than absent.

> **No bare directory entries.** Every exclusion is a file. `inFence` matches a basename tail, so
> `package.json` would cover all five committed manifests and a bare `packages/metrics` would cover
> `packages/metrics/package.json` — the trap loops 033 and 035 both paid for. There is no `except`
> clause anywhere in this fence.

**Heading-token check, run before writing this fence:** loop 036's `spec.md` yields four backticked
heading tokens. `ship()` and `ShipResult` resolve to `packages/metrics/src/agent.ts`, which is on the
**positive** side, so neither fires. `try` and `cli-ship` classify `not-a-symbol` — the second via the
hyphen, which is the false negative loop 035's security pass recorded as S-5 and did not fix.
`unresolvedSymbols` therefore stays **14** and the baseline needs no edit. Verified, not assumed.

**On `sdlc/README.md`:** Stage 6's retrospective lands in its own commit after `review.md`, as every
prior loop's has, and is not in this fence.

## Changes

### 1. `packages/core` — extract the transport mapping (B5)

```ts
// types.ts
export type TransportMessage = Extract<
  SurfaceableMessage, 'Network error' | 'TLS verification failed' | 'Request timed out'
>;

// client.ts
export function classifyFetchError(err: unknown, timedOut: boolean): TransportMessage {
  if (timedOut) return 'Request timed out';
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && TLS_FAILURE_CODES.has(code) ? 'TLS verification failed' : 'Network error';
}
```

`fetchUsage`'s inline ternary at `client.ts:269-273` becomes a call. **Zero behaviour change** — that
is the criterion for calling this a move rather than a rewrite, and `client.test.ts`'s existing
coverage of `fetchUsage` is the check.

`timedOut` stays a parameter rather than being inferred from the error: it is a closure variable set
by the abort timer at `client.ts:237`, and an `AbortError` alone cannot distinguish "we timed out"
from "the caller aborted". Inferring it is what made the first draft's criterion unsatisfiable.

### 2. `packages/metrics/src/types.ts` — the closed sets, and `ShipResult` moves here (n-1)

`ShipResult` currently lives in `agent.ts:16`. It now embeds `ShipFailure`, so both belong in one
file — otherwise a plan reading the spec's *Data and types* block fences the wrong file, which is
exactly what n-1 flagged.

`SpoolErrno` is an allowlist with an `'other'` fallback. An errno from the OS is not free text, and
`SPEC.md §12`'s rule for `lastHttpStatus` is the precedent: validate at the boundary, not at the
printer.

### 3. `packages/metrics/src/agent.ts` — five changes, each with its own criterion

**3a. The `try` narrows to `doFetch` alone (C3, A6).** `rmSync`, `shipped` and `filesShipped` move
after it, with their own `try` yielding `{ kind: 'spool', op: 'delete' }`. A 200 whose delete fails
now counts the events as shipped — because they were — and reports the real problem.
`client.ts:239-246` is cited in the code, because that comment is where this repo already wrote the
lesson down and it did not stop the recurrence.

**3b. The prune moves after the delivery loop (C2, A7).** One line. Measured today:
`shipped=20, filesDropped=1` on a recovery run with 21 deliverable files. After: `shipped=21,
filesDropped=0`. The cap still bounds disk; it just stops charging a file for the privilege.

**3c. `rotate` and the prune are wrapped (C1, A4).** A throw becomes
`{ kind: 'spool', op: 'rotate' | 'prune', code }` and the run continues to a printed result.
`cli-ship` wraps both `ship()` calls as well — a guard one level down is a guard a refactor removes.

**3d. A request timeout (B3, A11).** `AbortController` + `setTimeout`, mirroring `client.ts:230-240`,
including `clearTimeout` on every path. Without it `'Request timed out'` is unreachable and A5's third
leg is untestable — and a hung endpoint stops shipping entirely under `Type=oneshot`.

**3e. `backlog` and `oldestPendingAtMs` (M-4, A8, A9).** Computed in `agent.ts` after the delivery
loop, so `cli-ship` holds no domain logic. The age comes from the rotation stamp in the filename,
which *is* `Date.now()` (`agent.ts:69`) — the first draft guessed "~5 min of events", which
`CLAUDE.md` forbids and which a `Persistent=true` catch-up burst makes wrong by a weekend.

### 4. `packages/metrics/src/cli-ship.ts` — output, wrapping, and one stale comment (B6, B7)

Reasons grouped with a count. The loss line conditional on the post-run backlog. Status rendered only
when `Number.isInteger && 100..599`.

The header comment at `:2` says the shipper is "Run from a timer, or by verify." **`verify` does not
run it** — `scripts/verify.ts` has no ship step, checked. Corrected in the same commit as B7's
runbook line, because the two are the same defect: nothing runs this where anyone looks.

### 5. `packages/metrics/src/cli-ship.test.ts` — new, and it closes a carried-forward gap

A4 and A12 both need `cli-ship` run as a **subprocess**, because the defect in C1 is that the process
dies before printing — an in-process call cannot observe that. `cli-ship.ts` has had no test file
since it was written, recorded as PARTIAL against loop 034's A9 and carried forward through loops 035
and 036. **This loop closes it as a consequence of needing it**, which is the honest reason a gap
gets closed.

Each subprocess gets `HOME` and `XDG_CACHE_HOME` pointed at a `mktemp -d` sandbox. **Never the real
cache**, per the standing rule.

## Test mapping

| Criterion | Test |
|---|---|
| A2 | `agent.test.ts` — five: `an HTTP 404 is reported as http 404`, `an HTTP 503 is reported as http 503`, `a thrown fetch is reported as transport`, `an unreadable file is reported as unreadable`, `a throwing rotate is reported as spool` |
| A3 | included above — the two `http` tests assert different `status`, which is the whole point |
| A4 | `cli-ship.test.ts` — `a throwing rotate still prints a reason and exits non-zero` (subprocess) |
| A5 | `client.test.ts` — `classifyFetchError maps the three legs`; `agent.test.ts` — `a TLS-code error yields the same message from ship as from fetchUsage`; plus `only one module declares the TLS message` |
| A6 | `agent.test.ts` — `a 200 whose delete fails is spool/delete, not transport, and still counts as shipped` |
| A7 | `agent.test.ts` — `a recovery run ships all 21 and drops none` |
| A8 | `agent.test.ts` — `combineResults concatenates, sums, mins, and keeps failures.length === filesRetained` |
| A9 | `agent.test.ts` — `an idle run leaves the backlog unchanged`; `a failing run with new events raises it by one` |
| A10 | `cli-ship.test.ts` — three cases: dropped with backlog<20, dropped at the cap, nothing dropped |
| A11 | `agent.test.ts` — `a fetch that never resolves is aborted and reported as Request timed out` |
| A12 | `cli-ship.test.ts` — `no configured secret reaches any output`, across all five paths |
| A13 | `agent.test.ts` — `describeFailure rejects a status outside 100..599` |
| A14 | the mutation table below |
| A15 | the gate enforces it |
| A16 | the Stage 5 audit and `fenceCheck` |

### Mutation predictions — written before the run (A14)

Loop 035's lesson was *trace the early returns, not just the rules*. Traced: these eight mutations sit
in **different branches reached by different inputs**, not in an ordered guard chain, so per-rule
prediction is sound here in a way it was not for `classifyToken`. Where a mutation is genuinely
independent I say so, because "no cross-cutting suite" is a prediction that can be wrong.

| # | Mutation | Predicted |
|---|---|---|
| M1 | move the prune back before the delivery loop | A7 only. The existing cap test (`agent.test.ts:90`) asserts `pending <= MAX` after the run, which both orderings satisfy — so it will **not** fail, and if it does my model of it is wrong. |
| M2 | widen the `try` back over `rmSync` and the counters | A6 only. The 200-path tests pass either way because `rmSync` normally succeeds. |
| M3 | remove the `rotate`/prune wrapper | A4 only — and it must fail as a **non-zero exit with no reason line**, not as a wrong reason. If it fails some other way the test is not testing C1. |
| M4 | remove the `AbortController` | A11 only, and it must **hang to the test timeout** rather than assert-fail. A test that fails fast here is not exercising the abort. |
| M5 | hardcode `'Network error'` in `agent.ts` instead of importing | **2** — A5's behavioural leg and A5's one-module source check. |
| M6 | make the `DATA LOST` standing sentence unconditional | A10's `backlog < 20` case only. |
| M7 | drop the status range check | A13 only. |
| M8 | stop pushing a failure on the `unreadable` path | **2** — A2's `unreadable` test and A8's `failures.length === filesRetained` invariant. This is the one that proves the invariant is load-bearing rather than decorative. |

**M1 and M3's predictions name a failure *mode*, not just a test.** Loop 035's M6 passed its named
test for the wrong reason and only a differently-shaped assertion caught it; predicting the mode is
the cheapest guard against repeating that.

## Risks

- **`ShipResult` moving files is a breaking import change** for anything outside `packages/metrics`.
  Nothing imports it — `bun run typecheck` is the proof, and it runs before commit.
- **`classifyFetchError` touches product code on the fetch path.** The mitigation is that it is a
  move with no behaviour change and `fetchUsage`'s existing tests are the check. If any
  `client.test.ts` assertion changes, it is not a move and the change is wrong.
- **The subprocess tests are slow.** `scripts/env.test.ts` already pays 180s timeouts for the same
  reason. Budget them explicitly rather than discovering it in CI.
- **A live network call from a test.** `cli-ship.test.ts` points every subprocess at
  `127.0.0.1` on a closed port or `.invalid`, never at `api.anthropic.com` and never at a real
  endpoint. The A12 sentinel host is `sentinel-host.invalid`, which cannot resolve.
- **The prune reorder changes when disk is bounded** — from before the POSTs to after. Worst case
  within one run is 21 files rather than 20, i.e. 105 MB rather than 100 MB against `MAX_SPOOL_BYTES`.
  Accepted, and named so the audit can disagree.

## Out of scope, recorded

- **The `source: 'sdlc'` staleness bound.** Deferred with its measurement named; `anomaly.ts` is on
  the negative fence.
- **`SuccessExitStatus=0 1`.** B9. The unit files are on the negative fence.
- **Same-millisecond rotation overwriting silently.** Recorded in the spec's *Edge cases*; the fix
  changes the filename contract that `pendingShippingFiles` and `shouldDrainLegacy` both parse.
- **`upgrade-all`-shaped hyphenated tokens landing in the unasserted `notASymbol` bucket** — loop
  035's S-5, and `cli-ship` in this loop's own spec is an instance of it.
- **`readCacheResult` presence-only validation**, and the other standing queue items. Untouched.

---

**Next stage:** Build/Test — run `/sdlc-implement 036-silent-shipping-failure`.
