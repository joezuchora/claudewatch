import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MetricsStore, SCHEMA_VERSION } from './store.js';

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
