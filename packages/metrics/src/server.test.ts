import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { MetricsStore } from './store.js';
import { createHandler, validateOptions, ConfigurationError, MAX_BODY_BYTES, MIN_TOKEN_LENGTH } from './server.js';

const TOKEN = 'a'.repeat(MIN_TOKEN_LENGTH);
const evt = () => ({
  eventId: crypto.randomUUID(), ts: new Date().toISOString(), source: 'sdlc',
  kind: 'verify_run', ok: true, durationMs: 35000, schemaVersion: 1, payload: { outcome: 'pass' },
});
const req = (method: string, path: string, body?: unknown, token?: string) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('server: bind and token rules', () => {
  test('loopback without a token is allowed', () => {
    expect(validateOptions({ hostname: '127.0.0.1' })).toEqual({ hostname: '127.0.0.1', token: null });
  });

  test('refuses a non-loopback bind without a token', () => {
    expect(() => validateOptions({ hostname: '0.0.0.0' })).toThrow(ConfigurationError);
    expect(() => validateOptions({ hostname: '192.168.1.50' })).toThrow(/CLAUDEWATCH_METRICS_TOKEN/);
  });

  test('allows a non-loopback bind with a sufficient token', () => {
    expect(validateOptions({ hostname: '0.0.0.0', token: TOKEN }).token).toBe(TOKEN);
  });

  test('refuses a token shorter than the minimum, even on loopback', () => {
    expect(() => validateOptions({ token: 'short' })).toThrow(ConfigurationError);
    expect(() => validateOptions({ token: '   ' })).toThrow(/at least/);
  });
});

describe('server: routes', () => {
  let store: MetricsStore;
  let handle: ReturnType<typeof createHandler>;
  beforeEach(() => {
    store = new MetricsStore(':memory:');
    handle = createHandler(store, null);
  });
  afterEach(() => { store.close(); });

  test('health reports store state and schema version', async () => {
    const res = await handle(req('GET', '/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, schemaVersion: 1 });
  });

  test('ingests a batch and returns counts', async () => {
    const res = await handle(req('POST', '/v1/events', [evt(), evt()]));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: 2, duplicates: 0 });
  });

  test('an empty batch is a 200, not an error', async () => {
    const res = await handle(req('POST', '/v1/events', []));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: 0 });
  });

  test('malformed json is a 400 and leaves the store untouched', async () => {
    const bad = new Request('http://localhost/v1/events', { method: 'POST', body: '{ not json' });
    expect((await handle(bad)).status).toBe(400);
    expect(store.query()).toHaveLength(0);
  });

  test('an oversized body is a 413 and the process stays up', async () => {
    const huge = new Request('http://localhost/v1/events', {
      method: 'POST', body: JSON.stringify(['x'.repeat(MAX_BODY_BYTES + 1000)]),
    });
    expect((await handle(huge)).status).toBe(413);
    expect(store.query()).toHaveLength(0);
    expect((await handle(req('GET', '/health'))).status).toBe(200);
  });

  test('a non-array body is a 400', async () => {
    expect((await handle(req('POST', '/v1/events', { nope: 1 }))).status).toBe(400);
  });

  test('queries filter and stats aggregate', async () => {
    await handle(req('POST', '/v1/events', [evt(), evt()]));
    const q = await (await handle(req('GET', '/v1/events?kind=verify_run'))).json() as { events: unknown[] };
    expect(q.events).toHaveLength(2);
    const s = await (await handle(req('GET', '/v1/stats'))).json() as { verify: { runs: number } };
    expect(s.verify.runs).toBe(2);
  });

  test('unknown routes are 404', async () => {
    expect((await handle(req('GET', '/nope'))).status).toBe(404);
  });
});

describe('server: authentication', () => {
  let store: MetricsStore;
  beforeEach(() => { store = new MetricsStore(':memory:'); });
  afterEach(() => { store.close(); });

  test('gates every route when a token is configured, including the dashboard', async () => {
    const handle = createHandler(store, TOKEN);
    for (const path of ['/health', '/v1/events', '/v1/stats', '/']) {
      expect((await handle(req('GET', path))).status).toBe(401);
    }
    expect((await handle(req('POST', '/v1/events', [evt()]))).status).toBe(401);
  });

  test('accepts the correct bearer token', async () => {
    const handle = createHandler(store, TOKEN);
    expect((await handle(req('GET', '/health', undefined, TOKEN))).status).toBe(200);
  });

  test('rejects a wrong token of the same length', async () => {
    const handle = createHandler(store, TOKEN);
    expect((await handle(req('GET', '/health', undefined, 'b'.repeat(MIN_TOKEN_LENGTH)))).status).toBe(401);
  });
});
