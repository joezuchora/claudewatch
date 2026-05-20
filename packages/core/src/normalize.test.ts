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

  test('tags standard responses with tier=standard', () => {
    const raw = {
      five_hour: { utilization: 42, resets_at: '2026-03-07T17:00:00Z' },
      seven_day: { utilization: 18, resets_at: '2026-03-14T07:00:00Z' },
    };
    const snapshot = normalize(raw, FETCHED_AT);
    expect(snapshot.tier).toBe('standard');
    expect(snapshot.enterprise).toBeNull();
  });

  test('malformed responses tagged tier=unknown', () => {
    const snapshot = normalize(null, FETCHED_AT);
    expect(snapshot.tier).toBe('unknown');
    expect(snapshot.enterprise).toBeNull();
  });
});

describe('normalize: enterprise tier', () => {
  // Synthetic enterprise fixture modeled after observed /api/oauth/usage shape.
  // All time windows are null; extra_usage is the enterprise signal.
  const ENTERPRISE_RAW = {
    five_hour: null,
    seven_day: null,
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
    iguana_necktie: null,
    omelette_promotional: { utilization: 0, resets_at: null },
    extra_usage: {
      is_enabled: true,
      monthly_limit: 200000,
      used_credits: 291,
      utilization: 0.1455,
      currency: 'USD',
      disabled_reason: null,
    },
  };

  test('detects enterprise tier from extra_usage', () => {
    const snapshot = normalize(ENTERPRISE_RAW, FETCHED_AT);
    expect(snapshot.tier).toBe('enterprise');
    expect(snapshot.source.usageEndpoint).toBe('success');
    expect(snapshot.freshness.isStale).toBe(false);
  });

  test('populates enterprise usage fields', () => {
    const snapshot = normalize(ENTERPRISE_RAW, FETCHED_AT);
    expect(snapshot.enterprise).not.toBeNull();
    expect(snapshot.enterprise!.utilizationPct).toBe(0.1455);
    expect(snapshot.enterprise!.monthlyLimitCredits).toBe(200000);
    expect(snapshot.enterprise!.usedCredits).toBe(291);
    expect(snapshot.enterprise!.currency).toBe('USD');
    expect(snapshot.enterprise!.isEnabled).toBe(true);
    expect(snapshot.enterprise!.disabledReason).toBeNull();
  });

  test('primary display is enterprise with utilization, no reset time', () => {
    const snapshot = normalize(ENTERPRISE_RAW, FETCHED_AT);
    expect(snapshot.display.primaryWindow).toBe('enterprise');
    expect(snapshot.display.primaryUtilizationPct).toBe(0.1455);
    expect(snapshot.display.primaryResetsAt).toBeNull();
  });

  test('fiveHour and sevenDay remain null on enterprise', () => {
    const snapshot = normalize(ENTERPRISE_RAW, FETCHED_AT);
    expect(snapshot.fiveHour.utilizationPct).toBeNull();
    expect(snapshot.sevenDay.utilizationPct).toBeNull();
  });

  test('does NOT classify as enterprise when extra_usage is missing required fields', () => {
    const raw = {
      five_hour: { utilization: 42, resets_at: '2026-03-07T17:00:00Z' },
      seven_day: null,
      extra_usage: { is_enabled: true }, // missing monthly_limit, used_credits, utilization
    };
    const snapshot = normalize(raw, FETCHED_AT);
    // Should fall through to the standard path with the warning recorded
    expect(snapshot.tier).toBe('standard');
    expect(snapshot.enterprise).toBeNull();
    expect(snapshot.rawMetadata.normalizationWarnings.some(
      (w) => w.includes('extra_usage'),
    )).toBe(true);
  });

  test('does NOT classify as enterprise when extra_usage is null', () => {
    const raw = {
      five_hour: { utilization: 42, resets_at: '2026-03-07T17:00:00Z' },
      seven_day: null,
      extra_usage: null,
    };
    const snapshot = normalize(raw, FETCHED_AT);
    expect(snapshot.tier).toBe('standard');
    expect(snapshot.enterprise).toBeNull();
  });

  test('captures disabled_reason when extra usage is disabled', () => {
    const raw = {
      ...ENTERPRISE_RAW,
      extra_usage: {
        is_enabled: false,
        monthly_limit: 0,
        used_credits: 0,
        utilization: 0,
        currency: 'USD',
        disabled_reason: 'org_policy',
      },
    };
    const snapshot = normalize(raw, FETCHED_AT);
    expect(snapshot.tier).toBe('enterprise');
    expect(snapshot.enterprise!.isEnabled).toBe(false);
    expect(snapshot.enterprise!.disabledReason).toBe('org_policy');
  });

  test('defaults currency to USD when missing', () => {
    const raw = {
      ...ENTERPRISE_RAW,
      extra_usage: { ...ENTERPRISE_RAW.extra_usage, currency: undefined as unknown as string },
    };
    const snapshot = normalize(raw, FETCHED_AT);
    expect(snapshot.enterprise!.currency).toBe('USD');
  });

  test('sanitizes invalid currency text to USD', () => {
    const raw = {
      ...ENTERPRISE_RAW,
      extra_usage: {
        ...ENTERPRISE_RAW.extra_usage,
        currency: 'USD\u001b]52;c;ZXZpbA==\u0007',
      },
    };
    const snapshot = normalize(raw, FETCHED_AT);
    expect(snapshot.enterprise!.currency).toBe('USD');
    expect(snapshot.rawMetadata.normalizationWarnings.some(
      (w) => w.includes('extra_usage.currency invalid'),
    )).toBe(true);
  });

  test('does NOT classify as enterprise when utilization is out of range', () => {
    const raw = {
      ...ENTERPRISE_RAW,
      extra_usage: {
        ...ENTERPRISE_RAW.extra_usage,
        utilization: 200,
      },
    };
    const snapshot = normalize(raw, FETCHED_AT);
    expect(snapshot.tier).toBe('unknown');
    expect(snapshot.enterprise).toBeNull();
    expect(snapshot.rawMetadata.normalizationWarnings.some(
      (w) => w.includes('out-of-range'),
    )).toBe(true);
  });
});
