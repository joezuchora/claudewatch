import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ship, rotate, pendingShippingFiles, MAX_RETAINED_SHIPPING_FILES } from './agent.js';

const line = (i: number) =>
  `${JSON.stringify({ eventId: `e${i}`, ts: new Date().toISOString(), source: 'product', kind: 'render', ok: true, durationMs: 1, schemaVersion: 1, payload: {} })}\n`;

describe('agent: shipping', () => {
  let dir: string;
  let spool: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cw-agent-'));
    spool = join(dir, 'metrics-spool.jsonl');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const okFetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
  const failFetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
  const throwFetch = (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch;

  test('ships spooled events and removes the shipping file on success', async () => {
    writeFileSync(spool, line(1) + line(2));
    const r = await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: okFetch, now: () => 1 });
    expect(r.shipped).toBe(2);
    expect(r.filesShipped).toBe(1);
    expect(pendingShippingFiles(spool)).toHaveLength(0);
  });

  test('an absent or empty spool is a no-op', async () => {
    const r1 = await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: okFetch, now: () => 1 });
    expect(r1.filesShipped).toBe(0);
    writeFileSync(spool, '');
    const r2 = await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: okFetch, now: () => 2 });
    expect(r2.filesShipped).toBe(0);
  });

  test('ROTATES rather than truncating, so concurrent appends are not lost', async () => {
    // This is the case that made revision 1's "never lost" claim false. The statusline
    // appends on every prompt render, so an append landing mid-ship is routine.
    writeFileSync(spool, line(1) + line(2));

    const racyFetch = (async () => {
      // A statusline process appends while the batch is in flight.
      appendFileSync(spool, line(99));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const r = await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: racyFetch, now: () => 1 });
    expect(r.shipped).toBe(2);

    // The concurrently appended event is still in the fresh spool, not destroyed.
    expect(existsSync(spool)).toBe(true);
    expect(readFileSync(spool, 'utf-8')).toContain('"e99"');
  });

  test('retains the shipping file when the service rejects the batch', async () => {
    writeFileSync(spool, line(1));
    const r = await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: failFetch, now: () => 1 });
    expect(r.filesShipped).toBe(0);
    expect(r.filesRetained).toBe(1);
    expect(pendingShippingFiles(spool)).toHaveLength(1);
  });

  test('retains the shipping file when the service is unreachable', async () => {
    writeFileSync(spool, line(1));
    const r = await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: throwFetch, now: () => 1 });
    expect(r.filesRetained).toBe(1);
    expect(pendingShippingFiles(spool)).toHaveLength(1);
  });

  test('a retained file is shipped on the next run', async () => {
    writeFileSync(spool, line(1));
    await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: failFetch, now: () => 1 });
    const r = await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: okFetch, now: () => 2 });
    expect(r.shipped).toBe(1);
    expect(pendingShippingFiles(spool)).toHaveLength(0);
  });

  test('skips unparseable lines and still ships the rest', async () => {
    // A torn final line is expected: the statusline calls process.exit() on every path.
    writeFileSync(spool, line(1) + '{"eventId":"tor' + '\n' + line(2));
    const r = await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: okFetch, now: () => 1 });
    expect(r.shipped).toBe(2);
    expect(r.skippedUnparseable).toBe(1);
  });

  test('bounds retained shipping files so an unreachable service cannot fill the disk', async () => {
    for (let i = 0; i < MAX_RETAINED_SHIPPING_FILES + 5; i++) {
      writeFileSync(spool, line(i));
      await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: failFetch, now: () => 1000 + i });
    }
    expect(pendingShippingFiles(spool).length).toBeLessThanOrEqual(MAX_RETAINED_SHIPPING_FILES);
  });

  test('rotate is a no-op on an absent spool', () => {
    expect(rotate(spool, 1)).toBeNull();
  });
});
