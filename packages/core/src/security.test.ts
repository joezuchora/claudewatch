/**
 * Security tests (SPEC §12, §15.4)
 *
 * Verifies non-functional security requirements:
 * - No token leakage to cache, logs, or debug output
 * - No token in error messages
 * - Cache file safety
 * - TLS not disabled
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync } from 'fs';
import { homedir } from 'os';
import {
  emit, getSpoolPath, fetchResultEvent, cacheEvent, renderEvent, schemaDriftEvent,
  categorizeWarning, utilizationBucket,
} from './telemetry.js';
import { readFileSync } from 'fs';
import { normalize } from './normalize.js';
import { makeCacheEnvelope, writeCache, getCachePath } from './cache.js';
import { makeTestSnapshot, setupTestCacheDir } from './test-helpers.js';

const TOKEN = 'sk-ant-oat01-FAKE-SECRET-TOKEN-1234567890';
let cleanup: () => void;

beforeEach(() => {
  ({ cleanup } = setupTestCacheDir());
});

afterEach(() => {
  cleanup();
});

describe('security: no token leakage', () => {
  test('cache file never contains access token strings', () => {
    const snapshot = makeTestSnapshot();
    const envelope = makeCacheEnvelope(snapshot);
    writeCache(envelope);

    const raw = readFileSync(getCachePath(), 'utf-8');
    expect(raw).not.toContain('sk-ant');
    expect(raw).not.toContain('accessToken');
    expect(raw).not.toContain('refreshToken');
    expect(raw).not.toContain('Bearer');
  });

  test('UsageSnapshot type does not include token fields', () => {
    const snapshot = makeTestSnapshot();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('accessToken');
    expect(serialized).not.toContain('refreshToken');
    expect(serialized).not.toContain('Bearer');
  });

  test('normalize output never includes raw token data even with injected fields', () => {
    // Simulate an API response that tries to sneak a token into a field
    const malicious = {
      five_hour: { utilization: 42, resets_at: '2026-03-07T17:00:00Z' },
      seven_day: { utilization: 18, resets_at: '2026-03-14T07:00:00Z' },
      accessToken: TOKEN,
      authorization: `Bearer ${TOKEN}`,
    };
    const snapshot = normalize(malicious);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain('Bearer');
  });
});

describe('security: client headers', () => {
  test('client.ts sends correct URL and headers', async () => {
    // Read source and verify the URL is hardcoded to HTTPS
    const clientSource = readFileSync(
      new URL('./client.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      'utf-8'
    );
    expect(clientSource).toContain("'https://api.anthropic.com/api/oauth/usage'");
    // No option to disable TLS
    expect(clientSource).not.toContain('rejectUnauthorized');
    expect(clientSource).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED');
    expect(clientSource).not.toContain('insecure');
  });
});

describe('security: cache file integrity', () => {
  test('cache envelope version prevents format confusion', () => {
    const snapshot = makeTestSnapshot();
    const envelope = makeCacheEnvelope(snapshot);
    expect(envelope.version).toBe(2);
  });

  test('cache write uses atomic rename pattern', () => {
    // Verify by reading the source that writeCache uses temp file + rename
    const cacheSource = readFileSync(
      new URL('./cache.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      'utf-8'
    );
    expect(cacheSource).toContain('renameSync');
    expect(cacheSource).toContain('.tmp');
  });

  test('cache directory created with restrictive permissions', () => {
    const cacheSource = readFileSync(
      new URL('./cache.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      'utf-8'
    );
    expect(cacheSource).toContain('0o700');
  });

  test('cache file written with restrictive permissions', () => {
    const cacheSource = readFileSync(
      new URL('./cache.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      'utf-8'
    );
    expect(cacheSource).toContain('0o600');
  });
});

describe('security: normalization warnings do not leak sensitive data', () => {
  test('warnings contain field names, not values', () => {
    const raw = {
      five_hour: { utilization: 42, resets_at: 'not-a-date' },
      seven_day: { utilization: 18, resets_at: '2026-03-14T07:00:00Z' },
    };
    const snapshot = normalize(raw);
    for (const warning of snapshot.rawMetadata.normalizationWarnings) {
      expect(warning).not.toContain(TOKEN);
      // Warnings should reference field names
      expect(warning).toContain('resets_at');
    }
  });
});

describe('security: credential file is read-only', () => {
  test('credentials module does not write to credential file', () => {
    const credSource = readFileSync(
      new URL('./credentials.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      'utf-8'
    );
    expect(credSource).not.toContain('writeFileSync');
    expect(credSource).not.toContain('writeFile');
    expect(credSource).toContain('readFileSync');
  });
});

// === Telemetry leak boundary (sdlc/003-metrics-telemetry) ===
//
// Revision 1 of the spec proposed an allowlist of field NAMES and a test asserting
// keys(payload) subset of ALLOWLIST. That test passes by construction and detects nothing,
// and a name allowlist does not stop the actual leak vector here, which is a field VALUE:
// client.ts puts fetch error messages into failures, and in Bun those carry hostnames,
// proxy URLs and /home/<username>/ paths.
//
// These tests are adversarial instead: poison every string that reaches the pipeline and
// assert none of it survives into a spooled line.

describe('security: telemetry never leaks secrets or environment', () => {
  const POISON = {
    token: 'sk-ant-oat01-FAKEFAKEFAKE',
    path: '/home/testuser/.claude/.credentials.json',
    host: 'internal-proxy.corp.example.com',
    user: 'testuser',
  };
  const ALL_POISON = Object.values(POISON);

  let cleanup: () => void;
  beforeEach(() => { ({ cleanup } = setupTestCacheDir()); });
  afterEach(() => { cleanup(); });

  const spool = () => (existsSync(getSpoolPath()) ? readFileSync(getSpoolPath(), 'utf-8') : '');

  test('a poisoned normalization warning cannot reach the spool as text', () => {
    const poisoned = `five_hour.resets_at is not a valid ISO timestamp: ${POISON.token} at ${POISON.path} via ${POISON.host}`;
    emit({ enabled: true }, schemaDriftEvent({ category: categorizeWarning(poisoned), count: 1 }));

    const raw = spool();
    expect(raw.length).toBeGreaterThan(0);
    for (const p of ALL_POISON) expect(raw).not.toContain(p);
    // Only the category survives.
    expect(JSON.parse(raw.trim()).payload.category).toBe('timestamp');
  });

  test('every event kind serializes to enumerated leaves only', () => {
    emit({ enabled: true }, fetchResultEvent({ ok: false, statusClass: 'network', attempts: 2, durationMs: 5000 }));
    emit({ enabled: true }, cacheEvent({ outcome: 'corruptJson' }));
    emit({ enabled: true }, renderEvent({
      surface: 'statusline', runtimeState: 'Degraded', tier: 'enterprise',
      utilizationBucket: utilizationBucket(93), durationMs: 11,
    }));
    emit({ enabled: true }, schemaDriftEvent({ category: 'enterprise', count: 3 }));

    const lines = spool().trim().split('\n');
    expect(lines).toHaveLength(4);

    for (const line of lines) {
      for (const p of ALL_POISON) expect(line).not.toContain(p);
      const payload = JSON.parse(line).payload as Record<string, unknown>;
      for (const [key, value] of Object.entries(payload)) {
        const t = typeof value;
        expect(['number', 'boolean', 'string', 'object']).toContain(t);
        if (t === 'string') {
          // Any string leaf must be short and free of separators that indicate a path,
          // URL, or credential rather than an enum member.
          const v = value as string;
          expect(v.length).toBeLessThanOrEqual(32);
          expect(v).not.toContain('/');
          expect(v).not.toContain('\\');
          expect(v).not.toContain('@');
          expect(v).not.toContain(':');
          expect(v).not.toContain('.');
        }
        expect(key.length).toBeLessThanOrEqual(32);
      }
    }
  });

  test('enterprise credit amounts are never emitted', () => {
    // An account's billing position is not a health signal. Only tier and a decile bucket.
    emit({ enabled: true }, renderEvent({
      surface: 'vscode', runtimeState: 'Enterprise', tier: 'enterprise',
      utilizationBucket: utilizationBucket(14.5), durationMs: 3,
    }));

    // NUMERIC needles are asserted against the PAYLOAD, not the whole line.
    //
    // The envelope legitimately contains digits — a random UUID eventId and an ISO
    // timestamp whose seconds-and-milliseconds render as `SS.mmm`. So a whole-line
    // assertion for "14.5" matches any instant at second 14 with milliseconds 5xx: 0.18%
    // of the time, measured. That is invisible locally and fails in CI, which is exactly
    // what happened. Distinctive string needles (tokens, paths, hostnames) are still
    // asserted against the whole line below, where they are safe and where the real
    // security guarantee lives.
    const payload = JSON.stringify(JSON.parse(spool().trim()).payload);
    expect(payload).not.toContain('290000');   // usedCredits in minor units
    expect(payload).not.toContain('20000000'); // monthlyLimit in minor units
    expect(payload).not.toContain('14.5');     // the raw utilization
    expect(JSON.parse(spool().trim()).payload.utilizationBucket).toBe(1);
  });

  test('a spooled line never contains credential-shaped material', () => {
    for (let i = 0; i < 10; i++) {
      emit({ enabled: true }, renderEvent({
        surface: 'statusline', runtimeState: 'Healthy', tier: 'standard',
        utilizationBucket: i, durationMs: i,
      }));
    }
    const raw = spool();
    expect(raw).not.toContain('sk-ant');
    expect(raw).not.toContain('Bearer');
    expect(raw).not.toContain('accessToken');
    expect(raw).not.toContain('refreshToken');
    expect(raw).not.toContain(homedir());
  });
});
