import type { UsageSnapshot, StaleReason, CacheEnvelope } from './types.js';
import type { LastErrorInfo } from './format.js';

/**
 * Return a copy of the snapshot with freshness marked as stale.
 */
export function markStale(
  snapshot: UsageSnapshot,
  reason: StaleReason = 'fetchFailed',
): UsageSnapshot {
  return {
    ...snapshot,
    freshness: { isStale: true, staleReason: reason },
  };
}

/**
 * Create a minimal error snapshot for a given auth/failure state.
 *
 * - 'missing'/'invalid' → source 'unavailable' (never attempted API call)
 * - 'unknown'/'valid'   → source 'failed' (API call attempted and failed)
 */
export function makeErrorSnapshot(
  authState: UsageSnapshot['authState'],
): UsageSnapshot {
  const source: UsageSnapshot['source']['usageEndpoint'] =
    authState === 'missing' || authState === 'invalid' ? 'unavailable' : 'failed';

  const staleReason: StaleReason =
    authState === 'invalid' ? 'authInvalid'
    : authState === 'missing' ? 'none'
    : 'fetchFailed';

  return {
    fetchedAt: new Date().toISOString(),
    source: { usageEndpoint: source },
    authState,
    fiveHour: { utilizationPct: null, resetsAt: null },
    sevenDay: { utilizationPct: null, resetsAt: null },
    display: { primaryWindow: 'unknown', primaryUtilizationPct: null, primaryResetsAt: null },
    freshness: {
      isStale: authState !== 'missing',
      staleReason,
    },
    rawMetadata: { normalizationWarnings: [] },
  };
}

/**
 * Extract last error info from a cache envelope, or null if no error is stored.
 */
export function extractLastError(envelope: CacheEnvelope | null): LastErrorInfo | null {
  if (!envelope?.lastHttpStatus && !envelope?.lastErrorMessage) return null;
  return { httpStatus: envelope.lastHttpStatus, message: envelope.lastErrorMessage };
}
