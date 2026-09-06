# Spec: close the set of surfaceable error messages

- **ID:** 029-surfaced-error-guard
- **Stage:** 2 — Design
- **Status:** revised after spec review (three BLOCKING, six SHOULD-FIX; see "Spec review")
- **Date:** 2026-08-27

Reads `intent.md`. The design question it left open — runtime test, type-level constraint, or both —
is answered below: **both**, for reasons the first draft assumed rather than named.

## The asymmetry this loop closes

`client.ts:180`, on the timeout flag, says:

> *Reading it from a flag beats parsing `err.message`, which varies by platform and Bun version and
> is **exactly the free text the telemetry allowlist exists to keep out** (sdlc/007, sdlc/010).*

Four lines later, `client.ts:200` assigns that same `err.message` to `FetchResult.message`. Both legs
of what happens next were traced and confirmed by the spec reviewer:

1. **Persisted to disk.** `failurePolicy` returns `cooldown: true` for both `timeout` and
   `serviceUnavailable` (`cooldown.ts:117-119`), so `shouldCooldown` is true on the network path.
   Four call sites pass `result.message` into `enterCooldown` — `main.ts:307,316,321` and
   `extension.ts:240,249` — which assigns it to `lastErrorMessage`, and `writeCache` persists it.
2. **Rendered to the user.** `extension.ts:236` builds `LastErrorInfo` and passes it to
   `statusBar.update` → `buildTooltip` → **either** `format.ts:405` **or** `tooltip.ts:51`. CORRECTED
   from the first draft, which said "rendered twice": these are two mutually exclusive branches of
   **one** VS Code tooltip, not two surfaces. The terminal statusline never renders `Last error:` —
   `commands.ts:21` calls `formatTooltip` with no `lastError`. It does reach `--debug` output
   (`main.ts:143,171`).

So the repo identified this string as free text that must not escape into telemetry, built an
allowlist to keep it out, and then wrote it to the cache file and a tooltip. **The guard exists on
one path and not the other, and nothing records that as a decision.** That asymmetry is the loop.

## A second guarantee that holds by accident

`cooldown.ts:122` says, in a comment: *"`malformedResponse` is not constructed anywhere."* The class
exists in `types.ts:49`, `failurePolicy` handles it (`cooldown.ts:125`), and `SPEC.md §7.2` defines
its presentation — and no code path produces it. B1b below finally constructs it.

## Measurements — CORRECTED after review

| Question | Measured |
|---|---|
| HTTP failure messages | 4, all constants: `Authentication failed (401)`, `Rate limited (429)`, `Server error (${status})`, `Unexpected status ${status}` |
| Connection refused / TLS failure / DNS failure | `"Unable to connect. Is the computer able to access the url?"` |
| **Timeout** | **`"The operation was aborted."`** — a `DOMException`, which **is** `instanceof Error`, so the `'Unknown network error'` fallback is never reached |
| 200 with unparseable body | `"Failed to parse JSON"`, arriving as `serviceUnavailable` with `status: null` |
| Tests covering §12's surfaced-error clause | **0** of `security.test.ts`'s 14 |

**The timeout row was WRONG in the first draft**, which claimed all three network shapes produced the
"Unable to connect" string. The original probe raced `AbortSignal.timeout(1)` against a *refused*
connection, so the refusal won and its message was recorded as the timeout's. Re-measured against a
server that accepts and never responds. A badly-constructed measurement presented as evidence is
worse than no measurement, and this loop's whole argument rests on that table.

## Behaviour

### B1 — the network path emits a constant

```ts
message: timedOut ? 'Request timed out' : 'Network error',
```

Chosen by the same `timedOut` flag that already picks `failureClass`, for the reason `client.ts:180`
gives.

### B1b — `response.json()` gets its own `try`, and constructs `malformedResponse`

`singleFetch:86` calls `await response.json()` unguarded. A parse failure propagates to `fetchUsage`'s
catch and becomes a **status-less `serviceUnavailable`** carrying `err.message`. Found by the review;
it is a **seventh** failure path the first draft did not know about, and B1 alone would have relabelled
it `'Network error'` — turning a diagnosable condition into something indistinguishable from a dead
link, while the spec claimed `failureClass` carried the distinction. Here it demonstrably would not.

```ts
if (response.status === 200) {
  let data: unknown;
  try { data = await response.json(); }
  catch { return { ok: false, status: 200, failureClass: 'malformedResponse', message: 'Malformed response' }; }
  return { ok: true, status: 200, data };
}
```

This is also **the only path whose message could be influenced by remote data** — the response body.
Bun happens to emit the bare constant `"Failed to parse JSON"`, which is one more accidental property
of the runtime, and precisely what this loop exists to stop depending on.

### B2 — the set is closed at the producer by a TYPE, and at the consumer by a predicate

The first draft chose a runtime predicate and never mentioned the union, wrongly assuming
`Server error (${status})` ruled it out. It does not — a template-literal type accepts it:

```ts
export type SurfaceableMessage =
  | 'Authentication failed (401)' | 'Rate limited (429)'
  | 'Network error' | 'Request timed out' | 'Malformed response'
  | `Server error (${number})` | `Unexpected status ${number}`;
```

`FetchFailure.message` narrows to this. A free-text producer is then a **compile** error, which is
strictly stronger than a test that must be remembered. A `typefixtures/*.expect-error.ts` freezes the
negative control, using the harness this repo already has.

`isSurfaceableMessage(m: string): boolean` is kept **and given a production consumer**, because a type
cannot help at a deserialization boundary — see B3.

### B3 — the cache-read boundary is gated

The first draft claimed "after B1, no string that reaches a surface can contain a secret" and then, twelve
lines later, conceded that an old cache file's free-text `lastErrorMessage` "will still render". Both
cannot be true. `extractLastError` (`snapshot.ts:55-57`) reads it off disk with **no validation**:

```ts
message: isSurfaceableMessage(env.lastErrorMessage) ? env.lastErrorMessage : null,
```

One line. It closes the consumer side, makes the guarantee true rather than nearly-true, and gives
`isSurfaceableMessage` a real job — as specified in the first draft it had **zero production
consumers**, called only by its own test.

### B4 — a test that fails when the set is widened, and `SPEC.md §12` points at it

`security.test.ts` gains **one test with seven assertions**, driving every failure path with mocked
HTTP, asserting each message satisfies `isSurfaceableMessage`. The timeout arm must use the existing
`mockNeverSettles` helper (`client.test.ts:205`) to drive the *real* timeout — throwing a synthetic
`AbortError`, as `contract.test.ts:295` does, leaves `timedOut` false and yields `'Network error'`,
passing while testing the wrong branch.

§12 gains a pointer to the test, so the clause and its check are not discoverable only by grep — what
`no-explicit-any` lacked for 27 loops.

## The redactor decision, unchanged and now actually true

**No redactor is built.** After B1/B1b every produced message is a literal this repo wrote, and after
B3 every message consumed **through `extractLastError`** is checked against that set.

CORRECTED after the Stage 5 audit: an earlier revision said "every consumed message is checked", full
stop. That is false. `packages/statusline/src/main.ts:143` and `:171` read `lastErrorMessage` off the
envelope **directly**, never through `extractLastError`, so a pre-029 cache file's free text still
reaches `--debug` stdout verbatim. `grep -rn "isSurfaceableMessage\|extractLastError"
packages/statusline/src` returns nothing. The Risks section mentioned `--debug` but framed it as a
§17 documentation gap, not as a hole in the very gate B3 exists to close.

**Not fixed here, and queued.** Closing it means importing the predicate into `packages/statusline`,
which this plan's fence explicitly excludes — and widening a fence to cover a hole found in Stage 5
is how loops start eating each other. `--json` is clean: it dumps the snapshot, not the envelope.

Also unpropagated: `printLiveDebug`'s `fetchError` parameter is typed `{ …; message: string }`
(`main.ts:158`), not `SurfaceableMessage`, so the producer-side type does not reach that surface.
Harmless today — its only caller passes a real `FetchResult` — but it is a hole in the "compile error
for a free-text producer" story, not a completion of it. A `sk-ant-` stripper would defend a path no
message travels — loop 028's characterization-test error one level up.

Two facts make it actively wrong, not merely redundant:

- The diagnostics modal's **first field is `__filename`**, an absolute home path shown by design and
  sanctioned by §17. Scrubbing paths from the error string beneath it would be incoherent.
- The genuinely uncontrolled surface text is not an error: `enterprise.disabledReason` is rendered at
  **exactly one** site — `format.ts:369`, `formatTooltip`'s enterprise branch — plus the statusline's
  `--json` whole-snapshot dump. CORRECTED: the first draft said "every surface", and
  `formatStatusLine`/`formatRichStatusLine` never touch it. The accurate, smaller blast radius makes
  the deferral *easier* to justify, not harder.

`disabledReason` stays **out of scope, recorded open**: it is API-supplied content about the user's own
account, a different trust question from a credential leak.

## Declared amendments to `intent.md`

1. **B1/B1b change what one surface displays.** On a network failure the tooltip's `Last error:` line
   goes from `Unable to connect…` (or `The operation was aborted.` on timeout) to `Network error` /
   `Request timed out`; a malformed body now says `Malformed response` instead of `Failed to parse JSON`.
2. **B3 changes it again**: an old cache file's free-text `lastErrorMessage` will now be dropped rather
   than rendered.
3. **`commands.ts:26` is NOT covered.** `intent.md` promised "every path by which text reaches a
   user-visible surface, enumerated in one place". This spec closes `fetchUsage`'s paths only; the
   diagnostics modal still interpolates whatever `readCache`/`formatTooltip` throws. Deferred with a
   reason: it is not a `FetchResult`, so neither the type nor the predicate applies, and loop 028
   measured its one reachable throw as harmless.

Other producers checked and cleared: `errorLineFor`/`ERROR_DETAILS` (`tooltip.ts:8-31`) are repo
constants; `normalize.ts` warnings are repo constants with a window-name interpolation;
`makeErrorSnapshot` and `markStale` synthesise **no** text, only enum members.

## Compatibility

`lastErrorMessage` stays `string | null`; no cache version bump; prior cache files still parse.
`SurfaceableMessage` and `isSurfaceableMessage` are pure additions to core's exports. The two
user-visible changes are declared above.

## Acceptance criteria

- **A1** — no `err.message` in **non-comment** lines of `client.ts`:
  `grep -v '^\s*[/*]' packages/core/src/client.ts | grep -c 'err\.message'` is **0**. CORRECTED: the
  first draft demanded `grep -c` over the whole file be 0, which is unsatisfiable without deleting the
  `client.ts:180` comment this spec is *built on* — a criterion that forced the implementer to destroy
  its own evidence.
- **A2** — **the guard can fail.** Apply this exact seed to the 401 constant:
  `` `Authentication failed (401) at ${USAGE_URL} for token ${token.slice(0, 8)}` ``. Then:
  (a) `bun run typecheck` **fails** with `TS2322` — the union rejects it at compile time;
  (b) with the union temporarily widened to `string`, `bun test` reports **exactly one** additional
  failure and it names B4's test; (c) seed removed, gate green. **All three pasted into `review.md`.**
  CORRECTED: the first draft's parenthetical seed referenced `err`, which is not in scope in
  `singleFetch` — it fails typecheck with `TS2304`, and since `verify` stops at the first failure the
  gate would go red **without ever running B4**. That is loop 028's null experiment in a new costume.
- **A3** — B4 drives **seven** paths: 401, 429, 5xx, unexpected status, network throw, real timeout,
  malformed JSON. Seven, named individually. The first draft said six and was wrong.
- **A4** — `isSurfaceableMessage` is implemented as an array of exactly seven literal forms; the plan's
  mutation table has **one row per form**, each predicting exactly one failing assertion in B4.
- **A5** — `SPEC.md §12` names the test file and case.
- **A6** — **exactly three** existing assertions change, and they are:
  `client.test.ts:92` (`'DNS resolution failed'`), `contract.test.ts:303` (`'aborted'`),
  `contract.test.ts:317` (`'DNS'`). Each becomes an `isSurfaceableMessage` assertion. **A fourth edited
  expectation is a review finding.** CORRECTED: the first draft required that *no* test expectation
  change, which was already false when written — measured 3 failures, two of them §15.2 contract tests.
  The claim that "information lost is nil" was true of the string and false of the suite.
- **A7** — lint warnings unchanged at 11, no newly-firing rule.
- **A8** — every mutation in the plan's table produces its predicted count.
- **A9** — `malformedResponse` is constructed by production code, falsifying `cooldown.ts:122`'s
  comment, and that comment is updated in the same commit.

## Risks

- **A6 is the criterion most likely to be quietly violated**, because the natural response to a red test
  is to edit its expectation. It now names the three permitted edits explicitly.
- **B3 could hide a real signal**: a legitimately-produced message the predicate does not know about
  becomes `null` rather than rendering. Mitigated because the type makes producer and predicate share
  one source of truth — but a future producer must update both, which A4's mutation rows enforce.
- **`--debug` prints `lastErrorMessage`** (`main.ts:143,171`), and §17's "allowed debug information" list
  does not include it, nor `lastErrorClass`, `lastHttpStatus`, `cooldownUntil` or `freshness`.
  Pre-existing; B1 improves it; recorded so a reader does not think `--debug` was audited.
- **§17 states the opposite of the measurement** — it says `client.ts` error messages "carry hostnames
  and home-directory paths". Not true on bun 1.3.11/Linux, and B1 makes the disagreement moot going
  forward. Noted rather than amended.

## Spec review

Run at Stage 2 against `7060a94..463fb42`. Returned **three BLOCKING**, six SHOULD-FIX, four ADVISORY.
All are incorporated above. The premise was traced and **confirmed**, which was the review's first job.

Three of the reviewer's findings were re-measured by me before acting, because each invalidated
something I had written as fact: the timeout message (my probe was mis-constructed), the three
already-failing tests (A6 was red before the plan existed), and the seventh failure path.

## Next stage

`/sdlc-plan`.
