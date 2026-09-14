# Spec: make the compiler enforce the FailureClass decisions

- **ID:** 014-exhaustive-failure-class
- **Stage:** 2 — Design
- **Status:** revised after review
- **Derived from:** [`intent.md`](./intent.md)

## What the review changed

Four blocking findings. The worst is the one this loop should have been least capable of making.

| # | Finding | Verified | What changed |
|---|---|---|---|
| B1 | **My second compile-time guard does not compile-fail.** `const _exhaustive: _AllCovered[] = []` — an empty array literal is assignable to *every* array type, `never[]` included. I ran it: a missing member gives `TSC EXIT=0`. | Yes, both directions | Replaced with the `never`-assignment form, which I ran and watched fail with `TS2322: Type '"c"' is not assignable to type 'never'`. |
| B2 | The "compiler catches it" criteria were **one-shot manual acts** — a paste in `review.md`. `intent.md`'s own open question pre-rejected exactly that. | — | A committed fixture harness that runs `tsc` against `.expect-error.ts` files inside `bun test`. |
| B3 | `notConfigured` and `malformedResponse` are **never constructed** as `FailureClass` values. Two of six rows had no "today" to preserve, and I asserted them as preserved anyway. `notConfigured`'s exit code contradicted SPEC §11.5. | `grep`: only `types.ts` and tests | Rows marked as choices, not preservation. `notConfigured` → exit 2, per §11.5. |
| B4 | **A seventh consumer, and the most consequential**: `client.ts:165` decides *retryability* from `failureClass`, defaulting to "retry". | Yes | Fourth policy field, with the 429 status check deliberately kept separate. |

**That B1 got as far as a committed spec is the finding worth carrying.** A guard that compiles
is not a guard that works, and I wrote a justification paragraph for that exact hazard two
paragraphs above the broken guard. Nothing but running it would have caught it.

## The consumers, all seven

| # | Decision | Today | Default bucket |
|---|---|---|---|
| 1 | 5-minute cooldown (SPEC §9.4) | `fc === 'serviceUnavailable' \|\| fc === 'timeout'` (`cooldown.ts:55`) | no cooldown |
| 2 | **retry** (SPEC §9.3) | `fc === 'authInvalid' \|\| status === 429` (`client.ts:165`) | **retry it** |
| 3 | error snapshot kind | `fc === 'authInvalid' ? 'invalid' : 'unknown'` (`main.ts:228`) | `'unknown'` |
| 4 | statusline exit code (SPEC §11.5) | `fc === 'authInvalid' ? 2 : 1` (`main.ts:234`) | `1` |
| 5 | "auth invalid" display + exit 2 | `if (fc === 'authInvalid')` (`main.ts:324`) | generic failure |
| 6 | VS Code auth handling | `if (result.failureClass === 'authInvalid')` (`extension.ts:217`) | generic error |
| 7 | telemetry `statusClass` | `fc === 'timeout' ? 'timeout' : 'network'` (`client.ts:114`) | `'network'` |

## Behavior

### One policy, resolved exhaustively

```ts
export interface FailurePolicy {
  /** Enters the 5-minute backoff. SPEC §9.4. */
  cooldown: boolean;
  /** Whether a retry is worth attempting. SPEC §9.3. See the note below — not the whole rule. */
  retryable: boolean;
  /** Which snapshot the surfaces render — exactly `makeErrorSnapshot`'s parameter. SPEC §7.2. */
  presentation: 'invalid' | 'missing' | 'unknown';
  /** SPEC §11.5. Applies on two paths only — see "Where the exit code applies". */
  statuslineExitCode: 1 | 2 | 3;
}
```

| member | cooldown | retryable | presentation | exit | preserved? |
|---|---|---|---|---|---|
| `notConfigured` | false | false | `missing` | **2** | **choice** — never constructed; §11.5 says 2 = "credentials missing or unreadable" |
| `authInvalid` | false | **false** | `invalid` | 2 | preserved |
| `serviceUnavailable` | **true** | true | `unknown` | 1 | preserved |
| `timeout` | **true** | true | `unknown` | 1 | preserved |
| `malformedResponse` | false | true | `unknown` | 1 | **choice** — never constructed; matches the default bucket it would have fallen into |
| `unexpectedFailure` | false | true | `unknown` | 1 | preserved |

Two rows are marked as choices rather than quietly asserted as preserved. `notConfigured`
deliberately departs from the old default bucket because that bucket contradicted SPEC §11.5;
`intent.md` fenced the exit-code *contract* out of scope, and this does not change it — it makes
an unreachable member agree with it.

**`presentation` now uses `makeErrorSnapshot`'s own parameter values.** The first draft invented
`'authExpired'`, a string neither surface displays — `main.ts:324` prints `⊙ auth invalid`, and
`⊙ auth expired` belongs to the credential-resolution path, which is not keyed on `FailureClass`
at all. A field name an implementer could read as intent is a behaviour change waiting to happen.

**`retryable` is not the whole retry rule, deliberately.** 429 maps to `serviceUnavailable` and
is *not* retried; 5xx maps to `serviceUnavailable` and *is*. Retryability is a function of the
class **and** the status, so `client.ts` keeps `|| result.status === 429` beside
`!policy.retryable`, with a comment saying why they cannot merge. Folding the status into the
class-keyed policy would change behaviour — which is how a "pure refactor" ships a bug.

### Where the exit code applies

`main.ts` has six non-zero `process.exit` sites and only two derive from `FailureClass`
(`main.ts:234` in the `--debug --refresh` path, and `main.ts:331/341`). **When a renderable
stale cache exists, `main.ts:297-309` exits 0 regardless of the failure class** — the policy's
exit code must not be consulted there. Codes 2 from credential resolution (`main.ts:261-278`)
and 3 from the top-level catch (`main.ts:379`) are not derived from `FailureClass` and are
untouched. The field is named `statuslineExitCode` and typed `1 | 2 | 3` rather than `1 | 2`, so
§11.5's third code is not silently foreclosed.

Getting this wrong would break the exit-code contract for anyone scripting the binary, which
`packages/statusline/CLAUDE.md` calls out explicitly.

### Where the throw lands

The `never` fallback throws rather than returning a default. The first draft called that
"failing loudly"; the reviewer showed it is not, in one of the two surfaces:

- **Statusline** — lands in `main.ts:375-380`'s top-level catch: prints `⊙ error`, exits 3.
  Defensible under §11.5, and **a behaviour change worth naming**: the same input previously
  exited 1 after writing the cache.
- **VS Code** — lands in `extension.ts:244`'s bare `catch { }`, which renders the stale snapshot
  with *no* error indication. That is **quieter** than the default bucket it replaces.

Rather than argue about which is right, the fix removes the reachable cause: `readCacheResult`
validates `lastErrorClass` against `FAILURE_CLASSES` and nulls it on mismatch. Today a
hand-edited or corrupted cache carrying `lastErrorClass: "garbage"` passes validation — the
shape check tests `version`, `fetchedAt`, `display` and `freshness`, and never that field. It is
inert only because nothing branches on it, which this change ends. SPEC §7 treats a corrupt cache
as an *expected* failure class, not a contract violation, so "only reachable by a cast" was wrong.

That also gives `FAILURE_CLASSES` a job beyond iterating in tests.

### Two compile-time guards, both verified by running them

```ts
// 1. In failurePolicy, after the switch:
const unhandled: never = fc;
throw new Error(`unhandled FailureClass: ${String(unhandled)}`);

// 2. The member list, kept in sync with the union in BOTH directions:
export const FAILURE_CLASSES = [...] as const satisfies readonly FailureClass[];
const _allCovered: never = null as unknown as Exclude<FailureClass, typeof FAILURE_CLASSES[number]>;
```

`satisfies` catches a string in the array that is not in the union while preserving the literal
type that `typeof FAILURE_CLASSES[number]` needs; the `never` assignment catches a union member
the array lacks. Both forms were run against `tsc --strict` before being written here.

`FAILURE_CLASSES` lives in `cooldown.ts` beside `failurePolicy`, not in `types.ts` — that module
has no value exports today and `cooldown.ts` imports from it with `import type`.

### Consumers become thin

`shouldCooldown` keeps its signature and delegates. `main.ts` and `extension.ts` read the policy
instead of comparing strings. `statusClassOf` keeps its own shape — it answers a telemetry
question, not a policy one — but its status-less branch gains the same `never` treatment.

`failurePolicy` is added to `packages/statusline/src/core-deps.ts`, the value-rebinding module
`sdlc/001` created after 128 false failures. Importing it directly would bypass that discipline.

**The exit code belongs in core** (`intent.md`'s open question, unanswered by the first draft).
SPEC §8.2 puts business logic in `packages/core` and requires identical behaviour across
surfaces; §11.5 makes the codes contractual but says nothing about where the *derivation* lives.
`packages/vscode` will import a type carrying a field it ignores, which is the smaller cost.

## Data and types

- New in `packages/core/src/cooldown.ts`: `FailurePolicy`, `failurePolicy`, `FAILURE_CLASSES`.
- `FailureClass` itself is **unchanged** — no member added, removed, or renamed.
- `readCacheResult` gains one validation. No format change, so `CACHE_VERSION` is untouched and
  every persisted envelope stays valid; a bad `lastErrorClass` is nulled, not rejected.

## Edge cases

| Case | Expected behavior |
|---|---|
| A member added to `FailureClass`, not to the switch | `tsc` fails at the `never` assignment, naming the member |
| A member added to `FailureClass`, not to `FAILURE_CLASSES` | `tsc` fails at `_allCovered` |
| A string in `FAILURE_CLASSES` not in the union | `tsc` fails at `satisfies` |
| A `case` deleted | `tsc` fails at the `never` assignment |
| A status-less member other than `timeout` added | `statusClassOf`'s `never` fails, rather than defaulting to `'network'` |
| Cache carries `lastErrorClass: "garbage"` | Nulled by `readCacheResult`; the envelope is still used |
| A value outside the union reaches `failurePolicy` anyway | Throws. Statusline → exit 3; VS Code → stale render, silently. Both named above. |
| Renderable stale cache plus any failure | Exit **0**. The policy's exit code is not consulted. |
| 429 | Not retried, via the status check `client.ts` keeps beside the policy |
| 5xx | Retried, though it shares `serviceUnavailable` with 429 |

## Acceptance criteria

- [ ] **A committed fixture harness proves the compiler catches it**: `.expect-error.ts` fixtures
      (member missing from the switch; member missing from `FAILURE_CLASSES`; a deleted `case`;
      a status-less member added to `statusClassOf`) each run through `tsc --noEmit` inside
      `bun test`, asserting non-zero exit and `TS2322`. Runs in CI, not once by hand.
- [ ] A **hand-written** `Record<FailureClass, FailurePolicy>` expectation table in the test file
      is compared member-by-member while iterating `FAILURE_CLASSES`, plus
      `expect(FAILURE_CLASSES).toHaveLength(6)` so a new member fails until the table is edited
- [ ] `rg "'authInvalid'" packages/statusline/src/main.ts packages/vscode/src/extension.ts`
      returns zero matches
- [ ] Behavioural, per surface: statusline exits 2 and prints `⊙ auth invalid` for `authInvalid`
      with no cache; exits 1 and prints `⊙ error` for the other five
- [ ] `shouldCooldown` returns exactly today's answer for all six — `sdlc/010`'s regression guard
      passes **unmodified**
- [ ] A renderable stale cache still exits 0 for every failure class — tested, since this is the
      contract the exit-code field most plausibly breaks
- [ ] 429 is still not retried and 5xx still is — tested, since `retryable` alone would change it
- [ ] A cache with an invalid `lastErrorClass` is nulled, not rejected — tested
- [ ] `bun run verify` exits 0

## Rejected alternatives

- **A single `requiresReauth` boolean.** With `notConfigured` at exit 2 and presentation
  `missing`, the fields are now visibly uncorrelated, so this retires itself.
- **Separate exhaustive functions per decision.** A new member would need four edits in four
  files; missing one is the failure being fixed. One switch makes the decision set atomic.
- **A `Record<FailureClass, FailurePolicy>` lookup.** Also exhaustive, but no place for the
  runtime throw, and `statusClassOf` needs the `never` form regardless — one idiom beats two.
- **Folding the 429 check into `retryable`.** Changes behaviour: 429 and 5xx share a class.
- **A manual "I added a member and watched it fail" note** instead of the fixture harness. That
  was the first draft's position, and B1 is the demonstration of why it is not enough.
- **`RuntimeState` and `StaleReason` in the same change.** Same defect, unreviewable diff.

---

**Next stage:** Build — run `/sdlc-plan 014-exhaustive-failure-class`.
