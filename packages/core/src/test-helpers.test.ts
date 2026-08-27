/**
 * Tests for the shared fixtures themselves.
 *
 * A fixture with no test is how sdlc/024's defect survived: `makeTestEnvelope` returned
 * `version: 1` for the entire life of the repo, `CACHE_VERSION` has been 2 since sdlc/002, and
 * all 25 call sites passed it to an in-memory mock — so the one thing nobody did was write it
 * to disk and read it back, which is the only way the bug shows.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { existsSync, readFileSync, statSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  makeTestEnvelope,
  makeTestSnapshot,
  seedSandboxHome,
  setupTestCacheDir,
} from './test-helpers.js';
import { getCachePath, readCacheResult } from './cache.js';

describe('makeTestEnvelope round-trips through the real reader', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => { cleanup?.(); cleanup = null; });

  /**
   * A2. Both halves live here on purpose.
   *
   * The positive half alone would prove only that the pipe is connected — the shape sdlc/022
   * found, where 42 tests passed against a fingerprint that was a constant. The negative half
   * alone would prove only that SOME envelope is rejected. Together they say: this fixture is
   * accepted, and this reader does reject the thing it is supposed to reject.
   */
  test('an envelope from the fixture is a cache HIT, and a bad one is not', () => {
    const t = setupTestCacheDir();
    cleanup = t.cleanup;
    const path = getCachePath();

    // Positive: the fixture, written the way a caller would write it.
    writeFileSync(path, JSON.stringify(makeTestEnvelope()));
    expect(existsSync(path)).toBe(true);                 // precondition, not decoration
    const hit = readCacheResult();
    expect(hit.reason).toBe('hit');
    expect(hit.envelope).not.toBeNull();
    expect(existsSync(path)).toBe(true);                 // a rejected read would have deleted it

    // Negative: the exact failure this fixture used to have. `version: 1` was the real value;
    // 0 is used here so the test keeps its meaning after any future CACHE_VERSION bump.
    writeFileSync(path, JSON.stringify(makeTestEnvelope({ version: 0 })));
    expect(existsSync(path)).toBe(true);
    const miss = readCacheResult();
    expect(miss.reason).toBe('versionMismatch');
    expect(miss.envelope).toBeNull();
    expect(existsSync(path)).toBe(false);                // and this is what deletion looks like
  });

  test('the fixture carries every field the envelope requires', () => {
    // Guards the delegation to makeCacheEnvelope: both hand-rolled seeds omitted these two,
    // and `Partial<CacheEnvelope>` overrides cannot reintroduce a missing key.
    const env = makeTestEnvelope();
    expect(env).toHaveProperty('lastHttpStatus');
    expect(env).toHaveProperty('lastErrorMessage');
    expect(Object.keys(env).toSorted()).toEqual([
      'cooldownUntil', 'lastErrorClass', 'lastErrorMessage', 'lastHttpStatus', 'snapshot', 'version',
    ]);
  });
});

describe('seedSandboxHome', () => {
  const TOKEN = 'sk-ant-oat01-CORE-TEST-NOT-REAL';
  const seeds: string[] = [];
  const seed = (opts: Parameters<typeof seedSandboxHome>[0]) => {
    const s = seedSandboxHome(opts);
    seeds.push(s.home);
    return s;
  };
  afterEach(() => {
    while (seeds.length) rmSync(seeds.pop()!, { recursive: true, force: true });
  });

  /**
   * A4. 77 is chosen because it is the default of nothing: `makeTestSnapshot` defaults to 42,
   * `scripts/perf.ts` uses 37, `smoke.test.ts` uses 42. A seeder that accepted `utilizationPct`
   * and dropped it would leave 42 in the envelope, the binary would still print "42%", and
   * every smoke assertion would pass — so a seeded 42 could not tell the two apart.
   */
  test('the seeded utilization actually reaches the envelope on disk', () => {
    const s = seed({ prefix: 'cw-core-', accessToken: TOKEN, utilizationPct: 77 });
    const env = JSON.parse(readFileSync(s.cachePath, 'utf-8'));
    expect(env.snapshot.fiveHour.utilizationPct).toBe(77);
    expect(env.snapshot.display.primaryUtilizationPct).toBe(77);
    expect(s.utilizationPct).toBe(77);
    // And it is NOT the default, or the assertions above would hold for a seeder that ignored us.
    expect(makeTestSnapshot().fiveHour.utilizationPct).not.toBe(77);
  });

  test('what it writes is a cache hit for the real reader', () => {
    const s = seed({ prefix: 'cw-core-', accessToken: TOKEN, utilizationPct: 77 });
    const t = setupTestCacheDir();
    try {
      writeFileSync(getCachePath(), readFileSync(s.cachePath, 'utf-8'));
      const r = readCacheResult();
      expect(r.reason).toBe('hit');
      expect(r.envelope!.snapshot.display.primaryUtilizationPct).toBe(77);
    } finally {
      t.cleanup();
    }
  });

  // Relocated from scripts/perf.test.ts, which called the local copy this helper replaced.
  test.skipIf(process.platform === 'win32')(
    'seeds 0600/0700 at creation, with no chmod window',
    () => {
      const s = seed({ prefix: 'cw-core-', accessToken: TOKEN });
      expect(statSync(join(s.home, '.claude')).mode & 0o777).toBe(0o700);
      expect(statSync(join(s.home, '.cache', 'claudewatch')).mode & 0o777).toBe(0o700);
      expect(statSync(s.cachePath).mode & 0o777).toBe(0o600);
      expect(statSync(s.credentialsPath).mode & 0o777).toBe(0o600);
    },
  );

  test('the fixture token is self-evidently not real', () => {
    const s = seed({ prefix: 'cw-core-', accessToken: TOKEN });
    expect(readFileSync(s.credentialsPath, 'utf-8')).toContain('NOT-REAL');
  });

  test('seedCache: false leaves a HOME with no cache at all', () => {
    const s = seed({ prefix: 'cw-core-', accessToken: TOKEN, seedCache: false });
    expect(existsSync(s.credentialsPath)).toBe(true);
    expect(existsSync(s.cachePath)).toBe(false);
    // The positive half: the same call WITH a cache does produce one, so the assertion above
    // is about `seedCache`, not about the path being wrong.
    const withCache = seed({ prefix: 'cw-core-', accessToken: TOKEN });
    expect(existsSync(withCache.cachePath)).toBe(true);
  });

  test('two seeds never share a directory', () => {
    const a = seed({ prefix: 'cw-core-', accessToken: TOKEN });
    const b = seed({ prefix: 'cw-core-', accessToken: TOKEN });
    expect(a.home).not.toBe(b.home);
  });
});
