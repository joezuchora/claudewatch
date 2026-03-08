import { describe, expect, test } from 'bun:test';
import { markStale, makeErrorSnapshot, extractLastError } from './snapshot.js';
import { makeCacheEnvelope } from './cache.js';
import { makeTestSnapshot } from './test-helpers.js';

describe('markStale', () => {
  test('marks snapshot as stale with given reason', () => {
    const snapshot = makeTestSnapshot();
    const stale = markStale(snapshot, 'fetchFailed');
    expect(stale.freshness.isStale).toBe(true);
    expect(stale.freshness.staleReason).toBe('fetchFailed');
  });

  test('defaults to fetchFailed reason', () => {
    const snapshot = makeTestSnapshot();
    const stale = markStale(snapshot);
    expect(stale.freshness.staleReason).toBe('fetchFailed');
  });

  test('preserves other snapshot fields', () => {
    const snapshot = makeTestSnapshot();
    const stale = markStale(snapshot, 'authInvalid');
    expect(stale.fiveHour.utilizationPct).toBe(42);
    expect(stale.authState).toBe('valid');
    expect(stale.fetchedAt).toBe(snapshot.fetchedAt);
  });

  test('does not mutate original snapshot', () => {
    const snapshot = makeTestSnapshot();
    markStale(snapshot, 'fetchFailed');
    expect(snapshot.freshness.isStale).toBe(false);
  });
});

describe('makeErrorSnapshot', () => {
  test('missing: not stale, source unavailable', () => {
    const snap = makeErrorSnapshot('missing');
    expect(snap.authState).toBe('missing');
    expect(snap.freshness.isStale).toBe(false);
    expect(snap.freshness.staleReason).toBe('none');
    expect(snap.source.usageEndpoint).toBe('unavailable');
  });

  test('invalid: stale with authInvalid, source unavailable', () => {
    const snap = makeErrorSnapshot('invalid');
    expect(snap.authState).toBe('invalid');
    expect(snap.freshness.isStale).toBe(true);
    expect(snap.freshness.staleReason).toBe('authInvalid');
    expect(snap.source.usageEndpoint).toBe('unavailable');
  });

  test('unknown: stale with fetchFailed, source failed', () => {
    const snap = makeErrorSnapshot('unknown');
    expect(snap.authState).toBe('unknown');
    expect(snap.freshness.isStale).toBe(true);
    expect(snap.freshness.staleReason).toBe('fetchFailed');
    expect(snap.source.usageEndpoint).toBe('failed');
  });

  test('has null utilization windows', () => {
    const snap = makeErrorSnapshot('invalid');
    expect(snap.fiveHour.utilizationPct).toBeNull();
    expect(snap.sevenDay.utilizationPct).toBeNull();
    expect(snap.display.primaryUtilizationPct).toBeNull();
    expect(snap.display.primaryWindow).toBe('unknown');
  });

  test('has valid ISO fetchedAt', () => {
    const before = Date.now();
    const snap = makeErrorSnapshot('missing');
    const after = Date.now();
    const ts = new Date(snap.fetchedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe('extractLastError', () => {
  test('returns null when no error info stored', () => {
    const snapshot = makeTestSnapshot();
    const envelope = makeCacheEnvelope(snapshot);
    expect(extractLastError(envelope)).toBeNull();
  });

  test('returns null for null envelope', () => {
    expect(extractLastError(null)).toBeNull();
  });

  test('extracts httpStatus and message when present', () => {
    const snapshot = makeTestSnapshot();
    const envelope = makeCacheEnvelope(snapshot, null, 'serviceUnavailable', 429, 'Rate limited');
    const error = extractLastError(envelope);
    expect(error).not.toBeNull();
    expect(error!.httpStatus).toBe(429);
    expect(error!.message).toBe('Rate limited');
  });

  test('returns error info when only message is present', () => {
    const snapshot = makeTestSnapshot();
    const envelope = makeCacheEnvelope(snapshot, null, 'serviceUnavailable', null, 'Network timeout');
    const error = extractLastError(envelope);
    expect(error).not.toBeNull();
    expect(error!.httpStatus).toBeNull();
    expect(error!.message).toBe('Network timeout');
  });
});
