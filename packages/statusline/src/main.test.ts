import { describe, expect, test, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { makeTestSnapshot, makeTestEnvelope } from '@claudewatch/core/test-helpers';
import { evaluate, classify as realClassify, formatTooltip, formatPct, formatFreshness, formatRichStatusLine, markStale as realMarkStale, makeErrorSnapshot as realMakeErrorSnapshot } from '@claudewatch/core';
import type { UsageSnapshot, CacheEnvelope, CredentialResult, FetchResult, FailureClass } from '@claudewatch/core';

// --- Exit sentinel ---

class ExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

// --- Mock state ---

let mockReadCache: ReturnType<typeof mock>;
let mockWriteCache: ReturnType<typeof mock>;
let mockIsCacheFresh: ReturnType<typeof mock>;
let mockMakeCacheEnvelope: ReturnType<typeof mock>;
let mockGetCachePath: ReturnType<typeof mock>;
let mockIsInCooldown: ReturnType<typeof mock>;
let mockEnterCooldown: ReturnType<typeof mock>;
let mockClearCooldown: ReturnType<typeof mock>;
let mockShouldCooldown: ReturnType<typeof mock>;
let mockResolveCredentials: ReturnType<typeof mock>;
let mockGetCredentialPath: ReturnType<typeof mock>;
let mockFetchUsage: ReturnType<typeof mock>;
let mockNormalize: ReturnType<typeof mock>;
let mockClassify: ReturnType<typeof mock>;
let mockFormatStatusLine: ReturnType<typeof mock>;

mock.module('@claudewatch/core', () => {
  mockReadCache = mock(() => null);
  mockWriteCache = mock(() => {});
  mockIsCacheFresh = mock(() => false);
  mockMakeCacheEnvelope = mock((snapshot: UsageSnapshot) => makeTestEnvelope({ snapshot }));
  mockGetCachePath = mock(() => '/tmp/claudewatch/usage.json');
  mockIsInCooldown = mock(() => false);
  mockEnterCooldown = mock((env: CacheEnvelope, fc: FailureClass) => ({ ...env, cooldownUntil: new Date().toISOString(), lastErrorClass: fc }));
  mockClearCooldown = mock((env: CacheEnvelope) => ({ ...env, cooldownUntil: null, lastErrorClass: null }));
  mockShouldCooldown = mock(() => false);
  mockResolveCredentials = mock((): CredentialResult => ({ authState: 'valid', accessToken: 'sk-ant-test-token' }));
  mockGetCredentialPath = mock(() => '/home/user/.claude/credentials.json');
  mockFetchUsage = mock(async (): Promise<FetchResult> => ({ ok: true, status: 200, data: {} }));
  mockNormalize = mock(() => makeTestSnapshot());
  mockClassify = mock(realClassify);
  mockFormatStatusLine = mock(() => '⊙ 42% · 7d 18% · resets 3:00pm');

  return {
    readCache: (...args: unknown[]) => mockReadCache(...args),
    writeCache: (...args: unknown[]) => mockWriteCache(...args),
    isCacheFresh: (...args: unknown[]) => mockIsCacheFresh(...args),
    makeCacheEnvelope: (...args: unknown[]) => mockMakeCacheEnvelope(...args),
    getCachePath: (...args: unknown[]) => mockGetCachePath(...args),
    isInCooldown: (...args: unknown[]) => mockIsInCooldown(...args),
    enterCooldown: (...args: unknown[]) => mockEnterCooldown(...args),
    clearCooldown: (...args: unknown[]) => mockClearCooldown(...args),
    shouldCooldown: (...args: unknown[]) => mockShouldCooldown(...args),
    resolveCredentials: (...args: unknown[]) => mockResolveCredentials(...args),
    getCredentialPath: (...args: unknown[]) => mockGetCredentialPath(...args),
    fetchUsage: (...args: unknown[]) => mockFetchUsage(...args),
    normalize: (...args: unknown[]) => mockNormalize(...args),
    classify: (...args: unknown[]) => mockClassify(...args),
    formatStatusLine: (...args: unknown[]) => mockFormatStatusLine(...args),
    // Pass through real functions to prevent mock leaking into other test files
    evaluate,
    formatTooltip,
    formatPct,
    formatFreshness,
    formatRichStatusLine,
    markStale: realMarkStale,
    makeErrorSnapshot: realMakeErrorSnapshot,
    makeTestSnapshot,
    makeTestEnvelope,
  };
});

// Import after mock.module
import { parseFlags, getTerminalWidth, parseSessionInfo, main } from './main.js';
import { markStale, makeErrorSnapshot } from '@claudewatch/core';

// --- Shared spy state ---

let exitSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;
let savedArgv: string[];
let savedColumns: number | undefined;

beforeEach(() => {
  exitSpy = spyOn(process, 'exit').mockImplementation((code?: number | string | null | undefined) => {
    throw new ExitError(Number(code ?? 0));
  });
  logSpy = spyOn(console, 'log').mockImplementation(() => {});
  savedArgv = process.argv;
  savedColumns = process.stdout.columns;

  // Reset all mocks to defaults
  mockReadCache.mockReset().mockReturnValue(null);
  mockWriteCache.mockReset();
  mockIsCacheFresh.mockReset().mockReturnValue(false);
  mockMakeCacheEnvelope.mockReset().mockImplementation((snapshot: UsageSnapshot) => makeTestEnvelope({ snapshot }));
  mockGetCachePath.mockReset().mockReturnValue('/tmp/claudewatch/usage.json');
  mockIsInCooldown.mockReset().mockReturnValue(false);
  mockEnterCooldown.mockReset().mockImplementation((env: CacheEnvelope, fc: FailureClass) => ({ ...env, cooldownUntil: new Date().toISOString(), lastErrorClass: fc }));
  mockClearCooldown.mockReset().mockImplementation((env: CacheEnvelope) => ({ ...env, cooldownUntil: null, lastErrorClass: null }));
  mockShouldCooldown.mockReset().mockReturnValue(false);
  mockResolveCredentials.mockReset().mockReturnValue({ authState: 'valid', accessToken: 'sk-ant-test-token' });
  mockGetCredentialPath.mockReset().mockReturnValue('/home/user/.claude/credentials.json');
  mockFetchUsage.mockReset().mockResolvedValue({ ok: true, status: 200, data: {} });
  mockNormalize.mockReset().mockReturnValue(makeTestSnapshot());
  mockClassify.mockReset().mockReturnValue('Healthy');
  mockFormatStatusLine.mockReset().mockReturnValue('⊙ 42% · 7d 18% · resets 3:00pm');
});

afterEach(() => {
  exitSpy.mockRestore();
  logSpy.mockRestore();
  process.argv = savedArgv;
  Object.defineProperty(process.stdout, 'columns', { value: savedColumns, writable: true, configurable: true });
});

// Helper to run main and capture exit code
async function runMain(args: string[] = []): Promise<{ exitCode: number; output: string[] }> {
  process.argv = ['bun', 'main.ts', ...args];
  const output: string[] = [];
  logSpy.mockImplementation((...logArgs: unknown[]) => {
    output.push(logArgs.map(String).join(' '));
  });
  let exitCode = -1;
  try {
    await main();
  } catch (e) {
    if (e instanceof ExitError) {
      exitCode = e.code;
    } else {
      throw e;
    }
  }
  return { exitCode, output };
}

// === Pure helper tests ===

describe('parseFlags', () => {
  test('empty args returns all false', () => {
    const flags = parseFlags([]);
    expect(flags).toEqual({ version: false, json: false, refresh: false, debug: false });
  });

  test('--version', () => {
    expect(parseFlags(['--version']).version).toBe(true);
  });

  test('--json', () => {
    expect(parseFlags(['--json']).json).toBe(true);
  });

  test('--refresh', () => {
    expect(parseFlags(['--refresh']).refresh).toBe(true);
  });

  test('--debug', () => {
    expect(parseFlags(['--debug']).debug).toBe(true);
  });

  test('multiple flags', () => {
    const flags = parseFlags(['--json', '--refresh']);
    expect(flags.json).toBe(true);
    expect(flags.refresh).toBe(true);
    expect(flags.version).toBe(false);
    expect(flags.debug).toBe(false);
  });

  test('unknown flags are ignored', () => {
    const flags = parseFlags(['--unknown', '--foo']);
    expect(flags).toEqual({ version: false, json: false, refresh: false, debug: false });
  });
});

describe('getTerminalWidth', () => {
  test('returns columns when set', () => {
    Object.defineProperty(process.stdout, 'columns', { value: 120, writable: true, configurable: true });
    expect(getTerminalWidth()).toBe(120);
  });

  test('defaults to 80 when columns is undefined', () => {
    Object.defineProperty(process.stdout, 'columns', { value: undefined, writable: true, configurable: true });
    expect(getTerminalWidth()).toBe(80);
  });
});

describe('parseSessionInfo', () => {
  test('valid JSON object returns parsed object', () => {
    const result = parseSessionInfo('{"foo":"bar"}');
    expect(result).toEqual({ foo: 'bar' } as never);
  });

  test('empty string returns null', () => {
    expect(parseSessionInfo('')).toBeNull();
  });

  test('whitespace only returns null', () => {
    expect(parseSessionInfo('   \n\t  ')).toBeNull();
  });

  test('invalid JSON returns null', () => {
    expect(parseSessionInfo('{not valid json}')).toBeNull();
  });

  test('JSON null returns null', () => {
    expect(parseSessionInfo('null')).toBeNull();
  });

  test('JSON array returns null', () => {
    expect(parseSessionInfo('[1, 2, 3]')).toBeNull();
  });

  test('JSON primitive string returns null', () => {
    expect(parseSessionInfo('"hello"')).toBeNull();
  });

  test('JSON primitive number returns null', () => {
    expect(parseSessionInfo('42')).toBeNull();
  });

  test('valid session with model/workspace fields returns correctly', () => {
    const input = JSON.stringify({ model: 'claude-3', workspace: '/home/user/project' });
    const result = parseSessionInfo(input);
    expect(result).toEqual({ model: 'claude-3', workspace: '/home/user/project' } as never);
  });

  test('nested valid object returns as SessionInfo', () => {
    const input = JSON.stringify({ outer: { inner: { deep: true } }, list: [1, 2] });
    const result = parseSessionInfo(input);
    expect(result).toEqual({ outer: { inner: { deep: true } }, list: [1, 2] } as never);
  });
});

describe('markStale', () => {
  test('sets isStale and staleReason', () => {
    const snapshot = makeTestSnapshot();
    const stale = markStale(snapshot, 'fetchFailed');
    expect(stale.freshness.isStale).toBe(true);
    expect(stale.freshness.staleReason).toBe('fetchFailed');
  });

  test('preserves other fields', () => {
    const snapshot = makeTestSnapshot();
    const stale = markStale(snapshot, 'fetchFailed');
    expect(stale.fiveHour).toEqual(snapshot.fiveHour);
    expect(stale.sevenDay).toEqual(snapshot.sevenDay);
    expect(stale.display).toEqual(snapshot.display);
    expect(stale.authState).toBe(snapshot.authState);
  });

  test('does not mutate original', () => {
    const snapshot = makeTestSnapshot();
    markStale(snapshot, 'fetchFailed');
    expect(snapshot.freshness.isStale).toBe(false);
    expect(snapshot.freshness.staleReason).toBe('none');
  });
});

describe('makeErrorSnapshot', () => {
  test('sets correct authState', () => {
    const snap = makeErrorSnapshot('missing');
    expect(snap.authState).toBe('missing');
  });

  test('has null utilization windows', () => {
    const snap = makeErrorSnapshot('invalid');
    expect(snap.fiveHour.utilizationPct).toBeNull();
    expect(snap.sevenDay.utilizationPct).toBeNull();
    expect(snap.display.primaryUtilizationPct).toBeNull();
  });

  test('is marked stale with fetchFailed reason', () => {
    const snap = makeErrorSnapshot('unknown');
    expect(snap.freshness.isStale).toBe(true);
    expect(snap.freshness.staleReason).toBe('fetchFailed');
  });

  test('has valid ISO fetchedAt', () => {
    const before = Date.now();
    const snap = makeErrorSnapshot('missing');
    const after = Date.now();
    const ts = new Date(snap.fetchedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

// === main() orchestration tests ===

describe('main', () => {
  describe('--version', () => {
    test('prints version and exits 0', async () => {
      const { exitCode, output } = await runMain(['--version']);
      expect(exitCode).toBe(0);
      expect(output[0]).toBe('claudewatch 0.1.0');
    });
  });

  describe('--debug', () => {
    test('with cache: JSON includes cacheAgeSec and classification, exits 0', async () => {
      const envelope = makeTestEnvelope();
      mockReadCache.mockReturnValue(envelope);
      mockClassify.mockReturnValue('Healthy');

      const { exitCode, output } = await runMain(['--debug']);
      expect(exitCode).toBe(0);

      const parsed = JSON.parse(output[0]);
      expect(parsed).toHaveProperty('cacheAgeSec');
      expect(parsed).toHaveProperty('stateClassification');
      expect(parsed.stateClassification).toBe('Healthy');
    });

    test('without cache: JSON shows Initializing, exits 0', async () => {
      mockReadCache.mockReturnValue(null);

      const { exitCode, output } = await runMain(['--debug']);
      expect(exitCode).toBe(0);

      const parsed = JSON.parse(output[0]);
      expect(parsed.cacheAgeSec).toBeNull();
      expect(parsed.stateClassification).toBe('Initializing');
    });

    test('output contains no accessToken', async () => {
      const envelope = makeTestEnvelope();
      mockReadCache.mockReturnValue(envelope);

      const { output } = await runMain(['--debug']);
      const raw = output.join('\n');
      expect(raw).not.toContain('accessToken');
      expect(raw).not.toContain('sk-ant');
    });
  });

  describe('fresh cache', () => {
    test('outputs cached data and exits 0, does not call fetchUsage', async () => {
      const envelope = makeTestEnvelope();
      mockReadCache.mockReturnValue(envelope);
      mockIsCacheFresh.mockReturnValue(true);

      const { exitCode } = await runMain([]);
      expect(exitCode).toBe(0);
      expect(mockFetchUsage).not.toHaveBeenCalled();
      expect(mockFormatStatusLine).toHaveBeenCalled();
    });

    test('--json outputs JSON', async () => {
      const snapshot = makeTestSnapshot();
      const envelope = makeTestEnvelope({ snapshot });
      mockReadCache.mockReturnValue(envelope);
      mockIsCacheFresh.mockReturnValue(true);

      const { exitCode, output } = await runMain(['--json']);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output[0]);
      expect(parsed.authState).toBe('valid');
      expect(parsed.fiveHour.utilizationPct).toBe(42);
    });

    test('--refresh bypasses fresh cache', async () => {
      const envelope = makeTestEnvelope();
      mockReadCache.mockReturnValue(envelope);
      mockIsCacheFresh.mockReturnValue(true);

      const { exitCode } = await runMain(['--refresh']);
      expect(exitCode).toBe(0);
      expect(mockFetchUsage).toHaveBeenCalled();
    });
  });

  describe('cooldown active', () => {
    test('outputs stale data and exits 0, does not call fetchUsage', async () => {
      const envelope = makeTestEnvelope();
      mockReadCache.mockReturnValue(envelope);
      mockIsCacheFresh.mockReturnValue(false);
      mockIsInCooldown.mockReturnValue(true);

      const { exitCode } = await runMain([]);
      expect(exitCode).toBe(0);
      expect(mockFetchUsage).not.toHaveBeenCalled();
      expect(mockFormatStatusLine).toHaveBeenCalled();
    });

    test('--refresh still respects cooldown', async () => {
      const envelope = makeTestEnvelope();
      mockReadCache.mockReturnValue(envelope);
      mockIsCacheFresh.mockReturnValue(false);
      mockIsInCooldown.mockReturnValue(true);

      const { exitCode } = await runMain(['--refresh']);
      expect(exitCode).toBe(0);
      expect(mockFetchUsage).not.toHaveBeenCalled();
    });
  });

  describe('missing credentials', () => {
    beforeEach(() => {
      mockResolveCredentials.mockReturnValue({ authState: 'missing', accessToken: null });
    });

    test('text: prints "⊙ no credentials" and exits 2', async () => {
      const { exitCode, output } = await runMain([]);
      expect(exitCode).toBe(2);
      expect(output[0]).toBe('⊙ no credentials');
    });

    test('--json: outputs error snapshot JSON and exits 2', async () => {
      const { exitCode, output } = await runMain(['--json']);
      expect(exitCode).toBe(2);
      const parsed = JSON.parse(output[0]);
      expect(parsed.authState).toBe('missing');
      expect(parsed.freshness.isStale).toBe(false);
    });
  });

  describe('invalid credentials', () => {
    beforeEach(() => {
      mockResolveCredentials.mockReturnValue({ authState: 'invalid', accessToken: 'sk-ant-expired' });
    });

    test('text: prints "⊙ auth expired" and exits 2', async () => {
      const { exitCode, output } = await runMain([]);
      expect(exitCode).toBe(2);
      expect(output[0]).toBe('⊙ auth expired');
    });

    test('--json: outputs error snapshot JSON and exits 2', async () => {
      const { exitCode, output } = await runMain(['--json']);
      expect(exitCode).toBe(2);
      const parsed = JSON.parse(output[0]);
      expect(parsed.authState).toBe('invalid');
    });
  });

  describe('fetch success', () => {
    test('normalizes, writes cache, outputs, and exits 0', async () => {
      const snapshot = makeTestSnapshot();
      mockFetchUsage.mockResolvedValue({ ok: true, status: 200, data: { raw: true } });
      mockNormalize.mockReturnValue(snapshot);

      const { exitCode } = await runMain([]);
      expect(exitCode).toBe(0);
      expect(mockNormalize).toHaveBeenCalledWith({ raw: true });
      expect(mockWriteCache).toHaveBeenCalled();
      expect(mockFormatStatusLine).toHaveBeenCalled();
    });

    test('clears cooldown on success', async () => {
      mockFetchUsage.mockResolvedValue({ ok: true, status: 200, data: {} });

      await runMain([]);
      expect(mockClearCooldown).toHaveBeenCalled();
    });
  });

  describe('fetch failure', () => {
    test('with stale cache data, marks stale and exits 0', async () => {
      const envelope = makeTestEnvelope();
      mockReadCache.mockReturnValue(envelope);
      mockFetchUsage.mockResolvedValue({ ok: false, status: 503, failureClass: 'serviceUnavailable', message: 'down' });
      mockShouldCooldown.mockReturnValue(true);

      const { exitCode } = await runMain([]);
      expect(exitCode).toBe(0);
      expect(mockFormatStatusLine).toHaveBeenCalled();
    });

    test('triggers cooldown for serviceUnavailable', async () => {
      const envelope = makeTestEnvelope();
      mockReadCache.mockReturnValue(envelope);
      mockFetchUsage.mockResolvedValue({ ok: false, status: 503, failureClass: 'serviceUnavailable', message: 'down' });
      mockShouldCooldown.mockReturnValue(true);

      await runMain([]);
      expect(mockEnterCooldown).toHaveBeenCalled();
      expect(mockWriteCache).toHaveBeenCalled();
    });

    test('persists stale freshness into cache when refresh fails', async () => {
      const envelope = makeTestEnvelope();
      mockReadCache.mockReturnValue(envelope);
      mockFetchUsage.mockResolvedValue({ ok: false, status: 503, failureClass: 'serviceUnavailable', message: 'down' });
      mockShouldCooldown.mockReturnValue(true);

      await runMain([]);

      expect(mockWriteCache).toHaveBeenCalled();
      const writtenEnvelope = mockWriteCache.mock.calls.at(-1)?.[0] as CacheEnvelope;
      expect(writtenEnvelope.snapshot.freshness).toEqual({
        isStale: true,
        staleReason: 'fetchFailed',
      });
    });

    test('persists stale freshness even when failure does not trigger cooldown', async () => {
      const envelope = makeTestEnvelope();
      mockReadCache.mockReturnValue(envelope);
      mockFetchUsage.mockResolvedValue({ ok: false, status: 500, failureClass: 'unexpectedFailure', message: 'server error' });
      mockShouldCooldown.mockReturnValue(false);

      await runMain([]);

      expect(mockWriteCache).toHaveBeenCalledTimes(1);
      const writtenEnvelope = mockWriteCache.mock.calls[0]?.[0] as CacheEnvelope;
      expect(writtenEnvelope.snapshot.freshness).toEqual({
        isStale: true,
        staleReason: 'fetchFailed',
      });
      expect(writtenEnvelope.cooldownUntil).toBeNull();
      expect(writtenEnvelope.lastErrorClass).toBeNull();
    });

    test('authInvalid with no stale data exits 2', async () => {
      // No cache, or cache with null utilization
      mockReadCache.mockReturnValue(null);
      mockFetchUsage.mockResolvedValue({ ok: false, status: 401, failureClass: 'authInvalid', message: 'bad auth' });

      const { exitCode, output } = await runMain([]);
      expect(exitCode).toBe(2);
      expect(output[0]).toBe('⊙ auth invalid');
    });

    test('authInvalid --json exits 2 with error snapshot', async () => {
      mockReadCache.mockReturnValue(null);
      mockFetchUsage.mockResolvedValue({ ok: false, status: 401, failureClass: 'authInvalid', message: 'bad auth' });

      const { exitCode, output } = await runMain(['--json']);
      expect(exitCode).toBe(2);
      const parsed = JSON.parse(output[0]);
      expect(parsed.authState).toBe('invalid');
    });

    test('no cache, non-auth failure: prints error and exits 1', async () => {
      mockReadCache.mockReturnValue(null);
      mockFetchUsage.mockResolvedValue({ ok: false, status: 500, failureClass: 'unexpectedFailure', message: 'server error' });

      const { exitCode, output } = await runMain([]);
      expect(exitCode).toBe(1);
      expect(output[0]).toBe('⊙ error');
    });

    test('no cache, non-auth failure --json: outputs error snapshot and exits 1', async () => {
      mockReadCache.mockReturnValue(null);
      mockFetchUsage.mockResolvedValue({ ok: false, status: 500, failureClass: 'unexpectedFailure', message: 'server error' });

      const { exitCode, output } = await runMain(['--json']);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(output[0]);
      expect(parsed.authState).toBe('unknown');
      expect(parsed.freshness.isStale).toBe(true);
    });

    test('serviceUnavailable with no cache creates minimal envelope for cooldown', async () => {
      mockReadCache.mockReturnValue(null);
      mockFetchUsage.mockResolvedValue({ ok: false, status: 503, failureClass: 'serviceUnavailable', message: 'down' });
      mockShouldCooldown.mockReturnValue(true);

      const { exitCode } = await runMain([]);
      expect(exitCode).toBe(1);
      expect(mockMakeCacheEnvelope).toHaveBeenCalled();
      expect(mockEnterCooldown).toHaveBeenCalled();
      expect(mockWriteCache).toHaveBeenCalled();
    });
  });
});
