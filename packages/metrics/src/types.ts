/** Shared shapes between the emitter, the agent and the service. */
import type { TransportMessage } from '@claudewatch/core';

export interface StoredEvent {
  eventId: string;
  ts: string;
  receivedAt: string;
  source: string;
  kind: string;
  ok: boolean;
  durationMs: number | null;
  schemaVersion: number;
  payload: Record<string, unknown>;
}

export interface IngestResult {
  accepted: number;
  duplicates: number;
  rejected: number;
}

export interface EventQuery {
  source?: string;
  kind?: string;
  /** Filters on receivedAt, not the emitter's ts — emitter clocks skew. */
  since?: string;
  limit?: number;
}

export interface Stats {
  totalEvents: number;
  bySource: Array<{ source: string; count: number }>;
  verify: {
    runs: number;
    passRate: number | null;
    p50DurationMs: number | null;
    p95DurationMs: number | null;
    maxDurationMs: number | null;
    timeouts: number;
  };
  oldestReceivedAt: string | null;
  newestReceivedAt: string | null;
}

// === Shipping (sdlc/036) ===

/**
 * Filesystem errnos the shipper reports, as an allowlist with a fallback.
 *
 * An errno from the OS is not free text, and it must not be treated as such: the same rule
 * `SPEC.md §12` states for `lastHttpStatus` ("IS validated, because it reached `--debug` verbatim").
 * `'other'` exists so an unrecognised code is reported as unrecognised rather than echoed.
 */
export type SpoolErrno = 'ENOENT' | 'EACCES' | 'EPERM' | 'EISDIR' | 'ENOTDIR' | 'EROFS' | 'ENOSPC' | 'other';

/**
 * Why one spool file was not delivered.
 *
 * Four members, and the fourth is the one sdlc/036's Stage 2 review added. Before it, `rotate()`'s
 * `renameSync` and the prune's `rmSync` sat outside every `try` in this package, so a filesystem
 * error escaped `ship()` entirely and killed the whole diagnostic surface — reproduced as `EISDIR`,
 * with no reason line, no backlog line, and an unhandled rejection that `SuccessExitStatus=0 1` maps
 * to unit success. That is the failure this loop exists to make visible, escaping the loop's own fix.
 *
 * `spool` is NOT folded into `unreadable`. "I could not read this file" and "I could not rename the
 * spool" have different causes and different fixes, and collapsing them would repeat the defect this
 * loop exists to remove, one level up. The same argument is why `ShipResult.failures` is an array.
 */
export type ShipFailure =
  | { kind: 'http'; status: number }
  | { kind: 'transport'; message: TransportMessage }
  | { kind: 'unreadable'; code: SpoolErrno }
  | { kind: 'spool'; op: 'rotate' | 'prune' | 'delete'; code: SpoolErrno };

/**
 * Moved here from `agent.ts` in sdlc/036, because it now embeds `ShipFailure` and a type split
 * across two files is a plan that fences the wrong one.
 */
export interface ShipResult {
  shipped: number;
  skippedUnparseable: number;
  filesShipped: number;
  filesRetained: number;
  filesDropped: number;
  /**
   * One per retained file, in the order encountered.
   *
   * INVARIANT: `failures.length === filesRetained`. Asserted rather than assumed — that is the drift
   * which makes a merged result silently wrong, and nothing else would catch it.
   */
  failures: ShipFailure[];
  /** Pending `.shipping` files AFTER this run. Counts failed deliveries, not failed attempts. */
  backlog: number;
  /**
   * Rotation stamp of the oldest pending file, or `null` when the backlog is empty.
   *
   * The stamp IS `Date.now()` at rotation, so the real age is free. sdlc/036's first spec draft
   * printed "~5 min of events" instead — a guess presented as fact, against CLAUDE.md's "missing
   * optional fields are omitted, not guessed", and wrong by a weekend whenever `Persistent=true`
   * replays a catch-up burst.
   */
  oldestPendingAtMs: number | null;
}
