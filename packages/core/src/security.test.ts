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
import { readFileSync, writeFileSync } from 'fs';
import { normalize } from './normalize.js';
import { fetchUsage, isSurfaceableMessage } from './client.js';
import { extractLastError } from './snapshot.js';
import { shouldCooldown, failurePolicy } from './cooldown.js';
import { makeCacheEnvelope, writeCache, getCachePath, readCacheResult } from './cache.js';
import { makeTestEnvelope, makeTestSnapshot, setupTestCacheDir } from './test-helpers.js';
import { UNKNOWN_FETCHED_AT } from './closed-sets.js';

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

// Hoisted to module scope, not nested in the describe: `unicorn(consistent-function-scoping)` fires
// on a helper that captures nothing from its parent, and sdlc/029's A7 pins the warning count. The
// first version of this block nested both and pushed the count 11 -> 13 — the exact trap loop 028's
// own A6 named in writing ("a test written with a nested helper would trip this"), walked into one
// loop later. Found by the sdlc/029 plan-to-diff audit.
const mockSurfaceFetch = (impl: (...a: unknown[]) => Promise<Response>): void => {
  globalThis.fetch = impl as unknown as typeof fetch;
};
const jsonResponse = (status: number): Response =>
  new Response('{}', { status, headers: { 'Content-Type': 'application/json' } });

// === SPEC.md §12: "It must redact sensitive values from all surfaced errors" ===

describe('§12: every surfaceable error message is a literal this repo wrote', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  const FAST = { retryDelayMs: 0, timeoutMs: 25 } as const;

  /**
   * All SEVEN failure paths `fetchUsage` can take, asserted individually.
   *
   * Seven, not six: sdlc/029's first draft counted six and missed the `response.json()` throw, which
   * the spec review found. Before 029 that path produced a status-less `serviceUnavailable` carrying
   * `err.message`, and a contract test asserted that as correct — the misclassification was
   * enshrined, not undiscovered.
   *
   * Why this matters beyond tidiness: `client.ts:180` already called `err.message` "exactly the free
   * text the telemetry allowlist exists to keep out", and four lines later assigned it to a value
   * that is PERSISTED to the cache and RENDERED in the VS Code tooltip. The guard existed on the
   * telemetry path and not on this one.
   */
  test('all eight fetch failure paths produce a surfaceable message', async () => {
    const cases: Array<[string, () => void, string]> = [
      ['401', () => mockSurfaceFetch(async () => jsonResponse(401)), 'Authentication failed (401)'],
      ['429', () => mockSurfaceFetch(async () => jsonResponse(429)), 'Rate limited (429)'],
      ['5xx', () => mockSurfaceFetch(async () => jsonResponse(503)), 'Server error (503)'],
      ['unexpected', () => mockSurfaceFetch(async () => jsonResponse(418)), 'Unexpected status 418'],
      ['network', () => mockSurfaceFetch(async () => { throw new TypeError('fetch failed: getaddrinfo ENOTFOUND some.host'); }), 'Network error'],
      ['malformed', () => mockSurfaceFetch(async () => new Response('not json', { status: 200 })), 'Malformed response'],
      // Eighth path, added by sdlc/029's security pass. Selected from err.CODE, never err.message —
      // a code is a closed OpenSSL set, a message is free text. Without this a TLS interception
      // attempt was indistinguishable from a dead link on every surface.
      ['tls', () => mockSurfaceFetch(async () => {
        const e = new Error('self signed certificate') as Error & { code: string };
        e.code = 'DEPTH_ZERO_SELF_SIGNED_CERT';
        throw e;
      }), 'TLS verification failed'],
    ];

    // Collected and asserted as one array rather than per-case: bun's `expect` takes no label
    // argument, and a whole-array toEqual names the failing case in its diff anyway.
    const got: Array<[string, string, boolean]> = [];
    for (const [name, arrange] of cases) {
      arrange();
      const result = await fetchUsage('sk-ant-oat01-FAKE', FAST);
      expect(result.ok).toBe(false);
      if (!result.ok) got.push([name, result.message, isSurfaceableMessage(result.message)]);
    }
    expect(got).toEqual(cases.map(([name, , expected]) => [name, expected, true]));

    // Eighth: the REAL timeout. The mock honours the abort signal as real fetch does, so client's
    // own timer fires and sets `timedOut`. A synthetic AbortError would leave that flag false and
    // silently test the network branch instead — which is what the contract suite did for 29 loops.
    mockSurfaceFetch((_u: unknown, init: unknown) => new Promise<Response>((_res, rej) => {
      const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
      signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    }));
    const timedOut = await fetchUsage('sk-ant-oat01-FAKE', FAST);
    expect(timedOut.ok).toBe(false);
    if (!timedOut.ok) {
      expect(timedOut.failureClass).toBe('timeout');
      expect(timedOut.message).toBe('Request timed out');
      expect(isSurfaceableMessage(timedOut.message)).toBe(true);
    }

    // Positive precondition for the negatives above: the predicate really does reject things.
    expect(isSurfaceableMessage('Unable to connect. Is the computer able to access the url?')).toBe(false);
  });

  test('a malformed body still cools down — B1b must not remove the §9.4 throttle', () => {
    // sdlc/029's security pass: B1b moved the 200-with-non-JSON path off `serviceUnavailable`,
    // and `malformedResponse` sat in the no-cooldown bucket because nothing had ever constructed
    // it. Net effect measured before the fix: 2 authenticated requests per prompt render,
    // unbounded, instead of 2 per 5 minutes. cache.ts:139 calls the cooldown the ONLY throttle on
    // token-bearing requests.
    expect(shouldCooldown('malformedResponse')).toBe(true);
    expect(failurePolicy('malformedResponse').cooldown).toBe(true);
    // Positive precondition: the bucket it must NOT be in still exists and still means what it says.
    expect(shouldCooldown('unexpectedFailure')).toBe(false);
  });

  test('extractLastError drops a message no producer emits, in memory', () => {
    // The type closes the set at the producer; it cannot reach a value read off DISK. A cache file
    // written before sdlc/029 holds whatever `err.message` was on that machine.
    const envelope = makeCacheEnvelope(
      makeTestSnapshot(), null, 'serviceUnavailable', 503,
      'ENOENT open /home/someone/.claude/.credentials.json' as never,
    );
    const extracted = extractLastError(envelope);
    expect(extracted).not.toBeNull();
    expect(extracted!.message).toBeNull();      // free text dropped
    expect(extracted!.httpStatus).toBe(503);    // the number survives; it carries nothing free-form

    // Positive precondition: a real member survives the same path.
    const ok = extractLastError(makeCacheEnvelope(
      makeTestSnapshot(), null, 'serviceUnavailable', 503, 'Server error (503)',
    ));
    expect(ok!.message).toBe('Server error (503)');
  });

  test('free text read off DISK is nulled at the parse boundary', () => {
    // The case above constructs its envelope in memory, so it can only reach the ONE consumer
    // that calls `extractLastError`. This one goes through the file, which is the only way a
    // pre-sdlc/029 envelope actually arrives: back then the network path assigned `err.message`
    // verbatim, so a cache written by that build holds whatever the OS said — an absolute path,
    // a hostname, a username. `--debug` (main.ts:143) and the VS Code tooltip read the field
    // straight off the envelope and never see `extractLastError` at all.
    writeFileSync(getCachePath(), JSON.stringify(makeTestEnvelope({
      lastErrorClass: 'serviceUnavailable',
      lastHttpStatus: 503,
      lastErrorMessage: 'connect ECONNREFUSED /home/someone/.claude on someones-nuc.local' as never,
    })), { mode: 0o600 });

    const result = readCacheResult();
    // Degraded, not rejected: discarding the envelope would cost a live token-bearing fetch.
    expect(result.reason).toBe('hit');
    expect(result.envelope).not.toBeNull();
    expect(result.envelope!.lastErrorMessage).toBeNull();
    // The fields beside it are untouched — the message is dropped, the envelope is not.
    expect(result.envelope!.lastHttpStatus).toBe(503);
    expect(result.envelope!.lastErrorClass).toBe('serviceUnavailable');

    // Positive precondition. Without it every assertion above passes just as well if the branch
    // nulls the field unconditionally, which is a different (and useless) guard.
    writeFileSync(getCachePath(), JSON.stringify(makeTestEnvelope({
      lastErrorClass: 'serviceUnavailable',
      lastHttpStatus: 503,
      lastErrorMessage: 'Server error (503)',
    })), { mode: 0o600 });
    expect(readCacheResult().envelope!.lastErrorMessage).toBe('Server error (503)');
  });
});

/**
 * Each case asserts on the WHOLE serialised envelope, not on its field alone.
 *
 * `--json` (main.ts:241, :256 -> :371) stringifies the entire snapshot, so a per-field assertion
 * proves less than it looks: it cannot see a poison that survives in a neighbouring key. The
 * draft spec missed that surface entirely because it searched for readers of three field NAMES,
 * and `--json` names no field.
 */
function seedAndRead(snapshotOverrides: Record<string, unknown>): {
  serialised: string; envelope: NonNullable<ReturnType<typeof readCacheResult>['envelope']>;
} {
  writeFileSync(getCachePath(), JSON.stringify(makeTestEnvelope({
    snapshot: makeTestSnapshot(snapshotOverrides as never),
  })), { mode: 0o600 });
  const result = readCacheResult();
  expect(result.reason).toBe('hit');   // precondition: degraded, not discarded
  return { serialised: JSON.stringify(result.envelope), envelope: result.envelope! };
}


describe('§12: no value off a cache file reaches a surface unvalidated (sdlc/031)', () => {
  const POISON = '/home/someone sk-ant-oat01-SECRET nuc.local';

  test('a fetchedAt carrying free text is canonicalised', () => {
    // Parseable: Date.parse's legacy path ignores parenthesised trailing text, so this is finite
    // and was returned whole. Asserted as a SHAPE, not an instant — the legacy parser reads a
    // bare date as LOCAL time, so the exact value is timezone-dependent and the property is not.
    const { serialised, envelope } = seedAndRead({ fetchedAt: `2026-01-01 (${POISON})` });
    expect(envelope.snapshot.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(serialised).not.toContain(POISON);
  });

  test('a fetchedAt that will not parse becomes the sentinel', () => {
    const { serialised, envelope } = seedAndRead({ fetchedAt: `not-a-date ${POISON}` });
    expect(envelope.snapshot.fetchedAt).toBe(UNKNOWN_FETCHED_AT);
    expect(serialised).not.toContain(POISON);
  });

  test('a poisoned staleReason falls back to a member', () => {
    const { serialised, envelope } = seedAndRead({
      freshness: { isStale: true, staleReason: `leaked ${POISON}` },
    });
    expect(envelope.snapshot.freshness.staleReason).toBe('none');
    expect(envelope.snapshot.freshness.isStale).toBe(true);   // the fact survives; only the reason goes
    expect(serialised).not.toContain(POISON);
  });

  test('a non-boolean isStale becomes false', () => {
    const { serialised, envelope } = seedAndRead({
      freshness: { isStale: `yes ${POISON}`, staleReason: 'fetchFailed' },
    });
    expect(envelope.snapshot.freshness.isStale).toBe(false);
    expect(envelope.snapshot.freshness.staleReason).toBe('fetchFailed');  // a real member survives
    expect(serialised).not.toContain(POISON);
  });

  test('warnings are FILTERED, not emptied — a real one beside a poisoned one survives', () => {
    const { serialised, envelope } = seedAndRead({
      rawMetadata: { normalizationWarnings: ['Response is not an object', `evil ${POISON}`] },
    });
    // Filtering rather than emptying is the whole value of the field on the path where it appears.
    expect(envelope.snapshot.rawMetadata.normalizationWarnings).toEqual(['Response is not an object']);
    expect(serialised).not.toContain(POISON);
  });

  test('a non-array normalizationWarnings becomes an empty array', () => {
    const { envelope } = seedAndRead({ rawMetadata: { normalizationWarnings: `not an array ${POISON}` } });
    expect(envelope.snapshot.rawMetadata.normalizationWarnings).toEqual([]);
  });

  test('an honest envelope is untouched — the positive control for all six above', () => {
    // Without this, every assertion above passes just as well for a reader that blanks these
    // fields unconditionally, which is a different and useless guard.
    const fetchedAt = '2026-08-01T12:34:56.000Z';
    const { envelope } = seedAndRead({
      fetchedAt,
      freshness: { isStale: true, staleReason: 'malformedResponse' },
      rawMetadata: { normalizationWarnings: ['No valid usage windows found'] },
    });
    expect(envelope.snapshot.fetchedAt).toBe(fetchedAt);
    expect(envelope.snapshot.freshness).toEqual({ isStale: true, staleReason: 'malformedResponse' });
    expect(envelope.snapshot.rawMetadata.normalizationWarnings).toEqual(['No valid usage windows found']);
  });
});
