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

  /**
   * The fixture credential is expired ON PURPOSE. With the year-2100 timestamp the two
   * hand-rolled copies used, `resolveCredentials` returns 'valid' and every cache-miss path
   * falls through to a live authenticated GET carrying the token. Expiry closes that by
   * construction — main.ts exits 2 at :273 before fetchUsage is reached.
   */
  test('the fixture credential is already expired, so no miss path can fetch', () => {
    const s = seed({ prefix: 'cw-core-', accessToken: TOKEN });
    const creds = JSON.parse(readFileSync(s.credentialsPath, 'utf-8'));
    expect(creds.claudeAiOauth.expiresAt).toBeLessThan(Date.now());
    // Positive precondition: the override exists and does move it, so the assertion above is
    // about the DEFAULT rather than about expiresAt being absent or unreadable.
    const future = seed({ prefix: 'cw-core-', accessToken: TOKEN, expiresAt: 4102444800000 });
    const f = JSON.parse(readFileSync(future.credentialsPath, 'utf-8'));
    expect(f.claudeAiOauth.expiresAt).toBeGreaterThan(Date.now());
  });

  /**
   * Pinning HOME alone leaves os.homedir() following USERPROFILE on Windows, which is how a
   * benchmark would reach real credentials. smoke.test.ts pinned only HOME until the sdlc/024
   * security pass; carrying the env on the seed is what stops that recurring.
   */
  test('the seed carries every home variable a spawn needs, not just HOME', () => {
    const s = seed({ prefix: 'cw-core-', accessToken: TOKEN });
    expect(s.env.HOME).toBe(s.home);
    expect(s.env.USERPROFILE).toBe(s.home);        // os.homedir() on Windows
    expect(s.env.HOMEPATH).toBe(s.home);
    expect(s.env.HOMEDRIVE).toBe('');
    expect(s.env.CLAUDEWATCH_TELEMETRY).toBe('0');
    // None of them may point at the ambient home, which is the failure this guards.
    for (const v of Object.values(s.env)) {
      if (v) expect(v.startsWith(s.home) || v === '0').toBe(true);
    }
  });

  test('a prefix that would escape tmpdir is refused', () => {
    for (const bad of ['../escape', 'a/b', 'a\\b', '..']) {
      expect(() => seedSandboxHome({ prefix: bad, accessToken: TOKEN })).toThrow(/bare name/);
    }
    // Positive precondition: a bare prefix is still accepted, so the throws above are about
    // the traversal check and not about the function throwing for everything.
    expect(() => seed({ prefix: 'cw-core-', accessToken: TOKEN })).not.toThrow();
  });

  /**
   * Restored from scripts/perf.test.ts:114, which asserted this and was dropped in the move
   * without a replacement. The sdlc/024 plan-to-diff audit proved the gap live: seeding
   * `isStale: true` left all 11 core, 7 smoke and 21 perf tests green, because every smoke
   * assertion is `toContain("42%")` and a stale line reads "42% stale" — so the whole suite
   * would have been silently exercising the stale render path.
   */
  test('the seeded snapshot is FRESH, not stale', () => {
    const s = seed({ prefix: 'cw-core-', accessToken: TOKEN });
    const env = JSON.parse(readFileSync(s.cachePath, 'utf-8'));
    expect(env.snapshot.freshness.isStale).toBe(false);
    expect(env.snapshot.freshness.staleReason).toBe('none');
    // C-2: and the freshness the BINARY computes comes from fetchedAt, not from that block —
    // so assert the default is inside isCacheFresh's 600s TTL rather than trusting the flag.
    const age = Date.now() - new Date(env.snapshot.fetchedAt).getTime();
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(600_000);
    // Positive precondition: an explicitly stale fetchedAt IS outside the window, so the
    // assertion above is about the default rather than about the arithmetic always holding.
    const old = seed({
      prefix: 'cw-core-',
      accessToken: TOKEN,
      fetchedAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const oldEnv = JSON.parse(readFileSync(old.cachePath, 'utf-8'));
    expect(Date.now() - new Date(oldEnv.snapshot.fetchedAt).getTime()).toBeGreaterThan(600_000);
  });

  /**
   * C-5. `utilizationPct` is derived from the snapshot actually seeded. Echoing the input back
   * would make the field's docstring ("assert on THIS, never on a literal") a lie for any
   * caller passing `snapshot`.
   */
  test('utilizationPct reports the seeded snapshot, not the argument', () => {
    const s = seed({
      prefix: 'cw-core-',
      accessToken: TOKEN,
      utilizationPct: 11,                                  // ignored: `snapshot` wins
      snapshot: makeTestSnapshot({
        display: { primaryWindow: 'fiveHour', primaryUtilizationPct: 64, primaryResetsAt: null },
      }),
    });
    expect(s.utilizationPct).toBe(64);
    const env = JSON.parse(readFileSync(s.cachePath, 'utf-8'));
    expect(env.snapshot.display.primaryUtilizationPct).toBe(64);
  });

  test('two seeds never share a directory', () => {
    const a = seed({ prefix: 'cw-core-', accessToken: TOKEN });
    const b = seed({ prefix: 'cw-core-', accessToken: TOKEN });
    expect(a.home).not.toBe(b.home);
  });
});
