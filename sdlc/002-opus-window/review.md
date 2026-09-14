# Review findings: track the Opus weekly window as a first-class window

- **ID:** 002-opus-window
- **Stage:** 5 — Deploy
- **Reviewed against:** [`plan.md`](./plan.md) and [`/REVIEW.md`](../../REVIEW.md)

## Plan-to-diff audit

**Verdict: EXCURSIONS RECORDED.** Fence amended; original preserved in git history.

| File | Necessary or creep | Reason |
|---|---|---|
| `packages/core/src/snapshot.ts` | **Necessary** | Constructs a `UsageSnapshot` literal for error snapshots; adding a required field forces it. The compiler named it immediately. |
| `packages/core/src/types.test.ts` | **Necessary** | Same — builds snapshot literals to assert structural validity. |
| `packages/core/src/security.test.ts` | **Necessary** | Asserts the cache envelope version, which this change bumps 1 → 2. |

**In the fence but not modified:** `packages/vscode/src/tooltip.ts` and
`packages/statusline/src/main.test.ts`. Planned as possibly needing changes; neither did.
`tooltip.ts` passes core's formatted string straight through, so the Opus row appears with no
edit — a small confirmation that the "surfaces are thin" rule is holding.

**Held, as predicted:** `packages/statusline/src/main.ts` and `packages/vscode/src/statusbar.ts`
were explicitly excluded on the reasoning that `primaryUtilizationPct` changes value but not
shape. Neither needed touching. The prediction was correct.

**Plan items with no corresponding change:** none. **Test-mapping gaps:** one, below.

## Pass 1 — Bugs and logical errors

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | blocking | A response carrying **only** an Opus window normalized to `unknown`, not `sevenDayOpus`. The `No valid usage windows found` guard checked `fiveHour` and `sevenDay` only, intercepting the case before primary selection. `spec.md`'s edge-case table asserted this case should work but did not identify the guard standing in front of it. | Fixed — the guard now counts `sevenDayOpus`. **Behavior change worth noting:** a response with only an Opus window was previously reported as malformed and is now valid data. |
| 2 | major | `formatStatusLine` chose its secondary window as `primaryWindow === 'fiveHour' ? sevenDay : fiveHour`. With a third window, an Opus primary would have silently shown `fiveHour` as secondary even when `sevenDay` was more constrained. | Fixed. Opus primary now shows the more constrained of the rolling pair; the fiveHour/sevenDay cases reduce to exactly the previous expression. |
| 3 | minor | Ties. Three-way selection could have reordered precedence. | Strict `>` with candidates ordered `fiveHour`, `sevenDay`, `sevenDayOpus` keeps the first on a tie, preserving the previous `fiveHour >= sevenDay` behavior exactly. Directly tested. |

**Contract checks (`REVIEW.md` pass 1) re-verified:** `parseWindow` is reused unchanged, so
`resets_at` handling and warning strings are identical. Missing optional fields are omitted,
not guessed — an absent Opus window is the same null window the model already uses. Enterprise
handling returns before primary selection and its fixtures pass untouched. Retry, cooldown,
and exit codes are not touched.

## Pass 2 — Security and vulnerabilities

No findings.

**Invariants checked:** no new I/O, no new network call, no logging or serialization change,
and no path touching credentials. `cache.ts` changes one integer constant; its atomic-write
and permission behavior is untouched. The new field carries a utilization percentage and a
timestamp — no token, no PII.

The cache version bump is the security-relevant decision, and it is the conservative one:
a stale v1 envelope is deleted rather than deserialized into a shape the type system would
wrongly treat as complete.

## Pass 3 — Compliance

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | — | `spec.md` amends `SPEC.md §5.3`, which `REVIEW.md` requires be explicit. | **Satisfied.** §5.3 carries a dated amendment note stating the change and its user-visible consequence; §5.1 and §3.3 updated; §19.3's backlog entry struck. |
| 2 | — | All domain logic in core? | Yes. Normalization, selection and formatting are entirely in `packages/core`. The VS Code surface needed no change at all. |
| 3 | minor | `SPEC.md §5.1`'s canonical model **still omits `tier` and `enterprise`**, which shipped in commit `3dd83ae`. | **Pre-existing drift, not introduced here.** Noticed while editing §5.1. Not fixed — unrelated to this change and it would widen the diff. Recorded as a follow-up. |

No `any` introduced, ESM throughout, timestamps UTC ISO, tests colocated with HTTP mocked,
`parseWindow` and `makeTestSnapshot` reused rather than duplicated.

## Verification evidence

```
$ bun run verify
$ tsc --noEmit
$ oxlint
packages/vscode/src/commands.ts:10:9: warning eslint(no-shadow)   [known, see loop 001]
$ bun test
 360 pass
 0 fail
Ran 360 tests across 16 files. [26.1s]
$ ... builds
@claudewatch/core build: Exited with code 0
@claudewatch/statusline build: Exited with code 0
claudewatch-vscode build: Exited with code 0

VERIFY EXIT=0
```

360 tests, up from 341 — 19 added, none removed. The two pre-existing tests that asserted
Opus was *ignored* were rewritten to assert it is tracked, not deleted.

**VS Code bundle still CommonJS:** 12 `require`/`module.exports` occurrences.

**Backward compatibility, the load-bearing claim:** all 341 pre-existing tests pass unmodified
except the three that hardcoded the cache version. `format.test.ts` adds a direct assertion
that an Opus-less snapshot's status line has exactly two segments and contains no trace of
the feature at either width branch.

- [x] `bun run verify` exits 0
- [x] Every acceptance criterion in `spec.md` is met, with one qualified — see below
- [ ] CI green on the PR head commit — pending push

## Test-mapping gap

`plan.md` mapped "tooltip renders Opus row" to `packages/vscode/src/tooltip.test.ts`. **That
test could not be written there.** `statusbar.test.ts` mocks the shared `./core-bridge.js` for
the whole process, so `formatTooltip` inside `tooltip.test.ts` is a stub returning
`formatted: N%`. A test there would have asserted against the stub, not the code.

Coverage moved to `packages/core/src/format.test.ts`, where it runs against the real
formatter, and `tooltip.test.ts` carries a comment explaining why.

This is **residual contamination from the same root cause loop 001 fixed** — Bun's global
module mocks — surviving *within* a package rather than across packages. Loop 001 stopped
surface mocks from reaching `packages/core`; it did not stop two test files in the same
package from sharing one mocked bridge. Splitting the bridge per consumer would fix it.
Recorded as a follow-up rather than fixed here: it is loop 001's territory, not this change's.

## Findings deliberately not fixed

1. **Intra-package mock contamination in `packages/vscode`** — above. The most substantive.
2. **`SPEC.md §5.1` omits `tier` and `enterprise`** — Pass 3, finding 3. Pre-existing drift.
3. **Release note needed.** The headline number changes for Opus users. That is intended and
   documented in the SPEC amendment, but it needs to reach users at release, and nothing in
   this repo currently guarantees that. Worth an `intent.md` of its own.
4. All loop 001 follow-ups remain open, including the ~26 s of real `setTimeout` sleeps that
   still dominate every `verify` run.

## Note on process

Loop 2 ran without re-deriving the process — the artifacts were written and committed in
sequence with no re-reading of the stage definitions.

It also repeated loop 1's lesson in a new form. Both loops produced a **blocking Pass 1
finding that was a defect in their own spec**: loop 1's isolation strategy did not survive
Bun's actual behavior, and loop 2's edge-case table asserted an outcome the existing
`No valid usage windows` guard silently prevented. In both cases the spec was specific enough
that implementation falsified it immediately rather than shipping the ambiguity.

The pattern is now clear enough to act on: **a spec's edge-case table should be checked
against the code paths that guard those cases, not only against the intended behavior.** That
belongs in the `sdlc-spec` skill and in `spec-reviewer`.

---

**Next stage:** Maintain.
