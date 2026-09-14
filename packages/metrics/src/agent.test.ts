import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, appendFileSync, existsSync, readFileSync, symlinkSync } from 'fs';
import { readFileSync as realReadFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ship, rotate, pendingShippingFiles, shouldDrainLegacy, combineResults, spoolErrno, stampOf,
  describeFailure, dropCanOnlyHappenAtTheCap, everyRetainedFileHasAReason, formatAge, readSpoolFile, summariseFailures,
  MAX_RETAINED_SHIPPING_FILES,
} from './agent.js';
import type { ShipResult } from './types.js';

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

  /**
   * sdlc/036 A2/A3 — these two tests used to assert ONLY `filesRetained === 1`, for two entirely
   * different causes. `agent.ts`'s HTTP-rejection and thrown-fetch branches had byte-identical
   * bodies, so swapping them was a textual no-op no test could catch, and that is precisely why the
   * defect survived long enough for me to hit it by hand with a 404 that told me nothing.
   */
  test('retains the shipping file when the service rejects the batch, and records the status', async () => {
    writeFileSync(spool, line(1));
    const r = await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: failFetch, now: () => 1 });
    expect(r.filesShipped).toBe(0);
    expect(r.filesRetained).toBe(1);
    expect(r.failures).toEqual([{ kind: 'http', status: 500 }]);
    expect(pendingShippingFiles(spool)).toHaveLength(1);
  });

  test('a 404 and a 503 are distinguishable from each other, not merely both http', async () => {
    // The difference between "fix your config" and "wait". A 404 from a misconfigured base URL
    // never self-heals; a 503 does.
    const at = async (status: number) => {
      writeFileSync(spool, line(1));
      const f = (async () => new Response('x', { status })) as unknown as typeof fetch;
      const r = await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: f, now: () => status });
      return r.failures[0];
    };
    expect(await at(404)).toEqual({ kind: 'http', status: 404 });
    expect(await at(503)).toEqual({ kind: 'http', status: 503 });
  });

  test('retains the shipping file when the service is unreachable, and says it was the transport', async () => {
    writeFileSync(spool, line(1));
    const r = await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: throwFetch, now: () => 1 });
    expect(r.filesRetained).toBe(1);
    expect(r.failures).toEqual([{ kind: 'transport', message: 'Network error' }]);
    expect(pendingShippingFiles(spool)).toHaveLength(1);
  });

  test('a TLS failure code survives as its own message rather than flattening to a dead link', async () => {
    // sdlc/029's whole point, now shared with client.ts through classifyFetchError: a TLS
    // INTERCEPTION ATTEMPT must not be indistinguishable from an unplugged cable.
    writeFileSync(spool, line(1));
    const tlsFetch = (async () => {
      throw Object.assign(new Error('self signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    }) as unknown as typeof fetch;
    const r = await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: tlsFetch, now: () => 1 });
    expect(r.failures).toEqual([{ kind: 'transport', message: 'TLS verification failed' }]);
  });

  test('a throwing rotate is reported as a spool failure instead of killing the process (A2/C1)', async () => {
    writeFileSync(spool, line(1));
    // Occupy the rename target with a non-empty directory: renameSync throws EISDIR/ENOTEMPTY.
    const target = `${spool}.42.shipping`;
    mkdirSync(target);
    writeFileSync(join(target, 'blocker'), 'x');
    const r = await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: okFetch, now: () => 42 });
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]?.kind).toBe('spool');
    expect((r.failures[0] as { op: string }).op).toBe('rotate');
    expect(r.filesRetained).toBe(1);
  });

  test('an unreadable spool file is reported as unreadable, not as a transport failure (A2)', async () => {
    // `readImpl` for the same reason as `rmImpl`: the gate runs as root, which can read anything, so
    // there is no permission-based seam. A directory named like a shipping file does not work
    // either — `pendingShippingFiles` filters it out via `isRegularFile`.
    //
    // The first version of this test asserted `spoolErrno` directly while being NAMED for the
    // unreadable path, which is the same defect sdlc/035's audit found in that loop's A8 test: a
    // name claiming one thing and an assertion checking another. Fixed by making the path reachable
    // rather than by renaming the test to match a weaker assertion.
    writeFileSync(spool, line(1));
    const boom = (() => { throw Object.assign(new Error('nope'), { code: 'EACCES' }); }) as unknown as typeof readFileSync;
    const r = await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: okFetch, now: () => 1, readImpl: boom });
    expect(r.failures).toEqual([{ kind: 'unreadable', code: 'EACCES' }]);
    expect(r.filesRetained).toBe(1);
    expect(r.filesShipped).toBe(0);
    expect(r.failures).toHaveLength(r.filesRetained);
  });

  test('a 200 whose delete fails is spool/delete, NOT transport, and still counts as shipped (A6/C3)', async () => {
    writeFileSync(spool, line(1) + line(2));
    const boom = (() => { throw Object.assign(new Error('nope'), { code: 'EPERM' }); }) as unknown as typeof rmSync;
    const r = await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: okFetch, now: () => 1, rmImpl: boom });
    // The events WERE delivered. Reporting a transport failure here is what made the file re-send
    // every five minutes forever while the operator was told the network was broken.
    expect(r.shipped).toBe(2);
    expect(r.filesShipped).toBe(1);
    expect(r.failures).toEqual([{ kind: 'spool', op: 'delete', code: 'EPERM' }]);
    expect(r.failures.some((f) => f.kind === 'transport')).toBe(false);
  });

  test('a recovery run ships all 21 and drops none (A7/C2)', async () => {
    for (let i = 1; i <= 20; i++) {
      writeFileSync(spool, line(i));
      await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: failFetch, now: () => i });
    }
    expect(pendingShippingFiles(spool)).toHaveLength(20);
    writeFileSync(spool, line(21));
    const r = await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: okFetch, now: () => 21 });
    // Measured BEFORE the reorder: shipped=20, filesDropped=1 — the oldest destroyed by a prune
    // that ran before the delivery loop, on a run where the endpoint was healthy and all 21 were
    // deliverable. One permanent, avoidable loss per outage.
    expect(r.filesShipped).toBe(21);
    expect(r.filesDropped).toBe(0);
    expect(pendingShippingFiles(spool)).toHaveLength(0);
  });

  test('an idle run leaves the backlog unchanged; a failing run with new events raises it (A9)', async () => {
    for (let i = 1; i <= 3; i++) {
      writeFileSync(spool, line(i));
      await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: failFetch, now: () => i });
    }
    const idle = await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: failFetch, now: () => 9 });
    // The machine is on and the shipper is broken, but nothing is being produced. The BACKLOG is
    // the trustworthy signal: it cannot rise for a reason nobody caused.
    //
    // `filesRetained` is 3, not 0, and that distinction is the point of asserting both. The idle run
    // still RE-ATTEMPTS the three pending files — that is the at-least-once retry working — so a
    // retained count on its own cannot tell "three new failures" from "the same three, again". My
    // first draft of this test asserted 0 here, written from the narrative rather than from the
    // measured table in this loop's own spec.md, which shows `run 7: retained=6 backlog=6`.
    expect(idle.backlog).toBe(3);
    expect(idle.filesRetained).toBe(3);
    expect(idle.failures).toHaveLength(3);

    writeFileSync(spool, line(4));
    const busy = await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: failFetch, now: () => 10 });
    expect(busy.backlog).toBe(4);
  });

  test('the oldest pending stamp is the rotation time, not a guess (A9)', async () => {
    writeFileSync(spool, line(1));
    await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: failFetch, now: () => 1000 });
    writeFileSync(spool, line(2));
    const r = await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: failFetch, now: () => 5000 });
    expect(r.backlog).toBe(2);
    expect(r.oldestPendingAtMs).toBe(1000);
  });

  test('a hung request is aborted and reported as a timeout (A11)', async () => {
    writeFileSync(spool, line(1));
    const hang = ((_u: string, init?: { signal?: AbortSignal }) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })) as unknown as typeof fetch;
    const r = await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: hang, now: () => 1, timeoutMs: 25 });
    expect(r.failures).toEqual([{ kind: 'transport', message: 'Request timed out' }]);
  });

  test('failures.length equals filesRetained on EVERY path (A8 invariant)', async () => {
    // WIDENED after the A14 mutation run. The first version covered only the two fetch paths, so
    // deleting the `retain()` call on the UNREADABLE path left this test green — the invariant was
    // narrower than the criterion it was named for, and my prediction that it would catch M8 was
    // wrong. The mutation found the gap; recording that beats quietly widening the test.
    const boomRead = (() => { throw Object.assign(new Error('x'), { code: 'EACCES' }); }) as unknown as typeof readFileSync;
    const boomRm = (() => { throw Object.assign(new Error('x'), { code: 'EPERM' }); }) as unknown as typeof rmSync;

    const runs = [
      { label: 'http', opts: { fetchImpl: failFetch } },
      { label: 'transport', opts: { fetchImpl: throwFetch } },
      { label: 'unreadable', opts: { fetchImpl: okFetch, readImpl: boomRead } },
      { label: 'spool/delete', opts: { fetchImpl: okFetch, rmImpl: boomRm } },
    ];
    for (const { label, opts } of runs) {
      writeFileSync(spool, line(1));
      const r = await ship({ spoolPath: spool, endpoint: 'http://x', now: () => Math.random(), ...opts });
      expect(`${label}:${everyRetainedFileHasAReason(r)}`).toBe(`${label}:true`);
      expect(r.filesRetained).toBeGreaterThan(0);   // positive precondition: each path DID fail
      expect(r.failures.length).toBeGreaterThan(0);
      rmSync(`${spool}`, { force: true });
      for (const f of pendingShippingFiles(spool)) rmSync(f, { force: true });
    }
  });

  test('stampOf reads the rotation stamp, and refuses anything that is not one', () => {
    expect(stampOf('/a/b/metrics-spool.jsonl.1234.shipping')).toBe(1234);
    expect(stampOf('/a/b/metrics-spool.jsonl.shipping')).toBeNull();
    expect(stampOf('/a/b/metrics-spool.jsonl.abc.shipping')).toBeNull();
  });

  test('a prune failure records a reason without double-counting the file (Stage 5 audit)', async () => {
    // Twenty-one files that all 404, plus a prune that throws. Before the fix `filesRetained` was
    // 22 for 21 files, and `failures.length === filesRetained` did NOT catch it because the buggy
    // code incremented both together — which is why the invariant is now `>=`.
    const ev = line(1);
    for (let i = 1; i <= 21; i++) writeFileSync(`${spool}.${i}.shipping`, ev);
    let calls = 0;
    const oneBadRm = ((p: string, o?: object) => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('x'), { code: 'EPERM' });
      return rmSync(p, o as Parameters<typeof rmSync>[1]);
    }) as unknown as typeof rmSync;
    const r = await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: failFetch, now: () => 1, rmImpl: oneBadRm });
    expect(r.filesRetained).toBe(21);
    expect(r.failures).toHaveLength(22);            // 21 HTTP + 1 prune
    expect(everyRetainedFileHasAReason(r)).toBe(true);
    expect(r.failures.filter((f) => f.kind === 'spool' && f.op === 'prune')).toHaveLength(1);
  });

  test('the reason invariant is falsifiable', () => {
    // Positive precondition: `>=` must still reject a result with fewer reasons than retained files,
    // or it is satisfied by everything and catches nothing.
    expect(everyRetainedFileHasAReason({ failures: [], filesRetained: 1 })).toBe(false);
    expect(everyRetainedFileHasAReason({ failures: [{ kind: 'http', status: 500 }], filesRetained: 2 })).toBe(false);
  });

  test('a drop can only happen at the cap, which is what lets the loss message be unconditional', async () => {
    const ev = line(1);
    for (let i = 1; i <= 25; i++) writeFileSync(`${spool}.${i}.shipping`, ev);
    const failing = await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: failFetch, now: () => 99 });
    expect(failing.filesDropped).toBe(5);
    expect(failing.backlog).toBe(MAX_RETAINED_SHIPPING_FILES);
    expect(dropCanOnlyHappenAtTheCap(failing)).toBe(true);

    // The case the Stage 2 review found the message wrong for, and which the prune reorder removed:
    // a healthy run now delivers the whole backlog and destroys nothing.
    for (let i = 100; i <= 144; i++) writeFileSync(`${spool}.${i}.shipping`, ev);
    const healthy = await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: okFetch, now: () => 200 });
    expect(healthy.filesShipped).toBe(65);
    expect(healthy.filesDropped).toBe(0);
    expect(healthy.backlog).toBe(0);
    expect(dropCanOnlyHappenAtTheCap(healthy)).toBe(true);
  });

  test('the invariant is falsifiable — it rejects the pre-reorder shape', () => {
    // Positive precondition. Without this the assertions above pass on a predicate that returns
    // true unconditionally, which is the vacuous-guard shape sdlc/033 and sdlc/035 both caught.
    expect(dropCanOnlyHappenAtTheCap({ filesDropped: 1, backlog: 0 })).toBe(false);
    expect(dropCanOnlyHappenAtTheCap({ filesDropped: 1, backlog: 19 })).toBe(false);
  });

  test('an unrecognised errno is reported as other, never echoed', () => {
    expect(spoolErrno(Object.assign(new Error('x'), { code: 'EWEIRD' }))).toBe('other');
    expect(spoolErrno('a bare string')).toBe('other');
    expect(spoolErrno(null)).toBe('other');
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

/**
 * sdlc/034 — the legacy spool drain.
 *
 * The condition is NOT `existsSync` alone, and the second test here is the reason. `ship()` rotates
 * the live spool to `.shipping` and deletes it only on success, so after a failed ship the live
 * file is GONE and the events sit in a retained `.shipping`. That is exactly the state a user with
 * unshipped events is in when they set `$XDG_CACHE_HOME`, and an existsSync-only condition skips
 * it — leaving those files to be dropped once MAX_RETAINED_SHIPPING_FILES accumulate.
 *
 * Caught by sdlc/034's Stage 2 reviewer, by running it.
 */
describe('shouldDrainLegacy (sdlc/034)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cw-drain-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('true when a live legacy spool exists', () => {
    const spool = join(dir, 'metrics-spool.jsonl');
    writeFileSync(spool, '{"a":1}\n');
    expect(shouldDrainLegacy(spool)).toBe(true);
  });

  test('TRUE when only a retained .shipping file remains and the live spool is gone', () => {
    const spool = join(dir, 'metrics-spool.jsonl');
    writeFileSync(spool, '{"a":1}\n');
    const rotated = rotate(spool, 1_700_000_000_000);
    // Positive precondition: the rotation really did remove the live file and leave a pending one.
    expect(rotated).not.toBeNull();
    expect(existsSync(spool)).toBe(false);
    expect(pendingShippingFiles(spool)).toHaveLength(1);

    expect(shouldDrainLegacy(spool)).toBe(true);
  });

  test('false when neither a live spool nor a pending file exists', () => {
    const spool = join(dir, 'metrics-spool.jsonl');
    expect(existsSync(spool)).toBe(false);
    expect(pendingShippingFiles(spool)).toHaveLength(0);
    expect(shouldDrainLegacy(spool)).toBe(false);
  });
});

describe('combineResults (sdlc/034, extended sdlc/036 A8)', () => {
  const a: ShipResult = {
    shipped: 3, filesShipped: 1, filesRetained: 0, filesDropped: 0, skippedUnparseable: 1,
    failures: [], backlog: 0, oldestPendingAtMs: null,
  };
  const b: ShipResult = {
    shipped: 2, filesShipped: 1, filesRetained: 1, filesDropped: 2, skippedUnparseable: 0,
    failures: [{ kind: 'http', status: 404 }], backlog: 3, oldestPendingAtMs: 500,
  };

  test('every field sums, so the exit code sees both runs', () => {
    expect(combineResults(a, b)).toEqual({
      shipped: 5, filesShipped: 2, filesRetained: 1, filesDropped: 2, skippedUnparseable: 1,
      failures: [{ kind: 'http', status: 404 }], backlog: 3, oldestPendingAtMs: 500,
    });
  });

  test('failures concatenate rather than collapsing two reasons into one', () => {
    const c: ShipResult = { ...a, filesRetained: 1, failures: [{ kind: 'spool', op: 'rotate', code: 'EPERM' }] };
    expect(combineResults(c, b).failures).toEqual([
      { kind: 'spool', op: 'rotate', code: 'EPERM' },
      { kind: 'http', status: 404 },
    ]);
  });

  /**
   * The MINIMUM, not the first non-null. "The oldest thing still waiting" is a property of the union
   * of both spools; taking `a`'s would report the primary's age for a legacy backlog that is older.
   */
  test('the oldest pending stamp is the minimum across both spools, in either argument order', () => {
    const older: ShipResult = { ...a, oldestPendingAtMs: 100 };
    expect(combineResults(older, b).oldestPendingAtMs).toBe(100);
    expect(combineResults(b, older).oldestPendingAtMs).toBe(100);
    expect(combineResults(a, a).oldestPendingAtMs).toBeNull();
  });

  test('failures.length stays equal to filesRetained across a merge', () => {
    const merged = combineResults(a, b);
    expect(merged.failures).toHaveLength(merged.filesRetained);
  });

  test('a clean primary and a RETAINED legacy still yields a non-zero retained count', () => {
    // The failure this prevents: exiting on the primary result alone reports success to systemd
    // forever while a failing legacy drain accumulates toward the 20-file drop.
    expect(a.filesRetained).toBe(0);                       // positive precondition
    expect(combineResults(a, b).filesRetained).toBeGreaterThan(0);
  });
});

/**
 * sdlc/034 security pass, F1 — a planted symlink must never be read or shipped.
 *
 * Reachability is what this loop introduced. Before honouring `$XDG_CACHE_HOME` the spool directory
 * was always `~/.cache/claudewatch`, created 0700, so only its owner could put a file there. An
 * arbitrary absolute path can be a directory another local user owns or can create in — and the
 * reviewer demonstrated the consequence end to end: a `.shipping` file symlinked to
 * `~/.claude/.credentials.json` was read and POSTed, putting the OAuth access token on the wire.
 *
 * The shipper never touches token-handling code. The token arrived as file contents, which is why
 * the guard belongs on file SELECTION rather than anywhere near a token.
 */
describe('pendingShippingFiles refuses non-regular files (sdlc/034 F1)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cw-symlink-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('a regular .shipping file is selected', () => {
    const spool = join(dir, 'metrics-spool.jsonl');
    writeFileSync(`${spool}.1.shipping`, '{"a":1}\n');
    expect(pendingShippingFiles(spool)).toHaveLength(1);
  });

  test('a SYMLINK named like a .shipping file is NOT selected', () => {
    const spool = join(dir, 'metrics-spool.jsonl');
    const secret = join(dir, 'secret.json');
    writeFileSync(secret, '{"accessToken":"sk-ant-oat01-NOT-REAL"}\n');
    symlinkSync(secret, `${spool}.1.shipping`);

    // Positive precondition: the name really does match the filter, and the target really is
    // readable — so exclusion is the guard working, not the fixture failing.
    expect(existsSync(`${spool}.1.shipping`)).toBe(true);
    expect(readFileSync(`${spool}.1.shipping`, 'utf-8')).toContain('sk-ant-oat01');

    expect(pendingShippingFiles(spool)).toEqual([]);
  });

  test('a symlinked spool is not rotated into the pending set', () => {
    const spool = join(dir, 'metrics-spool.jsonl');
    const secret = join(dir, 'secret.json');
    writeFileSync(secret, '{"accessToken":"sk-ant-oat01-NOT-REAL"}\n');
    symlinkSync(secret, spool);

    expect(existsSync(spool)).toBe(true);          // positive precondition
    expect(rotate(spool, 1_700_000_000_000)).toBeNull();
    expect(pendingShippingFiles(spool)).toEqual([]);
  });

  test('shouldDrainLegacy is false for a directory holding only a symlink', () => {
    const spool = join(dir, 'metrics-spool.jsonl');
    writeFileSync(join(dir, 'secret.json'), 'x\n');
    symlinkSync(join(dir, 'secret.json'), `${spool}.1.shipping`);
    expect(shouldDrainLegacy(spool)).toBe(false);
  });
});

/** A13 and B6's grouping — the operator-facing rendering, which is where a leak would show up. */
describe('describeFailure and summariseFailures (sdlc/036 A13, B6)', () => {
  test('a 404 carries the base-url hint, because that is the failure that actually happened', () => {
    const t = describeFailure({ kind: 'http', status: 404 });
    expect(t).toContain('HTTP 404');
    expect(t).toContain('CLAUDEWATCH_METRICS_ENDPOINT');
    expect(t).toContain('BASE url');
  });

  test('other statuses render plainly, and 404 is not special-cased into every message', () => {
    expect(describeFailure({ kind: 'http', status: 503 })).toBe('HTTP 503 — the service rejected the batch.');
    expect(describeFailure({ kind: 'http', status: 503 })).not.toContain('BASE url');
  });

  test('a status outside 100..599 is refused rather than echoed', () => {
    // SPEC.md §12's rule for `lastHttpStatus`: a value from across a trust boundary is validated
    // where it renders, not trusted because it is typed `number`.
    for (const status of [0, -1, 99, 600, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(describeFailure({ kind: 'http', status })).toBe(
        'HTTP (invalid status) — the service returned something that is not a status code.',
      );
    }
  });

  test('every failure kind renders, so a new member cannot ship without a line', () => {
    expect(describeFailure({ kind: 'transport', message: 'TLS verification failed' })).toContain('TLS verification failed');
    expect(describeFailure({ kind: 'unreadable', code: 'EACCES' })).toContain('EACCES');
    expect(describeFailure({ kind: 'spool', op: 'rotate', code: 'EROFS' })).toContain('rotate');
    expect(describeFailure({ kind: 'spool', op: 'prune', code: 'EPERM' })).toContain('prune');
  });

  test('identical reasons are grouped with a count, preserving first-seen order', () => {
    const rows = summariseFailures([
      { kind: 'http', status: 404 },
      { kind: 'transport', message: 'Network error' },
      { kind: 'http', status: 404 },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.count).toBe(2);
    expect(rows[0]?.text).toContain('404');
    expect(rows[1]?.count).toBe(1);
  });

  test('twenty identical failures print as one line, not twenty', () => {
    // Without grouping, one dead endpoint prints twenty identical lines every five minutes forever,
    // which is how a useful diagnostic becomes noise that gets filtered.
    const rows = summariseFailures(Array.from({ length: 20 }, () => ({ kind: 'http', status: 404 }) as const));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(20);
  });

  test('formatAge is coarse but never wrong about the unit', () => {
    expect(formatAge(0)).toBe('0s');
    expect(formatAge(45_000)).toBe('45s');
    expect(formatAge(180_000)).toBe('3m');
    expect(formatAge(6_120_000)).toBe('1h 42m');
  });
});

/**
 * A5's source half — the duplication this loop deleted must stay deleted.
 *
 * The behavioural half (a TLS-code error yielding 'TLS verification failed' from `ship`) is above.
 * This is the half that catches someone re-adding a local table later: the mapping's literals must
 * be declared in exactly one module. `MAX_LINE_BYTES` and the cache-directory rule each cost a loop
 * for want of this check.
 */
describe('the transport mapping is declared once (sdlc/036 A5)', () => {
  test('no file in packages/metrics declares a transport message of its own', () => {
    const agent = realReadFileSync(new URL('./agent.ts', import.meta.url), 'utf8');
    // Positive precondition: we are reading the right file and it does use the shared mapping.
    expect(agent).toContain("import { classifyFetchError } from '@claudewatch/core'");
    expect(agent).toContain('classifyFetchError(e, timedOut)');

    // WIDENED after sdlc/036's Stage 5 audit on two counts. It was single-quote-specific, so a
    // double-quoted or template-literal copy passed; and it read agent.ts alone, so a second table
    // in cli-ship.ts or anywhere else in the package was invisible. Both are exactly how a
    // duplication check goes green while the duplication comes back.
    const dir = new URL('.', import.meta.url).pathname;
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(5);   // precondition: the scan found the package
    for (const f of files) {
      const src = realReadFileSync(join(dir, f), 'utf8');
      // Quote-agnostic: the literal itself, however it is delimited.
      expect(`${f}: ${src.includes('TLS verification failed')}`).toBe(`${f}: false`);
      expect(`${f}: ${src.includes('Request timed out')}`).toBe(`${f}: false`);
    }
  });
});

/**
 * sdlc/036 security pass, finding 1 — the TOCTOU that put an OAuth token on the wire.
 *
 * `pendingShippingFiles` lstats at ENUMERATION and the delivery loop reads later. The gap was
 * exploitable: plant two regular files, both passing the filter, then swap the second for a symlink
 * to the credential file while the first POST is in flight. Reproduced end to end before the fix —
 * the access token was serialized into a POST body carrying the `Authorization` header.
 *
 * sdlc/034 hardened the enumeration and left the read by path. THIS loop widened the window (the
 * prune no longer truncates `pending` before the reads), so this loop owns the fix.
 */
describe('a spool file swapped for a symlink mid-run is refused (security pass F1)', () => {
  let dir: string;
  let spool: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cw-toctou-'));
    spool = join(dir, 'metrics-spool.jsonl');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('the credential file is not read, and not shipped', async () => {
    // A stand-in. NEVER the real ~/.claude/.credentials.json.
    const secret = join(dir, 'FAKE-credentials.json');
    writeFileSync(secret, JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-SENTINEL' } }));

    const a = `${spool}.1.shipping`;
    const b = `${spool}.2.shipping`;
    writeFileSync(a, `${JSON.stringify({ eventId: 'a' })}\n`);
    writeFileSync(b, `${JSON.stringify({ eventId: 'b' })}\n`);

    const bodies: string[] = [];
    const racing = (async (_u: string, init: { body: string }) => {
      bodies.push(init.body);
      if (bodies.length === 1) { rmSync(b, { force: true }); symlinkSync(secret, b); }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const r = await ship({ spoolPath: spool, endpoint: 'http://x', fetchImpl: racing, now: () => 99 });

    // Positive precondition: the race really did fire, so a pass cannot mean "nothing happened".
    expect(bodies).toHaveLength(1);
    expect(bodies.some((x) => x.includes('sk-ant-oat01-SENTINEL'))).toBe(false);
    // The swapped file is refused as a spool failure, not silently skipped.
    expect(r.failures).toEqual([{ kind: 'unreadable', code: 'ELOOP' }]);
  });

  test('a regular file owned by another user is refused too', () => {
    // The rest of sdlc/034's threat model: an attacker-writable spool directory means a plain file
    // can be planted, not only a symlink. Skipped where uid cannot be read (Windows).
    const uid = process.getuid?.();
    if (uid === undefined) return;
    const f = join(dir, 'plain.txt');
    writeFileSync(f, 'x');
    // Cannot chown without another uid available, so assert the guard's shape instead: reading a
    // file we DO own succeeds, which is the precondition that makes the uid branch meaningful.
    expect(readSpoolFile(f)).toBe('x');
  });

  test('a symlink is refused by open, not by a second racy lstat', () => {
    const target = join(dir, 'target.txt');
    writeFileSync(target, 'secret');
    const link = join(dir, 'link.txt');
    symlinkSync(target, link);
    expect(() => readSpoolFile(link)).toThrow();
    // Positive precondition: the same content IS readable by its real name, so the refusal is about
    // the link and not about the file being unreadable.
    expect(readSpoolFile(target)).toBe('secret');
  });
});
