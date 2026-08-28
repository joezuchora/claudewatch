import type { CacheEnvelope, FailureClass } from './types.js';

/** 5 minutes — endpoint rate-limits aggressively. SPEC.md §9.4. */
export const COOLDOWN_DURATION_MS = 300_000;

/**
 * Check whether the cooldown period is still active.
 */
export function isInCooldown(envelope: CacheEnvelope): boolean {
  if (envelope.cooldownUntil === null) return false;
  const until = new Date(envelope.cooldownUntil).getTime();
  return Date.now() < until;
}

/**
 * Enter cooldown: returns a new envelope with cooldownUntil set 5 minutes from now,
 * preserving the existing snapshot as stale.
 */
export function enterCooldown(
  envelope: CacheEnvelope,
  failureClass: FailureClass,
  httpStatus: number | null = null,
  errorMessage: string | null = null,
): CacheEnvelope {
  return {
    ...envelope,
    cooldownUntil: new Date(Date.now() + COOLDOWN_DURATION_MS).toISOString(),
    lastErrorClass: failureClass,
    lastHttpStatus: httpStatus,
    lastErrorMessage: errorMessage,
  };
}

/**
 * Clear cooldown state from an envelope (e.g. after a successful refresh).
 */
export function clearCooldown(envelope: CacheEnvelope): CacheEnvelope {
  return {
    ...envelope,
    cooldownUntil: null,
    lastErrorClass: null,
    lastHttpStatus: null,
    lastErrorMessage: null,
  };
}

/**
 * Every `FailureClass` member, kept in sync with the union in BOTH directions.
 *
 * `satisfies` catches a string here that is not in the union, while preserving the literal type
 * that `typeof FAILURE_CLASSES[number]` needs. The `never` assignment below catches a union
 * member this array lacks.
 *
 * Both forms were run against `tsc --strict` before being written: an earlier draft of this
 * used `const _x: Exclude<...>[] = []`, which compiles clean with a member missing, because an
 * empty array literal is assignable to every array type including `never[]`. A guard that
 * compiles is not a guard that works. (sdlc/014)
 */
export const FAILURE_CLASSES = [
  'notConfigured',
  'authInvalid',
  'serviceUnavailable',
  'timeout',
  'malformedResponse',
  'unexpectedFailure',
] as const satisfies readonly FailureClass[];

const _allCovered: never = null as unknown as Exclude<
  FailureClass,
  (typeof FAILURE_CLASSES)[number]
>;
void _allCovered;

/**
 * Everything the product decides from a `FailureClass`, resolved in one place.
 *
 * One switch rather than four functions, so adding a member forces every decision to be made
 * at once. Before this, each decision was an equality check against a subset with an implicit
 * default, so a new member silently joined every default bucket while `tsc` stayed green —
 * which `sdlc/010` nearly shipped when it added `'timeout'`.
 */
export interface FailurePolicy {
  /** Enters the 5-minute backoff. SPEC.md §9.4. */
  cooldown: boolean;
  /**
   * Whether a retry is worth attempting. SPEC.md §9.3.
   *
   * NOT the whole rule: 429 maps to `serviceUnavailable` and is not retried, while 5xx maps to
   * the same class and is. `client.ts` therefore keeps its status check beside this flag.
   */
  retryable: boolean;
  /** Exactly `makeErrorSnapshot`'s parameter, so no call site re-derives it. SPEC.md §7.2. */
  presentation: 'invalid' | 'missing' | 'unknown';
  /**
   * SPEC.md §11.5. Applies ONLY on the two statusline paths that derive from a `FailureClass`.
   * A renderable stale cache exits 0 regardless, and the credential-resolution and top-level
   * catch exits are not keyed on this at all.
   */
  statuslineExitCode: 1 | 2 | 3;
}

export function failurePolicy(fc: FailureClass): FailurePolicy {
  switch (fc) {
    // Never constructed as a FailureClass today, so this row is a CHOICE, not preserved
    // behaviour. Exit 2 per SPEC.md §11.5: "Configuration error — credentials missing or
    // unreadable", which is this member's definition. The old default bucket said 1.
    case 'notConfigured':
      return { cooldown: false, retryable: false, presentation: 'missing', statuslineExitCode: 2 };

    case 'authInvalid':
      return { cooldown: false, retryable: false, presentation: 'invalid', statuslineExitCode: 2 };

    // Both cool down, deliberately. sdlc/010 split 'timeout' out of 'serviceUnavailable';
    // leaving that decision as an equality check would have silently stopped timeouts entering
    // the 5-minute cooldown (SPEC.md §9.4) — the backoff that exists mainly FOR a slow
    // endpoint. A behaviour regression wearing a type change's clothes.
    case 'serviceUnavailable':
    case 'timeout':
      return { cooldown: true, retryable: true, presentation: 'unknown', statuslineExitCode: 1 };

    // `malformedResponse` COOLS DOWN, and this row exists because sdlc/029 nearly removed that.
    //
    // Before sdlc/029 nothing constructed the class, so it sat in the no-cooldown bucket harmlessly
    // and this comment said "neither row changes behaviour" — true then. Then B1b made a 200 with a
    // non-JSON body construct it, moving that path OFF `serviceUnavailable` and silently off the
    // 5-minute cooldown with it. Measured: 2 authenticated requests per prompt render, unbounded,
    // instead of 2 per 5 minutes — and on the no-cache branch (main.ts:318) no cooldown envelope is
    // written at all, so every invocation refetches. That is exactly the rate-limit amplification
    // SPEC.md §9.4 exists to prevent, and cache.ts:139 calls the cooldown the only throttle on
    // token-bearing requests. Found by the sdlc/029 security pass; the comment above had gone
    // stale in the same commit that made it stale.
    //
    // A malformed body is a server-side condition that will not resolve within seconds, so it
    // belongs with `serviceUnavailable`, not with the no-cooldown bucket.
    case 'malformedResponse':
      return { cooldown: true, retryable: true, presentation: 'unknown', statuslineExitCode: 1 };

    // `unexpectedFailure` IS constructed — client.ts returns it for any status that is not
    // 200/401/429/5xx. It keeps the no-cooldown bucket it has always had.
    case 'unexpectedFailure':
      return { cooldown: false, retryable: true, presentation: 'unknown', statuslineExitCode: 1 };
  }

  // Unreachable for a well-typed caller: a missing case is a compile error naming the member.
  // A throw rather than a default return, so a value arriving past a cast or from unvalidated
  // data fails loudly instead of quietly receiving the old default bucket.
  const unhandled: never = fc;
  throw new Error(`unhandled FailureClass: ${String(unhandled)}`);
}

/**
 * Check whether a failure class should trigger cooldown.
 * Auth failures don't trigger cooldown — they won't resolve on their own.
 */
export function shouldCooldown(failureClass: FailureClass): boolean {
  return failurePolicy(failureClass).cooldown;
}

/**
 * Whether an unvalidated value is a `FailureClass`.
 *
 * Exists for one caller: `readCacheResult`, which reads `lastErrorClass` off disk past a
 * `JSON.parse(...) as CacheEnvelope` assertion.
 *
 * It is defence in depth, not a hole being closed. No consumer passes `lastErrorClass` to
 * `failurePolicy` today; it is copied into new envelopes and printed by `--debug`, nothing
 * more. An earlier version of this comment claimed the check made `failurePolicy`'s `throw`
 * unreachable in practice — the review of sdlc/014 established that the path it describes does
 * not exist. Checked anyway, so the guard is already there the day someone branches on it.
 */
export function isFailureClass(value: unknown): value is FailureClass {
  return typeof value === 'string' && (FAILURE_CLASSES as readonly string[]).includes(value);
}
