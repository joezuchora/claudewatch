/**
 * What the detector gets to look at.
 *
 * This module exists because of where the defect was. `cli-detect.ts` composed the detector's
 * input at its own top level, as `store.query({ limit: 1000 })` — no `kind` filter, though
 * `store.query` supports one, ordered `received_at DESC` and capped at 1000. So the duration
 * baseline was never "all history": it was however many `verify_run` events happened to fall
 * inside the last 1000 events of ANY kind.
 *
 * That fails in the silent direction, and it gets worse as the product succeeds. Loops 003, 007
 * and 008 wired `render`, `fetch_result`, `cache_event` and `schema_drift`; one `render` per
 * statusline invocation makes 1000 events a few minutes of ordinary use, at which point the
 * detector sees a handful of verify runs — or none, and reports `insufficient-data` forever
 * while the store holds thousands.
 *
 * Top-level script code cannot be reached by a test. That is the whole reason this is a module
 * rather than three lines back where they were. (sdlc/012)
 */
import { BOUNDS } from './anomaly.js';
import type { MetricsStore } from './store.js';
import type { StoredEvent } from './types.js';

/** The store's own cap (`store.ts`), restated so the intent of asking for it is explicit. */
const GENERAL_LIMIT = 1000;
const HOUR_MS = 3_600_000;

/**
 * How far back each kind-scoped query reaches, matched to the detector that consumes it.
 * `detectDriftSpike` compares 24h against the prior 7 days, so it needs 8; `detectFetchFailures`
 * is a 24h window. Both filter again on `receivedAt` themselves — this only guarantees the
 * events are in the set to be filtered.
 */
const DRIFT_LOOKBACK_HOURS = 24 * 8;
const FETCH_LOOKBACK_HOURS = 24;

/**
 * Verify runs asked for AS verify runs, plus the general recent window the other detectors
 * need. Deduplicated on `eventId`: the two queries overlap by construction, and a duplicated
 * run would quietly distort a p95.
 *
 * Ordering is not established here — `detect` sorts by `(receivedAt, ts)` itself, which is the
 * only ordering that survives batch ingest (sdlc/009).
 */
export function collectDetectorInput(store: MetricsStore, now: number = Date.now()): StoredEvent[] {
  const since = (hours: number) => new Date(now - hours * HOUR_MS).toISOString();

  // +1 because the window is the runs BEFORE the latest, and the latest is one of them.
  const runs = store.query({ kind: 'verify_run', limit: BOUNDS.verifyBaselineWindow + 1 });

  // The other two detectors starve under exactly the same flood. Fixing only the duration
  // baseline would have left the other half of the same defect in place, which the security
  // pass pointed out and which would have been a strange thing to document rather than fix in
  // a loop whose whole subject is this composition. (sdlc/012)
  const drift = store.query({
    kind: 'schema_drift', since: since(DRIFT_LOOKBACK_HOURS), limit: GENERAL_LIMIT,
  });
  const fetches = store.query({
    kind: 'fetch_result', since: since(FETCH_LOOKBACK_HOURS), limit: GENERAL_LIMIT,
  });

  const general = store.query({ limit: GENERAL_LIMIT });

  const seen = new Set<string>();
  const out: StoredEvent[] = [];
  for (const e of [...runs, ...drift, ...fetches, ...general]) {
    if (seen.has(e.eventId)) continue;
    seen.add(e.eventId);
    out.push(e);
  }
  return out;
}
