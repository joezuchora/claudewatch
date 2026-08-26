# Spec: make the compiler enforce the FailureClass decisions

- **ID:** 014-exhaustive-failure-class
- **Stage:** 2 — Design
- **Status:** draft
- **Derived from:** [`intent.md`](./intent.md)

## Summary

Every decision made from a `FailureClass` moves behind one exhaustive `switch` in
`packages/core`, so adding a member fails `bun run typecheck` until each decision is made
explicitly. No behaviour changes for any of the six current members.

## The consumers, all six

The intent lists five. Reading `client.ts` turned up a sixth, with the same shape:

| # | Decision | Today | Default bucket |
|---|---|---|---|
| 1 | 5-minute cooldown (SPEC §9.4) | `fc === 'serviceUnavailable' \|\| fc === 'timeout'` (`cooldown.ts:49`) | no cooldown |
| 2 | error snapshot kind | `fc === 'authInvalid' ? 'invalid' : 'unknown'` (`main.ts:228`) | `'unknown'` |
| 3 | statusline exit code (SPEC §11.5) | `fc === 'authInvalid' ? 2 : 1` (`main.ts:234`) | `1` |
| 4 | "auth invalid" display + exit 2 | `if (fc === 'authInvalid')` (`main.ts:324`) | generic failure |
| 5 | VS Code auth handling | `if (result.failureClass === 'authInvalid')` (`extension.ts:217`) | generic error |
| 6 | telemetry `statusClass` | `fc === 'timeout' ? 'timeout' : 'network'` (`client.ts:114`) | `'network'` |

Six is the number to hold onto: five of them collapse to "is this authInvalid", and four of
those five live in surfaces, which `CLAUDE.md`'s first architecture rule says they should not.

## Behavior

### One policy, resolved exhaustively

```ts
export interface FailurePolicy {
  /** Enters the 5-minute backoff. SPEC §9.4. */
  cooldown: boolean;
  /** Which error snapshot the surfaces render. SPEC §7.2. */
  presentation: 'authExpired' | 'genericFailure';
  /** Statusline exit code. SPEC §11.5. */
  exitCode: 1 | 2;
}

export function failurePolicy(fc: FailureClass): FailurePolicy { /* switch */ }
```

The mapping is exactly today's behaviour, member by member:

| member | cooldown | presentation | exitCode |
|---|---|---|---|
| `notConfigured` | false | genericFailure | 1 |
| `authInvalid` | **false** | **authExpired** | **2** |
| `serviceUnavailable` | **true** | genericFailure | 1 |
| `timeout` | **true** | genericFailure | 1 |
| `malformedResponse` | false | genericFailure | 1 |
| `unexpectedFailure` | false | genericFailure | 1 |

**Why three fields when two are perfectly correlated today.** `presentation` and `exitCode`
agree on all six members, so a single `requiresReauth` boolean would carry the same information
and could not drift. They stay separate because `SPEC.md` specifies them independently — §11.5
defines exit codes as a contract, §7.2 defines the states — and a future member could legitimately
want a generic presentation with exit 2, or the reverse. Collapsing them would encode today's
coincidence as tomorrow's constraint, and the whole point of this change is to make the next
author state each decision rather than inherit one.

`cooldown` is genuinely independent already: `timeout` and `serviceUnavailable` cool down while
presenting generically.

### Two compile-time guards, not one

**1. The `never` fallback.** After the switch:

```ts
const unhandled: never = fc;
throw new Error(`unhandled FailureClass: ${String(unhandled)}`);
```

A missing case makes the assignment a type error naming the member. The `throw` — rather than a
default return — means a value that reaches here at *runtime*, past a cast or from unvalidated
data, fails loudly instead of quietly receiving the old default bucket. That is testable, which
the type error is not.

**2. A member list the compiler keeps in sync.**

```ts
export const FAILURE_CLASSES = [...] as const;
type _AllCovered = Exclude<FailureClass, typeof FAILURE_CLASSES[number]>;
const _exhaustive: _AllCovered[] = [];   // errors if the union gained a member the array lacks
```

This exists so tests can iterate every member and assert its policy. Without it, a test loop
over a hand-written array silently stops covering the new member — the same class of defect this
loop is fixing, one level up.

### Consumers become thin

`shouldCooldown` keeps its signature and delegates, so its many call sites and tests are
untouched. `main.ts` and `extension.ts` read `failurePolicy(...)` instead of comparing strings.
`statusClassOf` (#6) keeps its own shape — it is keyed on `status === null` first and answers a
telemetry question, not a policy one — but gains the same `never` treatment for the status-less
branch, since a new status-less member silently becoming `'network'` is the identical defect.

## Data and types

- New in `packages/core/src/types.ts`: `FailurePolicy`, `FAILURE_CLASSES`.
- New in `packages/core/src/cooldown.ts`: `failurePolicy`. It lives beside `shouldCooldown`,
  which becomes its first caller.
- `FailureClass` itself is **unchanged**. No member added, none removed, no rename.
- No cache format change; `lastErrorClass` still stores the same six strings, so
  `CACHE_VERSION` is untouched and persisted envelopes stay valid.

## Edge cases

| Case | Expected behavior |
|---|---|
| A value outside the union reaches `failurePolicy` (cast, or parsed data) | Throws, naming the value. Never returns a default policy. |
| A member is added to `FailureClass` but not to the switch | `tsc --noEmit` fails at the `never` assignment, naming the member. |
| A member is added to the switch but not to `FAILURE_CLASSES` | `tsc --noEmit` fails at `_exhaustive`. |
| `shouldCooldown` called with each of the six | Identical to today, asserted member by member. |
| A status-less failure class other than `timeout` is added | `statusClassOf`'s `never` fails the build rather than defaulting to `'network'`. |

## Backward compatibility

Nothing observable changes. Every current member maps to exactly what it does today, and the
table above is asserted case by case rather than asserted in aggregate. `shouldCooldown` keeps
its signature so no call site or existing test changes.

The one visible difference is a *new* failure mode: a value outside the union now throws instead
of receiving the default bucket. That can only be reached by a cast or by unvalidated data —
both of which are already contract violations — and failing loudly is the behaviour this repo
chose everywhere else at a trust boundary.

## Acceptance criteria

- [ ] Adding a seventh member fails `bun run typecheck`, and **the actual error output is pasted
      in `review.md`** — performed, not reasoned about
- [ ] Removing any single `case` fails `bun run typecheck` — spot-checked and recorded
- [ ] All six members' policies asserted individually, iterating `FAILURE_CLASSES`
- [ ] `shouldCooldown` returns exactly what it returns today for all six — the `sdlc/010`
      regression guard still passes unmodified
- [ ] A value outside the union throws rather than returning a policy — tested
- [ ] `main.ts` and `extension.ts` contain no `=== 'authInvalid'` comparison
- [ ] `statusClassOf`'s status-less branch is exhaustive — verified by mutation
- [ ] `bun run verify` exits 0

## Rejected alternatives

- **A single `requiresReauth` boolean.** Smaller, cannot drift — and encodes today's coincidence
  that presentation and exit code agree. See above.
- **Separate exhaustive functions per decision.** Each reads more naturally at its call site, but
  a new member then forces three separate edits in three files, and missing one is exactly the
  failure mode being fixed. One switch makes the decision set atomic.
- **A `Record<FailureClass, FailurePolicy>` lookup table.** Also exhaustive, and arguably
  cleaner. Rejected because a `Record` gives no place to put the runtime throw, and the
  status-less `statusClassOf` branch needs the `never` form anyway — one idiom is easier to
  follow than two.
- **Doing `RuntimeState` and `StaleReason` in the same change.** Same latent defect, same fix,
  and an unreviewable diff. Out of scope per the intent.

---

**Next stage:** Build — run `/sdlc-plan 014-exhaustive-failure-class`.
