import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { readCache, readCacheResult, writeCache, isCacheFresh, makeCacheEnvelope, getCachePath, getCacheDir, sanitizeCooldownUntil } from './cache.js';
import { isInCooldown, COOLDOWN_DURATION_MS } from './cooldown.js';
import { makeTestSnapshot, setupTestCacheDir } from './test-helpers.js';

describe('cache', () => {
  let tempDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ tempDir, cleanup } = setupTestCacheDir());
  });

  afterEach(() => {
    cleanup();
  });

  describe('getCachePath', () => {
    test('returns path containing usage.json', () => {
      const path = getCachePath();
      expect(path).toContain('usage.json');
    });

    test('getCacheDir returns parent of getCachePath', () => {
      const dir = getCacheDir();
      const path = getCachePath();
      expect(path.startsWith(dir)).toBe(true);
    });

    test('uses injected base dir', () => {
      const dir = getCacheDir();
      expect(dir).toBe(tempDir);
    });
  });

  describe('makeCacheEnvelope', () => {
    test('creates valid envelope with defaults', () => {
      const snapshot = makeTestSnapshot();
      const envelope = makeCacheEnvelope(snapshot);
      expect(envelope.version).toBe(2);
      expect(envelope.snapshot).toBe(snapshot);
      expect(envelope.cooldownUntil).toBeNull();
      expect(envelope.lastErrorClass).toBeNull();
    });

    test('accepts cooldown and error class', () => {
      const snapshot = makeTestSnapshot();
      const cooldown = new Date(Date.now() + 60_000).toISOString();
      const envelope = makeCacheEnvelope(snapshot, cooldown, 'serviceUnavailable');
      expect(envelope.cooldownUntil).toBe(cooldown);
      expect(envelope.lastErrorClass).toBe('serviceUnavailable');
    });
  });

  describe('isCacheFresh', () => {
    test('returns true for snapshot fetched just now', () => {
      const snapshot = makeTestSnapshot({ fetchedAt: new Date().toISOString() });
      const envelope = makeCacheEnvelope(snapshot);
      expect(isCacheFresh(envelope, 60)).toBe(true);
    });

    test('returns false for snapshot older than TTL', () => {
      const oldTime = new Date(Date.now() - 120_000).toISOString();
      const snapshot = makeTestSnapshot({ fetchedAt: oldTime });
      const envelope = makeCacheEnvelope(snapshot);
      expect(isCacheFresh(envelope, 60)).toBe(false);
    });

    /**
     * A fixed clock, so the boundary is exact.
     *
     * This test used to compute `Date.now() - 59_999` and let `isCacheFresh` read the clock
     * again at the assertion — giving itself a ONE MILLISECOND budget for an ISO round-trip and
     * two object constructions. It went red on a slow container (sdlc/019). It also could only
     * ever assert the side it had slack on; the boundary itself was untested.
     */
    const NOW = Date.parse('2026-03-07T12:00:00.000Z');
    const agedMs = (ms: number) =>
      makeCacheEnvelope(makeTestSnapshot({ fetchedAt: new Date(NOW - ms).toISOString() }));

    test('one ms under the TTL is fresh', () => {
      expect(isCacheFresh(agedMs(59_999), 60, NOW)).toBe(true);
    });

    test('exactly AT the TTL is stale — the boundary is `<`, not `<=`', () => {
      // The side the old test could never reach, because it had no slack there.
      expect(isCacheFresh(agedMs(60_000), 60, NOW)).toBe(false);
    });

    test('one ms over the TTL is stale', () => {
      expect(isCacheFresh(agedMs(60_001), 60, NOW)).toBe(false);
    });

    test('the ambient clock is still the default when no `now` is passed', () => {
      // Margin measured in minutes, not milliseconds — this asserts the DEFAULT is wired, and
      // is deliberately nowhere near a boundary.
      const fresh = makeCacheEnvelope(makeTestSnapshot({ fetchedAt: new Date().toISOString() }));
      expect(isCacheFresh(fresh, 600)).toBe(true);
      const old = makeCacheEnvelope(
        makeTestSnapshot({ fetchedAt: new Date(Date.now() - 3_600_000).toISOString() }),
      );
      expect(isCacheFresh(old, 600)).toBe(false);
    });

    test('uses default TTL of 600s (10 minutes)', () => {
      const snapshot = makeTestSnapshot({ fetchedAt: new Date().toISOString() });
      const envelope = makeCacheEnvelope(snapshot);
      expect(isCacheFresh(envelope)).toBe(true);
    });

    test('5-minute-old cache is still fresh with default TTL', () => {
      const fiveMinAgo = new Date(Date.now() - 300_000).toISOString();
      const snapshot = makeTestSnapshot({ fetchedAt: fiveMinAgo });
      const envelope = makeCacheEnvelope(snapshot);
      expect(isCacheFresh(envelope)).toBe(true);
    });

    test('11-minute-old cache is stale with default TTL', () => {
      const elevenMinAgo = new Date(Date.now() - 660_000).toISOString();
      const snapshot = makeTestSnapshot({ fetchedAt: elevenMinAgo });
      const envelope = makeCacheEnvelope(snapshot);
      expect(isCacheFresh(envelope)).toBe(false);
    });
  });

  describe('cache version migration', () => {
  test('a v1 envelope is discarded rather than rendered', () => {
    // v1 snapshots predate sevenDayOpus. Reading one would produce a snapshot whose type
    // claims the field is present while it is undefined — see sdlc/002-opus-window.
    const stale = {
      version: 1,
      snapshot: makeTestSnapshot(),
      cooldownUntil: null,
      lastErrorClass: null,
    };
    writeFileSync(getCachePath(), JSON.stringify(stale), 'utf-8');

    expect(readCache()).toBeNull();
    // Deleted, so the next call is a clean miss rather than a repeated corrupt read.
    expect(existsSync(getCachePath())).toBe(false);
  });
});

describe('writeCache and readCache round-trip', () => {
    test('writes and reads back correctly', () => {
      const snapshot = makeTestSnapshot();
      const envelope = makeCacheEnvelope(snapshot);
      writeCache(envelope);
      const read = readCache();
      expect(read).not.toBeNull();
      expect(read!.version).toBe(2);
      expect(read!.snapshot.fiveHour.utilizationPct).toBe(42);
      expect(read!.snapshot.sevenDay.utilizationPct).toBe(18);
    });

    test('preserves cooldown fields', () => {
      const snapshot = makeTestSnapshot();
      const cooldown = new Date(Date.now() + 60_000).toISOString();
      const envelope = makeCacheEnvelope(snapshot, cooldown, 'serviceUnavailable');
      writeCache(envelope);
      const read = readCache();
      expect(read).not.toBeNull();
      expect(read!.cooldownUntil).toBe(cooldown);
      expect(read!.lastErrorClass).toBe('serviceUnavailable');
    });

    test('cache file does not contain access tokens', () => {
      const snapshot = makeTestSnapshot();
      const envelope = makeCacheEnvelope(snapshot);
      writeCache(envelope);
      const raw = readFileSync(getCachePath(), 'utf-8');
      expect(raw).not.toContain('sk-ant');
      expect(raw).not.toContain('accessToken');
      expect(raw).not.toContain('refreshToken');
    });
  });

  describe('corruption recovery', () => {
    test('readCache returns null and deletes file for invalid JSON', () => {
      const path = getCachePath();
      writeFileSync(path, '{invalid json!!!', 'utf-8');
      const result = readCache();
      expect(result).toBeNull();
      expect(existsSync(path)).toBe(false);
    });

    test('readCache returns null and deletes file for truncated JSON', () => {
      const path = getCachePath();
      writeFileSync(path, '{"version": 1, "snapshot":', 'utf-8');
      const result = readCache();
      expect(result).toBeNull();
      expect(existsSync(path)).toBe(false);
    });

    test('readCache returns null and deletes file for empty file', () => {
      const path = getCachePath();
      writeFileSync(path, '', 'utf-8');
      const result = readCache();
      expect(result).toBeNull();
    });

    test('readCache returns null and deletes for wrong version', () => {
      const path = getCachePath();
      writeFileSync(path, JSON.stringify({ version: 99, snapshot: {} }), 'utf-8');
      const result = readCache();
      expect(result).toBeNull();
      expect(existsSync(path)).toBe(false);
    });

    test('readCache returns null and deletes for missing snapshot field', () => {
      const path = getCachePath();
      writeFileSync(path, JSON.stringify({ version: 1 }), 'utf-8');
      const result = readCache();
      expect(result).toBeNull();
      expect(existsSync(path)).toBe(false);
    });

    test('readCache returns null for snapshot that is not an object', () => {
      const path = getCachePath();
      writeFileSync(path, JSON.stringify({ version: 1, snapshot: true }), 'utf-8');
      const result = readCache();
      expect(result).toBeNull();
      expect(existsSync(path)).toBe(false);
    });

    test('readCache returns null for snapshot missing fetchedAt', () => {
      const path = getCachePath();
      writeFileSync(path, JSON.stringify({
        version: 1,
        snapshot: { display: {}, freshness: {} },
      }), 'utf-8');
      const result = readCache();
      expect(result).toBeNull();
      expect(existsSync(path)).toBe(false);
    });

    test('readCache returns null for snapshot missing display', () => {
      const path = getCachePath();
      writeFileSync(path, JSON.stringify({
        version: 1,
        snapshot: { fetchedAt: '2026-03-07T12:00:00Z', freshness: {} },
      }), 'utf-8');
      const result = readCache();
      expect(result).toBeNull();
      expect(existsSync(path)).toBe(false);
    });

    test('readCache returns null for non-existent file', () => {
      const path = getCachePath();
      try { rmSync(path); } catch { /* ignore */ }
      const result = readCache();
      expect(result).toBeNull();
    });
  });
});

describe('readCacheResult: distinguishing why a read failed', () => {
  let cleanup2: () => void;
  beforeEach(() => { ({ cleanup: cleanup2 } = setupTestCacheDir()); });
  afterEach(() => { cleanup2(); });

  test('hit on a valid current-version envelope', () => {
    writeCache(makeCacheEnvelope(makeTestSnapshot()));
    const r = readCacheResult();
    expect(r.reason).toBe('hit');
    expect(r.envelope).not.toBeNull();
  });

  test('miss when the file is absent', () => {
    expect(readCacheResult()).toEqual({ envelope: null, reason: 'miss' });
  });

  test('corruptJson is distinguishable from a cold miss', () => {
    writeFileSync(getCachePath(), '{ not json at all', 'utf-8');
    expect(readCacheResult().reason).toBe('corruptJson');
    expect(existsSync(getCachePath())).toBe(false);
  });

  test('versionMismatch is distinguishable from corruption', () => {
    writeFileSync(getCachePath(), JSON.stringify({
      version: 1, snapshot: makeTestSnapshot(), cooldownUntil: null, lastErrorClass: null,
    }), 'utf-8');
    expect(readCacheResult().reason).toBe('versionMismatch');
  });

  test('invalidShape is distinguishable from versionMismatch', () => {
    writeFileSync(getCachePath(), JSON.stringify({
      version: 2, snapshot: { nope: true }, cooldownUntil: null, lastErrorClass: null,
    }), 'utf-8');
    expect(readCacheResult().reason).toBe('invalidShape');
  });

  test('readCache still returns just the envelope, unchanged', () => {
    writeCache(makeCacheEnvelope(makeTestSnapshot()));
    expect(readCache()).toEqual(readCacheResult().envelope);
  });
});

/**
 * Write a cache file with arbitrary field values, bypassing `makeCacheEnvelope`'s types.
 *
 * The validation tests below all need to plant a value the type system would refuse, which is
 * the entire point — that is what a corrupt file on disk looks like to `readCacheResult`.
 */
function writeEnvelopeWith(overrides: Record<string, unknown>): void {
  const envelope = { ...makeCacheEnvelope(makeTestSnapshot()), ...overrides };
  writeFileSync(getCachePath(), JSON.stringify(envelope), 'utf-8');
}

describe('lastErrorClass validation (sdlc/014)', () => {
  let cleanup: () => void;

  beforeEach(() => {
    ({ cleanup } = setupTestCacheDir());
  });

  afterEach(() => {
    cleanup();
  });

  test('an unknown lastErrorClass is nulled, not rejected', () => {
    // The snapshot beside it is fine. Discarding the envelope over a corrupt error-class field
    // would cost a live fetch on every read for a field nothing renders.
    writeEnvelopeWith({ lastErrorClass: 'someClassFromAFutureVersion' });
    const result = readCacheResult();
    expect(result.reason).toBe('hit');
    expect(result.envelope).not.toBeNull();
    expect(result.envelope?.lastErrorClass).toBeNull();
    expect(result.envelope?.snapshot.display.primaryUtilizationPct).toBe(
      makeTestSnapshot().display.primaryUtilizationPct,
    );
  });

  test('the cache file survives — this is not corruption recovery', () => {
    writeEnvelopeWith({ lastErrorClass: 'someClassFromAFutureVersion' });
    readCacheResult();
    expect(existsSync(getCachePath())).toBe(true);
  });

  test('the cooldown timestamp is kept, since it does not depend on the class', () => {
    // Nulling the class must not release a backoff. Otherwise a corrupt field turns into
    // unthrottled retries against an endpoint that just rate-limited us.
    const future = new Date(Date.now() + 60_000).toISOString();
    writeEnvelopeWith({ cooldownUntil: future, lastErrorClass: 'notAClass' });
    expect(readCacheResult().envelope?.cooldownUntil).toBe(future);
  });

  test('a non-string lastErrorClass is nulled too', () => {
    for (const value of [42, {}, ['authInvalid'], true]) {
      writeEnvelopeWith({ lastErrorClass: value });
      expect(readCacheResult().envelope?.lastErrorClass).toBeNull();
    }
  });

  test('a missing lastErrorClass field reads as null', () => {
    const envelope = makeCacheEnvelope(makeTestSnapshot()) as unknown as Record<string, unknown>;
    delete envelope.lastErrorClass;
    writeFileSync(getCachePath(), JSON.stringify(envelope), 'utf-8');
    expect(readCacheResult().envelope?.lastErrorClass).toBeNull();
  });

  test('a valid lastErrorClass is preserved untouched', () => {
    writeEnvelopeWith({ lastErrorClass: 'timeout' });
    expect(readCacheResult().envelope?.lastErrorClass).toBe('timeout');
  });
});

describe('non-object JSON is corruption, not a crash (sdlc/014 security pass)', () => {
  let cleanup: () => void;
  beforeEach(() => { ({ cleanup } = setupTestCacheDir()); });
  afterEach(() => { cleanup(); });

  // Each of these parses fine and then throws TypeError on `parsed.version`, out of
  // readCacheResult, out of main(), into the top-level catch — leaving the file in place so
  // every subsequent invocation does it again. Exit 3, forever, until someone deletes the file
  // by hand. SPEC.md §9 says corruption must delete and refetch, precisely so that cannot
  // happen.
  for (const raw of ['null', '4', '"a string"', '[]', '[{"version":2}]', 'true']) {
    test(`a cache file containing ${raw} is deleted, not thrown on`, () => {
      writeFileSync(getCachePath(), raw, 'utf-8');
      const result = readCacheResult();
      expect(result.envelope).toBeNull();
      expect(result.reason).toBe('corruptJson');
      expect(existsSync(getCachePath())).toBe(false);
    });
  }

  test('the second read after corruption is a clean miss', () => {
    // The actual property that matters: no stuck loop.
    writeFileSync(getCachePath(), 'null', 'utf-8');
    expect(readCacheResult().reason).toBe('corruptJson');
    expect(readCacheResult().reason).toBe('miss');
  });
});

describe('sanitizeCooldownUntil (sdlc/014 security pass)', () => {
  const NOW = Date.parse('2026-08-26T12:00:00.000Z');

  test('an unparseable string releases the cooldown rather than wedging it', () => {
    expect(sanitizeCooldownUntil('not-a-date', NOW)).toBeNull();
    expect(sanitizeCooldownUntil('', NOW)).toBeNull();
  });

  test('a non-string is nulled', () => {
    for (const value of [42, {}, [], true, null, undefined]) {
      expect(sanitizeCooldownUntil(value, NOW)).toBeNull();
    }
  });

  test('a value beyond one full cooldown is clamped to the ceiling', () => {
    expect(sanitizeCooldownUntil(new Date(8.64e15).toISOString(), NOW))
      .toBe(new Date(NOW + COOLDOWN_DURATION_MS).toISOString());
  });

  test('a legitimate cooldown we just wrote comes back identical', () => {
    // Identical because it was already canonical, not because it was echoed. Since sdlc/030 the
    // return value is always constructed; for a round-trippable ISO string the two coincide.
    const ours = new Date(NOW + COOLDOWN_DURATION_MS).toISOString();
    expect(sanitizeCooldownUntil(ours, NOW)).toBe(ours);
  });

  test('a past cooldown survives — isInCooldown already handles it', () => {
    const past = new Date(NOW - 1000).toISOString();
    expect(sanitizeCooldownUntil(past, NOW)).toBe(past);
  });

  test('a parseable string carrying free text is canonicalised, not echoed', () => {
    // sdlc/030 security pass, finding 1. `Date.parse` accepts far more than ISO-8601 and the
    // legacy parser ignores parenthesised trailing text entirely, so this string parses finite,
    // sits below the ceiling, and was returned VERBATIM — straight to `--debug` stdout via
    // main.ts:140 and :168. The clamp branch always constructed its result; only the in-range
    // passthrough echoed its input.
    const poisoned = '2026-08-26 (/home/someone/.claude sk-ant-oat01-SECRET on someones-nuc.local)';
    // Precondition: without this the test passes for the wrong reason if the parser ever
    // starts REJECTING the string, which would null it rather than canonicalise it.
    expect(Number.isFinite(Date.parse(poisoned))).toBe(true);

    const out = sanitizeCooldownUntil(poisoned, NOW);
    // Asserted as a shape, not an exact instant: the legacy parser reads a bare date-with-suffix
    // as LOCAL time, so the exact value is TZ-dependent while the property under test is not.
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(out).not.toContain('/home/someone');
    expect(out).not.toContain('sk-ant');
    expect(out).not.toContain('someones-nuc.local');
  });

  test('null stays null', () => {
    expect(sanitizeCooldownUntil(null, NOW)).toBeNull();
  });
});

describe('a corrupt cooldownUntil cannot release the throttle (sdlc/014 security pass)', () => {
  let cleanup: () => void;
  beforeEach(() => { ({ cleanup } = setupTestCacheDir()); });
  afterEach(() => { cleanup(); });

  test('REGRESSION: an unparseable cooldownUntil is nulled before isInCooldown sees it', () => {
    // Unsanitized, `new Date('garbage').getTime()` is NaN, `Date.now() < NaN` is false, and the
    // 5-minute backoff — the only throttle on token-bearing requests (SPEC.md §9.4) — silently
    // disappears. One corrupt byte, one authenticated request per prompt render.
    writeEnvelopeWith({ cooldownUntil: 'garbage' });
    const envelope = readCacheResult().envelope!;
    expect(envelope.cooldownUntil).toBeNull();
    expect(isInCooldown(envelope)).toBe(false);
  });

  test('a far-future cooldownUntil cannot pin the tool on stale data forever', () => {
    writeEnvelopeWith({ cooldownUntil: new Date(8.64e15).toISOString() });
    const envelope = readCacheResult().envelope!;
    expect(isInCooldown(envelope)).toBe(true);
    // Still in cooldown — but bounded, and it expires within one backoff rather than in the
    // year 275760.
    expect(new Date(envelope.cooldownUntil!).getTime())
      .toBeLessThanOrEqual(Date.now() + COOLDOWN_DURATION_MS);
  });

  test('a real cooldown written by enterCooldown survives a round trip', () => {
    const until = new Date(Date.now() + COOLDOWN_DURATION_MS).toISOString();
    writeEnvelopeWith({ cooldownUntil: until });
    const envelope = readCacheResult().envelope!;
    expect(envelope.cooldownUntil).toBe(until);
    expect(isInCooldown(envelope)).toBe(true);
  });
});
