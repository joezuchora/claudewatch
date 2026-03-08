import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { readCache, writeCache, isCacheFresh, makeCacheEnvelope, getCachePath, getCacheDir } from './cache.js';
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
      expect(envelope.version).toBe(1);
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

    test('returns true for snapshot at exactly TTL boundary minus 1ms', () => {
      const justUnder = new Date(Date.now() - 59_999).toISOString();
      const snapshot = makeTestSnapshot({ fetchedAt: justUnder });
      const envelope = makeCacheEnvelope(snapshot);
      expect(isCacheFresh(envelope, 60)).toBe(true);
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

  describe('writeCache and readCache round-trip', () => {
    test('writes and reads back correctly', () => {
      const snapshot = makeTestSnapshot();
      const envelope = makeCacheEnvelope(snapshot);
      writeCache(envelope);
      const read = readCache();
      expect(read).not.toBeNull();
      expect(read!.version).toBe(1);
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
