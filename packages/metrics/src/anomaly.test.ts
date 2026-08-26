import { describe, expect, test } from 'bun:test';
import { detect, BOUNDS, type Suppression } from './anomaly.js';
import type { StoredEvent } from './types.js';

const T0 = Date.parse('2026-08-26T08:00:00.000Z');
const hoursAgo = (h: number) => new Date(T0 - h * 3_600_000).toISOString();

let seq = 0;
function ev(o: Partial<StoredEvent> & { kind: string }): StoredEvent {
  seq++;
  return {
    eventId: `e${seq}`,
    ts: hoursAgo(1),
    receivedAt: hoursAgo(1),
    source: 'sdlc',
    ok: true,
    durationMs: null,
    schemaVersion: 1,
    payload: {},
    ...o,
  } as StoredEvent;
}

/** N verify runs at ~30s, oldest first. */
function baselineRuns(n: number, durationMs = 30_000, ok = true): StoredEvent[] {
  return Array.from({ length: n }, (_, i) =>
    ev({ kind: 'verify_run', durationMs, ok, receivedAt: hoursAgo(n - i + 1), payload: { outcome: ok ? 'pass' : 'fail' } }));
}

describe('detect: the minimum-sample guard', () => {
  test('an empty store is insufficient-data, NOT healthy', () => {
    const r = detect([], T0);
    expect(r.status).toBe('insufficient-data');
  });

  test('one below the minimum is still insufficient-data', () => {
    const r = detect(baselineRuns(BOUNDS.minVerifyRuns - 1), T0);
    expect(r.status).toBe('insufficient-data');
    if (r.status === 'insufficient-data') {
      expect(r.have).toBe(BOUNDS.minVerifyRuns - 1);
      expect(r.need).toBe(BOUNDS.minVerifyRuns);
    }
  });

  test('at the minimum, evaluation begins', () => {
    const r = detect(baselineRuns(BOUNDS.minVerifyRuns), T0);
    expect(r.status).toBe('healthy');
  });

  test('non-verify events do not count toward the minimum', () => {
    const noise = Array.from({ length: 50 }, () => ev({ kind: 'render' }));
    expect(detect(noise, T0).status).toBe('insufficient-data');
  });
});

describe('detect: verify_duration_outlier', () => {
  const withLatest = (ms: number) => [...baselineRuns(25), ev({
    kind: 'verify_run', durationMs: ms, ok: false, receivedAt: hoursAgo(0), payload: { outcome: 'timeout' },
  })];

  test('THE CASE THIS EXISTS FOR: a 550s run among ~30s runs raises', () => {
    const r = detect(withLatest(550_000), T0);
    expect(r.status).toBe('anomalies');
    if (r.status === 'anomalies') {
      expect(r.anomalies[0]!.kind).toBe('verify_duration_outlier');
      expect(r.anomalies[0]!.severity).toBe('high');
      expect(r.anomalies[0]!.evidence.outcome).toBe('timeout');
    }
  });

  test('just BELOW the bound does not raise — the false-positive side', () => {
    // 3.9x of a 30s p95.
    const r = detect(withLatest(30_000 * (BOUNDS.durationOutlierMultiple - 0.1)), T0);
    expect(r.status).toBe('healthy');
  });

  test('just ABOVE the bound raises', () => {
    const r = detect(withLatest(30_000 * (BOUNDS.durationOutlierMultiple + 0.1)), T0);
    expect(r.status).toBe('anomalies');
  });

  test('a normal slow-but-not-hung run does not raise', () => {
    // 43s against a 30s baseline — the real spread observed in this repo.
    expect(detect(withLatest(43_000), T0).status).toBe('healthy');
  });

  test('identical durations do not divide by zero or raise', () => {
    const r = detect(baselineRuns(25, 30_000), T0);
    expect(r.status).toBe('healthy');
  });
});

describe('detect: verify_pass_rate', () => {
  /** Last `bad` of 10 failing, on top of a healthy baseline. */
  const withRecent = (bad: number) => {
    // The older block must be strictly OLDER than the recent block, or sorting interleaves
    // them and slice(-10) is not the window the test means. (It did, the first time.)
    const older = Array.from({ length: 20 }, (_, i) =>
      ev({ kind: 'verify_run', durationMs: 30_000, ok: true, receivedAt: hoursAgo(100 - i) }));
    const recent = Array.from({ length: 10 }, (_, i) =>
      ev({ kind: 'verify_run', durationMs: 30_000, ok: i >= bad, receivedAt: hoursAgo(10 - i) }));
    return [...older, ...recent];
  };

  test('below the bound raises', () => {
    // 4 of 10 failing = 60%, below 70%.
    const r = detect(withRecent(4), T0);
    expect(r.status).toBe('anomalies');
    if (r.status === 'anomalies') {
      expect(r.anomalies.some((a) => a.kind === 'verify_pass_rate')).toBe(true);
    }
  });

  test('exactly AT the bound does not raise', () => {
    // 3 of 10 failing = 70%, which is not below 70%.
    const r = detect(withRecent(3), T0);
    if (r.status === 'anomalies') {
      expect(r.anomalies.some((a) => a.kind === 'verify_pass_rate')).toBe(false);
    }
  });

  test("today's three red gates would NOT have raised", () => {
    // 3 failures among 23 runs, none consecutive enough to drop the last 10 below 70%.
    const runs = baselineRuns(23).map((r, i) =>
      i === 5 || i === 11 || i === 17 ? { ...r, ok: false } : r);
    expect(detect(runs, T0).status).toBe('healthy');
  });
});

describe('detect: schema_drift_spike', () => {
  const drift = (h: number) => ev({ kind: 'schema_drift', receivedAt: hoursAgo(h), ok: false, payload: { category: 'timestamp', count: 1 } });

  test('three in 24h with a clean prior week raises', () => {
    const r = detect([...baselineRuns(25), drift(1), drift(2), drift(3)], T0);
    expect(r.status).toBe('anomalies');
    if (r.status === 'anomalies') {
      expect(r.anomalies.some((a) => a.kind === 'schema_drift_spike')).toBe(true);
    }
  });

  test('two in 24h does not raise — below the bound', () => {
    const r = detect([...baselineRuns(25), drift(1), drift(2)], T0);
    expect(r.status).toBe('healthy');
  });

  test('drift that was already the norm is not a spike', () => {
    // Same 3 recent, but the prior week had drift too. That is the status quo, not news.
    const r = detect([...baselineRuns(25), drift(1), drift(2), drift(3), drift(100)], T0);
    expect(r.status).toBe('healthy');
  });
});

describe('detect: fetch_failure_rate', () => {
  const fetches = (total: number, failed: number) =>
    Array.from({ length: total }, (_, i) =>
      ev({ kind: 'fetch_result', ok: i >= failed, receivedAt: hoursAgo(1) }));

  test('a majority failing over a sufficient sample raises', () => {
    const r = detect([...baselineRuns(25), ...fetches(10, 8)], T0);
    expect(r.status).toBe('anomalies');
    if (r.status === 'anomalies') {
      expect(r.anomalies.some((a) => a.kind === 'fetch_failure_rate')).toBe(true);
    }
  });

  test('too small a sample does not raise, however bad it looks', () => {
    // 3 of 3 failing is 100%, but three events is not evidence.
    const r = detect([...baselineRuns(25), ...fetches(3, 3)], T0);
    expect(r.status).toBe('healthy');
  });

  test('exactly at the rate bound does not raise', () => {
    const r = detect([...baselineRuns(25), ...fetches(10, 5)], T0);
    expect(r.status).toBe('healthy');
  });
});

describe('detect: suppression', () => {
  const hang = [...baselineRuns(25), ev({
    kind: 'verify_run', durationMs: 550_000, ok: false, receivedAt: hoursAgo(0), payload: { outcome: 'timeout' },
  })];

  test('a repeat within the window is suppressed and REPORTED as suppressed', () => {
    const first = detect(hang, T0);
    expect(first.status).toBe('anomalies');
    const fp = first.status === 'anomalies' ? first.anomalies[0]!.fingerprint : '';

    const sup: Suppression[] = [{ fingerprint: fp, raisedAt: hoursAgo(1) }];
    const second = detect(hang, T0, sup);

    expect(second.status).toBe('healthy');
    // Reported, not silently dropped — a detector that hides its decisions cannot be debugged.
    if (second.status === 'healthy') {
      expect(second.suppressed.map((a) => a.fingerprint)).toContain(fp);
    }
  });

  test('the same condition after the window raises again', () => {
    const first = detect(hang, T0);
    const fp = first.status === 'anomalies' ? first.anomalies[0]!.fingerprint : '';
    const stale: Suppression[] = [{ fingerprint: fp, raisedAt: hoursAgo(BOUNDS.suppressionHours + 1) }];
    expect(detect(hang, T0, stale).status).toBe('anomalies');
  });

  test('a corrupt or unparseable raisedAt does not suppress', () => {
    const first = detect(hang, T0);
    const fp = first.status === 'anomalies' ? first.anomalies[0]!.fingerprint : '';
    expect(detect(hang, T0, [{ fingerprint: fp, raisedAt: 'not a date' }]).status).toBe('anomalies');
  });

  test('an unrelated fingerprint does not suppress', () => {
    expect(detect(hang, T0, [{ fingerprint: 'something_else:1', raisedAt: hoursAgo(1) }]).status)
      .toBe('anomalies');
  });

  test('the same condition produces a stable fingerprint across repeats', () => {
    const a = detect(hang, T0);
    const b = detect(hang, T0 + 3_600_000);
    if (a.status === 'anomalies' && b.status === 'anomalies') {
      expect(a.anomalies[0]!.fingerprint).toBe(b.anomalies[0]!.fingerprint);
    }
  });
});

describe('detect: ordering within a shipped batch', () => {
  test('REGRESSION: a batch shares one receivedAt, so ts must break the tie', () => {
    // The agent ships a whole spool as ONE batch, and the store stamps receivedAt at ingest.
    // Every event in the batch therefore has an identical receivedAt and cannot be ordered by
    // it. Sorting on receivedAt alone made "the latest run" arbitrary, and the detector
    // reported healthy while a 550s hang sat in the data.
    //
    // Found by running against a real batched store. Every fixture above gives events
    // distinct receivedAt values by hand, which hid this completely.
    const batchStamp = hoursAgo(0);
    const runs: StoredEvent[] = [];
    for (let i = 0; i < 25; i++) {
      runs.push(ev({
        kind: 'verify_run', durationMs: 30_000, ok: true,
        receivedAt: batchStamp,               // identical across the batch
        ts: hoursAgo(30 - i),                 // only this distinguishes them
        payload: { outcome: 'pass' },
      }));
    }
    runs.push(ev({
      kind: 'verify_run', durationMs: 550_000, ok: false,
      receivedAt: batchStamp,
      ts: hoursAgo(0),                        // genuinely the latest
      payload: { outcome: 'timeout' },
    }));

    const r = detect(runs, T0);
    expect(r.status).toBe('anomalies');
    if (r.status === 'anomalies') {
      expect(r.anomalies[0]!.kind).toBe('verify_duration_outlier');
    }
  });

  test('a batch with the hang FIRST by ts does not report it as latest', () => {
    // The mirror case: the hang is old, the recent runs are fine. Nothing should raise.
    const batchStamp = hoursAgo(0);
    const runs: StoredEvent[] = [ev({
      kind: 'verify_run', durationMs: 550_000, ok: false,
      receivedAt: batchStamp, ts: hoursAgo(100), payload: { outcome: 'timeout' },
    })];
    for (let i = 0; i < 25; i++) {
      runs.push(ev({
        kind: 'verify_run', durationMs: 30_000, ok: true,
        receivedAt: batchStamp, ts: hoursAgo(30 - i), payload: { outcome: 'pass' },
      }));
    }
    expect(detect(runs, T0).status).toBe('healthy');
  });
});
