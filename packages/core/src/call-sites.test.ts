/**
 * Telemetry emission from the core call sites (sdlc/007).
 *
 * The property that matters most here is the DEFAULT: a surface that never calls
 * setTelemetryConfig must produce nothing. Core resolving its own consent would silently
 * void sdlc/006's VS Code gate one layer down.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import {
  setTelemetryConfig, getTelemetryConfig, getSpoolPath,
} from './telemetry.js';
import { readCacheResult, writeCache, makeCacheEnvelope, getCachePath } from './cache.js';
import { normalize } from './normalize.js';
import { fetchUsage } from './client.js';
import { mock } from 'bun:test';
import { makeTestSnapshot, setupTestCacheDir } from './test-helpers.js';

/**
 * The spool-event shape this file asserts on. Fields are declared as the assertions use them:
 * `kind` and `payload` always read, `ok`/`durationMs` read only on fetch_result, payload members
 * optional because they vary by kind. ONE FLAT INTERFACE, deliberately not a discriminated union —
 * a union would force narrowing at all 13 assertion sites for no gain in a test file whose fixtures
 * it constructs itself. (sdlc/028 B3)
 */
interface SpoolEvent {
  kind: string;
  ok: boolean;
  durationMs: number;
  payload: {
    outcome?: string;
    statusClass?: string;
    attempts?: number;
    category?: string;
    count?: number;
  };
}

const spoolLines = (): SpoolEvent[] => {
  if (!existsSync(getSpoolPath())) return [];
  return readFileSync(getSpoolPath(), 'utf-8').trim().split('\n')
    .filter(Boolean).map((l) => JSON.parse(l));
};
const kinds = () => spoolLines().map((e) => e.kind);

/**
 * sdlc/011: fast timings for the cases that would otherwise sit in a real setTimeout. The
 * assertions are untouched — a retry is still observed, and a timeout still classifies as one.
 * The 5xx durationMs test below deliberately does NOT use these; see the note there.
 */
const FAST = { retryDelayMs: 0 } as const;
const FAST_TIMEOUT = { timeoutMs: 40, retryDelayMs: 0 } as const;

describe('telemetry call sites', () => {
  let cleanup: () => void;
  beforeEach(() => {
    ({ cleanup } = setupTestCacheDir());
    setTelemetryConfig({ enabled: false });
  });
  afterEach(() => { setTelemetryConfig({ enabled: false }); cleanup(); });

  test('THE DEFAULT: with no setTelemetryConfig call, nothing is written', () => {
    // A fresh process starts disabled. A surface that forgets to opt in emits nothing.
    expect(getTelemetryConfig().enabled).toBe(false);
    readCacheResult();
    normalize({ five_hour: { utilization: 1, resets_at: 'nonsense' }, seven_day: null });
    expect(existsSync(getSpoolPath())).toBe(false);
  });

  test('a disabled config suppresses every kind, not just some', () => {
    setTelemetryConfig({ enabled: false });
    readCacheResult();
    normalize({ five_hour: { utilization: 1, resets_at: 'nonsense' }, seven_day: null });
    expect(existsSync(getSpoolPath())).toBe(false);
  });

  test('setTelemetryConfig coerces strictly — only true enables', () => {
    setTelemetryConfig({ enabled: 'yes' as unknown as boolean });
    expect(getTelemetryConfig().enabled).toBe(false);
  });

  describe('cache_event', () => {
    beforeEach(() => { setTelemetryConfig({ enabled: true }); });

    test('emits on a cold miss', () => {
      readCacheResult();
      expect(kinds()).toEqual(['cache_event']);
      expect(spoolLines()[0]!.payload.outcome).toBe('miss');
    });

    test('emits versionMismatch distinguishably — the loop 002 bump case', () => {
      writeFileSync(getCachePath(), JSON.stringify({
        version: 1, snapshot: makeTestSnapshot(), cooldownUntil: null, lastErrorClass: null,
      }));
      readCacheResult();
      expect(spoolLines()[0]!.payload.outcome).toBe('versionMismatch');
    });

    test('emits corruptJson and invalidShape', () => {
      writeFileSync(getCachePath(), '{ not json');
      readCacheResult();
      writeFileSync(getCachePath(), JSON.stringify({ version: 2, snapshot: { nope: 1 } }));
      readCacheResult();
      expect(spoolLines().map((e) => e.payload.outcome))
        .toEqual(['corruptJson', 'invalidShape']);
    });

    test('does NOT emit on a hit — one event per render is volume, not signal', () => {
      writeCache(makeCacheEnvelope(makeTestSnapshot()));
      expect(readCacheResult().reason).toBe('hit');
      expect(kinds()).toEqual([]);
    });
  });

  describe('schema_drift', () => {
    beforeEach(() => { setTelemetryConfig({ enabled: true }); });

    test('emits once per normalize with warnings, carrying a count not one event each', () => {
      normalize({
        five_hour: { utilization: 42, resets_at: 'not-a-timestamp' },
        seven_day: { utilization: 18, resets_at: 'also-not-a-timestamp' },
      });
      const drifts = spoolLines().filter((e) => e.kind === 'schema_drift');
      expect(drifts).toHaveLength(1);            // one drift, not two
      expect(drifts[0]!.payload.count).toBe(2);  // but both warnings counted
      expect(drifts[0]!.payload.category).toBe('timestamp');
    });

    test('does not emit when a response normalizes cleanly', () => {
      normalize({
        five_hour: { utilization: 42, resets_at: '2026-03-07T17:00:00Z' },
        seven_day: { utilization: 18, resets_at: '2026-03-14T07:00:00Z' },
      });
      expect(kinds().filter((k) => k === 'schema_drift')).toEqual([]);
    });

    test('does not emit for a response that fails to parse at all', () => {
      // That path is a failed fetch, already covered by fetch_result.
      normalize('not an object');
      expect(kinds().filter((k) => k === 'schema_drift')).toEqual([]);
    });
  });

  describe('fetch_result', () => {
    const originalFetch = globalThis.fetch;
    beforeEach(() => { setTelemetryConfig({ enabled: true }); });
    afterEach(() => { globalThis.fetch = originalFetch; });

    const mockFetch = (impl: (...a: unknown[]) => Promise<Response>) => {
      globalThis.fetch = mock(impl) as unknown as typeof fetch;
    };

    test('emits once on success with attempts=1', async () => {
      mockFetch(async () => new Response(JSON.stringify({
        five_hour: { utilization: 42, resets_at: '2026-03-07T17:00:00Z' }, seven_day: null,
      }), { status: 200 }));

      await fetchUsage('sk-ant-oat01-FAKE');
      const events = spoolLines().filter((e) => e.kind === 'fetch_result');
      expect(events).toHaveLength(1);
      expect(events[0]!.ok).toBe(true);
      expect(events[0]!.payload.statusClass).toBe('2xx');
      expect(events[0]!.payload.attempts).toBe(1);
    });

    test('a 401 emits 4xx once and is not retried', async () => {
      mockFetch(async () => new Response('nope', { status: 401 }));
      await fetchUsage('sk-ant-oat01-FAKE');
      const events = spoolLines().filter((e) => e.kind === 'fetch_result');
      expect(events).toHaveLength(1);
      expect(events[0]!.payload.statusClass).toBe('4xx');
      expect(events[0]!.payload.attempts).toBe(1);
    });

    test('a 5xx retries, and durationMs EXCLUDES the 2s retry sleep', async () => {
      // Deliberately NOT given FAST (sdlc/011). This test's whole subject is that the reported
      // duration omits the sleep; with a near-zero delay the assertion would pass no matter
      // what the code did. It pays the real 2s, and that is the point.
      mockFetch(async () => new Response('boom', { status: 503 }));
      const started = Date.now();
      await fetchUsage('sk-ant-oat01-FAKE');
      const wall = Date.now() - started;

      const events = spoolLines().filter((e) => e.kind === 'fetch_result');
      expect(events).toHaveLength(1);              // one per fetchUsage, not one per attempt
      expect(events[0]!.payload.attempts).toBe(2);
      expect(events[0]!.payload.statusClass).toBe('5xx');

      // Wall clock includes the 2000ms sleep; the reported duration must not, or a p95
      // silently carrying a fixed 2s is not a latency signal at all.
      expect(wall).toBeGreaterThan(1900);
      expect(events[0]!.durationMs).toBeLessThan(1000);
    });

    test('a network error reports the network class', async () => {
      mockFetch(async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:443'); });
      await fetchUsage('sk-ant-oat01-FAKE', FAST);
      const events = spoolLines().filter((e) => e.kind === 'fetch_result');
      expect(events[0]!.payload.statusClass).toBe('network');
      expect(events[0]!.ok).toBe(false);
      // The error message carries an IP. It must not appear anywhere in the payload.
      expect(JSON.stringify(events[0]!.payload)).not.toContain('10.0.0.1');
      expect(JSON.stringify(events[0]!.payload)).not.toContain('ECONNREFUSED');
    });
  });

  describe('timeout as a distinct failure class (sdlc/010)', () => {
    const originalFetch = globalThis.fetch;
    beforeEach(() => { setTelemetryConfig({ enabled: true }); });
    afterEach(() => { globalThis.fetch = originalFetch; });

    test('an aborted request reports timeout, not serviceUnavailable', async () => {
      // Honour the abort signal the client passes, as a real fetch would.
      globalThis.fetch = mock((_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener('abort', () =>
            rej(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })));
        })) as unknown as typeof fetch;

      const result = await fetchUsage('sk-ant-oat01-FAKE', FAST_TIMEOUT);
      expect(result.ok).toBe(false);
      // FetchResult is a discriminated union; the success variant has no failureClass.
      if (!result.ok) {
        expect(result.failureClass).toBe('timeout');
        expect(result.status).toBeNull();
      }
    });

    test('a plain network error still reports serviceUnavailable', async () => {
      globalThis.fetch = mock(async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.1:443');
      }) as unknown as typeof fetch;

      const result = await fetchUsage('sk-ant-oat01-FAKE', FAST);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failureClass).toBe('serviceUnavailable');
    });

    test('telemetry reports statusClass timeout, which was unreachable before', async () => {
      globalThis.fetch = mock((_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener('abort', () =>
            rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        })) as unknown as typeof fetch;

      await fetchUsage('sk-ant-oat01-FAKE', FAST_TIMEOUT);
      const events = spoolLines().filter((e) => e.kind === 'fetch_result');
      expect(events[0]!.payload.statusClass).toBe('timeout');
    });
  });
});
