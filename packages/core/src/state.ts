import type { UsageSnapshot, RuntimeState } from './types.js';

/**
 * Classify a UsageSnapshot into a RuntimeState (SPEC.md §7.1).
 *
 * Classification rules:
 * - AuthInvalid:   authState is 'invalid'
 * - NotConfigured: authState is 'missing'
 * - Stale:         freshness.isStale with staleReason 'fetchFailed' or 'sourceUnavailable',
 *                  AND at least one valid window exists (last known good data)
 * - Degraded:      source succeeded but no valid windows, OR malformed response with partial data
 * - HardFailure:   stale with no valid windows, or unexpected state
 * - Healthy:       at least one valid window and data is fresh
 * - Initializing:  should not normally come from normalize(), but handled for completeness
 */
export function classify(snapshot: UsageSnapshot): RuntimeState {
  // Auth-related states take priority
  if (snapshot.authState === 'invalid') {
    return 'AuthInvalid';
  }

  if (snapshot.authState === 'missing') {
    return 'NotConfigured';
  }

  const hasValidWindow =
    snapshot.fiveHour.utilizationPct !== null ||
    snapshot.sevenDay.utilizationPct !== null;

  // Stale data — last refresh failed but we have previous good data
  if (snapshot.freshness.isStale) {
    if (hasValidWindow) {
      // Malformed response with partial data → Degraded
      if (snapshot.freshness.staleReason === 'malformedResponse') {
        return 'Degraded';
      }
      return 'Stale';
    }
    // Stale with no data at all
    if (snapshot.freshness.staleReason === 'malformedResponse') {
      return 'Degraded';
    }
    return 'HardFailure';
  }

  // Fresh data
  if (hasValidWindow) {
    return 'Healthy';
  }

  // Fresh response but no valid windows — endpoint returned empty/unknown shape
  return 'Degraded';
}
