import { describe, expect, test } from 'bun:test';
import { normalize } from './normalize.js';

const FETCHED_AT = '2026-03-07T12:00:00.000Z';

describe('normalize', () => {
  test('normalizes a full valid response', () => {
    const raw = {
      five_hour: { utilization: 42, resets_at: '2026-03-07T17:00:00+00:00' },
      seven_day: { utilization: 18, resets_at: '2026-03-14T07:00:00+00:00' },
    };

    const snapshot = normalize(raw, FETCHED_AT);

    expect(snapshot.source.usageEndpoint).toBe('success');
    expect(snapshot.authState).toBe('valid');
    expect(snapshot.fiveHour.utilizationPct).toBe(42);
    expect(snapshot.sevenDay.utilizationPct).toBe(18);
    // Primary is the higher utilization
    expect(snapshot.display.primaryWindow).toBe('fiveHour');
    expect(snapshot.display.primaryUtilizationPct).toBe(42);
    expect(snapshot.freshness.isStale).toBe(false);
  });

  test('selects seven_day as primary when it has higher utilization', () => {
    const raw = {
      five_hour: { utilization: 10, resets_at: '2026-03-07T17:00:00Z' },
      seven_day: { utilization: 35, resets_at: '2026-03-14T07:00:00Z' },
    };

    const snapshot = normalize(raw, FETCHED_AT);
    expect(snapshot.display.primaryWindow).toBe('sevenDay');
    expect(snapshot.display.primaryUtilizationPct).toBe(35);
  });

  test('handles only five_hour window', () => {
    const raw = {
      five_hour: { utilization: 50, resets_at: '2026-03-07T17:00:00Z' },
      seven_day: null,
    };

    const snapshot = normalize(raw, FETCHED_AT);
    expect(snapshot.display.primaryWindow).toBe('fiveHour');
    expect(snapshot.sevenDay.utilizationPct).toBeNull();
  });

  test('handles only seven_day window', () => {
    const raw = {
      five_hour: null,
      seven_day: { utilization: 25, resets_at: '2026-03-14T07:00:00Z' },
    };

    const snapshot = normalize(raw, FETCHED_AT);
    expect(snapshot.display.primaryWindow).toBe('sevenDay');
    expect(snapshot.fiveHour.utilizationPct).toBeNull();
  });

  test('returns malformed when both windows are null', () => {
    const raw = { five_hour: null, seven_day: null };
    const snapshot = normalize(raw, FETCHED_AT);
    expect(snapshot.freshness.isStale).toBe(true);
    expect(snapshot.freshness.staleReason).toBe('malformedResponse');
    expect(snapshot.display.primaryWindow).toBe('unknown');
  });

  test('returns malformed for non-object input', () => {
    const snapshot = normalize('not an object', FETCHED_AT);
    expect(snapshot.freshness.staleReason).toBe('malformedResponse');
  });

  test('returns malformed for null input', () => {
    const snapshot = normalize(null, FETCHED_AT);
    expect(snapshot.freshness.staleReason).toBe('malformedResponse');
  });

  test('ignores unknown extra fields', () => {
    const raw = {
      five_hour: { utilization: 42, resets_at: '2026-03-07T17:00:00Z' },
      seven_day: { utilization: 18, resets_at: '2026-03-14T07:00:00Z' },
      iguana_necktie: null,
      seven_day_oauth_apps: null,
      some_future_field: { foo: 'bar' },
    };

    const snapshot = normalize(raw, FETCHED_AT);
    expect(snapshot.source.usageEndpoint).toBe('success');
    expect(snapshot.fiveHour.utilizationPct).toBe(42);
  });

  test('handles seven_day_opus present', () => {
    const raw = {
      five_hour: { utilization: 42, resets_at: '2026-03-07T17:00:00Z' },
      seven_day: { utilization: 18, resets_at: '2026-03-14T07:00:00Z' },
      seven_day_opus: { utilization: 0, resets_at: null },
    };

    const snapshot = normalize(raw, FETCHED_AT);
    expect(snapshot.source.usageEndpoint).toBe('success');
  });

  test('records warning for invalid resets_at timestamp', () => {
    const raw = {
      five_hour: { utilization: 42, resets_at: 'not-a-date' },
      seven_day: { utilization: 18, resets_at: '2026-03-14T07:00:00Z' },
    };

    const snapshot = normalize(raw, FETCHED_AT);
    expect(snapshot.rawMetadata.normalizationWarnings.length).toBeGreaterThan(0);
    expect(snapshot.fiveHour.resetsAt).toBeNull();
  });

  test('normalizes UTC timestamps to ISO format', () => {
    const raw = {
      five_hour: { utilization: 6, resets_at: '2025-11-04T04:59:59.943648+00:00' },
      seven_day: { utilization: 35, resets_at: '2025-11-06T03:59:59.943679+00:00' },
    };

    const snapshot = normalize(raw, FETCHED_AT);
    // Should be valid ISO strings ending in Z
    expect(snapshot.fiveHour.resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(snapshot.sevenDay.resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
