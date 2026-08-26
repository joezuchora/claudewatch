import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MetricsStore } from './store.js';
import { collectDetectorInput, GENERAL_LIMIT } from './detector-input.js';
import { detect, BOUNDS } from './anomaly.js';

let n = 0;
function evt(overrides: Record<string, unknown> = {}) {
  n++;
  return {
    eventId: `e${n}-${crypto.randomUUID()}`,
    // Distinct, increasing ts so ordering is well defined. receivedAt is stamped at ingest.
    ts: new Date(Date.parse('2026-08-26T00:00:00.000Z') + n * 1000).toISOString(),
    source: 'sdlc',
    kind: 'verify_run',
    ok: true,
    durationMs: 6_000,
    schemaVersion: 1,
    payload: { outcome: 'pass' },
    ...overrides,
  };
}

describe('collectDetectorInput', () => {
  let store: MetricsStore;
  beforeEach(() => { store = new MetricsStore(':memory:'); });
  afterEach(() => { store.close(); });

  test('THE DEFECT: a store flooded with render events still yields verify runs', () => {
    // The old composition was store.query({ limit: 1000 }) with no kind filter, ordered
    // received_at DESC. Ingest the verify runs FIRST, then 1200 renders, and the runs fall off
    // the end of that 1000 — the detector would report insufficient-data forever while the
    // store holds them. One render per statusline invocation makes this minutes of real use.
    store.ingest(Array.from({ length: 30 }, () => evt()));
    store.ingest(Array.from({ length: 1_200 }, () =>
      evt({ kind: 'render', durationMs: null, payload: { state: 'Healthy' } })));

    const oldWay = store.query({ limit: 1_000 }).filter((e) => e.kind === 'verify_run');
    expect(oldWay.length).toBeLessThan(BOUNDS.minVerifyRuns);   // the defect, demonstrated

    const input = collectDetectorInput(store);
    const runs = input.filter((e) => e.kind === 'verify_run');
    expect(runs).toHaveLength(30);
    expect(detect(input, Date.now()).status).not.toBe('insufficient-data');
  });

  test('the two queries overlap, and the overlap is deduplicated', () => {
    // Both queries return the same recent verify runs. A duplicated run would silently distort
    // a p95, so this is asserted rather than assumed.
    store.ingest(Array.from({ length: 10 }, () => evt()));
    const input = collectDetectorInput(store);
    expect(input).toHaveLength(10);
    expect(new Set(input.map((e) => e.eventId)).size).toBe(10);
  });

  test('the kind query guarantees a FLOOR of verify runs, it does not cap them', () => {
    // Worth stating precisely, because the first draft of this test asserted a cap and failed.
    // With no flood, the general query already returns every run, so the union is all 200 —
    // harmless, since detectDurationOutlier slices its own window and the extra runs only help
    // the minVerifyRuns guard and detectPassRate.
    store.ingest(Array.from({ length: 200 }, () => evt()));
    expect(collectDetectorInput(store).filter((e) => e.kind === 'verify_run')).toHaveLength(200);

    // What the kind query actually buys: a floor that survives any volume of other kinds.
    const flooded = new MetricsStore(':memory:');
    flooded.ingest(Array.from({ length: 200 }, () => evt()));
    flooded.ingest(Array.from({ length: 1_200 }, () =>
      evt({ kind: 'render', durationMs: null, payload: { state: 'Healthy' } })));
    const runs = collectDetectorInput(flooded).filter((e) => e.kind === 'verify_run');
    expect(runs).toHaveLength(BOUNDS.verifyBaselineWindow + 1);
    flooded.close();
  });

  test('other kinds still reach the time-windowed detectors', () => {
    store.ingest(Array.from({ length: 5 }, () =>
      evt({ kind: 'schema_drift', durationMs: null, payload: { category: 'unknownWindow' } })));
    const input = collectDetectorInput(store);
    expect(input.filter((e) => e.kind === 'schema_drift')).toHaveLength(5);
  });

  test('an empty store returns nothing rather than throwing', () => {
    expect(collectDetectorInput(store)).toEqual([]);
  });

  test('GENERAL_LIMIT is the store cap, so the general query is not silently truncated further', () => {
    expect(GENERAL_LIMIT).toBe(1_000);
  });
});

describe('cli-detect, run the way a user runs it', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cw-detect-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('prints the baseline line against a fixture db', async () => {
    // Spawned, not imported. cli-detect composes its input at its own top level, which is
    // exactly where the defect this loop fixes was living — and exactly what an import-based
    // test cannot reach. sdlc/005 and sdlc/009 both shipped a defect of this shape.
    const db = join(dir, 'metrics.db');
    const store = new MetricsStore(db);
    store.ingest(Array.from({ length: 25 }, () => evt()));
    store.close();

    const proc = Bun.spawn(['bun', 'run', 'src/cli-detect.ts'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        ...process.env,
        CLAUDEWATCH_METRICS_DB: db,
        CLAUDEWATCH_REPO: dir,
        CLAUDEWATCH_SUPPRESSIONS: join(dir, 'suppressions.json'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;

    expect(proc.exitCode).toBe(0);
    expect(out).toContain('baseline: p95 6000ms over 24 runs (window 50), threshold 120000ms');
    expect(out).toContain('healthy');
  }, 30_000);
});
