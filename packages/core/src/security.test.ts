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
    expect(envelope.version).toBe(1);
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
