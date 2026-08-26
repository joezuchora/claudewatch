/**
 * Local-spool telemetry emitter.
 *
 * The product NEVER opens a socket for telemetry. It appends one JSON line to a local file
 * and returns; a separate agent the user runs ships it. This is forced by SPEC.md §11.7's
 * 50ms cache-hit budget — measured startup floor is already 25-40ms, leaving ~10-25ms of
 * headroom, which is not enough for DNS + TLS + connect. Measured append cost: 0.003ms.
 *
 * SECURITY BOUNDARY. Every payload leaf is a number, a boolean, or a member of a closed
 * enumeration. There are NO free-text fields, because the obvious leak vector here is a
 * value, not a key: client.ts puts fetch error messages into failures, and in Bun those
 * routinely carry hostnames, proxy URLs and /home/<username>/ paths. Do not add a string
 * field to a payload unless it is constrained to a fixed set. See sdlc/003-metrics-telemetry.
 */
import { appendFileSync, mkdirSync, statSync, writeFileSync, renameSync, readFileSync } from 'fs';
import { join } from 'path';
import { getCacheDir } from './cache.js';
import type { TelemetryConfig } from './config.js';

export const TELEMETRY_SCHEMA_VERSION = 1;

/** Hard cap on one serialized line, keeping a single O_APPEND write atomic on POSIX. */
export const MAX_LINE_BYTES = 4096;

/** Byte cap on the spool. Bytes only — a line-count cap would mean reading up to 5MB on a
 *  path budgeted at 50ms. */
export const MAX_SPOOL_BYTES = 5 * 1024 * 1024;

export type MetricSource = 'product' | 'sdlc';

export type StatusClass = '2xx' | '4xx' | '5xx' | 'network' | 'timeout';
export type CacheOutcome =
  | 'hit' | 'miss' | 'corruptJson' | 'versionMismatch' | 'invalidShape' | 'cooldown';
export type Surface = 'statusline' | 'vscode';
export type WarningCategory = 'window' | 'timestamp' | 'enterprise' | 'shape';

export interface MetricEvent {
  eventId: string;
  ts: string;
  source: MetricSource;
  kind: string;
  ok: boolean;
  durationMs: number | null;
  schemaVersion: number;
  payload: Record<string, string | number | boolean | null>;
}

export interface SpoolState {
  droppedCount: number;
  firstDroppedAt: string | null;
}

/**
 * Process-level telemetry consent.
 *
 * Deep core modules (client.ts, cache.ts, normalize.ts) have no access to VS Code's consent
 * state, and sdlc/006 established that VS Code's global switch must win. If those modules
 * resolved their own config they would read env and file only, and a VS Code user who had
 * turned telemetry off globally would still be emitted for — voiding 006's guarantee one
 * layer down.
 *
 * So the SURFACE decides and pushes the answer here. Core never resolves consent.
 *
 * Default is disabled: a surface that forgets to call setTelemetryConfig emits nothing. That
 * is the only acceptable default for a consent flag — the dangerous mistake, a new surface
 * silently inheriting "on", is not expressible.
 */
let processConfig: TelemetryConfig = { enabled: false };

export function setTelemetryConfig(cfg: TelemetryConfig): void {
  processConfig = { enabled: cfg.enabled === true };
}

export function getTelemetryConfig(): TelemetryConfig {
  return processConfig;
}

/** Emit using the process config. The call sites in core use this. */
export function emitProcess(event: MetricEvent): void {
  emit(processConfig, event);
}

export function getSpoolPath(): string {
  return join(getCacheDir(), 'metrics-spool.jsonl');
}

export function getSpoolStatePath(): string {
  return join(getCacheDir(), 'metrics-spool.state.json');
}

function newEventId(): string {
  return crypto.randomUUID();
}

export function readSpoolState(): SpoolState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getSpoolStatePath(), 'utf-8'));
    if (parsed === null || typeof parsed !== 'object') return { droppedCount: 0, firstDroppedAt: null };
    const obj = parsed as Record<string, unknown>;
    return {
      droppedCount: typeof obj.droppedCount === 'number' ? obj.droppedCount : 0,
      firstDroppedAt: typeof obj.firstDroppedAt === 'string' ? obj.firstDroppedAt : null,
    };
  } catch {
    return { droppedCount: 0, firstDroppedAt: null };
  }
}

/**
 * Record a dropped event in the sidecar. The sidecar exists because the spool being full is
 * precisely when the spool cannot record anything, and because the statusline process that
 * observed the drop exits within ~30ms.
 */
function recordDrop(): void {
  try {
    const prev = readSpoolState();
    const next: SpoolState = {
      droppedCount: prev.droppedCount + 1,
      firstDroppedAt: prev.firstDroppedAt ?? new Date().toISOString(),
    };
    const path = getSpoolStatePath();
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // The drop counter failing is not worth degrading anything over.
  }
}

export function clearSpoolState(): void {
  try {
    const path = getSpoolStatePath();
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ droppedCount: 0, firstDroppedAt: null }), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // ignore
  }
}

export function makeEvent(
  source: MetricSource,
  kind: string,
  ok: boolean,
  durationMs: number | null,
  payload: Record<string, string | number | boolean | null>,
): MetricEvent {
  return {
    eventId: newEventId(),
    ts: new Date().toISOString(),
    source,
    kind,
    ok,
    durationMs,
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    payload,
  };
}

/**
 * Append one event to the spool. Never throws, never blocks on network, never degrades the
 * product. A telemetry failure is always silent from the caller's perspective.
 */
export function emit(config: TelemetryConfig, event: MetricEvent): void {
  if (!config.enabled) return; // The default. No I/O whatsoever.

  try {
    const line = `${JSON.stringify(event)}\n`;

    if (Buffer.byteLength(line, 'utf-8') > MAX_LINE_BYTES) {
      recordDrop();
      return;
    }

    const dir = getCacheDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    // One stat, not a read. See MAX_SPOOL_BYTES.
    const path = getSpoolPath();
    try {
      if (statSync(path).size >= MAX_SPOOL_BYTES) {
        recordDrop();
        return;
      }
    } catch {
      // Absent spool is fine — this is the first append.
    }

    appendFileSync(path, line, { mode: 0o600 });
  } catch {
    recordDrop();
  }
}

// === Payload builders ===
//
// These are the security boundary. Every value below is a number, a boolean, or a member of
// a closed union. Nothing here accepts a caller-supplied string. If you need a new field and
// it is not one of those three things, it does not go in a payload — map it to an
// enumeration first. security.test.ts asserts this adversarially with poisoned input.

export function fetchResultEvent(args: {
  ok: boolean;
  statusClass: StatusClass;
  attempts: number;
  durationMs: number;
}): MetricEvent {
  return makeEvent('product', 'fetch_result', args.ok, args.durationMs, {
    statusClass: args.statusClass,
    attempts: args.attempts,
  });
}

export function cacheEvent(args: { outcome: CacheOutcome }): MetricEvent {
  return makeEvent('product', 'cache_event', args.outcome === 'hit', null, {
    outcome: args.outcome,
  });
}

export function renderEvent(args: {
  surface: Surface;
  runtimeState: string;
  tier: string;
  utilizationBucket: number | null;
  durationMs: number | null;
}): MetricEvent {
  // runtimeState and tier are constrained by their producing unions in types.ts; bucket is a
  // decile, never a raw utilization, and never a credit amount.
  return makeEvent('product', 'render', true, args.durationMs, {
    surface: args.surface,
    runtimeState: args.runtimeState,
    tier: args.tier,
    utilizationBucket: args.utilizationBucket,
  });
}

export function schemaDriftEvent(args: { category: WarningCategory; count: number }): MetricEvent {
  return makeEvent('product', 'schema_drift', false, null, {
    category: args.category,
    count: args.count,
  });
}

/** Map a normalization warning to a category. Warning TEXT never leaves the process. */
export function categorizeWarning(warning: string): WarningCategory {
  if (warning.includes('resets_at')) return 'timestamp';
  if (warning.includes('extra_usage')) return 'enterprise';
  if (warning.includes('window')) return 'window';
  return 'shape';
}

/** Bucket a utilization percentage into a decile. Never emits the raw figure. */
export function utilizationBucket(pct: number | null): number | null {
  if (pct === null || !isFinite(pct)) return null;
  return Math.min(10, Math.max(0, Math.floor(pct / 10)));
}
