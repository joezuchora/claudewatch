/**
 * Contract tests (SPEC §15.2)
 *
 * Tests the full normalize → classify → evaluate pipeline against
 * mocked API responses for all documented scenarios.
 */
import { describe, expect, test, mock, afterEach } from 'bun:test';
import { normalize } from './normalize.js';
import { classify } from './state.js';
import { evaluate } from './thresholds.js';
import { fetchUsage } from './client.js';

const FETCHED_AT = '2026-03-07T12:00:00.000Z';

// Save original fetch
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Helper to mock globalThis.fetch with correct typing */
function mockFetch(impl: (...args: unknown[]) => Promise<Response>): void {
  globalThis.fetch = mock(impl) as unknown as typeof fetch;
}

describe('contract: successful response with both windows', () => {
  const raw = {
    five_hour: { utilization: 42, resets_at: '2026-03-07T17:00:00+00:00' },
    seven_day: { utilization: 18, resets_at: '2026-03-14T07:00:00+00:00' },
  };

  test('normalizes to valid snapshot', () => {
    const snapshot = normalize(raw, FETCHED_AT);
    expect(snapshot.source.usageEndpoint).toBe('success');
    expect(snapshot.authState).toBe('valid');
    expect(snapshot.fiveHour.utilizationPct).toBe(42);
    expect(snapshot.sevenDay.utilizationPct).toBe(18);
    expect(snapshot.freshness.isStale).toBe(false);
  });

  test('classifies as Healthy', () => {
    const snapshot = normalize(raw, FETCHED_AT);
    expect(classify(snapshot)).toBe('Healthy');
  });

  test('evaluates threshold correctly', () => {
    const snapshot = normalize(raw, FETCHED_AT);
    expect(evaluate(snapshot.display.primaryUtilizationPct!)).toBe('normal');
  });

  test('selects higher utilization as primary', () => {
    const snapshot = normalize(raw, FETCHED_AT);
    expect(snapshot.display.primaryWindow).toBe('fiveHour');
    expect(snapshot.display.primaryUtilizationPct).toBe(42);
    expect(snapshot.display.primaryResetsAt).not.toBeNull();
  });
});

describe('contract: successful response with only one window', () => {
  test('only five_hour', () => {
    const raw = {
      five_hour: { utilization: 60, resets_at: '2026-03-07T17:00:00Z' },
      seven_day: null,
    };
    const snapshot = normalize(raw, FETCHED_AT);
    expect(classify(snapshot)).toBe('Healthy');
    expect(snapshot.display.primaryWindow).toBe('fiveHour');
    expect(snapshot.display.primaryUtilizationPct).toBe(60);
    expect(snapshot.sevenDay.utilizationPct).toBeNull();
  });

  test('only seven_day', () => {
    const raw = {
      five_hour: null,
      seven_day: { utilization: 35, resets_at: '2026-03-14T07:00:00Z' },
    };
    const snapshot = normalize(raw, FETCHED_AT);
    expect(classify(snapshot)).toBe('Healthy');
    expect(snapshot.display.primaryWindow).toBe('sevenDay');
    expect(snapshot.display.primaryUtilizationPct).toBe(35);
    expect(snapshot.fiveHour.utilizationPct).toBeNull();
  });
});

describe('contract: response with seven_day_opus present', () => {
  test('ignores seven_day_opus, normalizes core windows', () => {
    const raw = {
      five_hour: { utilization: 6, resets_at: '2026-03-07T17:00:00Z' },
      seven_day: { utilization: 35, resets_at: '2026-03-14T07:00:00Z' },
      seven_day_opus: { utilization: 0, resets_at: null },
    };
    const snapshot = normalize(raw, FETCHED_AT);
    expect(classify(snapshot)).toBe('Healthy');
    expect(snapshot.fiveHour.utilizationPct).toBe(6);
    expect(snapshot.sevenDay.utilizationPct).toBe(35);
  });
});

describe('contract: response with unknown extra fields (forward compatibility)', () => {
  test('ignores unknown fields without error', () => {
    const raw = {
      five_hour: { utilization: 42, resets_at: '2026-03-07T17:00:00Z' },
      seven_day: { utilization: 18, resets_at: '2026-03-14T07:00:00Z' },
      iguana_necktie: null,
      seven_day_oauth_apps: null,
      brand_new_field: { some: 'data' },
      another_future_field: 123,
    };
    const snapshot = normalize(raw, FETCHED_AT);
    expect(classify(snapshot)).toBe('Healthy');
    expect(snapshot.rawMetadata.normalizationWarnings).toHaveLength(0);
  });
});

describe('contract: 401 response', () => {
  test('fetchUsage returns authInvalid', async () => {
    mockFetch(async () => new Response('Unauthorized', { status: 401 }));
    const result = await fetchUsage('bad-token');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureClass).toBe('authInvalid');
      expect(result.status).toBe(401);
    }
  });

  test('does not retry 401', async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      return new Response('Unauthorized', { status: 401 });
    });
    await fetchUsage('bad-token');
    expect(callCount).toBe(1);
  });
});

describe('contract: 429 response', () => {
  test('fetchUsage returns serviceUnavailable after retries', async () => {
    mockFetch(async () => new Response('Too Many Requests', { status: 429 }));
    const result = await fetchUsage('test-token');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureClass).toBe('serviceUnavailable');
      expect(result.status).toBe(429);
    }
  });

  test('does not retry 429 (preserves rate limit budget)', async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      return new Response('Too Many Requests', { status: 429 });
    });
    await fetchUsage('test-token');
    // 429 returns immediately, no retries
    expect(callCount).toBe(1);
  });
});

describe('contract: 5xx response', () => {
  test('500 returns serviceUnavailable', async () => {
    mockFetch(async () => new Response('Internal Server Error', { status: 500 }));
    const result = await fetchUsage('test-token');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureClass).toBe('serviceUnavailable');
    }
  });

  test('502 returns serviceUnavailable', async () => {
    mockFetch(async () => new Response('Bad Gateway', { status: 502 }));
    const result = await fetchUsage('test-token');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureClass).toBe('serviceUnavailable');
    }
  });

  test('503 returns serviceUnavailable', async () => {
    mockFetch(async () => new Response('Service Unavailable', { status: 503 }));
    const result = await fetchUsage('test-token');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureClass).toBe('serviceUnavailable');
    }
  });

  test('retries 5xx up to MAX_RETRIES', async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      return new Response('Server Error', { status: 500 });
    });
    await fetchUsage('test-token');
    // 1 initial + 1 retry = 2
    expect(callCount).toBe(2);
  });
});

describe('contract: malformed JSON response', () => {
  test('non-JSON response body causes network error on json()', async () => {
    mockFetch(async () => new Response('not json at all', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const result = await fetchUsage('test-token');
    // response.json() will throw on invalid JSON
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureClass).toBe('serviceUnavailable');
    }
  });

  test('empty object normalizes to malformed snapshot', () => {
    const snapshot = normalize({}, FETCHED_AT);
    expect(snapshot.freshness.isStale).toBe(true);
    expect(snapshot.freshness.staleReason).toBe('malformedResponse');
    expect(classify(snapshot)).toBe('Degraded');
  });

  test('array normalizes to malformed snapshot', () => {
    const snapshot = normalize([], FETCHED_AT);
    // Array is technically an object but has no required fields
    expect(snapshot.freshness.staleReason).toBe('malformedResponse');
  });

  test('number normalizes to malformed snapshot', () => {
    const snapshot = normalize(42, FETCHED_AT);
    expect(snapshot.freshness.staleReason).toBe('malformedResponse');
  });

  test('string normalizes to malformed snapshot', () => {
    const snapshot = normalize('hello', FETCHED_AT);
    expect(snapshot.freshness.staleReason).toBe('malformedResponse');
  });
});

describe('contract: valid JSON with missing required fields', () => {
  test('windows present but no utilization field', () => {
    const raw = {
      five_hour: { resets_at: '2026-03-07T17:00:00Z' },
      seven_day: { resets_at: '2026-03-14T07:00:00Z' },
    };
    const snapshot = normalize(raw, FETCHED_AT);
    // utilization is not a number → windows are null → malformed
    expect(snapshot.freshness.staleReason).toBe('malformedResponse');
    expect(snapshot.display.primaryWindow).toBe('unknown');
  });

  test('windows with non-numeric utilization', () => {
    const raw = {
      five_hour: { utilization: 'high', resets_at: '2026-03-07T17:00:00Z' },
      seven_day: { utilization: true, resets_at: '2026-03-14T07:00:00Z' },
    };
    const snapshot = normalize(raw, FETCHED_AT);
    expect(snapshot.freshness.staleReason).toBe('malformedResponse');
  });

  test('completely different schema', () => {
    const raw = {
      usage: { current: 42, limit: 100 },
      status: 'active',
    };
    const snapshot = normalize(raw, FETCHED_AT);
    expect(snapshot.freshness.staleReason).toBe('malformedResponse');
    expect(classify(snapshot)).toBe('Degraded');
  });
});

describe('contract: network timeout', () => {
  test('aborted fetch returns serviceUnavailable', async () => {
    mockFetch(async () => {
      // Simulate abort
      throw new DOMException('The operation was aborted', 'AbortError');
    });
    const result = await fetchUsage('test-token');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureClass).toBe('serviceUnavailable');
      expect(result.message).toContain('aborted');
    }
  });
});

describe('contract: DNS resolution failure', () => {
  test('DNS failure returns serviceUnavailable', async () => {
    mockFetch(async () => {
      throw new TypeError('fetch failed: DNS resolution failed');
    });
    const result = await fetchUsage('test-token');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureClass).toBe('serviceUnavailable');
      expect(result.message).toContain('DNS');
    }
  });
});

describe('contract: unexpected HTTP status codes', () => {
  test('403 returns unexpectedFailure', async () => {
    mockFetch(async () => new Response('Forbidden', { status: 403 }));
    const result = await fetchUsage('test-token');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureClass).toBe('unexpectedFailure');
      expect(result.status).toBe(403);
    }
  });

  test('404 returns unexpectedFailure', async () => {
    mockFetch(async () => new Response('Not Found', { status: 404 }));
    const result = await fetchUsage('test-token');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureClass).toBe('unexpectedFailure');
    }
  });
});

describe('contract: NaN and Infinity utilization rejected', () => {
  test('NaN utilization is treated as invalid window', () => {
    const raw = {
      five_hour: { utilization: NaN, resets_at: '2026-03-07T17:00:00Z' },
      seven_day: { utilization: 18, resets_at: '2026-03-14T07:00:00Z' },
    };
    const snapshot = normalize(raw, FETCHED_AT);
    expect(snapshot.fiveHour.utilizationPct).toBeNull();
    expect(snapshot.sevenDay.utilizationPct).toBe(18);
    expect(snapshot.display.primaryWindow).toBe('sevenDay');
  });

  test('Infinity utilization is treated as invalid window', () => {
    const raw = {
      five_hour: { utilization: Infinity, resets_at: '2026-03-07T17:00:00Z' },
      seven_day: { utilization: 18, resets_at: '2026-03-14T07:00:00Z' },
    };
    const snapshot = normalize(raw, FETCHED_AT);
    expect(snapshot.fiveHour.utilizationPct).toBeNull();
  });

  test('both windows NaN returns malformed', () => {
    const raw = {
      five_hour: { utilization: NaN, resets_at: '2026-03-07T17:00:00Z' },
      seven_day: { utilization: NaN, resets_at: '2026-03-14T07:00:00Z' },
    };
    const snapshot = normalize(raw, FETCHED_AT);
    expect(snapshot.freshness.staleReason).toBe('malformedResponse');
  });
});

describe('contract: edge case utilization values', () => {
  test('0% utilization is valid, not null', () => {
    const raw = {
      five_hour: { utilization: 0, resets_at: '2026-03-07T17:00:00Z' },
      seven_day: { utilization: 0, resets_at: '2026-03-14T07:00:00Z' },
    };
    const snapshot = normalize(raw, FETCHED_AT);
    expect(snapshot.fiveHour.utilizationPct).toBe(0);
    expect(snapshot.sevenDay.utilizationPct).toBe(0);
    expect(classify(snapshot)).toBe('Healthy');
  });

  test('100% utilization is valid', () => {
    const raw = {
      five_hour: { utilization: 100, resets_at: '2026-03-07T17:00:00Z' },
      seven_day: { utilization: 100, resets_at: '2026-03-14T07:00:00Z' },
    };
    const snapshot = normalize(raw, FETCHED_AT);
    expect(snapshot.display.primaryUtilizationPct).toBe(100);
    expect(evaluate(100)).toBe('critical');
  });

  test('fractional utilization is preserved', () => {
    const raw = {
      five_hour: { utilization: 42.7, resets_at: '2026-03-07T17:00:00Z' },
      seven_day: { utilization: 18.3, resets_at: '2026-03-14T07:00:00Z' },
    };
    const snapshot = normalize(raw, FETCHED_AT);
    expect(snapshot.fiveHour.utilizationPct).toBe(42.7);
    expect(snapshot.sevenDay.utilizationPct).toBe(18.3);
  });
});

describe('contract: high utilization threshold scenarios', () => {
  test('warning at 70%', () => {
    const raw = {
      five_hour: { utilization: 70, resets_at: '2026-03-07T17:00:00Z' },
      seven_day: { utilization: 30, resets_at: '2026-03-14T07:00:00Z' },
    };
    const snapshot = normalize(raw, FETCHED_AT);
    expect(evaluate(snapshot.display.primaryUtilizationPct!)).toBe('warning');
  });

  test('critical at 90%', () => {
    const raw = {
      five_hour: { utilization: 95, resets_at: '2026-03-07T17:00:00Z' },
      seven_day: { utilization: 50, resets_at: '2026-03-14T07:00:00Z' },
    };
    const snapshot = normalize(raw, FETCHED_AT);
    expect(evaluate(snapshot.display.primaryUtilizationPct!)).toBe('critical');
  });
});

describe('contract: retry behavior', () => {
  test('succeeds on second attempt after 5xx', async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response('Server Error', { status: 500 });
      }
      return new Response(JSON.stringify({
        five_hour: { utilization: 42, resets_at: '2026-03-07T17:00:00Z' },
        seven_day: { utilization: 18, resets_at: '2026-03-14T07:00:00Z' },
      }), { status: 200 });
    });
    const result = await fetchUsage('test-token');
    expect(result.ok).toBe(true);
    expect(callCount).toBe(2);
  });

  test('succeeds on second attempt after one 500', async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      if (callCount <= 1) {
        return new Response('Server Error', { status: 500 });
      }
      return new Response(JSON.stringify({
        five_hour: { utilization: 10, resets_at: '2026-03-07T17:00:00Z' },
        seven_day: { utilization: 5, resets_at: '2026-03-14T07:00:00Z' },
      }), { status: 200 });
    });
    const result = await fetchUsage('test-token');
    expect(result.ok).toBe(true);
    expect(callCount).toBe(2);
  });
});
