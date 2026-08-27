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
 * NOT COVERED, deliberately (see sdlc/027-extension-tests/spec.md A8): `activate`'s
 * config-change handlers, the polling timer's scheduling, and `commands.ts`. There is a
 * `test.todo` per gap so `bun test` prints them.
 */
import { describe, expect, test, mock, beforeAll, afterAll, afterEach } from 'bun:test';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { makeTestSnapshot, setupTestCacheDir } from '@claudewatch/core/test-helpers';
import { getCacheDir } from '@claudewatch/core';
import type { UsageSnapshot } from '@claudewatch/core';

// --- layer 1: no egress, whatever else goes wrong ---

const realFetch = globalThis.fetch;
let cacheCleanup: (() => void) | null = null;

beforeAll(() => {
  globalThis.fetch = (() => {
    throw new Error('extension.test.ts: a live fetch was attempted. No test here may reach the network.');
  }) as unknown as typeof fetch;
  const t = setupTestCacheDir();
  cacheCleanup = t.cleanup;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  cacheCleanup?.();
});

describe('the safety layers themselves', () => {
  test('the spool is redirected away from the real cache dir', () => {
    // The assertion that would have caught the inert-HOME defect had it been written against the
    // thing that matters rather than against the env var.
    expect(getCacheDir()).not.toBe(join(homedir(), '.cache', 'claudewatch'));
    expect(getCacheDir().startsWith(tmpdir())).toBe(true);
  });

  test('global fetch throws', () => {
    expect(() => (globalThis.fetch as unknown as () => void)()).toThrow(/live fetch was attempted/);
  });
});

// --- the vscode stub ---

const registered = new Map<string, (...a: unknown[]) => unknown>();
let intervalHandles: unknown[] = [];
let clearedHandles: unknown[] = [];

class MockMarkdownString { value = ''; appendText(t: string): this { this.value += t; return this; } }

mock.module('vscode', () => ({
  StatusBarAlignment: { Right: 2 },
  MarkdownString: MockMarkdownString,
  ThemeColor: class { constructor(public id: string) {} },
  window: {
    createStatusBarItem: () => ({
      text: '', tooltip: undefined as unknown, command: undefined, name: undefined,
      color: undefined, backgroundColor: undefined, show(): void {}, dispose(): void {},
    }),
    showInformationMessage: (): void => {},
    showErrorMessage: (): void => {},
  },
  commands: {
    registerCommand: (id: string, cb: (...a: unknown[]) => unknown) => {
      registered.set(id, cb);
      return { dispose(): void { registered.delete(id); } };
    },
  },
  workspace: {
    getConfiguration: () => ({ get: <T,>(_k: string, d: T): T => d }),
    onDidChangeConfiguration: () => ({ dispose(): void {} }),
  },
  env: { isTelemetryEnabled: false },
  Uri: { parse: (s: string) => s },
}));

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
    await new Promise((r) => setTimeout(r, 1));
    return fetchMode.mode === 'ok' ? { ok: true, data: fetchMode.data } : { ok: false, ...fetchMode.result };
  },
  normalize: (d: unknown) => { log('normalize'); return d as UsageSnapshot; },
  readCache: () => { log('readCache'); return cachedEnvelope; },
  writeCache: (e: unknown) => log('writeCache', e),
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

const { activate, deactivate } = await import('./extension.js');

// --- helpers ---

/**
 * Wait until the bridge mock's call log stops growing.
 *
 * `activate` fires an un-awaited `doRefresh(false)` (extension.ts:103) that nothing can await, so
 * asserting immediately after `activate` races it. Arithmetic does not work either: a command
 * issued while that refresh is in flight is SWALLOWED by the dedupe rather than counted, so you
 * cannot "subtract the initial refresh". Draining is the only correct option. Fails loudly rather
 * than proceeding on timeout.
 */
async function settle(timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    if (calls.length === last) return;
    last = calls.length;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`settle() timed out after ${timeoutMs}ms with ${calls.length} calls: ` +
    JSON.stringify(calls.map((c) => c.name)));
}

function makeCtx(): { subscriptions: Array<{ dispose(): void }> } {
  return { subscriptions: [] };
}

let ctx = makeCtx();

async function start(): Promise<void> {
  ctx = makeCtx();
  await activate(ctx as never);
  await settle();
  calls = [];   // drop activate's initial refresh; every case asserts on what IT caused
}

const refresh = async (): Promise<void> => {
  await registered.get('claudewatch.refresh')!();
  await settle();
};

const names = (): string[] => calls.map((c) => c.name);

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
  cooldownWanted = false; policyPresentation = 'unknown';
});

// --- A9: the stub's key set ---

describe('the bridge mock', () => {
  test('exposes exactly the symbols extension.ts imports', async () => {
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
    // The catch at extension.ts:252 also calls readCache. Exactly one here proves this case
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
  });

  test('an unknown-presentation failure with NO cache uses an unknown snapshot', async () => {
    credentials = { authState: 'valid', accessToken: 'tok' };
    fetchMode = { mode: 'fail', result: { failureClass: 'serviceUnavailable', status: 503, message: 'x' } };
    await start();
    await refresh();
    expect(calls.find((c) => c.name === 'makeErrorSnapshot')!.arg).toBe('unknown');
    expect(names()).not.toContain('markStale');
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
    await settle();
    expect(names()).toEqual(['setTelemetryConfig', 'readCache']);
    expect(names()).not.toContain('resolveCredentials');
  });

  test('cooldown writes a stale envelope', async () => {
    cachedEnvelope = { version: 2, snapshot: snap({ freshness: { isStale: false, staleReason: 'none' } }),
                       cooldownUntil: 'later', lastErrorClass: null };
    inCooldown = true;
    ctx = makeCtx();
    await activate(ctx as never);
    await settle();
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
    await settle();
    expect(names()).toContain('markStale');
    expect(names()).not.toContain('writeCache');
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
    await settle();
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
      await settle();
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

// --- A8: the gaps, printed on every run ---

test.todo('activate: the onDidChangeConfiguration handlers (interval, thresholds, telemetry)', () => {});
test.todo('startPolling: the interval scheduling and its 30s floor', () => {});
test.todo('commands.ts: openDashboard and showDiagnostics', () => {});
