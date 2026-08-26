/**
 * Shared test fixtures for ClaudeWatch test suites.
 * Not shipped in production — only imported by *.test.ts files.
 */
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import type { UsageSnapshot, CacheEnvelope } from './types.js';
import { setCacheBaseDir } from './cache.js';

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
 */
export function makeTestEnvelope(overrides?: Partial<CacheEnvelope>): CacheEnvelope {
  return {
    version: 1,
    snapshot: makeTestSnapshot(),
    cooldownUntil: null,
    lastErrorClass: null,
    lastHttpStatus: null,
    lastErrorMessage: null,
    ...overrides,
  };
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
