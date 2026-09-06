import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { tmpdir } from 'os';
import { MetricsStore } from './store.js';
import { collectDetectorInput } from './detector-input.js';
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

  test('the four queries overlap, and the overlap is deduplicated', () => {
    // NOT a regression test — it guards a hazard this change INTRODUCES. The old code made one
    // query and could not double-count; four overlapping queries can, and a duplicated run
    // would silently distort a p95. Recorded as such because the plan-to-diff audit caught me
    // claiming every test here discriminated against the old code. This one cannot, by
    // construction, and saying so is better than a test that quietly proves less than claimed.
    store.ingest(Array.from({ length: 10 }, () => evt()));
    store.ingest(Array.from({ length: 4 }, () =>
      evt({ kind: 'schema_drift', durationMs: null, payload: { category: 'unknownWindow' } })));
    store.ingest(Array.from({ length: 4 }, () =>
      evt({ kind: 'fetch_result', durationMs: 120, payload: { statusClass: '2xx' } })));

    const input = collectDetectorInput(store);
    expect(input).toHaveLength(18);
    expect(new Set(input.map((e) => e.eventId)).size).toBe(18);
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

  test('THE OTHER HALF: drift events survive the same flood', () => {
    // The security pass pointed out that fixing only verify_run left detectDriftSpike and
    // detectFetchFailures starving under exactly the flood this file's first test constructs.
    // Documenting a known blind spot in a monitoring component, in a loop whose whole subject
    // is that blind spot, would have been a strange choice.
    store.ingest(Array.from({ length: 5 }, () =>
      evt({ kind: 'schema_drift', durationMs: null, payload: { category: 'unknownWindow' } })));
    store.ingest(Array.from({ length: 1_200 }, () =>
      evt({ kind: 'render', durationMs: null, payload: { state: 'Healthy' } })));

    expect(store.query({ limit: 1_000 }).filter((e) => e.kind === 'schema_drift')).toHaveLength(0);
    expect(collectDetectorInput(store).filter((e) => e.kind === 'schema_drift')).toHaveLength(5);
  });

  test('THE OTHER HALF: fetch_result events survive the same flood', () => {
    store.ingest(Array.from({ length: 8 }, () =>
      evt({ kind: 'fetch_result', durationMs: 120, ok: false, payload: { statusClass: '5xx' } })));
    store.ingest(Array.from({ length: 1_200 }, () =>
      evt({ kind: 'render', durationMs: null, payload: { state: 'Healthy' } })));

    expect(store.query({ limit: 1_000 }).filter((e) => e.kind === 'fetch_result')).toHaveLength(0);
    expect(collectDetectorInput(store).filter((e) => e.kind === 'fetch_result')).toHaveLength(8);
  });

  test('the kind-scoped lookback is bounded, so it does not rescue ancient events', () => {
    // Second time I wrote this test asserting a CAP when the design gives a FLOOR. The general
    // query still sweeps recent events of every kind regardless; the kind-scoped queries only
    // guarantee a minimum. So the lookback is only observable under a flood, where the general
    // query has nothing left to contribute.
    //
    // The drift query reaches 8 days, matching what detectDriftSpike compares against; the
    // fetch query reaches 24h, matching its window. Older than that is not its business.
    store.ingest([evt({ kind: 'schema_drift', durationMs: null })]);
    store.ingest(Array.from({ length: 1_200 }, () =>
      evt({ kind: 'render', durationMs: null, payload: { state: 'Healthy' } })));

    // Evaluated ten days on, the one drift event is outside both the flood-cleared general
    // query and the 8-day kind query.
    const tenDaysOn = Date.now() + 10 * 24 * 3_600_000;
    expect(collectDetectorInput(store, tenDaysOn).filter((e) => e.kind === 'schema_drift'))
      .toHaveLength(0);
    // ...but within the lookback it is rescued, which is the whole point.
    expect(collectDetectorInput(store).filter((e) => e.kind === 'schema_drift'))
      .toHaveLength(1);
  });

  test('an empty store returns nothing rather than throwing', () => {
    // A triviality guard, not a regression test. It would pass against the old code too.
    expect(collectDetectorInput(store)).toEqual([]);
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
      // fileURLToPath, not `.pathname` — a URL path never decodes percent-escapes, so a
      // checkout under a directory with a space in it would fail with an opaque ENOENT.
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      // An explicit allowlist rather than ...process.env. The child prints nothing derived
      // from its environment, but handing a subprocess every variable a developer happens to
      // have exported is a surface with no upside.
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        CLAUDEWATCH_METRICS_DB: db,
        CLAUDEWATCH_REPO: dir,
        CLAUDEWATCH_SUPPRESSIONS: join(dir, 'suppressions.json'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // Both streams, concurrently. An unread stderr pipe deadlocks the child once it fills, and
    // a failure with no stderr in the message tells you nothing about why.
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    expect({ code: proc.exitCode, err }).toEqual({ code: 0, err: '' });
    expect(out).toContain('baseline: p95 6000ms over 24 runs (window 50), threshold 120000ms');
    expect(out).toContain('healthy');
  }, 30_000);
});
