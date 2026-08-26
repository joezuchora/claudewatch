/**
 * Control bounds over the stored metrics.
 *
 * RELUCTANCE IS THE POINT. On 2026-08-26 the gate went red three times in two hours; two of
 * those were my own test bounds and one was a correction to the other — one underlying cause.
 * A detector firing per red run would have produced three incident records and taught everyone
 * to ignore the fourth. A false positive costs more than a miss here, because the mechanism's
 * entire value is that a raised incident means something.
 *
 * Pure by design: no clock, no filesystem, no store. Every bound is testable by constructing
 * events, which is the only way a threshold gets tuned without a live system.
 */
import type { StoredEvent } from './types.js';

/** Every threshold in one place, so tuning is a one-line diff and a test. */
export const BOUNDS = {
  /** No verdict at all below this many verify_run events. */
  minVerifyRuns: 20,
  /** A run exceeding this multiple of baseline p95. The 550s hang against ~30s is 18x. */
  durationOutlierMultiple: 4,
  /**
   * Runs the duration baseline is drawn from, most recent first, excluding the latest.
   *
   * By COUNT, not by time: a time window's sample size depends on how often the gate happens
   * to be run, and sdlc/011 changed that by 10x in an afternoon. 50 is enough for a p95 to
   * mean something (sorted[47], so three runs sit above it) while still turning over.
   */
  verifyBaselineWindow: 50,
  /**
   * No run under this is an anomaly, whatever the ratio.
   *
   * Derived, not chosen: the slowest LEGITIMATE run in the real store is 67537ms — a verify on
   * a stale tree, passing, four steps, no timeout. 120s leaves ~1.8x above it. Without a floor
   * the wire lands near 33s once the baseline is all fast runs, and every branch switch would
   * raise a high-severity incident about nothing.
   *
   * It also keeps sdlc/009's guard 2 honest. That spec exempts this detector from the
   * two-event rule because "one event of the right magnitude is the signal" — true at 550s,
   * false at 33s. The floor is what makes the exemption mean something.
   */
  minOutlierMs: 120_000,
  /** Pass rate below this over the recent window. Below it, the gate is not a gate. */
  minPassRate: 0.7,
  /** Runs considered for the pass-rate window. */
  passRateWindow: 10,
  /** schema_drift events within 24h needed to call it a spike. */
  driftSpikeCount: 3,
  /** Failed fetch_result ratio, and the minimum sample to judge it. */
  maxFetchFailureRate: 0.5,
  minFetchSample: 6,
  /** How long a raised fingerprint stays suppressed. */
  suppressionHours: 24,
} as const;

export type AnomalyKind =
  | 'verify_duration_outlier'
  | 'verify_pass_rate'
  | 'schema_drift_spike'
  | 'fetch_failure_rate';

export interface Anomaly {
  kind: AnomalyKind;
  /** Stable across repeats of the same condition, so suppression can match it. */
  fingerprint: string;
  severity: 'high' | 'medium';
  summary: string;
  /** What actually triggered it. Goes into the incident record verbatim. */
  evidence: Record<string, string | number>;
}

/**
 * What the duration detector could see when it ran.
 *
 * Reported whether or not a verdict followed, because the failure this loop exists to fix was
 * an instrument losing sensitivity SILENTLY while `healthy` kept printing (sdlc/012). A
 * threshold nobody can see is a threshold nobody can check.
 */
export interface DurationBaseline {
  /** The configured bound. */
  windowSize: number;
  /** Non-null durations the window actually held. */
  samples: number;
  p95Ms: number;
  /** max(p95 * multiple, minOutlierMs) — what a run must exceed. */
  thresholdMs: number;
}

export function formatBaseline(b: DurationBaseline): string {
  return `baseline: p95 ${b.p95Ms}ms over ${b.samples} runs (window ${b.windowSize}), ` +
    `threshold ${b.thresholdMs}ms`;
}

export interface Suppression {
  fingerprint: string;
  raisedAt: string;
}

export type DetectResult =
  | { status: 'insufficient-data'; have: number; need: number }
  | {
      status: 'healthy';
      evaluated: number;
      suppressed: Anomaly[];
      durationBaseline?: DurationBaseline;
    }
  | {
      status: 'anomalies';
      anomalies: Anomaly[];
      suppressed: Anomaly[];
      evaluated: number;
      durationBaseline?: DurationBaseline;
    };

const HOUR_MS = 3_600_000;

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? null;
}

function within(e: StoredEvent, now: number, hours: number): boolean {
  // Windows use receivedAt, not the emitter's ts — emitter clocks skew (sdlc/003).
  const t = Date.parse(e.receivedAt);
  return Number.isFinite(t) && now - t <= hours * HOUR_MS;
}

/** Coarse bucket, so the same condition an hour later produces the same fingerprint. */
function magnitudeBucket(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return 'na';
  return String(Math.floor(Math.log10(value)));
}

/**
 * The latest run against a bounded window of the runs before it.
 *
 * Returns the baseline separately from the anomaly, so `detect` can report what the instrument
 * could see even when it reached no verdict — which is exactly when a reader needs it.
 */
function detectDurationOutlier(
  runs: StoredEvent[],
): { anomaly: Anomaly | null; baseline: DurationBaseline | null } {
  // Single-event by design: a hang is not a trend, and waiting for a second one means
  // waiting an hour to notice the terminal stopped moving. `minOutlierMs` is what keeps that
  // exemption defensible — see the bound's own note.
  const latest = runs[runs.length - 1];

  // The window, not everything before it. `runs.slice(0, -1)` LOOKED unbounded and was in fact
  // bounded by an accident: cli-detect asked for the last 1000 events of ANY kind, so the
  // baseline shrank as other telemetry kinds got noisier. sdlc/012.
  const window = runs.slice(-(BOUNDS.verifyBaselineWindow + 1), -1);

  // Guard AFTER the null filter. minVerifyRuns counts verify_run EVENTS; a window of 50 events
  // carrying 48 nulls would otherwise yield a p95 over two samples and report it as fact.
  const durations = window
    .map((r) => r.durationMs)
    .filter((d): d is number => d !== null)
    .sort((a, b) => a - b);
  if (durations.length < BOUNDS.minVerifyRuns - 1) return { anomaly: null, baseline: null };

  const p95 = percentile(durations, 0.95);
  if (p95 === null || p95 <= 0) return { anomaly: null, baseline: null };

  const thresholdMs = Math.max(p95 * BOUNDS.durationOutlierMultiple, BOUNDS.minOutlierMs);
  const baseline: DurationBaseline = {
    windowSize: BOUNDS.verifyBaselineWindow,
    samples: durations.length,
    p95Ms: p95,
    thresholdMs,
  };

  if (!latest || latest.durationMs === null) return { anomaly: null, baseline };
  if (latest.durationMs <= thresholdMs) return { anomaly: null, baseline };

  const multiple = latest.durationMs / p95;
  return {
    anomaly: {
      kind: 'verify_duration_outlier',
      fingerprint: `verify_duration_outlier:${magnitudeBucket(latest.durationMs)}`,
      severity: 'high',
      summary:
        `A verify run took ${(latest.durationMs / 1000).toFixed(1)}s against a baseline p95 of ` +
        `${(p95 / 1000).toFixed(1)}s over ${durations.length} runs — ${multiple.toFixed(1)}x, ` +
        `past a ${(thresholdMs / 1000).toFixed(0)}s threshold.`,
      evidence: {
        durationMs: latest.durationMs,
        baselineP95Ms: p95,
        // Both are present because they can disagree: when the floor binds, `multiple` can read
        // 9x beside a threshold the run only just exceeded. Evidence goes verbatim into an
        // incident record, so a reader must see which one actually fired.
        thresholdMs,
        multiple: Number(multiple.toFixed(2)),
        baselineSamples: durations.length,
        windowSize: BOUNDS.verifyBaselineWindow,
        outcome: String(latest.payload.outcome ?? (latest.ok ? 'pass' : 'fail')),
      },
    },
    baseline,
  };
}

function detectPassRate(runs: StoredEvent[]): Anomaly | null {
  const window = runs.slice(-BOUNDS.passRateWindow);
  if (window.length < BOUNDS.passRateWindow) return null;

  const passed = window.filter((r) => r.ok).length;
  const rate = passed / window.length;
  if (rate >= BOUNDS.minPassRate) return null;

  return {
    kind: 'verify_pass_rate',
    fingerprint: `verify_pass_rate:${Math.floor(rate * 10)}`,
    severity: 'high',
    summary:
      `The gate passed ${passed} of the last ${window.length} runs (${(rate * 100).toFixed(0)}%), ` +
      `below the ${(BOUNDS.minPassRate * 100).toFixed(0)}% bound.`,
    evidence: { passed, total: window.length, rate: Number(rate.toFixed(3)) },
  };
}

function detectDriftSpike(events: StoredEvent[], now: number): Anomaly | null {
  const drift = events.filter((e) => e.kind === 'schema_drift');
  const recent = drift.filter((e) => within(e, now, 24));
  if (recent.length < BOUNDS.driftSpikeCount) return null;

  // A spike is drift appearing from nothing. Drift that has always been there is the norm,
  // not news.
  const baseline = drift.filter((e) => !within(e, now, 24) && within(e, now, 24 * 8));
  if (baseline.length > 0) return null;

  return {
    kind: 'schema_drift_spike',
    fingerprint: `schema_drift_spike:${String(recent[0]?.payload.category ?? 'unknown')}`,
    severity: 'high',
    summary:
      `${recent.length} schema_drift events in 24h with none in the prior 7 days. ` +
      `The usage endpoint's shape may have changed.`,
    evidence: {
      recentCount: recent.length,
      category: String(recent[0]?.payload.category ?? 'unknown'),
      priorWeekCount: baseline.length,
    },
  };
}

function detectFetchFailures(events: StoredEvent[], now: number): Anomaly | null {
  const fetches = events.filter((e) => e.kind === 'fetch_result' && within(e, now, 24));
  if (fetches.length < BOUNDS.minFetchSample) return null;

  const failed = fetches.filter((e) => !e.ok).length;
  const rate = failed / fetches.length;
  if (rate <= BOUNDS.maxFetchFailureRate) return null;

  return {
    kind: 'fetch_failure_rate',
    fingerprint: `fetch_failure_rate:${Math.floor(rate * 10)}`,
    severity: 'medium',
    summary:
      `${failed} of ${fetches.length} usage-endpoint fetches failed in 24h ` +
      `(${(rate * 100).toFixed(0)}%).`,
    evidence: { failed, total: fetches.length, rate: Number(rate.toFixed(3)) },
  };
}

function isSuppressed(a: Anomaly, suppressions: Suppression[], now: number): boolean {
  return suppressions.some((s) => {
    if (s.fingerprint !== a.fingerprint) return false;
    const t = Date.parse(s.raisedAt);
    return Number.isFinite(t) && now - t < BOUNDS.suppressionHours * HOUR_MS;
  });
}

export function detect(
  events: StoredEvent[],
  now: number,
  suppressions: Suppression[] = [],
): DetectResult {
  // Oldest first, so "latest" means what it says.
  //
  // Ordering is (receivedAt, ts), NOT receivedAt alone. receivedAt is stamped by the store at
  // ingest, and the agent ships a whole spool as one batch — so every event in a batch shares
  // a receivedAt and cannot be ordered by it. The emitter's ts breaks the tie.
  //
  // Windows still filter on receivedAt (emitter clocks skew, per sdlc/003); only ORDERING
  // uses ts. Found by running the detector against a real batched store, not by a fixture:
  // hand-built fixtures gave every event a distinct receivedAt and hid this completely.
  const ordered = [...events].sort(
    (a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.ts.localeCompare(b.ts),
  );
  const runs = ordered.filter((e) => e.kind === 'verify_run');

  if (runs.length < BOUNDS.minVerifyRuns) {
    // Distinct from healthy, deliberately. A p95 over three samples is noise wearing a
    // statistic's clothes, and "healthy" would be a confident wrong answer.
    return { status: 'insufficient-data', have: runs.length, need: BOUNDS.minVerifyRuns };
  }

  const duration = detectDurationOutlier(runs);
  const found = [
    duration.anomaly,
    detectPassRate(runs),
    detectDriftSpike(ordered, now),
    detectFetchFailures(ordered, now),
  ].filter((a): a is Anomaly => a !== null);

  // Omitted, not guessed, when there was no honest p95 to report.
  const baselineField = duration.baseline === null ? {} : { durationBaseline: duration.baseline };

  const suppressed = found.filter((a) => isSuppressed(a, suppressions, now));
  const raised = found.filter((a) => !isSuppressed(a, suppressions, now));

  // Suppressed anomalies are reported, never silently dropped — a detector that hides its
  // own decisions cannot be debugged.
  if (raised.length === 0) {
    return { status: 'healthy', evaluated: runs.length, suppressed, ...baselineField };
  }
  return {
    status: 'anomalies', anomalies: raised, suppressed, evaluated: runs.length, ...baselineField,
  };
}
