# Plan: track the Opus weekly window as a first-class window

- **ID:** 002-opus-window
- **Stage:** 3 — Build
- **Status:** accepted
- **Derived from:** [`spec.md`](./spec.md)
- **Branch:** `claude/ai-sdlc-setup-plan-nqyqbk` (same session constraint as loop 1)

## Approach

Widen `computePrimaryDisplay` from two windows to three, reusing the existing `parseWindow`
helper for normalization so no new parsing logic enters the codebase. Thread the new field
through the snapshot, bump the cache version, then add display in both surfaces behind a
`utilizationPct !== null` guard so absent-Opus output is untouched.

Order: types → normalize → cache → tests for core → surfaces → tests for surfaces. Core must
be green before either surface is touched; a surface bug and a normalization bug look
identical from the terminal otherwise.

## Scope fence

```
packages/core/src/types.ts
packages/core/src/types.test.ts
packages/core/src/snapshot.ts
packages/core/src/security.test.ts
packages/core/src/normalize.ts
packages/core/src/cache.ts
packages/core/src/test-helpers.ts
packages/core/src/normalize.test.ts
packages/core/src/contract.test.ts
packages/core/src/cache.test.ts
packages/core/src/format.ts
packages/core/src/format.test.ts
packages/vscode/src/tooltip.ts
packages/vscode/src/tooltip.test.ts
packages/statusline/src/main.test.ts
SPEC.md
sdlc/002-opus-window/plan.md
sdlc/002-opus-window/review.md
```

`SPEC.md` is in the fence deliberately: `spec.md` amends §5.3, and an amendment that never
reaches the governing document is how specs rot. §19.3's backlog entry moves to done.

> **Fence amended during implementation (2026-08-26).** Three files were added, all forced by
> the compiler or the version bump and all recorded in `review.md`: `snapshot.ts` and
> `types.test.ts` construct `UsageSnapshot` literals and so must supply the new field, and
> `security.test.ts` asserts the cache envelope version. The original fence is preserved in
> git history.

`packages/statusline/src/main.ts` and `packages/vscode/src/statusbar.ts` are **not** in the
fence. Both consume `display.primaryUtilizationPct`, which changes value but not shape, so
neither should need editing. If either does, the change is not as contained as designed and
that is a finding.

## Changes

### `packages/core/src/types.ts`
- `UsageSnapshot.sevenDayOpus: UsageWindow` (always present).
- `display.primaryWindow` union gains `'sevenDayOpus'`.

### `packages/core/src/normalize.ts`
- Parse `seven_day_opus` via the existing `parseWindow(raw, warnings, 'seven_day_opus')`.
- `computePrimaryDisplay` takes three windows; select the highest valid utilization with
  precedence `fiveHour` > `sevenDay` > `sevenDayOpus` on ties.
- Enterprise branch untouched — it returns before primary selection.

### `packages/core/src/cache.ts`
- `CACHE_VERSION` 1 → 2. No other change; the existing mismatch path already deletes and
  refetches.

### `packages/core/src/test-helpers.ts`
- `makeTestSnapshot` gains a `sevenDayOpus` default of `{ utilizationPct: null, resetsAt: null }`
  so existing callers keep producing today's snapshots unchanged.

### `packages/core/src/format.ts`
- Statusline default width: `opus N%` segment after `7d`, only when non-null.
- Rich format: an Opus bar alongside the existing bars, only when non-null.
- `formatTooltip`: an Opus row, only when non-null.
- Compact format: untouched.

### `packages/vscode/src/tooltip.ts`
- Render the Opus row from the core-formatted tooltip. No domain logic.

### `SPEC.md`
- §5.3: primary ranges over three windows, with the tie precedence stated.
- §3.3 / §5.1: `sevenDayOpus` in the canonical model.
- §19.3: strike the backlog entry.

## Tests

| Spec criterion | Test | File |
|---|---|---|
| Normalizes into `sevenDayOpus` | `handles seven_day_opus present` (rewrite) | `normalize.test.ts` |
| Absent / null / malformed `resets_at` | three new cases | `normalize.test.ts` |
| Opus becomes primary when highest | new case | `normalize.test.ts` |
| Opus primary when others null | new case | `normalize.test.ts` |
| Three-way tie → `fiveHour` | new case | `normalize.test.ts` |
| End-to-end with Opus | replace `ignores seven_day_opus` | `contract.test.ts` |
| **No-Opus output byte-identical** | assert existing fixtures unchanged | `format.test.ts` |
| Statusline renders Opus segment | new case | `format.test.ts` |
| Tooltip renders Opus row | new case | `tooltip.test.ts` |
| v1 cache discarded and refetched | new case | `cache.test.ts` |
| Enterprise unaffected | existing tests, must pass untouched | `contract.test.ts` |

The byte-identical test is the one that matters most. Everything else verifies the feature;
that one verifies we did not break the 100% of users who do not have the feature.

## Risks

- **Silently changing the headline for no-Opus users.** Guarded by the byte-identical test.
- **`makeTestSnapshot` default wrong** would mask a real regression across ~13 test files. The
  default must be the null window, never a populated one.
- **Cache bump forces one refetch for everyone on upgrade.** Accepted and specified.
- **Enterprise regression** — all rolling windows are null there, so an Opus branch that does
  not check `utilizationPct !== null` could surface an empty segment. Covered by leaving the
  existing enterprise tests untouched and requiring them to pass.

---

**Next stage:** Build/Test — run `/sdlc-implement 002-opus-window`.
