# Spec: track the Opus weekly window as a first-class window

- **ID:** 002-opus-window
- **Stage:** 2 — Design
- **Status:** accepted
- **Derived from:** [`intent.md`](./intent.md)

## Summary

`seven_day_opus` is normalized into the snapshot as a third rolling window, `sevenDayOpus`,
and participates in primary-window selection on equal terms with the other two. Both surfaces
display it when present. Accounts without an Opus window see byte-identical output.

## Design decisions

### The Opus window participates in the primary-window rule

**This amends `SPEC.md §5.3`** and the change is user-visible. Recorded explicitly, as
`REVIEW.md` pass 3 requires.

§5.3 defines primary utilization as the highest across *supported* windows, on the principle
that the headline number should show the most constrained resource. Until now "supported"
meant two windows because the third was discarded. Making Opus supported and then excluding it
from the rule would contradict the rule's entire purpose: a user at 95% Opus and 20% weekly
would still be shown 20%, which is the exact failure `intent.md` describes.

So the rule is unchanged in principle — the set it ranges over grows by one:

> Primary utilization is the highest valid utilization across `fiveHour`, `sevenDay`, and
> `sevenDayOpus`.

**Consequence, accepted deliberately:** a user whose Opus window is their most constrained
will see a different headline number than before. That is the point of the change. It is not a
regression, and it must be called out in release notes.

Tie-breaking: `fiveHour` > `sevenDay` > `sevenDayOpus`, preserving today's existing
`fiveHour >= sevenDay` precedence exactly. A tie cannot change today's behavior.

### Cache version bumps to 2

`CACHE_VERSION` goes 1 → 2.

`readCache` treats a version mismatch as corrupt: it deletes the file and returns null,
producing a fresh fetch. That is already a defined, safe path (`SPEC.md §9.6`).

Without the bump, a v1 cache would deserialize into a snapshot whose `sevenDayOpus` is
`undefined` while the type claims it is present — a silent lie that would surface as a
rendering crash or a wrong display, and only for users upgrading. Bumping converts a subtle
correctness hazard into one extra fetch, once. That is a trade worth making every time.

### `sevenDayOpus` is always present, never optional

It is a `UsageWindow`, not `UsageWindow | null`. When the endpoint omits `seven_day_opus`,
it normalizes to `{ utilizationPct: null, resetsAt: null }` — exactly how `fiveHour` and
`sevenDay` already represent absence.

This keeps one representation of "no data" instead of two, and it means every consumer's
existing null-check works unchanged. It does **not** violate the "omitted, not guessed" rule
in `SPEC.md §3.3`: nothing is guessed, and a null utilization is precisely how the model
already encodes a missing window.

## Behavior

Normalization reuses the existing `parseWindow` helper — same validation, same warning
strings, same `resets_at` handling. No new parsing logic.

Display, when and only when `sevenDayOpus.utilizationPct !== null`:

- **Statusline, default width:** an `opus N%` segment after the `7d` segment.
- **Statusline, compact width:** unchanged. Compact shows only the primary figure, which
  already reflects Opus when Opus is primary.
- **Statusline, rich:** an Opus bar alongside the existing current/weekly bars.
- **VS Code tooltip:** an Opus row alongside the existing window rows.
- **VS Code status bar:** unchanged in structure. It shows primary utilization, which now
  accounts for Opus.

## Data and types

| Change | Detail |
|---|---|
| `UsageSnapshot.sevenDayOpus` | new, `UsageWindow`, always present |
| `UsageSnapshot.display.primaryWindow` | union gains `'sevenDayOpus'` |
| `CACHE_VERSION` | `1` → `2` |

No change to `RawUsageResponse` — `seven_day_opus` is already declared there.

## Edge cases

| Case | Expected behavior |
|---|---|
| `seven_day_opus` absent | `{ utilizationPct: null, resetsAt: null }`. No display segment. Primary unchanged. |
| `seven_day_opus: null` | Same as absent. |
| Present, `utilization: 0` | A real window at 0%. Displayed. Eligible to be primary only if the others are null. |
| Present with `resets_at: null` | Displayed without a reset time, as the other windows already do. |
| Present, malformed `resets_at` | Warning pushed, `resetsAt` null, utilization still used — matches `parseWindow`'s existing behavior. |
| Opus highest of three | Primary becomes `sevenDayOpus`. **The intended user-visible change.** |
| Three-way tie | `fiveHour` wins, preserving today's precedence. |
| Enterprise (all windows null) | Primary stays `'enterprise'`. Opus never displayed. Untouched. |
| Cache written by v1 | Version mismatch → deleted → refetched. One extra fetch, no wrong display. |
| Opus present, others null | Primary is `sevenDayOpus`. |

## Backward compatibility

- **Users with no Opus window: byte-identical output.** This is the load-bearing compatibility
  claim and is tested directly against the existing fixtures.
- **Users with an Opus window: the headline number may change.** Intended, and the reason for
  the change.
- Enterprise accounts unaffected — all rolling windows are `null` and the enterprise branch
  returns before primary selection.
- Exit codes, CLI flags, the API contract, and credential handling are untouched.
- One-time cache invalidation on upgrade.

## Acceptance criteria

- [ ] `seven_day_opus` normalizes into `sevenDayOpus` — new tests in `normalize.test.ts`
- [ ] Absent/null/malformed cases behave as tabled — new tests in `normalize.test.ts`
- [ ] Opus becomes primary when highest — new tests in `normalize.test.ts`
- [ ] Three-way tie resolves to `fiveHour` — new test
- [ ] `contract.test.ts`'s "ignores seven_day_opus" test is **replaced**, not deleted, by one
      asserting the new behavior end-to-end
- [ ] Snapshots without Opus produce output identical to today — assertion over existing
      fixtures in `format.test.ts`
- [ ] Statusline and tooltip render the Opus segment when present — new tests
- [ ] Enterprise fixtures unchanged — existing enterprise tests pass untouched
- [ ] A v1 cache envelope is discarded and refetched — new test in `cache.test.ts`
- [ ] `bun run verify` exits 0

## Rejected alternatives

- **Display Opus but never let it be primary.** Additive and zero-risk, and it preserves the
  exact bug the change exists to fix. Rejected.
- **`sevenDayOpus: UsageWindow | null`.** Two ways to say "no data"; every consumer gains a
  redundant branch. Rejected.
- **No cache bump, tolerate `undefined`.** Trades a visible one-time refetch for an invisible
  correctness hazard that only affects upgrading users. Rejected.
- **A separate Opus threshold/colour.** Out of scope per `intent.md`.

---

**Next stage:** Build — run `/sdlc-plan 002-opus-window`.
