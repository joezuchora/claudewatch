import { describe, expect, test } from 'bun:test';
import {
  durationRatioBand, detect, BOUNDS, formatBaseline, measureFreshness, formatFreshness, formatAgeMs,
  ANOMALY_KINDS, type Suppression,
} from './anomaly.js';
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

describe('detect: the baseline window (sdlc/012)', () => {
  /** Runs at `ms`, oldest first, continuing a sequence so receivedAt stays ordered. */
  function era(n: number, ms: number, startHoursAgo: number): StoredEvent[] {
    return Array.from({ length: n }, (_, i) =>
      ev({
        kind: 'verify_run',
        durationMs: ms,
        receivedAt: hoursAgo(startHoursAgo - i * 0.001),
        payload: { outcome: 'pass' },
      }));
  }

  test('a slow era outside the window does not set the baseline', () => {
    // 60 runs at 60s, then 60 at 6s. The last 50 before the latest are all fast, so a windowed
    // p95 is in the 6s regime. An ALL-TIME p95 is sorted[113] of 119 — squarely in the 60s
    // regime. The counts matter: with only 30 fast runs the window would still hold 21 slow
    // ones and sorted[47] would land among them, and this test would pass against the very
    // code it exists to reject.
    const runs = [...era(60, 60_000, 10), ...era(60, 6_000, 4)];
    const r = detect(runs, T0);
    expect(r.status).toBe('healthy');
    if (r.status === 'healthy') {
      expect(r.durationBaseline).toBeDefined();
      expect(r.durationBaseline!.p95Ms).toBe(6_000);
      expect(r.durationBaseline!.samples).toBe(BOUNDS.verifyBaselineWindow);
      expect(r.durationBaseline!.windowSize).toBe(BOUNDS.verifyBaselineWindow);
    }
  });

  test('the window respects (receivedAt, ts), not insertion order', () => {
    // One batch shares a receivedAt; ts breaks the tie. Build it shuffled and assert the
    // window still ends at the newest ts. Mirrors the sdlc/009 regression above.
    const shared = hoursAgo(1);
    const batch = Array.from({ length: 60 }, (_, i) =>
      ev({
        kind: 'verify_run',
        durationMs: i === 59 ? 550_000 : 6_000,
        ts: new Date(T0 - (60 - i) * 60_000).toISOString(),
        receivedAt: shared,
        payload: { outcome: i === 59 ? 'timeout' : 'pass' },
      }));
    const shuffled = [...batch.slice(30), ...batch.slice(0, 30)];

    const r = detect(shuffled, T0);
    expect(r.status).toBe('anomalies');
    if (r.status === 'anomalies') {
      expect(r.anomalies[0]!.kind).toBe('verify_duration_outlier');
      // The hang is the LATEST by ts, so it must not also be in its own baseline.
      expect(r.durationBaseline!.p95Ms).toBe(6_000);
    }
  });
});

describe('detect: the absolute floor (sdlc/012)', () => {
  const fastBaseline = (n = 25) => baselineRuns(n, 6_000);
  const withLatest = (ms: number, n = 25) => [...fastBaseline(n), ev({
    kind: 'verify_run', durationMs: ms, receivedAt: hoursAgo(0), payload: { outcome: 'pass' },
  })];

  test('REGRESSION: 59.5s against a 6s p95 does not raise — a stale tree is not a hang', () => {
    // The exact run from the real store: ts 10:30:54, durationMs 59483, passing, four steps,
    // no timeout — one of my own before/after measurements on a stashed pre-011 tree, sitting
    // between fast runs on both sides. It is a 9.9x ratio. An earlier draft of this loop set
    // the wire at 8x of the median and would have raised a high-severity incident about it.
    const r = detect(withLatest(59_483), T0);
    expect(r.status).toBe('healthy');
  });

  test('exactly at the floor does not fire', () => {
    expect(detect(withLatest(BOUNDS.minOutlierMs), T0).status).toBe('healthy');
  });

  test('one ms above the floor fires', () => {
    const r = detect(withLatest(BOUNDS.minOutlierMs + 1), T0);
    expect(r.status).toBe('anomalies');
    if (r.status === 'anomalies') {
      expect(r.anomalies[0]!.evidence.thresholdMs).toBe(BOUNDS.minOutlierMs);
    }
  });

  test('the case this exists for still fires against a FAST baseline', () => {
    const r = detect(withLatest(550_000), T0);
    expect(r.status).toBe('anomalies');
    if (r.status === 'anomalies') expect(r.anomalies[0]!.severity).toBe('high');
  });

  test('the ratio alone is not enough: 100x of a 100ms baseline stays under the floor', () => {
    const r = detect([...baselineRuns(25, 100), ev({
      kind: 'verify_run', durationMs: 10_000, receivedAt: hoursAgo(0), payload: { outcome: 'pass' },
    })], T0);
    expect(r.status).toBe('healthy');
  });

  test('a faster-than-baseline run never fires, at any ratio', () => {
    for (const ms of [1, 100, 5_999]) {
      expect(detect(withLatest(ms), T0).status).toBe('healthy');
    }
  });
});

describe('detect: the baseline is reported, not just used (sdlc/012)', () => {
  test('a null latest duration still reports the baseline', () => {
    // The case a reader most needs it: no verdict was reached, so without this the output says
    // nothing at all about what the detector could see.
    const runs = [...baselineRuns(25, 6_000), ev({
      kind: 'verify_run', durationMs: null, receivedAt: hoursAgo(0), payload: { outcome: 'pass' },
    })];
    const r = detect(runs, T0);
    expect(r.status).toBe('healthy');
    if (r.status === 'healthy') {
      expect(r.durationBaseline).toBeDefined();
      expect(r.durationBaseline!.p95Ms).toBe(6_000);
      expect(r.durationBaseline!.thresholdMs).toBe(BOUNDS.minOutlierMs);
    }
  });

  test('19 non-null durations in the window give a verdict', () => {
    const nulls = Array.from({ length: 31 }, (_, i) =>
      ev({ kind: 'verify_run', durationMs: null, receivedAt: hoursAgo(9 - i * 0.01) }));
    const real = baselineRuns(19, 6_000);
    const r = detect([...nulls, ...real, ev({
      kind: 'verify_run', durationMs: 6_000, receivedAt: hoursAgo(0),
    })], T0);
    expect(r.status).toBe('healthy');
    if (r.status === 'healthy') expect(r.durationBaseline!.samples).toBe(19);
  });

  test('18 non-null durations give none, and report no baseline', () => {
    const nulls = Array.from({ length: 32 }, (_, i) =>
      ev({ kind: 'verify_run', durationMs: null, receivedAt: hoursAgo(9 - i * 0.01) }));
    const real = baselineRuns(18, 6_000);
    const r = detect([...nulls, ...real, ev({
      kind: 'verify_run', durationMs: 550_000, receivedAt: hoursAgo(0),
    })], T0);
    // Enough verify_run EVENTS to pass minVerifyRuns, not enough real durations to have a p95.
    expect(r.status).toBe('healthy');
    if (r.status === 'healthy') expect(r.durationBaseline).toBeUndefined();
  });

  test('formatBaseline renders the stated format', () => {
    expect(formatBaseline({ windowSize: 50, samples: 19, p95Ms: 8268, thresholdMs: 120_000 }))
      .toBe('baseline: p95 8268ms over 19 runs (window 50), threshold 120000ms');
  });
});

describe('detect: values crossing the ingest trust boundary (sdlc/012 security pass)', () => {
  const hostile = 'x |\n| `rm -rf /` | see [here](http://evil.example) ';

  test('a crafted outcome cannot reach an incident record verbatim', () => {
    // `payload` arrives from the ingest endpoint and is not leaf-validated, and `evidenceTable`
    // writes evidence straight into a markdown file a human then reads and acts on.
    const runs = [...baselineRuns(25, 6_000), ev({
      kind: 'verify_run', durationMs: 550_000, receivedAt: hoursAgo(0),
      payload: { outcome: hostile },
    })];
    const r = detect(runs, T0);
    expect(r.status).toBe('anomalies');
    if (r.status === 'anomalies') {
      expect(r.anomalies[0]!.evidence.outcome).toBe('unknown');
      expect(JSON.stringify(r.anomalies[0]!.evidence)).not.toContain('rm -rf');
    }
  });

  test('a legitimate outcome still passes through', () => {
    const runs = [...baselineRuns(25, 6_000), ev({
      kind: 'verify_run', durationMs: 550_000, receivedAt: hoursAgo(0),
      payload: { outcome: 'timeout' },
    })];
    const r = detect(runs, T0);
    if (r.status === 'anomalies') expect(r.anomalies[0]!.evidence.outcome).toBe('timeout');
  });

  test('a crafted drift category cannot reach the fingerprint', () => {
    // Worse than evidence: fingerprints are persisted to suppressions.json, so an unbounded
    // value here writes attacker-chosen text into machine state that gates future detection.
    const drift = Array.from({ length: 3 }, () =>
      ev({ kind: 'schema_drift', receivedAt: hoursAgo(1), payload: { category: hostile } }));
    const r = detect([...baselineRuns(25, 6_000), ...drift], T0);
    expect(r.status).toBe('anomalies');
    if (r.status === 'anomalies') {
      const spike = r.anomalies.find((a) => a.kind === 'schema_drift_spike')!;
      expect(spike.fingerprint).toBe('schema_drift_spike:unknown');
      expect(spike.evidence.category).toBe('unknown');
    }
  });

  test('a legitimate drift category still reaches the fingerprint', () => {
    const drift = Array.from({ length: 3 }, () =>
      ev({ kind: 'schema_drift', receivedAt: hoursAgo(1), payload: { category: 'unknownField' } }));
    const r = detect([...baselineRuns(25, 6_000), ...drift], T0);
    if (r.status === 'anomalies') {
      const spike = r.anomalies.find((a) => a.kind === 'schema_drift_spike')!;
      expect(spike.fingerprint).toBe('schema_drift_spike:unknownField');
    }
  });

  test('the summary names the threshold that fired, not just the ratio', () => {
    // The two can disagree when the floor binds, and the summary is the line a human reads
    // first. Asserted because the plan-to-diff audit noted the rewritten wording was unplanned
    // and unchecked.
    const r = detect([...baselineRuns(25, 6_000), ev({
      kind: 'verify_run', durationMs: 550_000, receivedAt: hoursAgo(0), payload: { outcome: 'timeout' },
    })], T0);
    if (r.status === 'anomalies') {
      expect(r.anomalies[0]!.summary)
        .toBe('A verify run took 550.0s against a baseline p95 of 6.0s over 25 runs — 91.7x, past a 120s threshold.');
    }
  });
});

// --- sdlc/022: the duration fingerprint ---

/**
 * The replaced implementation, kept verbatim so A4 can show the collision it produced.
 *
 * Not imported — it is deleted from anomaly.ts. Copied here deliberately: a test that proves a
 * change happened needs the before as well as the after, and inlining it in one assertion made
 * the point invisible to a reader scanning the file.
 */
function magnitudeBucketAsShipped(value: number): string {
  return String(Math.floor(Math.log10(value)));
}

/** A run of the given duration and outcome, on top of a 25-run baseline at ~30s (threshold 120s). */
function latest(durationMs: number, outcome: 'pass' | 'fail' | 'timeout'): StoredEvent[] {
  return [...baselineRuns(25), ev({
    kind: 'verify_run', durationMs, ok: outcome === 'pass', receivedAt: hoursAgo(0),
    payload: { outcome },
  })];
}

function fingerprintOf(events: StoredEvent[]): string {
  const r = detect(events, T0);
  expect(r.status).toBe('anomalies');
  return r.status === 'anomalies' ? r.anomalies[0]!.fingerprint : '';
}

describe('A1/A2 — durationRatioBand', () => {
  test('A1 — each band, and na for unusable input', () => {
    expect(durationRatioBand(150_000, 120_000)).toBe('1x');
    expect(durationRatioBand(300_000, 120_000)).toBe('2x');
    expect(durationRatioBand(600_000, 120_000)).toBe('4x');

    for (const [d, t] of [[NaN, 120_000], [120_000, NaN], [Infinity, 120_000], [120_000, 0], [120_000, -1]]) {
      expect(durationRatioBand(d!, t!)).toBe('na');
    }
  });

  test('A2 — boundaries land in the upper band', () => {
    expect(durationRatioBand(240_000, 120_000)).toBe('2x');   // exactly 2x
    expect(durationRatioBand(480_000, 120_000)).toBe('4x');   // exactly 4x
    expect(durationRatioBand(239_999, 120_000)).toBe('1x');
    expect(durationRatioBand(479_999, 120_000)).toBe('2x');
  });

  test('A3 — the band is RELATIVE, not absolute', () => {
    // The property the replaced design could not have: the same ratio gives the same band at any
    // scale. An absolute band keyed to a fixed floor would call these different.
    expect(durationRatioBand(300_000, 150_000)).toBe('2x');
    expect(durationRatioBand(3_000_000, 1_500_000)).toBe('2x');
    expect(durationRatioBand(30_000, 15_000)).toBe('2x');
  });
});

describe('A9 — every band stays reachable when the baseline moves', () => {
  test('at the slowest legitimate run on record, all three bands are still reachable', () => {
    // THE criterion that would have caught the replaced design. The trigger is
    // max(p95 * durationOutlierMultiple, minOutlierMs), which MOVES: at p95 = 67.5s it is 270s,
    // and the draft's lowest absolute band [120s, 240s) was entirely below it — empty, with the
    // fingerprint collapsing back toward a constant under exactly the slow conditions it was for.
    //
    // Computed the way detectDurationOutlier computes it, not restated as 270_000.
    const p95 = 67_500;
    const threshold = Math.max(p95 * BOUNDS.durationOutlierMultiple, BOUNDS.minOutlierMs);
    expect(threshold).toBe(270_000);

    const bands = new Set([
      durationRatioBand(threshold * 1.5, threshold),
      durationRatioBand(threshold * 3, threshold),
      durationRatioBand(threshold * 5, threshold),
    ]);
    expect(bands).toEqual(new Set(['1x', '2x', '4x']));
  });

  test('and at a fast baseline too — the bands do not depend on the floor at all', () => {
    for (const threshold of [120_000, 270_000, 1_000_000]) {
      const bands = new Set([
        durationRatioBand(threshold * 1.5, threshold),
        durationRatioBand(threshold * 3, threshold),
        durationRatioBand(threshold * 5, threshold),
      ]);
      expect(bands.size).toBe(3);
    }
  });
});

describe('A4/A5/A8/A10 — the fingerprint through detect', () => {
  test('A4 — a blip and a hang get DIFFERENT fingerprints', () => {
    // The motivating case. Under magnitudeBucket both were `verify_duration_outlier:5`, so the
    // blip's 24h suppression swallowed the hang entirely.
    const blip = fingerprintOf(latest(150_000, 'pass'));
    const hangFp = fingerprintOf(latest(900_000, 'timeout'));
    expect(blip).not.toBe(hangFp);

    // ...and the old scheme is shown to collide, in the same test, so this cannot pass against it.
    expect(magnitudeBucketAsShipped(150_000)).toBe(magnitudeBucketAsShipped(900_000));
  });

  test('A5 — two runs in the same band and outcome SHARE a fingerprint', () => {
    // The suppression property that must survive. Non-vacuous only beside A4/A10.
    expect(fingerprintOf(latest(310_000, 'timeout'))).toBe(fingerprintOf(latest(320_000, 'timeout')));
  });

  test('A8 — a killed run and a slow-but-green run of similar duration DIFFER', () => {
    // The collision `outcome` exists to break: a band alone gives a dead gate and a green gate
    // one fingerprint.
    expect(fingerprintOf(latest(310_000, 'timeout'))).not.toBe(fingerprintOf(latest(310_000, 'pass')));
  });

  test('A10 — different where it matters, same where it should be', () => {
    // Fails against magnitudeBucket, against an unwired band function, and against a constant.
    expect(fingerprintOf(latest(150_000, 'timeout'))).not.toBe(fingerprintOf(latest(550_000, 'timeout')));
    expect(fingerprintOf(latest(310_000, 'timeout'))).toBe(fingerprintOf(latest(320_000, 'timeout')));
  });

  test('the fingerprint is a bounded string of closed-set parts', () => {
    expect(fingerprintOf(latest(550_000, 'timeout'))).toBe('verify_duration_outlier:timeout:4x');
    expect(fingerprintOf(latest(150_000, 'pass'))).toBe('verify_duration_outlier:pass:1x');
  });
});

describe('A6/A7 — suppression across different and same conditions', () => {
  test('A6 — a blip\'s suppression does NOT suppress a later hang', () => {
    const blipFp = fingerprintOf(latest(150_000, 'pass'));
    const r = detect(latest(900_000, 'timeout'), T0, [{ fingerprint: blipFp, raisedAt: hoursAgo(1) }]);
    expect(r.status).toBe('anomalies');
    expect(r.status === 'anomalies' ? r.suppressed : []).toEqual([]);
  });

  test('A7 — a MATCHING fingerprint still suppresses', () => {
    // A6's non-vacuous pair: without this, an isSuppressed that never matched would pass A6.
    const hangFp = fingerprintOf(latest(900_000, 'timeout'));
    const r = detect(latest(900_000, 'timeout'), T0, [{ fingerprint: hangFp, raisedAt: hoursAgo(1) }]);
    // When every anomaly is suppressed the status is 'healthy', with `suppressed` populated —
    // reported rather than silently dropped. A first version of this test asserted 'anomalies'
    // and read an empty list through a false ternary, which is a test bug that looks like a code
    // bug. The existing suppression test three describes up has the right shape.
    expect(r.status).toBe('healthy');
    expect(r.status === 'healthy' ? r.suppressed.map(a => a.fingerprint) : []).toContain(hangFp);
  });
});

/**
 * sdlc/037 — the detector reports its input's freshness and judges none of it.
 *
 * Three ages, not two. The first spec draft shipped an all-kinds arrival age beside a `verify_run`
 * emission age, so the two differed along the CLOCK axis and the POPULATION axis at once; a
 * difference could not be attributed to either. Each test below therefore uses a population where
 * the other two ages give a DIFFERENT answer — otherwise none of them establishes which axis moved.
 */
describe('measureFreshness (sdlc/037 A2)', () => {
  const NOW = T0;

  test('the arrival age is the newest event of ANY kind', () => {
    const f = measureFreshness([
      ev({ kind: 'verify_run', receivedAt: hoursAgo(5), ts: hoursAgo(5) }),
      ev({ kind: 'fetch_result', receivedAt: hoursAgo(1), ts: hoursAgo(1) }),
    ], NOW);
    expect(f.newestArrivalAgeMs).toBe(3_600_000);
    // Positive precondition: the run ages are OLDER, so this assertion is about the population and
    // not merely about there being one event.
    expect(f.newestRunArrivalAgeMs).toBe(5 * 3_600_000);
  });

  test('the run arrival age ignores other kinds', () => {
    const f = measureFreshness([
      ev({ kind: 'verify_run', receivedAt: hoursAgo(9), ts: hoursAgo(9) }),
      ev({ kind: 'schema_drift', receivedAt: hoursAgo(1), ts: hoursAgo(1) }),
      ev({ kind: 'render', receivedAt: hoursAgo(2), ts: hoursAgo(2) }),
    ], NOW);
    expect(f.newestRunArrivalAgeMs).toBe(9 * 3_600_000);
    expect(f.newestArrivalAgeMs).toBe(3_600_000);   // and the other kinds ARE newer
  });

  test('the run emitted age uses ts, not receivedAt', () => {
    // One batch: a single receivedAt, ts values hours apart. This is the real store's shape —
    // 311 events share 70 distinct receivedAt values — so ordering by receivedAt alone cannot pick
    // the newest run.
    const f = measureFreshness([
      ev({ kind: 'verify_run', receivedAt: hoursAgo(1), ts: hoursAgo(7) }),
      ev({ kind: 'verify_run', receivedAt: hoursAgo(1), ts: hoursAgo(4) }),
    ], NOW);
    expect(f.newestRunArrivalAgeMs).toBe(3_600_000);
    expect(f.newestRunEmittedAgeMs).toBe(4 * 3_600_000);
  });
});

describe('the drained-backlog discriminator (sdlc/037 A3)', () => {
  /**
   * B4 rests on this shape. A hole in `receivedAt` FILLED with `ts` values is a shipping outage —
   * events kept being emitted and spooled while delivery failed. A hole in both is an absence.
   * That is what makes broken-vs-absent decidable in the past tense, and it is the reason two
   * clocks exist rather than one.
   */
  test('a batch delivered late reads as fresh arrival, old emission', () => {
    const batch = [3, 2, 1].map((h) =>
      ev({ kind: 'verify_run', receivedAt: hoursAgo(0.1), ts: hoursAgo(h + 5) }));
    const f = measureFreshness(batch, T0);
    expect(f.newestRunArrivalAgeMs).toBe(360_000);              // 0.1h — just arrived
    expect(f.newestRunEmittedAgeMs).toBe(6 * 3_600_000);        // emitted six hours ago
    expect(f.newestRunEmittedAgeMs! - f.newestRunArrivalAgeMs!).toBeGreaterThan(5 * 3_600_000);
  });
});

describe('freshness edge cases (sdlc/037 A4, A5, A9)', () => {
  test('an input with no verify_run reports a fresh arrival and null run ages', () => {
    // SYNTHETIC. The live store has never held a non-verify_run event — zero schema_drift, zero
    // fetch_result — so this blind spot is architecturally real and empirically unobserved.
    const f = measureFreshness([ev({ kind: 'fetch_result', receivedAt: hoursAgo(1) })], T0);
    expect(f.newestArrivalAgeMs).toBe(3_600_000);
    expect(f.newestRunArrivalAgeMs).toBeNull();
    expect(f.newestRunEmittedAgeMs).toBeNull();
  });

  test('an empty input yields null for all three', () => {
    expect(measureFreshness([], T0)).toEqual({
      newestArrivalAgeMs: null, newestRunArrivalAgeMs: null, newestRunEmittedAgeMs: null,
    });
  });

  test('an unparseable timestamp is excluded from the max rather than poisoning it', () => {
    const f = measureFreshness([
      ev({ kind: 'verify_run', receivedAt: hoursAgo(3), ts: hoursAgo(3) }),
      ev({ kind: 'verify_run', receivedAt: 'not a date', ts: 'not a date' }),
    ], T0);
    expect(f.newestRunArrivalAgeMs).toBe(3 * 3_600_000);
    expect(Number.isFinite(f.newestRunArrivalAgeMs!)).toBe(true);
  });

  test('every member unparseable is null, not NaN', () => {
    const f = measureFreshness([ev({ kind: 'verify_run', receivedAt: 'x', ts: 'x' })], T0);
    expect(f.newestArrivalAgeMs).toBeNull();
  });

  test('a known age comes back exactly (A9)', () => {
    const f = measureFreshness([ev({ kind: 'verify_run', receivedAt: hoursAgo(2), ts: hoursAgo(2) })], T0);
    expect(f.newestArrivalAgeMs).toBe(7_200_000);
  });

  test('a future event yields a NEGATIVE age on the result, clamped only at render', () => {
    // Emitter clock skew (sdlc/003). store.ts takes `ts` verbatim off the wire with no range check,
    // so this is reachable — the first spec draft called the shape "impossible" twelve lines before
    // documenting skew as an edge case.
    const f = measureFreshness([ev({ kind: 'verify_run', receivedAt: hoursAgo(-1), ts: hoursAgo(-1) })], T0);
    expect(f.newestArrivalAgeMs).toBeLessThan(0);
    expect(formatAgeMs(f.newestArrivalAgeMs)).toBe('0s');
  });
});

describe('formatAgeMs renders every ladder boundary (sdlc/037 A5)', () => {
  test('the ladder is exactly what the spec pinned', () => {
    expect(formatAgeMs(null)).toBe('never');
    expect(formatAgeMs(-1)).toBe('0s');
    expect(formatAgeMs(0)).toBe('0s');
    expect(formatAgeMs(59_000)).toBe('59s');
    expect(formatAgeMs(60_000)).toBe('1m');
    expect(formatAgeMs(59 * 60_000)).toBe('59m');
    expect(formatAgeMs(3_600_000)).toBe('1h 0m');
    expect(formatAgeMs(23 * 3_600_000)).toBe('23h 0m');
    expect(formatAgeMs(24 * 3_600_000)).toBe('1d 0h');
    expect(formatAgeMs(365 * 24 * 3_600_000)).toBe('365d 0h');
  });

  test('NaN renders unknown, not NaNh NaNm', () => {
    expect(formatAgeMs(Number.NaN)).toBe('unknown');
    expect(formatAgeMs(Number.POSITIVE_INFINITY)).toBe('unknown');
  });

  test('formatFreshness names all three ages', () => {
    const line = formatFreshness({
      newestArrivalAgeMs: 60_000, newestRunArrivalAgeMs: null, newestRunEmittedAgeMs: 3_600_000,
    });
    expect(line).toContain('newest arrived 1m ago');
    expect(line).toContain('newest verify run arrived never ago');
    expect(line).toContain('emitted 1h 0m ago');
  });
});

describe('freshness reaches every verdict (sdlc/037 A6, A7)', () => {
  test('insufficient-data carries it — the case a broken pipeline lands in first', () => {
    const r = detect([ev({ kind: 'verify_run', receivedAt: hoursAgo(4), ts: hoursAgo(4) })], T0);
    expect(r.status).toBe('insufficient-data');
    expect(r.freshness.newestRunArrivalAgeMs).toBe(4 * 3_600_000);
  });

  test('a year-old store is still HEALTHY, and says how old it is', () => {
    // SYNTHETIC: RETENTION_DAYS is 90, so 365 days is unreachable in a real store — after a 90-day
    // outage `prune()` empties it and this number degrades to `never`. Accepted, recorded.
    //
    // The status NOT changing is the point. This loop adds a fact, not a verdict.
    const year = 365 * 24;
    // Built directly rather than spread over `baselineRuns`'s output: `oxc(no-map-spread)` is in the
    // enforced warning budget, and A11 pins it at 8 rows / 10 warnings. The gate rejected the first
    // version of this test, which is the budget working as designed.
    const old = Array.from({ length: BOUNDS.minVerifyRuns }, () =>
      ev({ kind: 'verify_run', durationMs: 30_000, receivedAt: hoursAgo(year), ts: hoursAgo(year), payload: { outcome: 'pass' } }));
    const r = detect(old, T0);
    expect(r.status).toBe('healthy');
    expect(r.freshness.newestArrivalAgeMs).toBeGreaterThan(300 * 24 * 3_600_000);
    expect(formatAgeMs(r.freshness.newestArrivalAgeMs)).toBe('365d 0h');
  });
});

/**
 * A8 — a change-detector, in both directions.
 *
 * `AnomalyKind` used to be a hand-written union, and a union is erased at runtime: the only way to
 * "assert" it was a source grep, which is the vacuous form sdlc/014's review recorded. Checked
 * before writing this: the type appears in exactly two places and there is NO exhaustive switch on
 * it, so a fifth member typechecks silently and nothing else in the repo notices.
 *
 * What it protects: sdlc/037 ships no staleness bound, on the reasoning in that loop's spec B4. A
 * future loop adding one should have to edit a test that says so.
 */
describe('the bound set is pinned (sdlc/037 A8)', () => {
  test('ANOMALY_KINDS is exactly the four current members', () => {
    expect([...ANOMALY_KINDS]).toEqual([
      'verify_duration_outlier', 'verify_pass_rate', 'schema_drift_spike', 'fetch_failure_rate',
    ]);
  });

  test('BOUNDS has exactly its ten current keys', () => {
    expect(Object.keys(BOUNDS).toSorted()).toEqual([
      'driftSpikeCount', 'durationOutlierMultiple', 'maxFetchFailureRate', 'minFetchSample',
      'minOutlierMs', 'minPassRate', 'minVerifyRuns', 'passRateWindow', 'suppressionHours',
      'verifyBaselineWindow',
    ]);
  });
});
