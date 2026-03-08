import { describe, expect, test } from 'bun:test';
import { classify } from './state.js';
import { makeTestSnapshot as makeSnapshot } from './test-helpers.js';

describe('classify', () => {
  test('Healthy: fresh data with both valid windows', () => {
    const snapshot = makeSnapshot();
    expect(classify(snapshot)).toBe('Healthy');
  });

  test('Healthy: fresh data with only fiveHour window', () => {
    const snapshot = makeSnapshot({
      sevenDay: { utilizationPct: null, resetsAt: null },
      display: { primaryWindow: 'fiveHour', primaryUtilizationPct: 42, primaryResetsAt: '2026-03-07T17:00:00.000Z' },
    });
    expect(classify(snapshot)).toBe('Healthy');
  });

  test('Healthy: fresh data with only sevenDay window', () => {
    const snapshot = makeSnapshot({
      fiveHour: { utilizationPct: null, resetsAt: null },
      display: { primaryWindow: 'sevenDay', primaryUtilizationPct: 18, primaryResetsAt: '2026-03-14T07:00:00.000Z' },
    });
    expect(classify(snapshot)).toBe('Healthy');
  });

  test('AuthInvalid: authState is invalid', () => {
    const snapshot = makeSnapshot({ authState: 'invalid' });
    expect(classify(snapshot)).toBe('AuthInvalid');
  });

  test('AuthInvalid takes priority over other conditions', () => {
    const snapshot = makeSnapshot({
      authState: 'invalid',
      freshness: { isStale: true, staleReason: 'authInvalid' },
    });
    expect(classify(snapshot)).toBe('AuthInvalid');
  });

  test('NotConfigured: authState is missing', () => {
    const snapshot = makeSnapshot({ authState: 'missing' });
    expect(classify(snapshot)).toBe('NotConfigured');
  });

  test('Stale: fetch failed but has previous good data', () => {
    const snapshot = makeSnapshot({
      freshness: { isStale: true, staleReason: 'fetchFailed' },
    });
    expect(classify(snapshot)).toBe('Stale');
  });

  test('Stale: source unavailable but has previous good data', () => {
    const snapshot = makeSnapshot({
      freshness: { isStale: true, staleReason: 'sourceUnavailable' },
    });
    expect(classify(snapshot)).toBe('Stale');
  });

  test('Degraded: malformed response with valid windows', () => {
    const snapshot = makeSnapshot({
      freshness: { isStale: true, staleReason: 'malformedResponse' },
    });
    expect(classify(snapshot)).toBe('Degraded');
  });

  test('Degraded: malformed response with no valid windows', () => {
    const snapshot = makeSnapshot({
      fiveHour: { utilizationPct: null, resetsAt: null },
      sevenDay: { utilizationPct: null, resetsAt: null },
      display: { primaryWindow: 'unknown', primaryUtilizationPct: null, primaryResetsAt: null },
      freshness: { isStale: true, staleReason: 'malformedResponse' },
    });
    expect(classify(snapshot)).toBe('Degraded');
  });

  test('Degraded: fresh data but no valid windows', () => {
    const snapshot = makeSnapshot({
      fiveHour: { utilizationPct: null, resetsAt: null },
      sevenDay: { utilizationPct: null, resetsAt: null },
      display: { primaryWindow: 'unknown', primaryUtilizationPct: null, primaryResetsAt: null },
    });
    expect(classify(snapshot)).toBe('Degraded');
  });

  test('HardFailure: stale with fetchFailed and no valid windows', () => {
    const snapshot = makeSnapshot({
      fiveHour: { utilizationPct: null, resetsAt: null },
      sevenDay: { utilizationPct: null, resetsAt: null },
      display: { primaryWindow: 'unknown', primaryUtilizationPct: null, primaryResetsAt: null },
      freshness: { isStale: true, staleReason: 'fetchFailed' },
    });
    expect(classify(snapshot)).toBe('HardFailure');
  });

  test('HardFailure: stale with sourceUnavailable and no valid windows', () => {
    const snapshot = makeSnapshot({
      fiveHour: { utilizationPct: null, resetsAt: null },
      sevenDay: { utilizationPct: null, resetsAt: null },
      display: { primaryWindow: 'unknown', primaryUtilizationPct: null, primaryResetsAt: null },
      freshness: { isStale: true, staleReason: 'sourceUnavailable' },
    });
    expect(classify(snapshot)).toBe('HardFailure');
  });
});
