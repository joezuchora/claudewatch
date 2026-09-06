/**
 * Metrics HTTP service.
 *
 * Binds to loopback by default. Binding anywhere else REQUIRES a token and refuses to start
 * without one — the intended home is a NUC that may be reachable from other devices on a
 * home LAN, and an unauthenticated write endpoint there would let anything on the network
 * inject the signal that loop 004 treats as an anomaly.
 */
import { MetricsStore, defaultDbPath, RETENTION_DAYS } from './store.js';
import { renderDashboard } from './dashboard.js';
import type { EventQuery } from './types.js';

export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_BATCH_EVENTS = 1000;
export const MIN_TOKEN_LENGTH = 32;

export interface ServerOptions {
  port?: number;
  hostname?: string;
  token?: string | null;
  dbPath?: string;
  store?: MetricsStore;
}

export class ConfigurationError extends Error {}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/** Constant-time comparison, so a token cannot be recovered by timing the endpoint. */
function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ab.length !== bb.length) {
    // Still burn a comparison so the length check is not the only timing signal.
    let acc = 0;
    for (let i = 0; i < ab.length; i++) acc |= ab[i]! ^ ab[i]!;
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

export function validateOptions(opts: ServerOptions): { hostname: string; token: string | null } {
  const hostname = opts.hostname ?? '127.0.0.1';
  const token = opts.token ?? null;

  if (token !== null && token.trim().length < MIN_TOKEN_LENGTH) {
    throw new ConfigurationError(
      `CLAUDEWATCH_METRICS_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters (got ${token.trim().length}).`,
    );
  }

  if (!isLoopback(hostname) && token === null) {
    throw new ConfigurationError(
      `Refusing to bind to ${hostname} without CLAUDEWATCH_METRICS_TOKEN. ` +
      `A non-loopback bind exposes an unauthenticated write endpoint on your network.`,
    );
  }

  return { hostname, token };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function createHandler(store: MetricsStore, token: string | null) {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Auth gates every route, including the dashboard — the dashboard shows the same data.
    if (token !== null) {
      const header = req.headers.get('authorization') ?? '';
      const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!timingSafeEqual(presented, token)) {
        return json({ error: 'unauthorized' }, 401);
      }
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return json({
        ok: store.healthy(),
        schemaVersion: store.schemaVersion(),
        retentionDays: RETENTION_DAYS,
      }, store.healthy() ? 200 : 503);
    }

    if (req.method === 'POST' && url.pathname === '/v1/events') {
      const raw = await req.text();
      if (Buffer.byteLength(raw, 'utf-8') > MAX_BODY_BYTES) {
        return json({ error: 'payload too large', maxBytes: MAX_BODY_BYTES }, 413);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return json({ error: 'malformed json' }, 400);
      }

      const events = Array.isArray(parsed)
        ? parsed
        : (parsed as { events?: unknown })?.events;
      if (!Array.isArray(events)) {
        return json({ error: 'expected an array of events' }, 400);
      }
      if (events.length > MAX_BATCH_EVENTS) {
        return json({ error: 'batch too large', maxEvents: MAX_BATCH_EVENTS }, 413);
      }
      // An empty batch is a success with nothing done, not an error: the agent sends one
      // when a spool file contained only unparseable lines.
      return json(store.ingest(events), 200);
    }

    if (req.method === 'GET' && url.pathname === '/v1/events') {
      const q: EventQuery = {};
      const source = url.searchParams.get('source');
      const kind = url.searchParams.get('kind');
      const since = url.searchParams.get('since');
      const limit = url.searchParams.get('limit');
      if (source) q.source = source;
      if (kind) q.kind = kind;
      if (since) q.since = since;
      if (limit && /^\d+$/.test(limit)) q.limit = Number(limit);
      return json({ events: store.query(q) });
    }

    if (req.method === 'GET' && url.pathname === '/v1/stats') {
      return json(store.stats());
    }

    if (req.method === 'GET' && url.pathname === '/') {
      return new Response(renderDashboard(store.stats(), store.query({ limit: 50 })), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    return json({ error: 'not found' }, 404);
  };
}

export function startServer(opts: ServerOptions = {}) {
  const { hostname, token } = validateOptions(opts);
  const store = opts.store ?? new MetricsStore(opts.dbPath ?? defaultDbPath());
  store.prune();

  const handler = createHandler(store, token);
  const server = Bun.serve({
    port: opts.port ?? 8787,
    hostname,
    fetch: handler,
  });

  return { server, store, handler };
}
