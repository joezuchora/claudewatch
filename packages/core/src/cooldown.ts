import type { CacheEnvelope, FailureClass } from './types.js';

const COOLDOWN_DURATION_MS = 300_000; // 5 minutes — endpoint rate-limits aggressively

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
 * Check whether a failure class should trigger cooldown.
 * Auth failures don't trigger cooldown — they won't resolve on their own.
 */
export function shouldCooldown(failureClass: FailureClass): boolean {
  return failureClass === 'serviceUnavailable';
}
