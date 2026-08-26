/** Shared shapes between the emitter, the agent and the service. */

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
