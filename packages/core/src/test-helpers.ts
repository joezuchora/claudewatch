/**
 * Shared test fixtures for ClaudeWatch test suites, and for `scripts/perf.ts` — the benchmark
 * is not a test file but seeds the same sandbox, and having it keep its own copy is exactly
 * what sdlc/024 exists to end. Nothing here is reachable from `index.ts`, so none of it is
 * bundled into a shipped artifact.
 */
import { join } from 'path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import type { UsageSnapshot, CacheEnvelope, CredentialFile } from './types.js';
import { setCacheBaseDir, makeCacheEnvelope } from './cache.js';
import { NORMALIZATION_WARNINGS } from './closed-sets.js';

/**
 * Create a valid UsageSnapshot with sensible defaults.
 * Override any field via the overrides parameter.
 */
export function makeTestSnapshot(overrides?: Partial<UsageSnapshot>): UsageSnapshot {
  return {
    fetchedAt: new Date().toISOString(),
    source: { usageEndpoint: 'success' },
    authState: 'valid',
    tier: 'standard',
    fiveHour: { utilizationPct: 42, resetsAt: '2026-03-07T17:00:00.000Z' },
    sevenDay: { utilizationPct: 18, resetsAt: '2026-03-14T07:00:00.000Z' },
    // Defaults to absent: existing callers must keep producing pre-Opus snapshots.
    sevenDayOpus: { utilizationPct: null, resetsAt: null },
    enterprise: null,
    display: { primaryWindow: 'fiveHour', primaryUtilizationPct: 42, primaryResetsAt: '2026-03-07T17:00:00.000Z' },
    freshness: { isStale: false, staleReason: 'none' },
    rawMetadata: { normalizationWarnings: [] },
    ...overrides,
  };
}

/**
 * A snapshot in which EVERY leaf differs from that leaf's own degraded value.
 *
 * `makeTestSnapshot`'s defaults are, for six leaves, identical to what `sanitizeSnapshot` would
 * substitute: `sevenDayOpus` is `null/null`, `enterprise` is `null`, `isStale` is `false`,
 * `staleReason` is `'none'`, and `normalizationWarnings` is `[]`. A round-trip test built on those
 * defaults passes for a rebuild that DROPS those fields and hardcodes the substitute — the Stage 2
 * reviewer of sdlc/032 demonstrated it with `currency`, where dropping the field and hardcoding
 * `'USD'` satisfies both the round-trip and the `'zz' -> 'USD'` edge case while formatting every
 * non-USD account with the wrong symbol and divisor.
 *
 * A whitelist rebuild fails by DROPPING a field, not by leaking one, so this fixture is the only
 * thing standing between that failure mode and silence. `cache.test.ts` asserts leaf-by-leaf that
 * every value here differs from its degraded counterpart, so the fixture cannot go vacuous
 * silently the way its predecessor did.
 */
export function makeRichTestSnapshot(): UsageSnapshot {
  return makeTestSnapshot({
    fetchedAt: '2026-08-01T12:34:56.000Z',      // canonical, and NOT the current time
    source: { usageEndpoint: 'success' },        // degrade is 'unavailable'
    authState: 'valid',                          // degrade is 'unknown'
    tier: 'enterprise',                          // degrade is 'unknown'; coherent with `enterprise`
    fiveHour: { utilizationPct: 42, resetsAt: '2026-03-07T17:00:00.000Z' },
    sevenDay: { utilizationPct: 18, resetsAt: '2026-03-14T07:00:00.000Z' },
    sevenDayOpus: { utilizationPct: 7, resetsAt: '2026-03-21T09:00:00.000Z' },
    enterprise: {
      utilizationPct: 12.5,
      monthlyLimitCredits: 200000,
      usedCredits: 25000,
      currency: 'EUR',                           // degrade is 'USD' — the reviewer's example
      isEnabled: false,                          // degrade is "nulls the object"
      disabledReason: 'Disabled by your administrator',   // degrade is null
    },
    display: {
      primaryWindow: 'enterprise',               // degrade is 'unknown'
      primaryUtilizationPct: 12.5,
      primaryResetsAt: '2026-03-07T17:00:00.000Z',
    },
    freshness: { isStale: true, staleReason: 'malformedResponse' },  // degrades: false, 'none'
    rawMetadata: { normalizationWarnings: [...NORMALIZATION_WARNINGS] },  // degrade is []
  });
}

/**
 * Create a valid enterprise UsageSnapshot for tests.
 */
export function makeTestEnterpriseSnapshot(overrides?: Partial<UsageSnapshot>): UsageSnapshot {
  return makeTestSnapshot({
    tier: 'enterprise',
    fiveHour: { utilizationPct: null, resetsAt: null },
    sevenDay: { utilizationPct: null, resetsAt: null },
    enterprise: {
      utilizationPct: 0.1455,
      monthlyLimitCredits: 200000,
      usedCredits: 291,
      currency: 'USD',
      isEnabled: true,
      disabledReason: null,
    },
    display: {
      primaryWindow: 'enterprise',
      primaryUtilizationPct: 0.1455,
      primaryResetsAt: null,
    },
    ...overrides,
  });
}

/**
 * Create a valid CacheEnvelope wrapping a test snapshot.
 *
 * Built by the PRODUCT'S OWN WRITER rather than by a literal. This file previously hardcoded
 * `version: 1`, and `CACHE_VERSION` has been 2 since sdlc/002 — so every envelope from here was
 * one `readCacheResult` would reject as a `versionMismatch`, delete, and report as a cache miss.
 * All 25 call sites happened to pass it to an in-memory mock, so nothing was ever red; the first
 * caller to write one to disk would have paid for it. Delegating removes the class of bug rather
 * than the instance: a version bump or a new envelope field now arrives here for free, and
 * `CACHE_VERSION` stays module-private. (sdlc/024)
 */
export function makeTestEnvelope(overrides?: Partial<CacheEnvelope>): CacheEnvelope {
  return { ...makeCacheEnvelope(makeTestSnapshot()), ...overrides };
}

/**
 * Create a temp directory for cache test isolation.
 * Returns the path to the created directory.
 */
export function makeTempCacheDir(): string {
  const dir = join(tmpdir(), `claudewatch-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Set up an isolated cache directory for tests.
 * Returns a cleanup function to call in afterEach.
 */
export function setupTestCacheDir(): { tempDir: string; cleanup: () => void } {
  const tempDir = makeTempCacheDir();
  setCacheBaseDir(tempDir);
  return {
    tempDir,
    cleanup: () => {
      setCacheBaseDir(null);
      try { rmSync(tempDir, { recursive: true }); } catch { /* ignore */ }
    },
  };
}

export interface SandboxSeed {
  /** Absolute path to the sandbox HOME. Callers own its removal. */
  home: string;
  /** Absolute path to the seeded cache envelope. */
  cachePath: string;
  /** Absolute path to the fixture credential. */
  credentialsPath: string;
  /** The utilization the seeded envelope renders. Assert on THIS, never on a literal. */
  utilizationPct: number;
  /**
   * The child environment that actually isolates a spawn. Spread this — pinning HOME alone is
   * NOT enough: `os.homedir()` follows USERPROFILE on Windows, a supported target (SPEC.md
   * §13.1), so a HOME-only spawn runs against the developer's REAL credentials and REAL cache
   * there. scripts/perf.ts learned that in sdlc/013 and smoke.test.ts did not, which is the
   * same drift this helper exists to end — so the env travels WITH the sandbox rather than
   * being re-derived by each caller. (sdlc/024 security pass)
   */
  env: Record<string, string>;
}

/**
 * Seed an isolated HOME with a fixture credential and a cache envelope, so a test or a
 * benchmark can run the compiled binary without touching the network.
 *
 * This replaces two hand-rolled copies (packages/statusline/src/smoke.test.ts and
 * scripts/perf.ts) that had drifted apart on six of seven rows — one shipped
 * `staleReason: null`, an `ageSeconds` field that does not exist, and no `primaryResetsAt`,
 * none of which `tsc` could see because both were `JSON.stringify` over an unannotated object
 * literal. Routing the snapshot through `makeTestSnapshot`, whose return is annotated
 * `UsageSnapshot`, is the entire guard: a schema change that invalidates this fixture is now a
 * compile error, and `scripts/` has been inside `bun run typecheck` since sdlc/018.
 *
 * Two things a caller must know:
 *
 *  - **`fetchedAt` is a hazard, not a free parameter.** Seeding a stale one puts the binary on
 *    main.ts:249-255, which WRITES the cache — which would trip scripts/perf.ts's mtime guard
 *    and report the samples as non-cache-hits.
 *  - **The `freshness` block is NOT decorative.** An earlier draft of this comment said it was,
 *    on the grounds that `readCacheResult` checks only its presence. That is true of the READER
 *    and false of everything downstream: `freshness.isStale` has nine production readers
 *    (format.ts:82,138,402,429 — which append a literal " stale" to the rendered line —
 *    state.ts:29,40, main.ts:249, extension.ts:172). Seeding `isStale: true` would leave every
 *    smoke assertion green, because they match "42%" and a stale line still contains it, while
 *    silently exercising the stale render path. `seedSandboxHome` therefore keeps
 *    `makeTestSnapshot`'s `isStale: false`, and test-helpers.test.ts asserts it. This is the
 *    second time in one loop that "nothing reads this field" turned out false — the same claim
 *    about `staleReason` was corrected in the spec two sections before this one was written.
 *  - **The default seed expires in 600 seconds**, `isCacheFresh`'s default TTL. A suite that
 *    seeds once and spawns for longer than that will start missing the cache.
 *
 * Cleanup is deliberately the caller's: perf.ts needs signal handlers, smoke.test.ts needs
 * `afterAll`, and both are already correct.
 */
export function seedSandboxHome(opts: {
  prefix: string;
  accessToken: string;
  utilizationPct?: number;
  snapshot?: UsageSnapshot;
  envelope?: Partial<CacheEnvelope>;
  seedCache?: boolean;
  fetchedAt?: string;
  /** Override the deliberately-expired default. Only a case that WANTS a live fetch needs it. */
  expiresAt?: number;
}): SandboxSeed {
  // This is the only code in the repo that writes a file named `.credentials.json`. A prefix
  // carrying a separator or `..` would place one outside tmpdir().
  if (/[/\\]|\.\./.test(opts.prefix)) {
    throw new Error(`seedSandboxHome: prefix must be a bare name, got ${JSON.stringify(opts.prefix)}`);
  }

  let utilizationPct = opts.utilizationPct ?? 42;
  let snapshot: UsageSnapshot | undefined;
  const home = mkdtempSync(join(tmpdir(), opts.prefix));

  // Modes at creation, not after: a writeFileSync-then-chmod leaves a 0644 window, and this
  // helper is a template someone will copy to a path where that matters. There is no trailing
  // chmod — `mode` is ignored only when the file already exists, which cannot happen inside a
  // fresh mkdtemp. (The copy this replaced justified its chmod as "advisory against a
  // permissive umask", which is backwards: umask can only clear bits, never add them.)
  mkdirSync(join(home, '.claude'), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, '.cache', 'claudewatch'), { recursive: true, mode: 0o700 });

  const credentialsPath = join(home, '.claude', '.credentials.json');
  const creds: CredentialFile = {
    claudeAiOauth: {
      accessToken: opts.accessToken,
      refreshToken: 'r',
      // ALREADY EXPIRED, deliberately. The previous copies used a year-2100 timestamp, which
      // made `resolveCredentials` return `valid` — so any path that missed the cache
      // (seedCache: false, an expired 600s TTL, a CACHE_VERSION bump, --refresh) fell through
      // to a LIVE authenticated GET carrying this token. I hit that path by hand while scoping
      // sdlc/024. An expired credential exits 2 at main.ts:273 before `fetchUsage` is reached,
      // which makes the sandbox network-inert BY CONSTRUCTION rather than by every caller
      // remembering to seed a valid cache. The fresh-cache branch at main.ts:240 runs before
      // credentials are resolved at :261, so cache-hit cases are unaffected.
      expiresAt: opts.expiresAt ?? Date.now() - 86_400_000,
    },
  };
  writeFileSync(credentialsPath, JSON.stringify(creds), { mode: 0o600 });

  const cachePath = join(home, '.cache', 'claudewatch', 'usage.json');
  if (opts.seedCache !== false) {
    // Overrides are written as an INLINE literal on purpose: excess-property checking is
    // skipped when the argument is a pre-declared variable, so hoisting this to a `const` would
    // let a stray field through — which is one of the three defects this helper exists to stop.
    snapshot = opts.snapshot ?? makeTestSnapshot({
      fetchedAt: opts.fetchedAt ?? new Date().toISOString(),
      fiveHour: { utilizationPct, resetsAt: '2099-01-01T00:00:00.000Z' },
      sevenDay: { utilizationPct: 18, resetsAt: '2099-01-01T00:00:00.000Z' },
      display: {
        primaryWindow: 'fiveHour',
        primaryUtilizationPct: utilizationPct,
        primaryResetsAt: '2099-01-01T00:00:00.000Z',
      },
    });
    // Derived from the snapshot actually seeded, not echoed back from the input: a caller who
    // passes `snapshot` would otherwise get `utilizationPct` reporting 42 regardless, which
    // would make the field's own docstring ("assert on THIS") a lie.
    utilizationPct = snapshot.display.primaryUtilizationPct ?? utilizationPct;
    writeFileSync(
      cachePath,
      JSON.stringify(makeTestEnvelope({ snapshot, ...opts.envelope })),
      { mode: 0o600 },
    );
  }

  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,   // os.homedir() follows this on Windows
    HOMEDRIVE: '',
    HOMEPATH: home,
    CLAUDEWATCH_TELEMETRY: '0',
    // Since sdlc/034, sandboxing HOME no longer sandboxes the cache: getCacheDir() honours
    // $XDG_CACHE_HOME, which bypasses homedir() entirely. Every spawn site merges this over
    // process.env, so without pinning it a developer or CI runner with the variable set would have
    // the seed written under the sandbox home and the binary reading the ambient path — a
    // guaranteed miss, and perf.ts's sentinel throwing. Measured before it was written.
    XDG_CACHE_HOME: join(home, '.cache'),
  };

  return { home, cachePath, credentialsPath, utilizationPct, env };
}
