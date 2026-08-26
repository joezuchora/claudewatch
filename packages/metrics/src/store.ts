/**
 * SQLite-backed event store.
 *
 * bun:sqlite is built into Bun, so the metrics package inherits core's zero-third-party-
 * runtime-dependency property (SPEC.md §2.2). Spiked before specifying: WAL enables, 5000
 * inserts take 16ms, and a concurrent reader works against an open writer.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { StoredEvent, IngestResult, EventQuery, Stats } from './types.js';

export const SCHEMA_VERSION = 1;

/** Events older than this are pruned, so a NUC running for years does not fill its disk. */
export const RETENTION_DAYS = 90;

export function defaultDbPath(): string {
  return join(homedir(), '.local', 'share', 'claudewatch-metrics', 'metrics.db');
}

export class MetricsStore {
  private db: Database;

  constructor(path: string = defaultDbPath()) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new Database(path, { create: true });
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.run(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
    const row = this.db.query<{ version: number }, []>('SELECT version FROM schema_version LIMIT 1').get();
    if (row === null) {
      this.db.run('INSERT INTO schema_version(version) VALUES (?)', [SCHEMA_VERSION]);
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id     TEXT NOT NULL UNIQUE,
        ts           TEXT NOT NULL,
        received_at  TEXT NOT NULL,
        source       TEXT NOT NULL,
        kind         TEXT NOT NULL,
        ok           INTEGER NOT NULL,
        duration_ms  INTEGER,
        schema_version INTEGER NOT NULL,
        payload      TEXT NOT NULL
      )
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_events_lookup ON events(source, kind, received_at)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_events_received ON events(received_at)');
  }

  schemaVersion(): number {
    return this.db.query<{ version: number }, []>('SELECT version FROM schema_version LIMIT 1').get()?.version ?? 0;
  }

  /**
   * Ingest a batch. Duplicate event_ids are ignored rather than rejected — the agent is
   * at-least-once by design, so retries are expected and must not distort the pass rate.
   */
  ingest(events: unknown[]): IngestResult {
    const result: IngestResult = { accepted: 0, duplicates: 0, rejected: 0 };
    const receivedAt = new Date().toISOString();

    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO events
        (event_id, ts, received_at, source, kind, ok, duration_ms, schema_version, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction((batch: unknown[]) => {
      for (const raw of batch) {
        const e = normalizeIncoming(raw);
        if (e === null) { result.rejected++; continue; }
        const res = insert.run(
          e.eventId, e.ts, receivedAt, e.source, e.kind,
          e.ok ? 1 : 0, e.durationMs, e.schemaVersion, JSON.stringify(e.payload),
        );
        // INSERT OR IGNORE reports 0 changes when the unique event_id already exists.
        if (Number(res.changes ?? 0) > 0) result.accepted++; else result.duplicates++;
      }
    });
    tx(events);
    return result;
  }

  query(q: EventQuery = {}): StoredEvent[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (q.source) { clauses.push('source = ?'); params.push(q.source); }
    if (q.kind) { clauses.push('kind = ?'); params.push(q.kind); }
    if (q.since) { clauses.push('received_at >= ?'); params.push(q.since); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);

    const rows = this.db.query<Record<string, never>, never[]>(
      `SELECT event_id, ts, received_at, source, kind, ok, duration_ms, schema_version, payload
       FROM events ${where} ORDER BY received_at DESC, id DESC LIMIT ${limit}`,
    ).all(...(params as never[])) as unknown as Array<Record<string, unknown>>;

    return rows.map(rowToEvent);
  }

  stats(): Stats {
    const total = this.db.query<{ c: number }, []>('SELECT count(*) AS c FROM events').get()?.c ?? 0;
    const bySource = this.db.query<{ source: string; count: number }, []>(
      'SELECT source, count(*) AS count FROM events GROUP BY source ORDER BY count DESC',
    ).all();

    const durations = this.db.query<{ duration_ms: number }, []>(
      `SELECT duration_ms FROM events
       WHERE kind = 'verify_run' AND duration_ms IS NOT NULL
       ORDER BY duration_ms ASC`,
    ).all().map((r) => r.duration_ms);

    const runs = this.db.query<{ c: number }, []>(
      `SELECT count(*) AS c FROM events WHERE kind = 'verify_run'`).get()?.c ?? 0;
    const passed = this.db.query<{ c: number }, []>(
      `SELECT count(*) AS c FROM events WHERE kind = 'verify_run' AND ok = 1`).get()?.c ?? 0;
    const timeouts = this.db.query<{ c: number }, []>(
      `SELECT count(*) AS c FROM events
       WHERE kind = 'verify_run' AND json_extract(payload, '$.outcome') = 'timeout'`).get()?.c ?? 0;

    const bounds = this.db.query<{ oldest: string | null; newest: string | null }, []>(
      'SELECT min(received_at) AS oldest, max(received_at) AS newest FROM events').get();

    return {
      totalEvents: total,
      bySource,
      verify: {
        runs,
        passRate: runs > 0 ? passed / runs : null,
        p50DurationMs: percentile(durations, 0.5),
        p95DurationMs: percentile(durations, 0.95),
        maxDurationMs: durations.length > 0 ? durations[durations.length - 1]! : null,
        timeouts,
      },
      oldestReceivedAt: bounds?.oldest ?? null,
      newestReceivedAt: bounds?.newest ?? null,
    };
  }

  /** Prune events past the retention window. Returns how many were removed. */
  prune(retentionDays: number = RETENTION_DAYS): number {
    const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
    // Use run()'s own report rather than a separate SELECT changes() — the latter is not
    // reliably scoped to the statement we care about.
    const res = this.db.run('DELETE FROM events WHERE received_at < ?', [cutoff]);
    return Number(res.changes ?? 0);
  }

  healthy(): boolean {
    try {
      this.db.query('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.db.close();
  }
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx] ?? null;
}

function rowToEvent(r: Record<string, unknown>): StoredEvent {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(String(r.payload)) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return {
    eventId: String(r.event_id),
    ts: String(r.ts),
    receivedAt: String(r.received_at),
    source: String(r.source),
    kind: String(r.kind),
    ok: Number(r.ok) === 1,
    durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
    schemaVersion: Number(r.schema_version),
    payload,
  };
}

/**
 * Validate an incoming event. Unknown schemaVersion is STORED, not rejected: a metrics
 * service that drops data on version skew loses exactly the data that explains the skew.
 */
function normalizeIncoming(raw: unknown): {
  eventId: string; ts: string; source: string; kind: string;
  ok: boolean; durationMs: number | null; schemaVersion: number;
  payload: Record<string, unknown>;
} | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.eventId !== 'string' || o.eventId.length === 0) return null;
  if (typeof o.source !== 'string' || typeof o.kind !== 'string') return null;

  const ts = typeof o.ts === 'string' ? o.ts : new Date().toISOString();
  const durationMs =
    typeof o.durationMs === 'number' && isFinite(o.durationMs) ? Math.round(o.durationMs) : null;
  const payload =
    o.payload !== null && typeof o.payload === 'object'
      ? (o.payload as Record<string, unknown>)
      : {};

  return {
    eventId: o.eventId,
    ts,
    source: o.source,
    kind: o.kind,
    ok: o.ok === true,
    durationMs,
    schemaVersion: typeof o.schemaVersion === 'number' ? o.schemaVersion : 0,
    payload,
  };
}
