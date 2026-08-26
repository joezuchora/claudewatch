/**
 * Spool shipping agent.
 *
 * Rotates by rename rather than truncating. Truncation loses every event a concurrently
 * running statusline appended between the read and the rewrite, and the statusline runs on
 * every prompt render — so that interleaving is routine, not rare.
 *
 * Guarantee: at-least-once for events that reach the spool. Events may still be dropped at
 * the spool cap or on filesystem error; both are counted in the sidecar.
 */
import { readdirSync, readFileSync, renameSync, rmSync, existsSync, statSync } from 'fs';
import { dirname, join, basename } from 'path';

export const MAX_RETAINED_SHIPPING_FILES = 20;

export interface ShipResult {
  shipped: number;
  skippedUnparseable: number;
  filesShipped: number;
  filesRetained: number;
  filesDropped: number;
}

export interface ShipOptions {
  spoolPath: string;
  endpoint: string;
  token?: string | null;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

function shippingSuffix(): string {
  return '.shipping';
}

/** Rename the live spool aside so emitters immediately start a fresh one. */
export function rotate(spoolPath: string, stamp: number): string | null {
  if (!existsSync(spoolPath)) return null;
  try {
    if (statSync(spoolPath).size === 0) return null;
  } catch {
    return null;
  }
  const target = `${spoolPath}.${stamp}${shippingSuffix()}`;
  renameSync(spoolPath, target); // atomic; no coordination with emitters needed
  return target;
}

export function pendingShippingFiles(spoolPath: string): string[] {
  const dir = dirname(spoolPath);
  const prefix = `${basename(spoolPath)}.`;
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(shippingSuffix()))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function parseLines(raw: string): { events: unknown[]; skipped: number } {
  const events: unknown[] = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // A torn final line is expected: the statusline calls process.exit() on every path.
      skipped++;
    }
  }
  return { events, skipped };
}

export async function ship(opts: ShipOptions): Promise<ShipResult> {
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetchImpl ?? fetch;

  rotate(opts.spoolPath, now());

  const result: ShipResult = {
    shipped: 0, skippedUnparseable: 0, filesShipped: 0, filesRetained: 0, filesDropped: 0,
  };

  let pending = pendingShippingFiles(opts.spoolPath);

  // Bound retained files so a permanently unreachable service cannot fill the disk.
  while (pending.length > MAX_RETAINED_SHIPPING_FILES) {
    const oldest = pending.shift()!;
    rmSync(oldest, { force: true });
    result.filesDropped++;
  }

  for (const file of pending) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf-8');
    } catch {
      result.filesRetained++;
      continue;
    }

    const { events, skipped } = parseLines(raw);
    result.skippedUnparseable += skipped;

    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (opts.token) headers.authorization = `Bearer ${opts.token}`;

      const res = await doFetch(`${opts.endpoint.replace(/\/$/, '')}/v1/events`, {
        method: 'POST',
        headers,
        body: JSON.stringify(events),
      });

      if (res.ok) {
        // Delete only after the service has taken it.
        rmSync(file, { force: true });
        result.shipped += events.length;
        result.filesShipped++;
      } else {
        result.filesRetained++;
      }
    } catch {
      result.filesRetained++;
    }
  }

  return result;
}
