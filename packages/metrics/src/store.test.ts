import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { MetricsStore, SCHEMA_VERSION, BUSY_TIMEOUT_MS } from './store.js';

function evt(overrides: Record<string, unknown> = {}) {
  return {
    eventId: crypto.randomUUID(),
    ts: new Date().toISOString(),
    source: 'sdlc',
    kind: 'verify_run',
    ok: true,
    durationMs: 35000,
    schemaVersion: 1,
    payload: { outcome: 'pass' },
    ...overrides,
  };
}

describe('MetricsStore', () => {
  let store: MetricsStore;
  beforeEach(() => { store = new MetricsStore(':memory:'); });
  afterEach(() => { store.close(); });

  test('creates its schema and records a version', () => {
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
  });

  test('ingests and returns events', () => {
    const r = store.ingest([evt(), evt()]);
    expect(r).toEqual({ accepted: 2, duplicates: 0, rejected: 0 });
    expect(store.query()).toHaveLength(2);
  });

  test('a duplicate eventId yields one row, not two', () => {
    const e = evt();
    expect(store.ingest([e]).accepted).toBe(1);
    const second = store.ingest([e]);
    expect(second.accepted).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(store.query()).toHaveLength(1);
  });

  test('rejects structurally invalid events without failing the batch', () => {
    const r = store.ingest([evt(), null, { nope: true }, 'string', evt()]);
    expect(r.accepted).toBe(2);
    expect(r.rejected).toBe(3);
  });

  test('stores an unknown schemaVersion rather than dropping it', () => {
    store.ingest([evt({ schemaVersion: 999 })]);
    expect(store.query()[0]!.schemaVersion).toBe(999);
  });

  test('filters by source, kind and since', () => {
    store.ingest([
      evt({ source: 'product', kind: 'render' }),
      evt({ source: 'sdlc', kind: 'verify_run' }),
    ]);
    expect(store.query({ source: 'product' })).toHaveLength(1);
    expect(store.query({ kind: 'verify_run' })).toHaveLength(1);
    expect(store.query({ since: '2099-01-01T00:00:00.000Z' })).toHaveLength(0);
  });

  test('limit is clamped to a sane range', () => {
    store.ingest(Array.from({ length: 30 }, () => evt()));
    expect(store.query({ limit: 5 })).toHaveLength(5);
    expect(store.query({ limit: 100000 }).length).toBeLessThanOrEqual(1000);
  });

  test('stats compute pass rate, percentiles and timeouts', () => {
    store.ingest([
      evt({ ok: true, durationMs: 30000 }),
      evt({ ok: true, durationMs: 35000 }),
      evt({ ok: false, durationMs: 550000, payload: { outcome: 'timeout' } }),
      evt({ ok: true, durationMs: 32000 }),
    ]);
    const s = store.stats();
    expect(s.verify.runs).toBe(4);
    expect(s.verify.passRate).toBeCloseTo(0.75, 5);
    expect(s.verify.timeouts).toBe(1);
    expect(s.verify.maxDurationMs).toBe(550000);
    expect(s.verify.p50DurationMs).not.toBeNull();
  });

  test('stats on an empty store do not divide by zero', () => {
    const s = store.stats();
    expect(s.totalEvents).toBe(0);
    expect(s.verify.passRate).toBeNull();
    expect(s.verify.p95DurationMs).toBeNull();
  });

  test('prune removes events past the retention window', () => {
    store.ingest([evt()]);
    expect(store.prune(90)).toBe(0); // recent, retained

    // A negative window puts the cutoff in the future, so everything is past it. Using 0
    // would be flaky: ingest and prune can land on the same millisecond, and the comparison
    // is strictly less-than.
    expect(store.prune(-1)).toBe(1);
    expect(store.query()).toHaveLength(0);
  });

  test('reports health', () => {
    expect(store.healthy()).toBe(true);
  });
});

describe('MetricsStore: durability', () => {
  test('a restarted store returns previously ingested events', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-metrics-'));
    const path = join(dir, 'metrics.db');
    try {
      const first = new MetricsStore(path);
      first.ingest([evt(), evt()]);
      first.close();

      // Fresh instance, same file — this is the "survives restarts" requirement.
      const second = new MetricsStore(path);
      expect(second.query()).toHaveLength(2);
      expect(second.schemaVersion()).toBe(SCHEMA_VERSION);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MetricsStore: two processes, one database (sdlc/013)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cw-busy-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('REGRESSION: a connection WAITS for a held lock instead of dying on SQLITE_BUSY', async () => {
    // Reproduces the CI failure exactly. Two conditions are BOTH required, and getting one
    // wrong is why my first attempt at this test passed with the fix removed:
    //
    //   1. The database must be in the DEFAULT journal mode, so the WAL transition genuinely
    //      needs an exclusive lock. Creating it through MetricsStore first sets WAL, after
    //      which `PRAGMA journal_mode = WAL` is a no-op that never blocks.
    //   2. Another PROCESS must hold a write lock — the shipped deployment's shape, where
    //      claudewatch-metrics.service holds the database while the hourly loop ships into it
    //      and metrics:detect reads it.
    //
    // Verified by mutation: without the busy_timeout pragma this throws "database is locked",
    // which is the error CI produced on a docs-only commit.
    const path = join(dir, 'metrics.db');
    const seed = new Database(path, { create: true });
    seed.run('CREATE TABLE placeholder(x)');   // default journal mode, deliberately not WAL
    seed.close();

    const holder = Bun.spawn(['bun', '-e', `
      const { Database } = require('bun:sqlite');
      const db = new Database(${JSON.stringify(path)});
      db.run('BEGIN EXCLUSIVE');
      console.log('locked');
      setTimeout(() => { db.run('COMMIT'); db.close(); }, 600);
    `], { stdout: 'pipe', stderr: 'pipe' });

    // Wait until the lock is actually held before racing it.
    const reader = holder.stdout.getReader();
    await reader.read();
    reader.releaseLock();

    // This is the constructor line that threw SQLITE_BUSY in CI.
    const second = new MetricsStore(path);
    expect(second.schemaVersion()).toBe(SCHEMA_VERSION);
    second.close();
    await holder.exited;
  }, 30_000);

  test('the busy timeout is set on the connection, not merely intended', () => {
    // Mutation-visible: deleting the pragma makes this read 0. Asserted through a second
    // connection's own pragma so the value is observed rather than assumed — busy_timeout is
    // per-connection, so a store that forgot it would report 0 here.
    const path = join(dir, 'metrics.db');
    const store = new MetricsStore(path);
    try {
      expect(BUSY_TIMEOUT_MS).toBeGreaterThan(0);
      expect(store.busyTimeoutMs()).toBe(BUSY_TIMEOUT_MS);
    } finally {
      store.close();
    }
  });
});
