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
import { readdirSync, readFileSync, renameSync, rmSync, existsSync, statSync, lstatSync } from 'fs';
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
/**
 * A spool file is only ever a REGULAR file. Never a symlink.
 *
 * `lstat`, not `stat`, so the link itself is inspected rather than its target — the same guard
 * `credentials.ts:15` already applies to the credential file, for the same reason.
 *
 * This became load-bearing in sdlc/034. Before it, the spool directory was always
 * `~/.cache/claudewatch`, created 0700 by this tool, so only its owner could put a file there.
 * Honouring `$XDG_CACHE_HOME` made the directory an arbitrary absolute path — possibly one another
 * local user owns or can create in. sdlc/034's security pass then demonstrated the consequence end
 * to end: a planted `metrics-spool.jsonl.<n>.shipping` symlinked to `~/.claude/.credentials.json`
 * was read and POSTed to the configured endpoint, putting the OAuth access token on the wire. The
 * shipper never touches token-handling code; the token arrived as file contents.
 */
function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

export function rotate(spoolPath: string, stamp: number): string | null {
  if (!existsSync(spoolPath)) return null;
  // Refuse to rotate anything that is not a regular file: renaming a symlink would carry it into
  // the pending set under a name the filter accepts.
  if (!isRegularFile(spoolPath)) return null;
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
      .toSorted()
      .map((f) => join(dir, f))
      // The guard that stops a planted symlink being read and shipped. Applied HERE rather than at
      // the read site so that every consumer of this list inherits it — `shouldDrainLegacy` counts
      // these files, and a count that includes a symlink would drain a directory that holds nothing
      // shippable.
      .filter(isRegularFile);
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

/**
 * Whether a legacy spool location still holds anything worth draining.
 *
 * NOT `existsSync` alone. `ship()` rotates the live spool to `<spool>.<stamp>.shipping` and deletes
 * it only on HTTP 2xx, so after a FAILED ship the live `metrics-spool.jsonl` is gone and the events
 * sit in a retained `.shipping` file. That is precisely the situation a drain exists for — a user
 * with unshipped events who then sets `$XDG_CACHE_HOME` — and an existsSync-only condition would
 * skip it, leaving those files to be dropped by `MAX_RETAINED_SHIPPING_FILES` once 20 accumulate.
 *
 * sdlc/034's Stage 2 review caught this by running it. See sdlc/034-xdg-cache-home/.
 */
export function shouldDrainLegacy(legacySpool: string): boolean {
  return existsSync(legacySpool) || pendingShippingFiles(legacySpool).length > 0;
}

/**
 * Fold two ship runs into one result, because `cli-ship` exits on `filesRetained`.
 *
 * Exiting on the primary result alone would report success to systemd forever while a permanently
 * failing legacy drain accumulated toward the 20-file drop.
 */
export function combineResults(a: ShipResult, b: ShipResult): ShipResult {
  return {
    shipped: a.shipped + b.shipped,
    filesShipped: a.filesShipped + b.filesShipped,
    filesRetained: a.filesRetained + b.filesRetained,
    filesDropped: a.filesDropped + b.filesDropped,
    skippedUnparseable: a.skippedUnparseable + b.skippedUnparseable,
  };
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
