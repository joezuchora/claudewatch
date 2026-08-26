import { describe, expect, test, mock, afterEach } from 'bun:test';
import {
  fetchUsage,
  resolveFetchTiming,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_MAX_RETRIES,
} from './client.js';

// Save original fetch
const originalFetch = globalThis.fetch;

/** Helper to mock globalThis.fetch with correct typing */
function mockFetch(impl: (...args: unknown[]) => Promise<Response>): void {
  globalThis.fetch = mock(impl) as unknown as typeof fetch;
}

/** A mock that honours the abort signal the client passes, as a real fetch would. */
function mockNeverSettles(): void {
  globalThis.fetch = mock((_url: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () =>
        rej(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })));
    })) as unknown as typeof fetch;
}

/**
 * sdlc/011: a retrying test used to pay the production 2s sleep. Overriding the delay changes
 * only how long the test waits — every assertion below is exactly what it was before.
 */
const FAST = { retryDelayMs: 0 } as const;

describe('client', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns success on 200 with valid data', async () => {
    const mockData = {
      five_hour: { utilization: 42, resets_at: '2026-03-07T17:00:00Z' },
      seven_day: { utilization: 18, resets_at: '2026-03-14T07:00:00Z' },
    };

    mockFetch(async () => new Response(JSON.stringify(mockData), { status: 200 }));

    const result = await fetchUsage('test-token');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(200);
      expect(result.data).toEqual(mockData);
    }
  });

  test('returns authInvalid on 401', async () => {
    mockFetch(async () => new Response('Unauthorized', { status: 401 }));

    const result = await fetchUsage('bad-token');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureClass).toBe('authInvalid');
      expect(result.status).toBe(401);
    }
  });

  test('returns serviceUnavailable on 429', async () => {
    mockFetch(async () => new Response('Too Many Requests', { status: 429 }));

    const result = await fetchUsage('test-token');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureClass).toBe('serviceUnavailable');
    }
  });

  test('returns serviceUnavailable on 500', async () => {
    mockFetch(async () => new Response('Server Error', { status: 500 }));

    const result = await fetchUsage('test-token', FAST);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureClass).toBe('serviceUnavailable');
    }
  });

  test('returns serviceUnavailable on network error', async () => {
    mockFetch(async () => { throw new Error('DNS resolution failed'); });

    const result = await fetchUsage('test-token', FAST);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureClass).toBe('serviceUnavailable');
      expect(result.message).toContain('DNS resolution failed');
    }
  });

  test('does not retry 401 errors', async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      return new Response('Unauthorized', { status: 401 });
    });

    await fetchUsage('bad-token');
    expect(callCount).toBe(1);
  });

  test('sends correct headers', async () => {
    let capturedHeaders: Headers | null = null;
    mockFetch(async (_url: unknown, init?: unknown) => {
      capturedHeaders = new Headers((init as RequestInit)?.headers);
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await fetchUsage('my-token');
    expect(capturedHeaders!.get('Authorization')).toBe('Bearer my-token');
    expect(capturedHeaders!.get('anthropic-beta')).toBe('oauth-2025-04-20');
    expect(capturedHeaders!.get('Content-Type')).toBe('application/json');
  });
});

describe('resolveFetchTiming (sdlc/011)', () => {
  const DEFAULTS = {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    retryDelayMs: DEFAULT_RETRY_DELAY_MS,
    maxRetries: DEFAULT_MAX_RETRIES,
  };

  test('the production defaults are still the production defaults', () => {
    // spec.md's rejected alternative was "shorten the constants" — make the gate fast by making
    // the product worse. This is what stops that happening quietly later.
    expect(DEFAULT_TIMEOUT_MS).toBe(5000);
    expect(DEFAULT_RETRY_DELAY_MS).toBe(2000);
    expect(DEFAULT_MAX_RETRIES).toBe(1);
  });

  test('no options resolves to the production defaults', () => {
    expect(resolveFetchTiming()).toEqual(DEFAULTS);
    expect(resolveFetchTiming({})).toEqual(DEFAULTS);
  });

  test('tighter values are honoured', () => {
    expect(resolveFetchTiming({ timeoutMs: 40, retryDelayMs: 25, maxRetries: 0 })).toEqual({
      timeoutMs: 40, retryDelayMs: 25, maxRetries: 0,
    });
  });

  test('retryDelayMs 0 is honoured, unlike a zero timeout', () => {
    expect(resolveFetchTiming({ retryDelayMs: 0 }).retryDelayMs).toBe(0);
    expect(resolveFetchTiming({ timeoutMs: 0 }).timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveFetchTiming({ timeoutMs: -1 }).timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  test('looser values are clamped — the defaults are ceilings, not suggestions', () => {
    // Raised by the security pass: an unbounded timeoutMs holds a credential-bearing request
    // open past the hard kill SPEC §3.1 and §11.7 state, and an unbounded maxRetries turns the loop into a
    // flood of authenticated requests. Nothing legitimate asks for either.
    expect(resolveFetchTiming({ timeoutMs: 600_000 }).timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveFetchTiming({ retryDelayMs: 600_000 }).retryDelayMs).toBe(DEFAULT_RETRY_DELAY_MS);
    expect(resolveFetchTiming({ maxRetries: 1e9 }).maxRetries).toBe(DEFAULT_MAX_RETRIES);
  });

  test('non-finite input falls back instead of becoming a 0ms timer', () => {
    // setTimeout coerces NaN to 0, so an unguarded NaN aborts every request on the next tick.
    expect(resolveFetchTiming({ timeoutMs: Number.NaN })).toEqual(DEFAULTS);
    expect(resolveFetchTiming({ retryDelayMs: Number.NaN })).toEqual(DEFAULTS);
    expect(resolveFetchTiming({ maxRetries: Number.NaN })).toEqual(DEFAULTS);
    expect(resolveFetchTiming({ timeoutMs: Number.POSITIVE_INFINITY })).toEqual(DEFAULTS);
  });

  test('non-numeric input falls back, even though the types forbid it', () => {
    // The fields are typed `number | undefined`, but the guards take `unknown` on purpose: a
    // plain-JS caller or an `as` cast must not be able to smuggle a string into a timer.
    const smuggled = { timeoutMs: 'soon', retryDelayMs: null, maxRetries: [] };
    expect(resolveFetchTiming(smuggled as unknown as Parameters<typeof resolveFetchTiming>[0]))
      .toEqual(DEFAULTS);
  });
});

describe('client: the resolved timings are actually used (sdlc/011)', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('retryDelayMs override is honoured and the retry still happens', async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      return new Response('Server Error', { status: 500 });
    });

    const started = Date.now();
    const result = await fetchUsage('test-token', { retryDelayMs: 25 });
    const wall = Date.now() - started;

    // The contract is unchanged: still two attempts, still serviceUnavailable.
    expect(callCount).toBe(2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failureClass).toBe('serviceUnavailable');
    // Only the waiting changed. Bounded well under the 2s default rather than just under it,
    // so a delay that resolved to, say, 500ms would still fail this.
    expect(wall).toBeLessThan(1000);
  });

  test('timeoutMs override is honoured and still produces failureClass timeout', async () => {
    mockNeverSettles();

    const started = Date.now();
    const result = await fetchUsage('test-token', { timeoutMs: 40, retryDelayMs: 0 });
    const wall = Date.now() - started;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureClass).toBe('timeout');
      expect(result.status).toBeNull();
    }
    // Two attempts at 40ms, so ~80ms. Bounded at 1s: far under the 5s default, far over
    // anything a loaded CI runner will add to an operation with no real I/O in it.
    expect(wall).toBeLessThan(1000);
  });

  test('maxRetries 0 means a single attempt', async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      return new Response('Server Error', { status: 500 });
    });

    await fetchUsage('test-token', { maxRetries: 0 });
    expect(callCount).toBe(1);
  });
});
