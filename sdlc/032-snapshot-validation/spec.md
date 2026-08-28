# Spec: validate the whole snapshot, not four fields of it

- **ID:** 032-snapshot-validation
- **Stage:** 2 — Design
- **Status:** draft
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

### The leak is total, not partial: 14 of 14

Poisoned every remaining field of a v2 envelope, read it back through `readCacheResult`, and searched
the serialised result for each marker:

```
usageEndpoint  sourceExtra  authState  primaryWindow  primaryPct  primaryResetsAt  displayExtra
fivePct  fiveResetsAt  windowExtra  entPct  currency  disabledReason  snapshotExtra
                                                                → 14 of 14 LEAK
```

Not "roughly twenty fields, some unchecked" as `intent.md` put it. **Every field loop 031 did not
name survives, and so does every unknown key at every depth.**

### `renderEvent` narrowing costs **zero** call-site errors — and the first probe said two

`intent.md`'s open question 3 predicted zero and demanded the number be measured before the change.
First probe: **2 errors**. Both were `TS2304: Cannot find name` — the types were not imported. That
is a different failure from the one being predicted, and recording "2" would have been a wrong number
arrived at honestly, which is the exact species this loop's predecessors kept shipping. With the
import added: **0 errors**. `classify` already returns `RuntimeState` and `tier` is already
`AccountTier` after loop 031.

### A null `primaryUtilizationPct` renders `⊙ error`, not a blank

`intent.md`'s open question 2 worried that degrading a poisoned percentage to `null` would "silently
blank the statusline". Measured:

```
valid pct -> "⊙ 42% resets sat 5:00 pm · 7d 18% resets sat 7:00 am"
null  pct -> "⊙ error"
```

Not silent, and not blank. `format.ts` already has an error rendering for exactly this state. **This
settles question 2**: `null` is the right degrade, because the resulting display is honest — the
cache is corrupt and the tool says so — and it costs no fetch.

### `disabledReason` reaches the tooltip verbatim, today

`format.ts:374` interpolates it directly: `` const reason = e.disabledReason ? ` — ${e.disabledReason}` : '' ``.
It is a live §12 instance, not a hypothetical one, and it is the **only** field in the snapshot for
which no closed set can exist — the text is chosen by the API.

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
| `enterprise` | `null`, or rebuilt with every field checked | `null` |
| `enterprise.currency` | `ISO_CURRENCY_RE` — the regex `normalize.ts:12` already uses | `'USD'` |
| `enterprise.disabledReason` | **bounded, not enumerated** — see B2 | `null` |
| `display.primaryWindow` | closed set of 5 | `'unknown'` |
| `display.primaryUtilizationPct` | finite number in 0–100 or `null` | `null` |
| `display.primaryResetsAt` | canonicalised ISO or `null` | `null` |
| `freshness`, `rawMetadata` | **unchanged from loop 031** | as there |

Unknown keys at every depth are dropped by construction.

`resetsAt` timestamps are **canonicalised, not sentinelled** — unlike `fetchedAt`, `null` is already
in their type and already means "no reset known", so no sentinel is needed and none is invented.

### B2 — `disabledReason` is the one field a closed set cannot cover

Its text is chosen by the API. Enumerating it is impossible, and the producer-union argument that it
"comes from Anthropic so it is safe" is precisely the reasoning loops 029–031 established is void for
a value read off disk.

**Bounded rather than enumerated**: kept if it is a string, truncated to 200 characters, else `null`.
This is a *different mitigation for a genuinely different case*, and it is the weakest decision in
this spec — it stops an unbounded blob reaching a tooltip and does **not** stop a short poisoned
string. Stated plainly so the reviewer can reject it rather than discover it. The alternative
considered and rejected was nulling it on every cache read, which would delete a legitimate,
user-facing explanation from every render except the one immediately after a fetch — a real feature
loss to close a hole whose content cannot carry local state.

### B3 — `renderEvent` narrows

`runtimeState: string` → `RuntimeState`, `tier: string` → `AccountTier`, and the comment justifying
them as "constrained by their producing unions" is replaced with what is now true. Measured cost: **0
call-site errors** once the types are imported.

### Amendments to `SPEC.md`

- **§12's gap paragraph is deleted**, not replaced. After B1 there is no unvalidated snapshot field
  and no surviving unknown key. What remains open is the structural-reject path (`snapshot`,
  `display`, `freshness` missing entirely), which already has its own bullet, and `disabledReason`'s
  bound, which gains one.
- **§17** records that `renderEvent`'s enum leaves are enforced by the compiler.

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

- [ ] **A1** — a `usage.json` with all 14 measured fields poisoned puts none of that text on
      `--debug`, on `--json`, or into the telemetry spool — verified by a unit test asserting on the
      whole serialised envelope, and by two end-to-end cases against the compiled binary, one per
      flag. The spool leg is asserted by driving `renderEvent`/`emit` into a sandboxed `HOME` and
      reading the spool file, because loop 031 established stdout is not the whole surface.
- [ ] **A2** — no unknown key survives at any depth — verified by a test seeding one at each of the
      five levels and asserting the serialised envelope contains none of them.
- [ ] **A3** — **a rich envelope round-trips deep-equal**, with a fixture populating `enterprise`,
      all three windows, a non-`'none'` `staleReason` and all nine warnings. A whitelist's failure
      mode is a dropped field; this is the criterion that catches it. `makeTestSnapshot`'s defaults
      are every field's *degraded* value, so the fixture must override them — that vacuity was a
      Stage 2 finding against loop 031 and applies with more force here.
- [ ] **A4** — every closed set is exhaustive against its union — verified by the
      `Exclude<…> = never` guard, and by a typefixture proving the guard fails when a member is
      omitted. Loop 031 learned that a criterion the gate cannot run is a note; this one runs.
- [ ] **A5** — no poisoned value costs a fetch or discards `cooldownUntil` — verified by a test
      asserting `reason === 'hit'`, `cooldownUntil` unchanged, `isInCooldown` true.
- [ ] **A6** — each per-field rule is individually load-bearing — verified by a mutation table in
      `review.md` with every result **predicted in `plan.md` before the run**, the prediction commit
      SHA preceding every implementation commit so `git log --oneline <predict>..<impl>` shows it.
      **Predictions are made against the tests as written, not against the plan's test table** —
      loop 031 missed four of nine by predicting against its own mapping, and its miss list included
      one row that was in the mapping and simply overlooked.
- [ ] **A7** — `renderEvent`'s narrowing produces **0** call-site errors, as measured above —
      verified by `bun run typecheck` exiting 0, and by a typefixture proving a `string` payload
      field is now rejected.
- [ ] **A8** — `SPEC.md §12`'s gap paragraph is **deleted**, and §17 records the compiler
      enforcement — verified by reading the diff. A §12 still claiming unvalidated snapshot fields
      fails it.
- [ ] **A9** — at most **two** existing expectations change, both named in `plan.md` in advance,
      with the measured count recorded before the change rather than budgeted. Loop 031 measured
      zero and held; this loop touches far more surface and the honest expectation is not zero.
- [ ] **A10** — no new lint warning — recorded in `review.md` as two sorted `oxlint` outputs
      compared as a **set** (line numbers shift on unrelated edits). Still a manual step; wiring it
      into the gate is loop 033, and this is the third loop to say so.
- [ ] **A11** — `bun run verify` exits 0.

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
