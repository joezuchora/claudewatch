import type { UsageSnapshot, StaleReason, CacheEnvelope } from './types.js';
import type { LastErrorInfo } from './format.js';
import { isSurfaceableMessage } from './client.js';

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
    tier: 'unknown',
    fiveHour: { utilizationPct: null, resetsAt: null },
    sevenDay: { utilizationPct: null, resetsAt: null },
    sevenDayOpus: { utilizationPct: null, resetsAt: null },
    enterprise: null,
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
  // A STANDING SECOND GUARD, not the boundary. Since sdlc/030 the value has already been validated
  // in `readCacheResult`, where the file enters the process, so nothing free-form off disk reaches
  // this line any more. Kept because this function also accepts envelopes built in memory by
  // callers that never went through the reader, and because the day a fourth producer appears the
  // check is already here. Claiming it was the boundary — as this comment did until sdlc/031 —
  // overstated it in exactly the direction sdlc/014's review warned about.
  // (SPEC.md §12, sdlc/029 B3, sdlc/030 B1)
  const message = isSurfaceableMessage(envelope.lastErrorMessage) ? envelope.lastErrorMessage : null;
  return { httpStatus: envelope.lastHttpStatus, message };
}
