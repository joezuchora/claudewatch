# Plan: make the compiler enforce the FailureClass decisions

- **ID:** 014-exhaustive-failure-class
- **Stage:** 3 — Build
- **Status:** draft
- **Derived from:** [`spec.md`](./spec.md)
- **Branch:** `claude/ai-sdlc-setup-plan-nqyqbk`

## Approach

One exhaustive `switch` in `packages/core/src/cooldown.ts` answers all four decisions; the seven
consumers read it instead of comparing strings. Two compile-time guards, **both already run
against `tsc --strict` before this plan was written** — the spec's first draft shipped one that
compiled clean with a member missing, which is the reason that verification is not optional here.

The riskiest part is not the switch. It is that four of the seven consumers live in surfaces and
one of them (`client.ts`'s retry) is *not* a pure function of the class, so a mechanical
"replace the comparison" pass would change behaviour. Each consumer gets read before it gets
edited.

## Scope fence

```
packages/core/src/cooldown.ts
packages/core/src/cooldown.test.ts
packages/core/src/client.ts
packages/core/src/cache.ts
packages/core/src/cache.test.ts
packages/statusline/src/main.ts
packages/statusline/src/core-deps.ts
packages/vscode/src/extension.ts
packages/core/src/typefixtures/exhaustive.test.ts
packages/core/src/typefixtures/*.expect-error.ts
tsconfig.json
sdlc/014-exhaustive-failure-class/plan.md
sdlc/014-exhaustive-failure-class/review.md
sdlc/README.md
```

`tsconfig.json` is in the fence because the fixtures must be **excluded** from the project build —
they are files that are *supposed* to fail typecheck, so leaving them in would make `bun run
verify` permanently red.

## Changes

### `packages/core/src/cooldown.ts`
- `FAILURE_CLASSES`, `FailurePolicy`, `failurePolicy`, and the two guards.
- `shouldCooldown` keeps its signature and delegates.

### `packages/core/src/client.ts`
- `statusClassOf`'s status-less branch gets the `never` treatment.
- The retry decision reads `!policy.retryable` **and keeps** `|| result.status === 429`, with a
  comment saying why they cannot merge: 429 and 5xx share `serviceUnavailable` and differ.

### `packages/core/src/cache.ts`
- `readCacheResult` validates `lastErrorClass` against `FAILURE_CLASSES` and **nulls it** on
  mismatch rather than rejecting the envelope. This is what makes the runtime `throw` in
  `failurePolicy` unreachable from a corrupt cache — today that field passes shape validation
  unchecked and is inert only because nothing branches on it.

### `packages/statusline/src/main.ts`, `packages/vscode/src/extension.ts`
- Read the policy. No `=== 'authInvalid'` remains in either.
- **The exit code is consulted only on the two paths that derive from `FailureClass`.** The
  stale-cache path at `main.ts:297-309` exits 0 regardless and must not consult it.

### `packages/statusline/src/core-deps.ts`
- Re-bind `failurePolicy`. Importing core directly bypasses the mocking discipline `sdlc/001`
  created after 128 false failures.

### `packages/core/src/typefixtures/`
- Four `.expect-error.ts` files and a test that runs `tsc --noEmit` at each, asserting non-zero
  exit and `TS2322`.

## Tests

| Spec criterion | Test | File |
|---|---|---|
| Compiler catches a missing case | `a member missing from the switch fails typecheck` | `typefixtures/exhaustive.test.ts` |
| Compiler catches a missing `FAILURE_CLASSES` entry | `a member missing from FAILURE_CLASSES fails typecheck` | same |
| Compiler catches a deleted `case` | `a deleted case fails typecheck` | same |
| `statusClassOf` exhaustive | `a new status-less member fails typecheck` | same |
| All six policies, hand-written table | `every member's policy matches the table` + `toHaveLength(6)` | `cooldown.test.ts` |
| No `=== 'authInvalid'` in surfaces | `rg` assertion | `cooldown.test.ts` |
| `shouldCooldown` unchanged | `sdlc/010`'s guard, **unmodified** | `cooldown.test.ts` |
| Stale cache still exits 0 | `a renderable stale cache exits 0 for every failure class` | `main.test.ts` |
| 429 not retried, 5xx retried | existing `contract.test.ts` cases, unmodified | `contract.test.ts` |
| Invalid `lastErrorClass` nulled | `a cache with an unknown lastErrorClass is nulled, not rejected` | `cache.test.ts` |

## Verification

```
bun run verify
# plus, per REVIEW.md, mutation checks on every guard whose absence would be silent
```

## Risks

- **The fixture harness runs `tsc` four times.** At ~2 s each that is 8 s on a gate that is
  ~13 s. If it lands that badly the right answer is one fixture file with all four errors and a
  single `tsc` run asserting all four codes — not dropping the harness, which is the only thing
  that makes the guards checkable.
- **A mechanical comparison-replacement changes behaviour** in `client.ts` (429) and in
  `main.ts`'s stale-cache path (exit 0). Both are called out above and both have tests.
- **`tsconfig.json` exclusion is load-bearing.** Get it wrong and `verify` is permanently red —
  loudly, which is the safe direction.

---

**Next stage:** Build/Test — implement, then `/sdlc-review 014-exhaustive-failure-class`.
