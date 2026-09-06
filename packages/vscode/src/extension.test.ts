/**
 * Tests for the extension's refresh logic.
 *
 * `doRefresh` is NOT exported, and is not exported for these tests either. Every case drives it
 * the way a user does — through `activate` and the registered `claudewatch.refresh` command — so
 * what is under test is what ships. (sdlc/027 Q1, settled by running it.)
 *
 * NETWORK SAFETY — two layers, and the first one is NOT an isolated HOME.
 *
 * The first version of this file set `process.env.HOME` to a temp dir with an expired credential
 * and claimed the network was unreachable "by construction". **That layer did not exist.** On bun,
 * `os.homedir()` is fixed at process start and does not re-read HOME, so `getCredentialPath()`
 * still resolved to the developer's real `~/.claude/.credentials.json`. Measured:
 *
 *     homedir() before: /root
 *     process.env.HOME = /tmp/fake   ->   homedir() after: /root
 *     getCredentialPath(): /root/.claude/.credentials.json
 *
 * The pattern was lifted from sdlc/024's `seedSandboxHome`, where setting HOME works because it
 * goes into a CHILD PROCESS's spawn env. In-process it does nothing. Worse than a missing guard:
 * the docstring asserted the guarantee, so the next reader would have built on it. Found by the
 * sdlc/027 security pass.
 *
 * What actually holds egress shut:
 *
 *   1. `globalThis.fetch` is replaced with a thrower for the whole file. `client.ts:75` calls the
 *      global, so this blocks a live request no matter which module lost `mock.module`'s
 *      process-wide race — which is the failure mode sdlc/024 paid for.
 *   2. The `./extension-bridge.js` mock's `fetchUsage` throws unless a case opts in.
 *
 * TELEMETRY: `setCacheBaseDir` points the spool at a temp dir, because unlike HOME it DOES take
 * effect in-process (measured). Without it this file's real `StatusBarManager` calls real
 * `emitProcess`, and core's `processConfig` is whatever an earlier test file left — the security
 * pass produced 14+ render lines in the real `~/.cache/claudewatch/metrics-spool.jsonl` that way.
 *
 * NOT COVERED, deliberately (see sdlc/027-extension-tests/spec.md A8): `activate`'s config-change
 * handlers, and the polling timer's scheduling. There is a `test.todo` per gap so `bun test` prints
 * them. `activate`'s `onDidChangeTelemetryEnabled` listener WAS a third gap and is covered as of
 * sdlc/041 — its todo said the branch was dead because the stub omitted the key, which stopped
 * being true when sdlc/039 added it.
 *
 * The count below is machine-checked ('the docstring gap count matches the todos'), because this
 * paragraph has drifted before: an earlier revision said "a `test.todo` per gap" while listing three
 * gaps beside four todos, the fourth added without updating the count. `commands.ts` was that fourth
 * gap and is now covered by `commands.test.ts` (sdlc/028). Prose is prose; the assertion reads the
 * line below and nothing else.
 *
 * GAPS: 2
 */
import { describe, expect, test, mock, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { makeTestSnapshot, setupTestCacheDir } from '@claudewatch/core/test-helpers';
import { getCacheDir } from '@claudewatch/core';
import type { UsageSnapshot } from '@claudewatch/core';
import { vscodeStub, resetVscodeStub } from './vscode-stub.js';

// --- layer 1: no egress, whatever else goes wrong ---

const realFetch = globalThis.fetch;
let sandboxCacheDir: string;
let cacheCleanup: (() => void) | null = null;

beforeAll(() => {
  globalThis.fetch = (() => {
    throw new Error('extension.test.ts: a live fetch was attempted. No test here may reach the network.');
  }) as unknown as typeof fetch;
  const t = setupTestCacheDir();
  cacheCleanup = t.cleanup;
  sandboxCacheDir = t.tempDir;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  cacheCleanup?.();
});

describe('the safety layers themselves', () => {
  test('the spool is redirected away from the real cache dir', () => {
    // The assertion that would have caught the inert-HOME defect had it been written against the
    // thing that matters rather than against the env var.
    //
    // POSITIVE identity, not two negatives. Until sdlc/034 this read `not.toBe(legacy)` plus
    // `startsWith(tmpdir())`, and sdlc/034's audit showed that combination goes GREEN with the
    // `setupTestCacheDir` override deleted — because `getCacheDir()` then honours an ambient
    // `$XDG_CACHE_HOME`, which on a container or CI runner usually lives under TMPDIR and satisfies
    // both checks. A describe block named "the safety layers themselves" was passing with the
    // safety layer removed. Asserting the exact directory the override installed kills that mutant
    // and does not depend on where anyone's cache happens to live.
    expect(getCacheDir()).toBe(sandboxCacheDir);
    // Kept as a standing statement of intent: whatever the override installs must not be the real
    // location. Redundant while the line above holds, and the one that fails loudest if it stops.
    expect(getCacheDir()).not.toBe(join(homedir(), '.cache', 'claudewatch'));
  });

  test('global fetch throws', () => {
    expect(() => (globalThis.fetch as unknown as () => void)()).toThrow(/live fetch was attempted/);
  });
});

// --- the vscode stub ---

let intervalHandles: unknown[] = [];
let clearedHandles: unknown[] = [];

// One shared vscode stub; see vscode-stub.ts for why per-file factories do not compose. The
// command registry this file drives lives in the stub's state, refreshed by `resetVscodeStub()`
// so a command registered by one test cannot be invoked by the next. (sdlc/039)
mock.module('vscode', () => vscodeStub);

/** The stub's live command registry. Assigned by the reset in `beforeEach`, never at load: a
 *  side-effecting reset of a process-wide singleton at IMPORT time is the one thing in this diff
 *  that could perturb another file's state if load and run ever interleave — which is the hazard
 *  class this loop exists to close. (Stage 5 audit) */
let registered: Map<string, (...a: unknown[]) => unknown>;

// --- the bridge mock ---

interface Call { name: string; arg?: unknown }
let calls: Call[] = [];
const log = (name: string, arg?: unknown): void => { calls.push({ name, arg }); };

/** Flipped per-case. `throw` is the default so a case that forgets to opt in cannot fetch. */
let fetchMode: { mode: 'throw' } | { mode: 'ok'; data: unknown } | { mode: 'fail'; result: Record<string, unknown> } =
  { mode: 'throw' };
let credentials: { authState: string; accessToken: string | null } = { authState: 'missing', accessToken: null };
let cachedEnvelope: Record<string, unknown> | null = null;
let cacheFresh = false;
let inCooldown = false;
let cooldownWanted = false;
let policyPresentation = 'unknown';
/** Drives the unexpected-throw arm (extension.ts:254). Nothing else in doRefresh can be made to
 *  throw without also breaking the catch-all's own `readCache`. */
let writeCacheThrows = false;

const snap = (o?: Partial<UsageSnapshot>): UsageSnapshot => makeTestSnapshot(o);

const BRIDGE_KEYS = [
  'clearCooldown', 'enterCooldown', 'extractLastError', 'failurePolicy', 'fetchUsage',
  'isCacheFresh', 'isInCooldown', 'makeCacheEnvelope', 'makeErrorSnapshot', 'markStale',
  'normalize', 'readCache', 'resolveCredentials', 'setTelemetryConfig', 'shouldCooldown',
  'writeCache',
];

mock.module('./extension-bridge.js', () => ({
  setTelemetryConfig: (c: unknown) => log('setTelemetryConfig', c),
  resolveCredentials: () => { log('resolveCredentials'); return credentials; },
  fetchUsage: async () => {
    log('fetchUsage');
    if (fetchMode.mode === 'throw') throw new Error('fetchUsage must not be reached in this case');
    // Deliberately NO timer. `flush()`'s guarantee rests on this mock resolving on the microtask
    // queue; a `setTimeout` here reintroduces the macrotask lull that made the old `settle()` a
    // 5ms-margin flake (sdlc/027 Stage 5: delay 1ms -> 0 fail, 6ms -> 2 fail, 20ms -> 6 fail).
    // The premise is pinned by a test rather than by this comment — see 'adds no macrotask wait'.
    return fetchMode.mode === 'ok' ? { ok: true, data: fetchMode.data } : { ok: false, ...fetchMode.result };
  },
  normalize: (d: unknown) => { log('normalize'); return d as UsageSnapshot; },
  readCache: () => { log('readCache'); return cachedEnvelope; },
  writeCache: (e: unknown) => {
    log('writeCache', e);
    if (writeCacheThrows) throw new Error('writeCache exploded');
  },
  isCacheFresh: () => cacheFresh,
  makeCacheEnvelope: (s: unknown, c: unknown = null, l: unknown = null) =>
    ({ version: 2, snapshot: s, cooldownUntil: c, lastErrorClass: l, lastHttpStatus: null, lastErrorMessage: null }),
  isInCooldown: () => inCooldown,
  enterCooldown: (e: Record<string, unknown>) => { log('enterCooldown'); return { ...e, cooldownUntil: 'soon' }; },
  clearCooldown: (e: unknown) => { log('clearCooldown'); return e; },
  shouldCooldown: () => cooldownWanted,
  failurePolicy: () => ({ presentation: policyPresentation }),
  markStale: (s: unknown) => { log('markStale'); return s as UsageSnapshot; },
  makeErrorSnapshot: (k: string) => { log('makeErrorSnapshot', k); return snap(); },
  extractLastError: () => null,
}));

const { activate, deactivate, telemetryOverride } = await import('./extension.js');

// --- helpers ---

/**
 * Yield one macrotask, which drains the microtask queue to exhaustion.
 *
 * `activate` fires an un-awaited `doRefresh(false)` (extension.ts:105) that nothing can await, so
 * asserting immediately after `activate` races it. Arithmetic does not work either: a command
 * issued while that refresh is in flight is SWALLOWED by the dedupe rather than counted, so you
 * cannot "subtract the initial refresh".
 *
 * This REPLACES a drain-until-quiet helper that polled until the call log stopped growing. That
 * was not a completion test, it was a lull test, and `doRefresh` contains a lull: it suspends at
 * `await fetchUsage(...)`. Whenever that suspension outlasted one 5ms poll, the helper returned
 * mid-refresh, `refreshInFlight` stayed true, and the NEXT case's refresh was silently swallowed
 * by the dedupe — surfacing as that case's own missing calls. Measured in Stage 5 by varying only
 * the mock's delay, which changes no behaviour under test: 1ms -> 0 fail, 6ms -> 2, 20ms -> 6.
 * A 5ms margin, i.e. one loaded CI box away from red.
 *
 * One macrotask is a GUARANTEE here rather than a longer heuristic, and only because of a premise
 * the mock upholds: `fetchUsage` starts no timer, so `doRefresh` contains no macrotask wait
 * between entry and `finally`. Every continuation is a microtask, and the microtask queue drains
 * completely before the next macrotask callback runs. That premise is load-bearing, so it is
 * asserted ('adds no macrotask wait') rather than trusted.
 */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

function makeCtx(): { subscriptions: Array<{ dispose(): void }> } {
  return { subscriptions: [] };
}

let ctx = makeCtx();

async function start(): Promise<void> {
  ctx = makeCtx();
  await activate(ctx as never);
  await flush();
  calls = [];   // drop activate's initial refresh; every case asserts on what IT caused
}

const refresh = async (): Promise<void> => {
  await registered.get('claudewatch.refresh')!();
  await flush();
};

const names = (): string[] => calls.map((c) => c.name);

beforeEach(() => {
  // The stub is shared across every test file now, so each test starts from its pristine shape
  // and a fresh command registry rather than inheriting whatever the last one left. (sdlc/039)
  registered = resetVscodeStub().registered;
});

afterEach(() => {
  // Dispose BEFORE deactivate: deactivate clears only pollingTimer and statusBar, leaving the
  // command registrations and the config listener live. A listener surviving into the next test
  // can call startPolling() again, creating an interval after deactivate already ran.
  for (const d of ctx.subscriptions) d.dispose();
  deactivate();
  calls = [];
  fetchMode = { mode: 'throw' };
  credentials = { authState: 'missing', accessToken: null };
  cachedEnvelope = null; cacheFresh = false; inCooldown = false;
  cooldownWanted = false; policyPresentation = 'unknown'; writeCacheThrows = false;
});

// --- A9: the stub's key set ---

describe('the bridge mock', () => {
  test('exposes exactly the symbols extension.ts imports', async () => {
    // Catches a SURPLUS key only, and that is the whole of its value. A MISSING key is a hard
    // SyntaxError at module-link time (0 pass, 1 fail) — measured, against a spec that claimed it
    // would be a swallowed TypeError. See extension-bridge.ts's docstring.
    // Known gap: BRIDGE_KEYS is a hand-written literal, and because this module is mocked the
    // assertion compares the MOCK's keys to it, never the bridge's real exports. A symbol added to
    // extension-bridge.ts but not imported by extension.ts drifts past both.
    const stubbed = await import('./extension-bridge.js');
    expect(Object.keys(stubbed).toSorted()).toEqual(BRIDGE_KEYS);
  });
});

// --- A3: the branches ---

describe('doRefresh, driven through the registered command', () => {
  test('missing credentials writes an error snapshot and never fetches', async () => {
    await start();
    await refresh();
    expect(names()).toEqual(['readCache', 'resolveCredentials', 'makeErrorSnapshot', 'writeCache']);
    expect(calls.find((c) => c.name === 'makeErrorSnapshot')!.arg).toBe('missing');
    // The catch at extension.ts:254 also calls readCache. Exactly one here proves this case
    // reached its own branch rather than throwing into the catch-all — which is how the sdlc/027
    // prototype fooled itself.
    expect(names().filter((n) => n === 'readCache')).toHaveLength(1);
  });

  test('a valid authState with an empty token takes the same branch', async () => {
    // `authState === 'missing' || !creds.accessToken` — a distinct condition. Mutating `||` to
    // `&&` keeps the previous test green and breaks this one.
    credentials = { authState: 'valid', accessToken: '' };
    await start();
    await refresh();
    expect(calls.find((c) => c.name === 'makeErrorSnapshot')!.arg).toBe('missing');
    expect(names()).not.toContain('fetchUsage');
  });

  test('invalid credentials writes an invalid snapshot and never fetches', async () => {
    credentials = { authState: 'invalid', accessToken: 'tok' };
    await start();
    await refresh();
    expect(calls.find((c) => c.name === 'makeErrorSnapshot')!.arg).toBe('invalid');
    expect(names()).not.toContain('fetchUsage');
  });

  test('a successful fetch writes a cleared envelope', async () => {
    credentials = { authState: 'valid', accessToken: 'tok' };
    fetchMode = { mode: 'ok', data: snap() };
    await start();
    await refresh();
    expect(names()).toContain('fetchUsage');
    expect(names()).toContain('normalize');
    expect(names()).toContain('clearCooldown');
    expect(names()).toContain('writeCache');
    // Positive precondition for every `not.toContain('fetchUsage')` above: the throwing default
    // really would have fired, because this case reaches the same stub with the flag flipped.
  });

  test('a failure with a definite presentation replaces the status bar', async () => {
    credentials = { authState: 'valid', accessToken: 'tok' };
    fetchMode = { mode: 'fail', result: { failureClass: 'authInvalid', status: 401, message: 'x' } };
    policyPresentation = 'invalid';
    await start();
    await refresh();
    expect(calls.find((c) => c.name === 'makeErrorSnapshot')!.arg).toBe('invalid');
    expect(names()).not.toContain('markStale');
  });

  test('an unknown-presentation failure WITH cache goes stale-while-error', async () => {
    credentials = { authState: 'valid', accessToken: 'tok' };
    cachedEnvelope = { version: 2, snapshot: snap(), cooldownUntil: null, lastErrorClass: null };
    fetchMode = { mode: 'fail', result: { failureClass: 'serviceUnavailable', status: 503, message: 'x' } };
    await start();
    await refresh();
    expect(names()).toContain('markStale');
    expect(names()).not.toContain('enterCooldown');   // cooldownWanted is false
  });

  test('...and enters cooldown when the failure class says so', async () => {
    credentials = { authState: 'valid', accessToken: 'tok' };
    cachedEnvelope = { version: 2, snapshot: snap(), cooldownUntil: null, lastErrorClass: null };
    fetchMode = { mode: 'fail', result: { failureClass: 'serviceUnavailable', status: 503, message: 'x' } };
    cooldownWanted = true;
    await start();
    await refresh();
    expect(names()).toContain('enterCooldown');
    // Pins WHICH arm. `enterCooldown` is reachable from extension.ts:240 and :249; only the
    // with-cache arm calls markStale first. Without this the case passes via the no-cache arm
    // and the {cached} x {cooldown} cell it claims to cover is untested. (Stage 5 audit.)
    expect(names()).toContain('markStale');
  });

  test('an unknown-presentation failure with NO cache uses an unknown snapshot', async () => {
    credentials = { authState: 'valid', accessToken: 'tok' };
    fetchMode = { mode: 'fail', result: { failureClass: 'serviceUnavailable', status: 503, message: 'x' } };
    await start();
    await refresh();
    expect(calls.find((c) => c.name === 'makeErrorSnapshot')!.arg).toBe('unknown');
    expect(names()).not.toContain('markStale');
  });

  test('...and the no-cache arm enters cooldown too', async () => {
    // extension.ts:249, the fourth cell of {cached, none} x {cooldown y, n}. The plan's Tests
    // table promised all four; revision 1 shipped three and the miss was invisible because the
    // with-cache case above asserted only `toContain('enterCooldown')`. (Stage 5 audit.)
    credentials = { authState: 'valid', accessToken: 'tok' };
    fetchMode = { mode: 'fail', result: { failureClass: 'serviceUnavailable', status: 503, message: 'x' } };
    cooldownWanted = true;
    await start();
    await refresh();
    expect(calls.find((c) => c.name === 'makeErrorSnapshot')!.arg).toBe('unknown');   // no-cache arm
    expect(names()).toContain('enterCooldown');
    expect(names()).not.toContain('markStale');
  });

  test('an unexpected throw lands in the catch-all instead of escaping', async () => {
    // extension.ts:254 — the arm the Stage 2 spec review added to A3 by name, precisely because a
    // prototype had fooled itself by miscounting it, and which revision 1 then shipped without.
    // Exact equality is what makes it decisive: the SECOND `readCache` is the catch's signature,
    // and no non-throwing path produces one.
    await start();
    // AFTER start(), deliberately. Setting it before means activate's own initial refresh throws
    // too, so the fixture leans on the catch-all to survive its own setup and a second escape
    // bleeds into the next case. One throw, in the call under test. (Found by mutating the catch
    // away and getting two failures where one was predicted.)
    writeCacheThrows = true;
    await refresh();                       // must resolve, not reject: the point is not crashing
    expect(names()).toEqual([
      'readCache', 'resolveCredentials', 'makeErrorSnapshot', 'writeCache', 'readCache',
    ]);
  });
});

describe('doRefresh, driven through activate (the non-manual path)', () => {
  test('a fresh cache short-circuits without resolving credentials', async () => {
    // `!manual` — unreachable from the command, which always passes manual: true. Driven through
    // activate's initial refresh instead, which is why this case does not call start().
    cachedEnvelope = { version: 2, snapshot: snap(), cooldownUntil: null, lastErrorClass: null };
    cacheFresh = true;
    ctx = makeCtx();
    await activate(ctx as never);
    await flush();
    expect(names()).toEqual(['setTelemetryConfig', 'readCache']);
    expect(names()).not.toContain('resolveCredentials');
  });

  test('cooldown writes a stale envelope', async () => {
    cachedEnvelope = { version: 2, snapshot: snap({ freshness: { isStale: false, staleReason: 'none' } }),
                       cooldownUntil: 'later', lastErrorClass: null };
    inCooldown = true;
    ctx = makeCtx();
    await activate(ctx as never);
    await flush();
    expect(names()).toContain('markStale');
    expect(names()).toContain('writeCache');
    expect(names()).not.toContain('resolveCredentials');
  });

  test('cooldown SUPPRESSES the write when the snapshot is already stale for the same reason', async () => {
    // The false side of extension.ts:171-174. A different arm from the case above; breaking the
    // guard must redden exactly one of them.
    cachedEnvelope = { version: 2, snapshot: snap({ freshness: { isStale: true, staleReason: 'fetchFailed' } }),
                       cooldownUntil: 'later', lastErrorClass: null };
    inCooldown = true;
    ctx = makeCtx();
    await activate(ctx as never);
    await flush();
    expect(names()).toContain('markStale');
    expect(names()).not.toContain('writeCache');
  });
});

describe('the premises these tests rest on', () => {
  test('the bridge mock adds no macrotask wait', async () => {
    // flush() is only a guarantee while this holds. A promise resolved on the microtask queue
    // always beats setTimeout(...,0), so reintroducing a timer into the mock's fetchUsage — the
    // exact edit that quantified the old helper's 5ms margin — reddens this and nothing else.
    const bridge = await import('./extension-bridge.js');
    fetchMode = { mode: 'ok', data: snap() };
    const raced = await Promise.race([
      bridge.fetchUsage('tok').then(() => 'microtask'),
      new Promise((r) => setTimeout(() => r('macrotask'), 0)),
    ]);
    expect(raced).toBe('microtask');
  });

  test('the refresh command returns a promise that settles AFTER the refresh', async () => {
    // Pins extension.ts:93, this loop's one production change. A2 permitted it so it could not be
    // slipped in unnoticed; the Stage 5 audit then found no test needed it — reverting to the
    // discarding form left the suite green, which was the plan's own falsification condition and
    // it was met. This is the test that earns it: the discarding form returns undefined, so the
    // first assertion fails outright, and the second fails because nothing has run yet.
    credentials = { authState: 'valid', accessToken: 'tok' };
    fetchMode = { mode: 'ok', data: snap() };
    await start();
    const returned = registered.get('claudewatch.refresh')!();
    expect(returned).toBeInstanceOf(Promise);
    await returned;
    // Deliberately NO flush(): if the handler awaited the refresh, the log is already complete.
    expect(names()).toContain('writeCache');
  });
});

describe('lifecycle', () => {
  test('the in-flight dedupe drops a concurrent refresh', async () => {
    credentials = { authState: 'valid', accessToken: 'tok' };
    fetchMode = { mode: 'ok', data: snap() };
    await start();
    const a = registered.get('claudewatch.refresh')!();
    const b = registered.get('claudewatch.refresh')!();   // lands while a is suspended in fetchUsage
    await Promise.all([a, b]);
    await flush();
    expect(names().filter((n) => n === 'fetchUsage')).toHaveLength(1);
  });

  test('deactivate clears the interval it created', async () => {
    // Asserts on the HANDLE, not on "no further refresh occurs" — the interval floor is 30s, so
    // that could never fire during a test and the assertion would be unconditionally true.
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    intervalHandles = []; clearedHandles = [];
    globalThis.setInterval = ((...a: Parameters<typeof setInterval>) => {
      const h = realSet(...a); intervalHandles.push(h); return h;
    }) as typeof setInterval;
    globalThis.clearInterval = ((h: Parameters<typeof clearInterval>[0]) => {
      clearedHandles.push(h); return realClear(h);
    }) as typeof clearInterval;
    try {
      ctx = makeCtx();
      await activate(ctx as never);
      await flush();
      expect(intervalHandles).toHaveLength(1);
      expect(clearedHandles).not.toContain(intervalHandles[0]);
      deactivate();
      expect(clearedHandles).toContain(intervalHandles[0]);
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    }
  });
});

/**
 * Builds a `test.todo(...)` line as fixture TEXT for A4's control.
 *
 * Assembled by interpolation, and module-scoped, for two different reasons. Interpolation so the
 * fixture's own source lines cannot be counted by A4's self-read whatever indentation or quoting
 * they are written in — measured: as a literal, reformatting the fixture broke A4 with a confusing
 * count. Module scope because it captures nothing, and `unicorn(consistent-function-scoping)` is in
 * the lint budget. (sdlc/041 Stage 5 audit)
 */
const todoLine = (indent: string, name: string): string => `${indent}test.${'todo'}('${name}');`;

describe('the telemetry listener', () => {
  /**
   * extension.ts:75-81 — the LIVE half of SPEC.md §10.6 (line 595): "Both inputs are re-evaluated
   * live." telemetry-gate.test.ts covers the decision function; nothing covered the wiring, so a
   * callback replaced by `() => {}` kept every test in this repo green while telemetry carried on
   * flowing from a user who had turned it off. (sdlc/041)
   *
   * All four drive `activate(ctx)` directly rather than `start()`, which clears `calls` at :210.
   */
  const SENTINEL = { dispose: (): void => {} };

  /** Overrides the leaf to capture the callback and hand back a disposable we can identify. */
  function captureListener(): { cb: () => void } {
    const box: { cb: () => void } = { cb: () => {} };
    vscodeStub.env.onDidChangeTelemetryEnabled = ((cb: () => void) => {
      box.cb = cb;
      return SENTINEL;
    }) as typeof vscodeStub.env.onDidChangeTelemetryEnabled;
    return box;
  }

  const lastGate = (): unknown => calls.findLast((c) => c.name === 'setTelemetryConfig')?.arg;

  test('is registered: the disposable it returns lands in context.subscriptions', async () => {
    const box = captureListener();
    ctx = makeCtx();
    await activate(ctx as never);
    await flush();

    expect(typeof box.cb).toBe('function');
    // IDENTITY, not length. `activate` pushes seven disposables, so deleting only the telemetry
    // push leaves six and any "did it grow" assertion survives the mutation it exists to catch.
    expect(ctx.subscriptions).toContain(SENTINEL);
  });

  // Named for the ONE event source it fires. "Both observables" means the two things asserted on —
  // `setTelemetryConfig` and `telemetryOverride()` — not two event sources: `onDidChangeConfiguration`
  // is NOT fired here and is still a `test.todo`. Gutting its telemetry branch (extension.ts:126)
  // leaves all 428 tests green, so a user who turns the SETTING off mid-session keeps emitting until
  // reload with nothing to notice. Recorded in sdlc/041's review.md; out of this loop's fence.
  test('firing the telemetry-enabled event re-runs the gate over both ANDed inputs', async () => {
    // Seed the setting BEFORE capturing: `resetVscodeStub()` restores the pristine leaf, so a
    // capture installed before it would be undone. `extension.ts` reads the setting with
    // `.get<boolean>('telemetry.enabled')` and NO default, so an unseeded stub returns `undefined`
    // and the AND is a constant `false` — which the first draft of this spec mistook for proof the
    // observable worked.
    const st = resetVscodeStub();
    st.configValues['telemetry.enabled'] = true;
    const box = captureListener();
    vscodeStub.env.isTelemetryEnabled = true;
    ctx = makeCtx();
    await activate(ctx as never);
    await flush();

    // Row 1 — both on is the only combination that emits.
    box.cb();
    expect(lastGate()).toEqual({ enabled: true });
    expect(telemetryOverride()).toEqual({ enabled: true });

    // Row 2 — the global switch subtracts.
    vscodeStub.env.isTelemetryEnabled = false;
    box.cb();
    expect(lastGate()).toEqual({ enabled: false });
    expect(telemetryOverride()).toEqual({ enabled: false });

    // Row 3 — the SETTING subtracts. Varying only the switch leaves a mutant that drops
    // settingEnabled from the AND invisible, inverting SPEC.md:595's "narrow, never widen".
    // Seeded explicitly false rather than left unseeded: only that says "the user turned it off".
    vscodeStub.env.isTelemetryEnabled = true;
    st.configValues['telemetry.enabled'] = false;
    box.cb();
    expect(lastGate()).toEqual({ enabled: false });
    expect(telemetryOverride()).toEqual({ enabled: false });
  });

  test('a host without the key registers nothing and still activates', async () => {
    // Two halves so the negative has a positive control and no magic number. `toBe(6)` would break
    // the day anything else in `activate` pushes a disposable, and the next person would bump it
    // to 7 rather than notice.
    captureListener();
    ctx = makeCtx();
    await activate(ctx as never);
    await flush();
    const withKey = ctx.subscriptions.length;
    expect(ctx.subscriptions).toContain(SENTINEL);

    for (const d of ctx.subscriptions) d.dispose();
    deactivate();
    resetVscodeStub();
    delete (vscodeStub.env as Partial<typeof vscodeStub.env>).onDidChangeTelemetryEnabled;

    ctx = makeCtx();
    await activate(ctx as never);   // resolving at all is the "still activates" half
    await flush();
    expect(ctx.subscriptions).not.toContain(SENTINEL);
    expect(ctx.subscriptions.length).toBe(withKey - 1);
  });

  test('the docstring gap count matches the todos', () => {
    const text = readFileSync(import.meta.path, 'utf-8');
    // Three parts, each doing a different job, measured over THIS FILE rather than over a fixture:
    //
    //   `\s*`  makes an INDENTED todo count. A bare `^` misses one written inside a describe, and
    //          the docstring would then claim two while bun prints three — green on real drift.
    //   `\(`   excludes the backticked `test.todo` prose in the header and the regex literals here.
    //   `td()` below assembles the fixture's lines by interpolation, so the fixture cannot be
    //          counted by this read whatever indentation or quoting style it is written in.
    //
    // Four earlier explanations of this line were wrong, each replaced by another that was also
    // wrong: the assembly prevents the self-count (it did not), the `^` anchor does (it did not
    // alone), the `\(` does all of it (measured false — unanchored counts 4 over this file, because
    // it also hits the fixture). This one was measured against the file it reads.
    //
    // `String.match` resets a /g regex's lastIndex, so TODO is safe to apply twice; `.test()` would
    // NOT be — see mock-topology.ts's MOCK_CALL note for the version of this that bit before.
    const TODO = /^\s*test\.todo\(/gm;
    const CLAIM = /^ \* GAPS: (\d+)$/m;

    const claimed = Number(CLAIM.exec(text)?.[1] ?? '-1');
    const actual = (text.match(TODO) ?? []).length;
    expect(actual).toBeGreaterThan(0);   // an unmatched pattern must not be green-forever
    expect(`claimed=${claimed} actual=${actual}`).toBe(`claimed=${actual} actual=${actual}`);

    // Control 1: the claim regex reads a synthetic pre-change line. No historical `GAPS:` line
    // exists — the old docstring said "THREE" in prose — so this fixture is synthetic by necessity.
    expect(Number(CLAIM.exec(' * GAPS: 3')?.[1])).toBe(3);

    // Control 2: a fixture, not a phrase pin. A prose-non-match assertion passes with OR without
    // the anchor and so controls nothing.
    const FIXTURE = [
      ' * There is a `test.todo` per gap',
      todoLine('', 'top level'),
      todoLine('  ', 'indented inside a describe'),
    ].join('\n');
    // TODO itself, not a private copy of it. Shipped with its own duplicate literal, this control
    // stayed green when TODO was weakened to a bare `^` — a control decoupled from the thing it
    // controls, inside the criterion added to prevent exactly that. (Stage 5 audit)
    expect((FIXTURE.match(TODO) ?? []).length).toBe(2);
  });
});

// --- A8: the gaps, printed on every run ---

test.todo('activate: the onDidChangeConfiguration handlers (interval, thresholds, telemetry)', () => {});
test.todo('startPolling: the interval scheduling and its 30s floor', () => {});
