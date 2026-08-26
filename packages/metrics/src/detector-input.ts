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

/** Events for the three time-windowed detectors — drift, fetch failures, pass rate context. */
export const GENERAL_LIMIT = 1000;

/**
 * Verify runs asked for AS verify runs, plus the general recent window the other detectors
 * need. Deduplicated on `eventId`: the two queries overlap by construction, and a duplicated
 * run would quietly distort a p95.
 *
 * Ordering is not established here — `detect` sorts by `(receivedAt, ts)` itself, which is the
 * only ordering that survives batch ingest (sdlc/009).
 */
export function collectDetectorInput(store: MetricsStore): StoredEvent[] {
  // +1 because the window is the runs BEFORE the latest, and the latest is one of them.
  const runs = store.query({
    kind: 'verify_run',
    limit: BOUNDS.verifyBaselineWindow + 1,
  });
  const general = store.query({ limit: GENERAL_LIMIT });

  const seen = new Set<string>();
  const out: StoredEvent[] = [];
  for (const e of [...runs, ...general]) {
    if (seen.has(e.eventId)) continue;
    seen.add(e.eventId);
    out.push(e);
  }
  return out;
}
