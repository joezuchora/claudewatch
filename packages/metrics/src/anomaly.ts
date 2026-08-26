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

export interface Suppression {
  fingerprint: string;
  raisedAt: string;
}

export type DetectResult =
  | { status: 'insufficient-data'; have: number; need: number }
  | { status: 'healthy'; evaluated: number; suppressed: Anomaly[] }
  | { status: 'anomalies'; anomalies: Anomaly[]; suppressed: Anomaly[]; evaluated: number };

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

function detectDurationOutlier(runs: StoredEvent[]): Anomaly | null {
  // Single-event by design: a hang is not a trend, and waiting for a second one means
  // waiting an hour to notice the terminal stopped moving.
  const latest = runs[runs.length - 1];
  if (!latest || latest.durationMs === null) return null;

  const baseline = runs.slice(0, -1)
    .map((r) => r.durationMs)
    .filter((d): d is number => d !== null)
    .sort((a, b) => a - b);
  if (baseline.length < BOUNDS.minVerifyRuns - 1) return null;

  const p95 = percentile(baseline, 0.95);
  if (p95 === null || p95 <= 0) return null;

  const multiple = latest.durationMs / p95;
  if (multiple <= BOUNDS.durationOutlierMultiple) return null;

  return {
    kind: 'verify_duration_outlier',
    fingerprint: `verify_duration_outlier:${magnitudeBucket(latest.durationMs)}`,
    severity: 'high',
    summary:
      `A verify run took ${(latest.durationMs / 1000).toFixed(1)}s against a baseline p95 of ` +
      `${(p95 / 1000).toFixed(1)}s — ${multiple.toFixed(1)}x.`,
    evidence: {
      durationMs: latest.durationMs,
      baselineP95Ms: p95,
      multiple: Number(multiple.toFixed(2)),
      baselineSamples: baseline.length,
      outcome: String(latest.payload.outcome ?? (latest.ok ? 'pass' : 'fail')),
    },
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

  const found = [
    detectDurationOutlier(runs),
    detectPassRate(runs),
    detectDriftSpike(ordered, now),
    detectFetchFailures(ordered, now),
  ].filter((a): a is Anomaly => a !== null);

  const suppressed = found.filter((a) => isSuppressed(a, suppressions, now));
  const raised = found.filter((a) => !isSuppressed(a, suppressions, now));

  // Suppressed anomalies are reported, never silently dropped — a detector that hides its
  // own decisions cannot be debugged.
  if (raised.length === 0) {
    return { status: 'healthy', evaluated: runs.length, suppressed };
  }
  return { status: 'anomalies', anomalies: raised, suppressed, evaluated: runs.length };
}
