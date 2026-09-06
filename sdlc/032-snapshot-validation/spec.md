# Spec: validate the whole snapshot, not four fields of it

- **ID:** 032-snapshot-validation
- **Stage:** 2 — Design
- **Status:** revised after review — five BLOCKING, seven MAJOR, seven MINOR, all folded in
- **Derived from:** [`intent.md`](./intent.md)

## Summary

`readCacheResult` will return a snapshot **rebuilt field by field from known keys**, so that every
value it hands on is either a member of a closed set, a number this repo checked, a timestamp this
repo constructed, or a bounded string — and no key it does not name survives at all. `renderEvent`'s
two payload parameters narrow from `string` to their unions, making `SPEC.md §17`'s closed-enum
guarantee a compile error instead of a comment.

## Measurements taken before designing

This loop's three predecessors each shipped a wrong number in a section headed "measured". Every
figure below was produced by running code, and the command is stated so it can be re-run.

### The leak is total: **26 of 26**, and my first count was 14

Poisoned every field, at every level, and read it back through `readCacheResult`:

```
LEAK COUNT: 26 of 26
  inside snapshot : 24
  envelope-level  : extraEnvelopeKey, lastHttpStatus
```

**The first version of this section said 14, and that number is wrong for the same reason loop 031's
warning table said seven.** The probe behind it poisoned `fiveHour` but not `sevenDay` or
`sevenDayOpus`, and three of `enterprise`'s six fields but not the other three — and it never seeded
an unknown key at the enterprise level at all, while the spec's own edge-case table and A2 both
asserted that level. An enumeration presented as the counter-measure against a miscount, built from
an incomplete probe. Third loop running.

The ten fields the first probe missed: `sevenDay.utilizationPct`, `sevenDay.resetsAt`,
`sevenDayOpus.utilizationPct`, `sevenDayOpus.resetsAt`, unknown keys on both of those windows,
`enterprise.monthlyLimitCredits`, `.usedCredits`, `.isEnabled`, and an unknown key on `enterprise`.

**And two of the 26 are not in the snapshot at all** — see B4.

### `renderEvent` narrowing costs **zero** call-site errors — and the first probe said two

`intent.md`'s open question 3 predicted zero and demanded the number be measured before the change.
First probe: **2 errors**. Both were `TS2304: Cannot find name` — the types were not imported. That
is a different failure from the one being predicted, and recording "2" would have been a wrong number
arrived at honestly, which is the exact species this loop's predecessors kept shipping. With the
import added: **0 errors**. `classify` already returns `RuntimeState` and `tier` is already
`AccountTier` after loop 031.

### A null `primaryUtilizationPct` renders `⊙ error` — **on one of four surfaces, and not the default one**

`intent.md`'s open question 2 asked what a poisoned percentage should degrade to. The first version
of this section measured `formatStatusLine`, got `⊙ error`, and wrote **"this settles question 2"**.
It settles nothing. Measured across every renderer:

| surface | with `primaryUtilizationPct: null` |
|---|---|
| `formatStatusLine` | `⊙ error` |
| **`formatRichStatusLine`** | **renders `current: 42% \| weekly: 18%` normally — never reads the field** |
| `formatTooltip` | renders windows normally — never reads it |
| VS Code status bar | `classify` returns `Healthy`; renders `$(graph) —`, a blank |

**`formatRichStatusLine` is the default production renderer.** Claude Code pipes session JSON,
`readStdin()` returns non-null, and `main.ts` takes the rich branch. The one function measured was
the fallback. So "the display is then honest" was true of the surface nobody sees and false of the
three they do — a measurement that did not isolate the case it named, which is loop 029's rule
arriving in loop 032.

`null` is still the right degrade, but for a different reason, and it needs the coherence rule in B4
to be true: **a degraded primary must force a state the surfaces already render as an error**, rather
than relying on one renderer's null-check.

### `disabledReason` reaches the tooltip verbatim, today

`format.ts:374` interpolates it directly: `` const reason = e.disabledReason ? ` — ${e.disabledReason}` : '' ``.
It is a live §12 instance, not a hypothetical one, and it is the only field in the snapshot that is
neither enumerable nor **canonicalisable** — the text is chosen by the API. (`fetchedAt` and the
four `resetsAt` fields have no closed set either; the distinction being drawn is canonicalisability,
and the first draft said "only field for which no closed set can exist", which is wrong.)

### A poisoned `enterprise.utilizationPct` throws — a live stuck-failure loop, today

```
enterprise.utilizationPct = "POISON"   -> THROWS: pct.toFixed is not a function
enterprise.monthlyLimitCredits = "..." -> renders "⊙ E 1.0% · $0.01 / $NaN"
```

The throw reaches `main()`'s top-level catch and exits 3. `readCacheResult` returns the envelope
rather than deleting it, so **every subsequent render repeats it forever** — the class `SPEC.md §9`
exists to prevent, and `§7.3` requires a compact error state "without crashing". Pre-existing, not
introduced here, and this is the loop that claims to close every snapshot field, so it is in scope.

### The rebuild can manufacture states no producer can emit

`normalize()` emits `tier: 'enterprise'` only inside its `enterprise !== null` branch, so the pair
`tier: 'enterprise'` + `enterprise: null` is unreachable from the producer. Degrading each field
independently makes it reachable from the reader — poison one enterprise number, the object nulls,
`tier` survives because `'enterprise'` is a valid member. Measured, that state renders:

```
classify   : Enterprise
statusline : "⊙ 42% resets sat 5:00 pm · 7d 18% resets sat 7:00 am"
```

A plausible line with no indication anything is wrong. (The reviewer measured `⊙ 0%` here from a
different fixture; the exact string differs, the finding does not — an unreachable state renders as
though it were fine.) It also breaks `SPEC.md §5.3`, whose invariant is that primary utilization is
the highest across valid windows, once `display.*` is validated independently of the windows it is
derived from.

## Behavior

### B1 — `sanitizeSnapshot`, a whitelist rebuild

`readCacheResult` passes `parsed.snapshot` through a new `sanitizeSnapshot`, which **constructs and
returns a fresh `UsageSnapshot`**, naming every field. This answers `intent.md`'s question 1 in
favour of whitelisting over validate-in-place, for a reason loop 031 supplied by accident: it fixed
`freshness` and `rawMetadata` by rebuilding them, and left every other object passed through by
reference — and the audit then found unknown sibling keys surviving on exactly those. **A rebuild
makes completeness structural**: a field that is not named does not survive, so the failure mode is a
dropped field caught by the round-trip test, not a leaked one caught by nobody.

Per-field rules:

| Field | Rule | Degrades to |
|---|---|---|
| `fetchedAt` | canonicalise / sentinel — **unchanged from loop 031** | `UNKNOWN_FETCHED_AT` |
| `source.usageEndpoint` | closed set of 3 | `'unavailable'` |
| `authState` | closed set of 4 | `'unknown'` |
| `tier` | closed set of 3 — **unchanged from loop 031** | `'unknown'` |
| `fiveHour` / `sevenDay` / `sevenDayOpus` | rebuilt: `utilizationPct` finite number or `null`; `resetsAt` canonicalised ISO or `null` | `{utilizationPct: null, resetsAt: null}` |
| `enterprise` | `null`, or rebuilt with **all six** fields checked; **any failing numeric nulls the whole object** — a half-degraded `enterprise` is what renders `$NaN` | `null` |
| `enterprise.utilizationPct` | finite number — **unchecked today it THROWS**, see the measurement above | nulls the object |
| `enterprise.monthlyLimitCredits` | finite number, `>= 0` | nulls the object |
| `enterprise.usedCredits` | finite number, `>= 0` | nulls the object |
| `enterprise.isEnabled` | boolean | nulls the object |
| `enterprise.currency` | `ISO_CURRENCY_RE`, **moved to `closed-sets.ts`** — it is a module-private const in `normalize.ts` and importing it would close the `cache -> normalize -> telemetry -> cache` cycle `closed-sets.ts` exists to avoid | `'USD'` |
| `enterprise.disabledReason` | **bounded, not enumerated** — see B2 | `null` |
| `display.primaryWindow` | closed set of 5 | `'unknown'` |
| `display.primaryUtilizationPct` | finite number `>= 0`, **no upper bound** | `null` |
| `display.primaryResetsAt` | canonicalised ISO or `null` | `null` |
| `freshness`, `rawMetadata` | **unchanged from loop 031** | as there |

Unknown keys at every depth are dropped by construction.

**No 0–100 bound**, and the first draft had one. `normalize()` bounds only the *enterprise*
utilization; window `utilization` is copied through unbounded and `computePrimaryDisplay` copies the
window's value verbatim. So an honest `five_hour.utilization: 105` would have been nulled on the
first cache read — the same snapshot rendering `⊙ 105%` fresh and `⊙ error` a second later, with the
window keeping 105 while `display` went null, desynchronising two renderers off one file.
`contract.test.ts` also seeds `utilization: 100`, so an exclusive bound would have broken a shipped
contract test.

### B1b — cross-field coherence, because independent degradation invents states

Field-at-a-time degradation is what manufactures `tier: 'enterprise'` + `enterprise: null`. Two
coupling rules, applied after the per-field pass:

- `enterprise === null` → force `tier` to `'unknown'` and `display` to
  `{primaryWindow: 'unknown', primaryUtilizationPct: null, primaryResetsAt: null}`.
- `display.primaryWindow` names a window whose `utilizationPct` degraded to `null` → force
  `primaryWindow` to `'unknown'` and `primaryUtilizationPct` to `null`.

This is also what makes the `null` degrade honest on all four renderers rather than one: the
resulting state is one the surfaces already treat as unknown.

`resetsAt` timestamps are **canonicalised, not sentinelled** — unlike `fetchedAt`, `null` is already
in their type and already means "no reset known", so no sentinel is needed and none is invented.

### B2 — `disabledReason` is the one field a closed set cannot cover

Its text is chosen by the API. Enumerating it is impossible, and the producer-union argument that it
"comes from Anthropic so it is safe" is precisely the reasoning loops 029–031 established is void for
a value read off disk.

It also reaches **`--json` unconditionally**, where the `!isEnabled` gate that guards the tooltip
line does not apply — and `isEnabled` is itself unvalidated today, so poisoning it to a truthy string
suppresses the tooltip line entirely. The first draft named only the tooltip.

**Bounded rather than enumerated**: kept if it is a string, truncated to 200 characters, else `null`.
This is a *different mitigation for a genuinely different case*, and it is the weakest decision in
this spec — it stops an unbounded blob reaching a tooltip and does **not** stop a short poisoned
string. Stated plainly so the reviewer can reject it rather than discover it. A third option the first draft did not consider, raised by the review: **redact rather than
truncate** — reject the string if it matches path or host shapes (`/`, `\\`, `sk-ant-`, `@`,
`.local`) and keep it otherwise. `SPEC.md §17` already requires that class of scrub for `sdlc`-source
free text, so the idiom exists in-repo, and it keeps the legitimate message while closing the
short-poisoned-string hole the bound admits it leaves open. **Adopted in preference to the bare
bound**: the rule is now *redact-then-bound* — reject on those shapes, else truncate to 200.
It is still weaker than a closed set and still the weakest decision here.

The alternative
considered and rejected was nulling it on every cache read, which would delete a legitimate,
user-facing explanation from every render except the one immediately after a fetch — a real feature
loss to close a hole whose content cannot carry local state.

### B4 — `lastHttpStatus`, and the paragraph the first draft deleted

Two of the 26 leaking values are **not in the snapshot**, so `sanitizeSnapshot` cannot reach them:
`lastHttpStatus` and an unknown key on the envelope itself. `main.ts` copies `lastHttpStatus` into
`--debug` unvalidated; measured, `"lastHttpStatus": "MARK_httpStatus /home/someone/.claude"` reaches
stdout.

`lastHttpStatus` comes into scope: `Number.isInteger` else `null`, one line at the same boundary
beside the seven checks already there. Unknown envelope keys stay out — `output()` serialises the
snapshot and `printDebug` copies named keys, so they are inert, as loop 031 established.

**The first draft said §12's gap paragraph would be "deleted, not replaced", and made that a pass
condition in A8.** `SPEC.md` states "Every value `readCacheResult` returns from a cache file is
either validated against a closed set or reconstructed by us — never echoed." Deleting the paragraph
below it while `lastHttpStatus` still echoed would have made that sentence false and scored it MET.
The paragraph is now **rewritten to name exactly what remains**, and A8 is rewritten to check that
against a re-run of the probe rather than against its own previous text.

### B3 — `renderEvent` narrows, and `MetricEvent.payload` narrows with it

`runtimeState: string` → `RuntimeState`, `tier: string` → `AccountTier`. Measured cost: **0
call-site errors** once the types are imported.

**That alone does not deliver `intent.md`'s outcome**, and the first draft filed it as though it
did. Narrowing two existing parameters says nothing about a *new* one: the reviewer added
`newFreeText?: string` to `renderEvent` and `bun run typecheck` exited **0**, because
`MetricEvent.payload` is `Record<string, string | number | boolean | null>` — `string` is
structurally legal in a payload, and no typefixture can prove otherwise. A7's second half was
unachievable as written and would have been scored MET by a fixture proving something else.

So `payload`'s value type narrows too: `number | boolean | null` plus a `PayloadEnum` union of the
closed sets telemetry may carry. *That* is the structural guarantee `intent.md:75` asked for, and a
typefixture can freeze it. Whether the narrowing is achievable without churning every existing
`makeEvent` call is the one open risk this spec carries into `plan.md`, which must measure the
error count before committing to it.

### Amendments to `SPEC.md`

- **§12's gap paragraph is deleted**, not replaced. After B1 there is no unvalidated snapshot field
  and no surviving unknown key. What remains open is the structural-reject path (`snapshot`,
  `display`, `freshness` missing entirely), which already has its own bullet, and `disabledReason`'s
  bound, which gains one.
- **§17** records that `renderEvent`'s enum leaves are enforced by the compiler.
- **§11.4 and §14** — the `--json` contract. No key changes, but six *values* now may be
  substitutions (`usageEndpoint`, `authState`, `primaryWindow`, `enterprise`, `currency`,
  `disabledReason`). Loop 031 amended both sections for a single sentinel; doing less for six is an
  unacknowledged amendment by the standard this repo already set. §14's "a corrupt cache file is
  deleted and a fresh fetch performed" also needs to distinguish structural rejection from value
  degradation, which it currently does not.

## Data and types

New: `sanitizeSnapshot(raw: unknown): UsageSnapshot` and the closed sets it needs
(`USAGE_ENDPOINT_STATES`, `AUTH_STATES`, `PRIMARY_WINDOWS`) in `closed-sets.ts`, each with the
`Exclude<…> = never` guard already used for `STALE_REASONS`, so a new union member that nobody adds
to the set is a compile error.

No field added, removed, renamed or made optional. `CACHE_VERSION` stays **2**: validation does not
change the envelope's shape.

## Edge cases

| Case | Expected |
|---|---|
| every field valid, `enterprise: null` | deep-equal to the file |
| every field valid, `enterprise` populated | deep-equal to the file |
| all three windows empty (`null`/`null`) | unchanged — this is the normal cold shape |
| unknown key at snapshot, source, display, window or enterprise level | dropped |
| `usageEndpoint`, `authState`, `primaryWindow` poisoned | closed-set fallback; nothing on any surface |
| `utilizationPct` is a string / `NaN` / `Infinity` / `-1` / `101` | `null`; statusline renders `⊙ error` |
| `resetsAt` is `'2026-01-01 (/home/someone)'` | canonicalised; free text gone |
| `resetsAt` unparseable | `null` — no sentinel, because `null` is already in the type |
| `enterprise` is a string, a number, or an array | `null` |
| `enterprise.currency` is `'zz'` or free text | `'USD'` |
| `disabledReason` is 10,000 characters | truncated to 200 |
| `disabledReason` is a short poisoned string | **survives — the known limit of B2** |
| a poisoned field beside a live `cooldownUntil` | envelope kept, cooldown intact, `reason: 'hit'` |
| `snapshot` / `display` / `freshness` missing | reject, unchanged; §9.4 exposure still open |

## Backward compatibility

- No `CACHE_VERSION` bump; no user's cache discarded.
- **An honestly-written envelope must round-trip deep-equal**, and this is the criterion that
  matters most, because a whitelist rebuild fails by *dropping* a field rather than leaking one. The
  round-trip fixture must populate every optional shape.
- No `--debug` or `--json` key added, removed or renamed.
- **Changed, knowingly:** a corrupt `primaryUtilizationPct` now renders `⊙ error` where it previously
  rendered whatever the file said. That is the intended effect.

## Acceptance criteria

- [ ] **A1** — a `usage.json` with all **26** measured values poisoned puts none of that text on
      `--debug`, on `--json`, or into the telemetry spool — verified by a unit test asserting on the
      whole serialised envelope, and by two end-to-end cases against the compiled binary.
      **Both e2e cases carry preconditions in the same block**: `exitCode === 0`,
      `typeof cacheAgeSec === 'number'`, and a value from the *seeded* envelope present in the
      output. Without them the `--json` leg passes vacuously — a poisoned `fetchedAt` degrades to
      the sentinel, `isCacheFresh` goes false, the binary falls through to an expired credential and
      exits 2, and every `not.toContain` assertion holds against a snapshot the cache never
      produced. `smoke.test.ts`'s existing `poisonedButFresh()` solves this and must be reused.
- [ ] **A2** — no unknown key survives at any depth — verified by seeding one at **all five** levels
      (snapshot, source, display, each window, enterprise) and asserting none appears. The first
      draft asserted this level count without ever probing the enterprise one.
- [ ] **A3** — **a rich envelope round-trips `toStrictEqual`**, with a fixture whose every leaf
      differs from that leaf's own degraded value, **enforced by a positive precondition in the same
      test**: a table of `[field, fixtureValue, degradedValue]` asserting they differ, for every
      field in the B1 table. Without it this criterion is vacuous for at least five fields — the
      reviewer showed a rebuild that **drops `currency` and hardcodes `'USD'`** passes both A3 and
      the `'zz' → 'USD'` edge-case row, silently formatting every non-USD account with the wrong
      symbol and divisor. `currency`, `disabledReason`, `isStale`, `primaryResetsAt` and `isEnabled`
      all have fixtures in `makeTestSnapshot` identical to their degraded values.
      `toStrictEqual`, not `toEqual`: measured in bun 1.3.11, `expect({x:1,y:undefined}).toEqual({x:1})`
      **passes**, so a rebuild that sets a field to `undefined` would round-trip green.
- [ ] **A4** — every closed set is exhaustive against its union — verified by the
      `Exclude<…> = never` guard **anchored to indexed access**
      (`UsageSnapshot['source']['usageEndpoint']`, `UsageSnapshot['display']['primaryWindow']`),
      because those are anonymous unions with no named type to exclude from. Note `authState` is
      spelled twice — inline at `types.ts:30` and as `AuthState` at `:118` — so a guard anchored to
      the named type would miss a member added to the inline one. The negative control is the
      **existing** `typefixtures/array-missing-member.expect-error.ts`; cite it, do not add a fourth
      copy (`CLAUDE.md`: reuse before adding).
- [ ] **A5** — no poisoned value costs a fetch or discards `cooldownUntil` — verified by a test
      asserting `reason === 'hit'`, `isInCooldown` true, and `cooldownUntil` **resolving to the same
      instant** (not byte-identical: `sanitizeCooldownUntil` canonicalises).
- [ ] **A6** — each per-field rule and both coherence rules are individually load-bearing —
      verified by a mutation table in `review.md`, every result predicted in `plan.md` before the
      run, prediction commit SHA preceding every implementation commit. **`plan.md` must name, per
      mutation, the specific `file:testname` it expects to fail** — that makes "predicted against
      the tests as written" checkable by diffing predicted names against observed failures, instead
      of the honour system loop 031 ran on and missed four of nine.
- [ ] **A7** — a `string` payload field in `renderEvent` is a **compile error** — verified by a
      typefixture. This is achievable only after `MetricEvent.payload` narrows (B3); if `plan.md`
      measures that as too costly, **A7 is cut and `intent.md`'s outcome 5 is recorded as unmet**,
      not quietly rescored against the weaker guarantee.
- [ ] **A8** — `SPEC.md §12`'s gap paragraph **names exactly what remains**, verified by re-running
      the 26-marker probe and checking the paragraph against its output. Deleting it is a pass only
      if the probe reports zero. §17 records the compiler enforcement.
- [ ] **A9** — **zero** existing expectations change. Measured, not budgeted: the reviewer
      prototyped `sanitizeSnapshot` against this spec's rules, wired it into `readCacheResult`, and
      ran the suite — **854 pass, 0 fail, identical to baseline**. The first draft budgeted "at most
      two" while its own sentence said the number should be measured rather than budgeted, which is
      the contradiction loop 029 shipped and loop 031 fixed. If any expectation changes, A9 fails
      and it is a finding.
- [ ] **A10** — a poisoned `enterprise.utilizationPct` no longer throws — verified by a test that
      reads such an envelope and renders it without exception. This closes a live §9 stuck-failure
      loop (exit 3, file never deleted, forever) that no artefact in this loop claimed until the
      review found it.
- [ ] **A11** — **one place names every validated field** — verified by a test that reflects over
      `makeTestSnapshot()`'s keys and fails if any is absent from an exported `SANITIZED_FIELDS`
      list that `sanitizeSnapshot` uses, so a field added to `UsageSnapshot` without a rule is red
      rather than silently dropped. This is `intent.md`'s outcome 7, which the first draft dropped
      without saying so, and it is the check that stops loop 033 re-running this arithmetic.
- [ ] **A12** — no new lint warning — recorded in `review.md` as two sorted `oxlint` outputs
      compared as a **set**. Still manual; the gate wiring is loop 033, and this is the third loop
      to say so.
- [ ] **A13** — `bun run verify` exits 0.

## Rejected alternatives

- **Validate in place rather than rebuild.** Smaller diff, and it leaves unknown keys alive — the
  precise hole loop 031's audit found after loop 031 fixed two objects by rebuilding and left the
  rest by reference.
- **Null `disabledReason` on every cache read.** Closes the hole completely and deletes a real
  user-facing message from every render except the one after a fetch. Rejected as a feature loss
  disproportionate to a field whose content cannot carry local state; the bound is the compromise
  and its limit is stated in B2.
- **Sentinel a bad `resetsAt`, by symmetry with `fetchedAt`.** Rejected: `null` is already in the
  type and already means "unknown". `fetchedAt` needed a sentinel only because `null` is *not* in
  its type. Inventing a second sentinel would add a state every reader must learn for no gain.
- **Reject the envelope on a poisoned value.** Settled since loop 030: `tryDelete` discards the
  cooldown, which is §9.4's only throttle.
- **Include the two harness gates.** Deferred to loop 033 by `intent.md`, for the reason loop 031's
  spec gave. Third consecutive loop to carry A10 as prose; recorded as a cost, not a plan.

---

**Next stage:** Build — run `/sdlc-plan 032-snapshot-validation`.
