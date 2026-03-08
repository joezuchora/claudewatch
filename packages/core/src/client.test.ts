import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { fetchUsage } from './client.js';

// Save original fetch
const originalFetch = globalThis.fetch;

describe('client', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns success on 200 with valid data', async () => {
    const mockData = {
      five_hour: { utilization: 42, resets_at: '2026-03-07T17:00:00Z' },
      seven_day: { utilization: 18, resets_at: '2026-03-14T07:00:00Z' },
    };

    globalThis.fetch = mock(async () => new Response(JSON.stringify(mockData), { status: 200 }));

    const result = await fetchUsage('test-token');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(200);
      expect(result.data).toEqual(mockData);
    }
  });

  test('returns authInvalid on 401', async () => {
    globalThis.fetch = mock(async () => new Response('Unauthorized', { status: 401 }));

    const result = await fetchUsage('bad-token');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureClass).toBe('authInvalid');
      expect(result.status).toBe(401);
    }
  });

  test('returns serviceUnavailable on 429', async () => {
    globalThis.fetch = mock(async () => new Response('Too Many Requests', { status: 429 }));

    const result = await fetchUsage('test-token');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureClass).toBe('serviceUnavailable');
    }
  });

  test('returns serviceUnavailable on 500', async () => {
    globalThis.fetch = mock(async () => new Response('Server Error', { status: 500 }));

    const result = await fetchUsage('test-token');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureClass).toBe('serviceUnavailable');
    }
  });

  test('returns serviceUnavailable on network error', async () => {
    globalThis.fetch = mock(async () => { throw new Error('DNS resolution failed'); });

    const result = await fetchUsage('test-token');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureClass).toBe('serviceUnavailable');
      expect(result.message).toContain('DNS resolution failed');
    }
  });

  test('does not retry 401 errors', async () => {
    let callCount = 0;
    globalThis.fetch = mock(async () => {
      callCount++;
      return new Response('Unauthorized', { status: 401 });
    });

    await fetchUsage('bad-token');
    expect(callCount).toBe(1);
  });

  test('sends correct headers', async () => {
    let capturedHeaders: Headers | null = null;
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await fetchUsage('my-token');
    expect(capturedHeaders!.get('Authorization')).toBe('Bearer my-token');
    expect(capturedHeaders!.get('anthropic-beta')).toBe('oauth-2025-04-20');
    expect(capturedHeaders!.get('Content-Type')).toBe('application/json');
  });
});
