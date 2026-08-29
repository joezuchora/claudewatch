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
import { classifyFetchError } from '@claudewatch/core';
import type { ShipFailure, ShipResult, SpoolErrno } from './types.js';

export type { ShipFailure, ShipResult, SpoolErrno } from './types.js';

export const MAX_RETAINED_SHIPPING_FILES = 20;

export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Map an errno onto the reported allowlist. Anything unrecognised is `'other'`, never echoed.
 *
 * `SPEC.md §12`'s rule for `lastHttpStatus`, applied one boundary over: a value crossing out of the
 * OS is validated where it enters, not where it prints.
 */
const KNOWN_ERRNOS: ReadonlySet<string> = new Set([
  'ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'EROFS', 'ENOSPC',
]);

export function spoolErrno(e: unknown): SpoolErrno {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && KNOWN_ERRNOS.has(code) ? (code as SpoolErrno) : 'other';
}

/** The rotation stamp embedded in `<spool>.<stamp>.shipping`, or `null` if it does not parse. */
export function stampOf(file: string): number | null {
  const m = /\.(\d+)\.shipping$/.exec(file);
  if (m === null) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export interface ShipOptions {
  spoolPath: string;
  endpoint: string;
  token?: string | null;
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Overridable so A11 can assert the abort without a test that waits 10 seconds. */
  timeoutMs?: number;
  /**
   * Injected for the same reason `fetchImpl` is: the guard is otherwise untestable.
   *
   * A6 needs a POST that SUCCEEDS and a delete that FAILS — the case that used to be reported as a
   * transport failure and re-sent forever. It cannot be produced with real permissions here, because
   * the gate runs as root and root ignores the mode bits that would deny `unlink`. sdlc/035's M11
   * is the precedent: a guard whose absence no test can detect is not a guard, and the remedy is a
   * parameter rather than a cleverer fixture.
   */
  rmImpl?: typeof rmSync;
  /** Same reason as `rmImpl`: root can read anything, so the unreadable branch has no other seam. */
  readImpl?: typeof readFileSync;
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
    failures: [...a.failures, ...b.failures],
    backlog: a.backlog + b.backlog,
    // MINIMUM, not the first non-null: "the oldest thing still waiting" is a property of the union
    // of both spools, and taking `a`'s would report the primary's age for a legacy backlog that is
    // older. Summing would be meaningless; picking either arbitrarily would be wrong half the time.
    oldestPendingAtMs:
      a.oldestPendingAtMs === null ? b.oldestPendingAtMs
      : b.oldestPendingAtMs === null ? a.oldestPendingAtMs
      : Math.min(a.oldestPendingAtMs, b.oldestPendingAtMs),
    skippedUnparseable: a.skippedUnparseable + b.skippedUnparseable,
  };
}

/**
 * One operator-facing line for one failure. No endpoint, no path, no token.
 *
 * The endpoint is deliberately absent even though it is the most obvious thing to print: it can
 * carry credentials in userinfo (`https://user:pass@host`), and SPEC.md §12 forbids a secret
 * reaching any output. Naming the ENVIRONMENT VARIABLE is as useful to the person who configured it
 * and cannot leak.
 *
 * The 404 hint is specific because that is the failure I actually hit while running the round trip
 * by hand in sdlc/035's Stage 5 — `CLAUDEWATCH_METRICS_ENDPOINT` is a BASE url and `/v1/events` is
 * appended, so pointing it at the full path 404s on every POST and the old output said only
 * "retained 1".
 */
export function describeFailure(f: ShipFailure): string {
  switch (f.kind) {
    case 'http':
      // Validated on render, not trusted. SPEC.md §12 records the same rule for `lastHttpStatus`:
      // "IS validated (`Number.isInteger`), because it reached `--debug` verbatim."
      if (!Number.isInteger(f.status) || f.status < 100 || f.status > 599) {
        return 'HTTP (invalid status) — the service returned something that is not a status code.';
      }
      return f.status === 404
        ? 'HTTP 404 — the service rejected the batch. Check CLAUDEWATCH_METRICS_ENDPOINT; it is a '
          + 'BASE url and /v1/events is appended.'
        : `HTTP ${f.status} — the service rejected the batch.`;
    case 'transport':
      return `${f.message} — the batch never reached the service.`;
    case 'unreadable':
      return `could not read a spool file (${f.code}).`;
    case 'spool':
      return `could not ${f.op} a spool file (${f.code}). The spool directory may be read-only.`;
  }
}

/** `1h 42m`, `3m`, `12s`. Coarse on purpose: this is a runbook hint, not a measurement. */
export function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  const mins = Math.round(ms / 60_000);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/**
 * Group identical reasons with a count, preserving first-seen order.
 *
 * Without this, a backlog of twenty files behind one dead endpoint prints twenty identical lines
 * every five minutes forever, which is how a useful diagnostic becomes noise that gets filtered.
 */
export function summariseFailures(failures: readonly ShipFailure[]): Array<{ text: string; count: number }> {
  const out: Array<{ text: string; count: number }> = [];
  const seen = new Map<string, { text: string; count: number }>();
  for (const f of failures) {
    const text = describeFailure(f);
    const hit = seen.get(text);
    if (hit) hit.count++;
    else {
      const row = { text, count: 1 };
      seen.set(text, row);
      out.push(row);
    }
  }
  return out;
}

/**
 * The invariant `cli-ship`'s data-loss message depends on: a drop can only happen at the cap.
 *
 * Exported so the message's unconditional wording is backed by a test rather than by my reading of
 * the prune's position. It holds only because the prune runs AFTER the delivery loop — before
 * sdlc/036 it ran first, and a recovery run gave `filesDropped=1, backlog=0`, which is exactly the
 * case that made the wording wrong.
 */
export function dropCanOnlyHappenAtTheCap(r: Pick<ShipResult, 'filesDropped' | 'backlog'>): boolean {
  return r.filesDropped === 0 || r.backlog >= MAX_RETAINED_SHIPPING_FILES;
}

export async function ship(opts: ShipOptions): Promise<ShipResult> {
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetchImpl ?? fetch;
  const doRm = opts.rmImpl ?? rmSync;
  const doRead = opts.readImpl ?? readFileSync;

  const result: ShipResult = {
    shipped: 0, skippedUnparseable: 0, filesShipped: 0, filesRetained: 0, filesDropped: 0,
    failures: [], backlog: 0, oldestPendingAtMs: null,
  };

  const retain = (f: ShipFailure): void => {
    result.filesRetained++;
    result.failures.push(f);
  };

  // `rotate` renames, and `renameSync` sat OUTSIDE the only `try` in it. An EPERM/EISDIR/EROFS threw
  // straight out of `ship()` and out of `cli-ship`, which has no `try` around either call — so the
  // process died before printing anything at all: no reason, no backlog, no DATA LOST. Reproduced as
  // EISDIR in sdlc/036's Stage 2 review, in exactly the read-only-spool configuration
  // `deploy/README.md` documents as reachable. The loop's own headline failure, escaping its own fix.
  try {
    rotate(opts.spoolPath, now());
  } catch (e) {
    retain({ kind: 'spool', op: 'rotate', code: spoolErrno(e) });
  }

  const pending = pendingShippingFiles(opts.spoolPath);

  for (const file of pending) {
    let raw: string;
    try {
      raw = String(doRead(file, 'utf-8'));
    } catch (e) {
      retain({ kind: 'unreadable', code: spoolErrno(e) });
      continue;
    }

    const { events, skipped } = parseLines(raw);
    result.skippedUnparseable += skipped;

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;

    // The abort timer's callback is the ONLY code that knows a timeout happened — reading a flag
    // beats parsing a message that varies by platform. Mirrors `client.ts:232-237`, whose classifier
    // this now shares.
    //
    // Without a timeout at all, a hung endpoint stops shipping ENTIRELY: `Type=oneshot` defaults
    // `TimeoutStartSec=infinity`, the unit stays active, the timer will not re-fire, and the live
    // spool grows to MAX_SPOOL_BYTES where the emitter starts dropping events. (sdlc/036 B3)
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, opts.timeoutMs ?? REQUEST_TIMEOUT_MS);

    // The `try` covers the POST and NOTHING else.
    //
    // It used to wrap `rmSync` and both counters, which meant a POST that SUCCEEDED and whose file
    // deletion then failed was reported as a transport failure: `shipped` never incremented, the file
    // stayed, and it was re-sent every five minutes forever while the operator was told the network
    // was broken. `client.ts:239-246` already records this exact lesson from the sdlc/014 pass — "a
    // guard whose failure is indistinguishable from a flaky network is not a guard" — and sdlc/036's
    // first spec draft reproduced the shape anyway, inside the loop whose purpose is that failure
    // causes must not be conflated. Writing the lesson down did not confer immunity.
    let res: Response;
    try {
      res = await doFetch(`${opts.endpoint.replace(/\/$/, '')}/v1/events`, {
        method: 'POST',
        headers,
        body: JSON.stringify(events),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      retain({ kind: 'transport', message: classifyFetchError(e, timedOut) });
      continue;
    }
    clearTimeout(timer);

    if (!res.ok) {
      retain({ kind: 'http', status: res.status });
      continue;
    }

    // The events ARE delivered at this point. A failed delete is a spool problem, not a transport
    // one, and `shipped` counts them either way — because they were shipped.
    result.shipped += events.length;
    result.filesShipped++;
    try {
      doRm(file, { force: true });
    } catch (e) {
      retain({ kind: 'spool', op: 'delete', code: spoolErrno(e) });
    }
  }

  // The prune runs AFTER the delivery loop, and the ordering is the whole of sdlc/036's C2.
  //
  // Before, it ran first: with twenty backlog files, a recovered endpoint and one new event, the
  // oldest was destroyed and the remaining twenty shipped — measured `shipped=20, filesDropped=1`
  // for twenty-one deliverable files. One permanent, avoidable loss per outage, caused by ordering
  // and nothing else. After: `shipped=21, filesDropped=0`. The cap still bounds disk; it no longer
  // charges a file for the privilege.
  let left = pendingShippingFiles(opts.spoolPath);
  while (left.length > MAX_RETAINED_SHIPPING_FILES) {
    const oldest = left.shift()!;
    try {
      doRm(oldest, { force: true });
      result.filesDropped++;
    } catch (e) {
      retain({ kind: 'spool', op: 'prune', code: spoolErrno(e) });
    }
  }

  left = pendingShippingFiles(opts.spoolPath);
  result.backlog = left.length;
  const stamps = left.map(stampOf).filter((n): n is number => n !== null);
  result.oldestPendingAtMs = stamps.length === 0 ? null : Math.min(...stamps);

  return result;
}
