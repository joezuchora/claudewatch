/**
 * Smoke tests against the COMPILED BINARY.
 *
 * Three defects reached this repository because no test ran the shipped artifact the way a
 * user runs it:
 *   - sdlc/001: CI split the suite across processes and hid 128 failures.
 *   - sdlc/003 B1: module tests could not see that the statusline had no config channel.
 *   - sdlc/004: 98.89% line coverage on a binary that hangs on startup.
 *
 * Every case here spawns the real binary. If this file is slow, fix it. Do not skip it.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { spawnSync, spawn } from 'child_process';
import { rmSync, existsSync, statSync, readdirSync } from 'fs';
import { resolve } from 'path';
import * as net from 'net';
import { seedSandboxHome, makeTestSnapshot, type SandboxSeed } from '@claudewatch/core/test-helpers';

const BIN = resolve(import.meta.dir, '..', 'dist', 'claudewatch');
const REPO = resolve(import.meta.dir, '..', '..', '..');

let seed: SandboxSeed;

/**
 * One structurally-invalid placeholder, referenced twice. Two hand-rolled copies of a
 * token-shaped literal is how a real one eventually gets pasted into the second. (sdlc/030
 * security pass, finding 5.)
 */
const FAKE_TOKEN = 'sk-ant-oat01-SMOKE-TEST-NOT-REAL';

/** Newest mtime among the .ts sources compiled into the binary. */
function newestSourceMtime(): number {
  const roots = [
    resolve(REPO, 'packages', 'core', 'src'),
    resolve(REPO, 'packages', 'statusline', 'src'),
  ];
  let newest = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      const m = statSync(full).mtimeMs;
      if (m > newest) newest = m;
    }
  };
  for (const r of roots) walk(r);
  return newest;
}

beforeAll(() => {
  // STALE, not merely ABSENT. This used to rebuild only when the binary was missing, and
  // `scripts/verify.ts` runs `test` BEFORE `build` — so every case here asserted against a binary
  // compiled from some earlier source state. Deleting a guard in `cache.ts` left this file green
  // while the core suite went red, which made the end-to-end case the weaker of the two exactly
  // where it was supposed to be the stronger. Found by sdlc/030's security pass, finding 3.
  if (!existsSync(BIN) || statSync(BIN).mtimeMs < newestSourceMtime()) {
    const built = spawnSync('bun', ['run', '--filter', '@claudewatch/statusline', 'build'],
      { cwd: REPO, stdio: 'ignore' });
    if (built.status !== 0) throw new Error('could not build the statusline binary for smoke tests');
  }
  // One seeded HOME for every case here. The helper is shared with scripts/perf.ts so the two
  // cannot drift again; see sdlc/024.
  seed = seedSandboxHome({
    prefix: 'cw-smoke-',
    utilizationPct: 42,
    accessToken: FAKE_TOKEN,
  });
});

afterAll(() => { if (seed) rmSync(seed.home, { recursive: true, force: true }); });

interface RunResult { code: number | null; stdout: string; timedOut: boolean; ms: number }

/** Run the binary with a caller-supplied stdin, under a hard bound. */
function runWithStdin(
  stdio: 'ignore' | 'pipe' | number,
  opts: { write?: string; closeStdin?: boolean; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(BIN, [], {
      env: { ...process.env, ...seed.env },
      stdio: [stdio, 'pipe', 'ignore'],
    });

    let stdout = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });

    if (stdio === 'pipe' && child.stdin) {
      if (opts.write !== undefined) child.stdin.write(opts.write);
      // closeStdin false leaves an open pipe with no further writes — the deadline case.
      if (opts.closeStdin !== false) child.stdin.end();
    }

    // Generous by design. What these cases assert is "exits rather than hanging forever",
    // and that claim needs no precision — it needs a bound that cannot be reached by a slow
    // process spawn. The original 5000ms was chosen when this suite was 349 tests; at 480,
    // with seven real spawns competing with everything else, one run exceeded it and turned
    // the gate red on a commit CI had passed. The distinction that matters is 20s versus
    // never, not 5s versus 20s.
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs ?? 20000);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, timedOut, ms: Date.now() - started });
    });
  });
}

const SESSION_JSON = JSON.stringify({
  workspace: { project_dir: '/home/smoke/myproject' },
  model: { display_name: 'Claude 4 Opus' },
  context_window: { total_input_tokens: 45200, context_window_size: 200000, used_percentage: 23 },
});

describe('smoke: the compiled binary exits on every stdin state', () => {
  // Bun's DEFAULT per-test timeout is 5000ms, and that — not the SIGKILL timer inside
  // runWithStdin — is what killed these tests twice. The failures both read exactly
  // "[5000.50ms]", which was the answer sitting in plain sight while a previous fix raised
  // the SIGKILL timer from 5s to 20s and changed nothing, because Bun aborted the test first.
  //
  // Each spawning case now declares its own ceiling, so runWithStdin's 20s timer is the
  // binding constraint and a genuine hang still fails the test rather than passing quietly.
  const SPAWN_TIMEOUT_MS = 30_000;

  test('closed stdin', async () => {
    const r = await runWithStdin('ignore');
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`${seed.utilizationPct}%`);
  }, SPAWN_TIMEOUT_MS);

  test('SOCKET stdin — the reported failure in sdlc/004', async () => {
    // The exact condition that hung: open, silent, never closed, and isTTY is undefined.
    const pair = net.createServer();
    await new Promise<void>((res) => pair.listen(0, '127.0.0.1', () => res()));
    const addr = pair.address() as net.AddressInfo;
    const sock = net.connect(addr.port, '127.0.0.1');
    await new Promise<void>((res) => sock.on('connect', () => res()));

    try {
      const r = await runWithStdin((sock as unknown as { _handle: { fd: number } })._handle.fd);
      expect(r.timedOut).toBe(false);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`${seed.utilizationPct}%`);
    } finally {
      sock.destroy();
      pair.close();
    }
  }, SPAWN_TIMEOUT_MS);

  test('empty pipe, closed immediately', async () => {
    const r = await runWithStdin('pipe', { write: '' });
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`${seed.utilizationPct}%`);
  }, SPAWN_TIMEOUT_MS);

  test('pipe carrying valid session JSON produces RICH output', async () => {
    // The compatibility guarantee: the only invocation path with users today.
    const r = await runWithStdin('pipe', { write: SESSION_JSON });
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('myproject');
    expect(r.stdout).toContain('Claude 4 Opus');
  }, SPAWN_TIMEOUT_MS);

  test('pipe carrying malformed JSON degrades to plain output', async () => {
    const r = await runWithStdin('pipe', { write: '{ not json at all' });
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`${seed.utilizationPct}%`);
    expect(r.stdout).not.toContain('myproject');
  }, SPAWN_TIMEOUT_MS);

  test('unwritten, unclosed pipe exits on the deadline rather than hanging', async () => {
    const r = await runWithStdin('pipe', { closeStdin: false });
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`${seed.utilizationPct}%`);
    // The claim is that the 250ms deadline bounds the read. r.ms includes process spawn,
    // which varies with suite load, so this asserts an order of magnitude rather than a
    // tight figure: comfortably above spawn variance, and far below "forever", which is
    // what the code did before sdlc/005.
    expect(r.ms).toBeLessThan(10000);
  }, SPAWN_TIMEOUT_MS);

  test('--version short-circuits before any stdin read', async () => {
    const r = await new Promise<RunResult>((res) => {
      const started = Date.now();
      const child = spawn(BIN, ['--version'], {
        env: { ...process.env, ...seed.env }, stdio: ['pipe', 'pipe', 'ignore'],
      });
      let stdout = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      // Deliberately never close stdin — --version must not care.
      const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        res({ code, stdout, timedOut: false, ms: Date.now() - started });
      });
    });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^claudewatch \d+\.\d+\.\d+$/);
  }, SPAWN_TIMEOUT_MS);
});

describe('smoke: --debug never prints free text off a cache file', () => {
  test('a pre-sdlc/029 lastErrorMessage is nulled before the binary can print it', async () => {
    // Its own HOME: the shared seed's envelope is clean and this case needs a poisoned one.
    // Network-inert by the same two independent mechanisms every case in this file relies on —
    // the seeded credential is deliberately expired, AND `--debug` without `--refresh` returns
    // at main.ts:204-207, before `resolveCredentials` and before any fetch is reachable.
    const poisoned = seedSandboxHome({
      prefix: 'cw-smoke-debug-',
      accessToken: FAKE_TOKEN,
      envelope: {
        lastErrorClass: 'serviceUnavailable',
        lastHttpStatus: 503,
        // `as never` is load-bearing. sdlc/030 narrowed the field to SurfaceableMessage, and the
        // whole point of this case is to test the runtime guard from OUTSIDE the type system —
        // a cache file on disk was written by some earlier build and never saw this compiler.
        // It is not a smell to tidy away.
        lastErrorMessage: 'connect ECONNREFUSED /home/someone/.claude on someones-nuc.local' as never,
      },
    });

    try {
      const r = await new Promise<RunResult>((res) => {
        const started = Date.now();
        const child = spawn(BIN, ['--debug'], {
          env: { ...process.env, ...poisoned.env }, stdio: ['ignore', 'pipe', 'ignore'],
        });
        let stdout = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 20000);
        child.on('exit', (code) => {
          clearTimeout(timer);
          res({ code, stdout, timedOut, ms: Date.now() - started });
        });
      });
      expect(r.timedOut).toBe(false);
      expect(r.code).toBe(0);

      const out = JSON.parse(r.stdout) as Record<string, unknown>;
      // Preconditions in the SAME block, not a separate case. On a miss `printDebug` omits
      // `lastErrorMessage` and `lastHttpStatus` entirely and reports `cacheAgeSec: null`, so an
      // envelope rejected as versionMismatch / invalidShape / corruptJson would leave the
      // assertion below asserting on `undefined` and it could go green while proving nothing at
      // all. These two say the cache was read, and that it was THIS envelope.
      expect(typeof out.cacheAgeSec).toBe('number');
      expect(out.lastHttpStatus).toBe(503);

      expect(out.lastErrorMessage).toBeNull();
      // Belt and braces on the raw bytes: the field could be dropped and the text still reach
      // stdout through some other key.
      expect(r.stdout).not.toContain('/home/someone');
      expect(r.stdout).not.toContain('someones-nuc.local');
    } finally {
      rmSync(poisoned.home, { recursive: true, force: true });
    }
  }, 30_000);
});

const p = (n: number): string => String(n).padStart(2, '0');

// Hoisted to module scope so BOTH describe blocks can use them — and because a helper that
// captures nothing trips unicorn(consistent-function-scoping), the trap loop 028 named in
// writing and loops 029 and 031 each walked into.

/**
 * A `fetchedAt` that is poisoned AND parses to roughly now.
 *
 * This matters for --json and took a measurement to get right. `--debug` returns before any
 * freshness check, so it takes any seed; `--json` only reaches `output()` at main.ts:241 when
 * `isCacheFresh` is true. An ISO string with a suffix does not parse at all, and a bare date
 * parses to midnight — both leave the cache stale and route --json somewhere else entirely.
 * Date.parse's legacy path ignores parenthesised text, so a full local date-time plus a
 * parenthesised suffix parses to ~now and stays fresh.
 */
function poisonedButFresh(marker: string): string {
  const d = new Date();
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  return `${mon} ${d.getDate()} ${d.getFullYear()} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} (${marker})`;
}

function runFlag(flag: string, env: Record<string, string>): Promise<RunResult> {
  return new Promise((res) => {
    const started = Date.now();
    const child = spawn(BIN, [flag], {
      env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 20000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      res({ code, stdout, timedOut, ms: Date.now() - started });
    });
  });
}

describe('smoke: neither --debug nor --json prints free text off a cache file', () => {
  // Four DISTINGUISHABLE poisons, one per validated field, in one envelope. A single-check
  // mutation then fails with a message naming which field leaked, rather than a bare "output
  // contained a string".
  const P = {
    fetchedAt: 'LEAK-FETCHEDAT-/home/someone',
    staleReason: 'LEAK-STALEREASON-/home/someone',
    isStale: 'LEAK-ISSTALE-/home/someone',
    warning: 'LEAK-WARNING-/home/someone',
  };


  function seedPoisoned(): SandboxSeed {
    return seedSandboxHome({
      prefix: 'cw-smoke-poison-',
      accessToken: FAKE_TOKEN,
      snapshot: makeTestSnapshot({
        fetchedAt: poisonedButFresh(P.fetchedAt),
        freshness: { isStale: P.isStale, staleReason: P.staleReason },
        rawMetadata: { normalizationWarnings: [P.warning, 'Response is not an object'] },
      } as never),
    });
  }


  test('T5 — --debug', async () => {
    // Network-inert twice over: --debug without --refresh returns at main.ts:204-207 before
    // resolveCredentials, and the seeded credential is already expired.
    const seedP = seedPoisoned();
    try {
      const r = await runFlag('--debug', seedP.env);
      expect(r.timedOut).toBe(false);
      expect(r.code).toBe(0);

      const out = JSON.parse(r.stdout) as Record<string, unknown>;
      // Preconditions: the cache was READ, and it was THIS envelope. printDebug omits every cache
      // key on a miss, so without these the absence assertions could pass while proving nothing.
      expect(typeof out.cacheAgeSec).toBe('number');
      expect(out.freshness).toBeDefined();

      for (const [field, poison] of Object.entries(P)) {
        expect(`${field}: ${r.stdout}`).not.toContain(poison);
      }
      // The surviving real warning proves the filter filters rather than empties.
      expect(r.stdout).toContain('Response is not an object');
    } finally {
      rmSync(seedP.home, { recursive: true, force: true });
    }
  }, 30_000);

  test('T6 — --json, which serialises the WHOLE snapshot', async () => {
    // The surface the draft spec missed. It names no field, so no field-name search could find it.
    // Reached only on the fresh-cache path (main.ts:241), hence poisonedButFresh above.
    const seedP = seedPoisoned();
    try {
      const r = await runFlag('--json', seedP.env);
      expect(r.timedOut).toBe(false);
      expect(r.code).toBe(0);

      const snap = JSON.parse(r.stdout) as { fetchedAt: string; freshness: Record<string, unknown> };
      // Precondition: this really is the fresh-cache path serialising the cached snapshot, not a
      // stale or error snapshot built in main().
      expect(snap.freshness).toBeDefined();
      expect(snap.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      for (const [field, poison] of Object.entries(P)) {
        expect(`${field}: ${r.stdout}`).not.toContain(poison);
      }
      expect(r.stdout).toContain('Response is not an object');
    } finally {
      rmSync(seedP.home, { recursive: true, force: true });
    }
  }, 30_000);
});

const M = (k: string): string => `MARK_${k}`;

describe('smoke: 26 poisoned values reach neither --debug nor --json (sdlc/032)', () => {

  const SNAPSHOT_KEYS = [
    'tier', 'authState', 'usageEndpoint', 'sourceExtra',
    'primaryWindow', 'primaryPct', 'primaryResetsAt', 'displayExtra',
    'fiveResetsAt', 'fiveExtra', 'sevenPct', 'sevenResetsAt', 'sevenExtra',
    'opusPct', 'opusResetsAt', 'opusExtra',
    'entPct', 'entLimit', 'entUsed', 'currency', 'entEnabled', 'disabledReason', 'entExtra',
    'snapshotExtra',
  ];

  function poisonedSnapshot(): Record<string, unknown> {
    const s = JSON.parse(JSON.stringify(makeTestSnapshot())) as Record<string, unknown>;
    // fetchedAt is poisoned but stays FRESH — see poisonedButFresh above. A poisoned-unparseable
    // fetchedAt degrades to the sentinel, isCacheFresh goes false, and --json routes to an expired
    // credential and exit 2, where every not.toContain assertion would hold against a snapshot the
    // cache never produced.
    s.fetchedAt = poisonedButFresh(M('fetchedAt'));
    s.tier = M('tier');
    s.authState = M('authState');
    s.source = { usageEndpoint: M('usageEndpoint'), extra: M('sourceExtra') };
    // fiveHour keeps a real utilizationPct so the fresh-cache path renders a normal line; its
    // resetsAt and an unknown key still carry markers.
    s.fiveHour = { utilizationPct: 42, resetsAt: M('fiveResetsAt'), extra: M('fiveExtra') };
    s.sevenDay = { utilizationPct: M('sevenPct'), resetsAt: M('sevenResetsAt'), extra: M('sevenExtra') };
    s.sevenDayOpus = { utilizationPct: M('opusPct'), resetsAt: M('opusResetsAt'), extra: M('opusExtra') };
    s.display = {
      primaryWindow: M('primaryWindow'), primaryUtilizationPct: M('primaryPct'),
      primaryResetsAt: M('primaryResetsAt'), extra: M('displayExtra'),
    };
    s.enterprise = {
      utilizationPct: M('entPct'), monthlyLimitCredits: M('entLimit'), usedCredits: M('entUsed'),
      currency: M('currency'), isEnabled: M('entEnabled'), disabledReason: M('disabledReason'),
      extra: M('entExtra'),
    };
    s.extraSnapshotKey = M('snapshotExtra');
    return s;
  }

  function seedPoisoned26(): SandboxSeed {
    return seedSandboxHome({
      prefix: 'cw-smoke-26-',
      accessToken: FAKE_TOKEN,
      snapshot: poisonedSnapshot() as never,
      envelope: { lastHttpStatus: M('httpStatus') as never },
    });
  }

  test('T2 — --debug', async () => {
    const seedP = seedPoisoned26();
    try {
      const r = await runFlag('--debug', seedP.env);
      expect(r.timedOut).toBe(false);
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout) as Record<string, unknown>;
      // Preconditions: the cache was READ, and it was THIS envelope.
      expect(typeof out.cacheAgeSec).toBe('number');
      expect(out.freshness).toBeDefined();

      // WHAT --debug CAN ACTUALLY SEE, and no more. `printDebug` (main.ts:124-152) emits a FIXED
      // key list: from the snapshot it copies only `fetchedAt`, `classify()` (a closed enum),
      // `rawMetadata.normalizationWarnings` and `freshness`. The 24 SNAPSHOT_KEYS asserted here
      // originally could not reach this surface AT ALL — proved by the audit: under a mutation that
      // makes sanitizeSnapshot a total no-op and turns 22 other tests red, this test stayed GREEN.
      // Asserting them was theatre, and worse, it was promoted into SPEC.md as evidence.
      //
      // `--json` is the whole-snapshot leg. This one covers the envelope field and the three
      // snapshot values printDebug genuinely emits.
      expect(r.stdout).not.toContain(M('httpStatus'));           // envelope, and the reason T2 exists
      expect(r.stdout).not.toContain(M('fetchedAt'));
      for (const k of ['sevenPct', 'opusPct']) void k;           // not reachable here; see --json
      expect(out.stateClassification).toBe('Healthy');           // classify() is a closed enum
      expect(Array.isArray((out as { normalizationWarnings?: unknown[] }).normalizationWarnings)).toBe(true);
    } finally {
      rmSync(seedP.home, { recursive: true, force: true });
    }
  }, 30_000);

  test('T3 — --json, which serialises the whole snapshot', async () => {
    const seedP = seedPoisoned26();
    try {
      const r = await runFlag('--json', seedP.env);
      expect(r.timedOut).toBe(false);
      expect(r.code).toBe(0);
      const snap = JSON.parse(r.stdout) as { fetchedAt: string; freshness: unknown };
      // Precondition: this is the fresh-cache path serialising the CACHED snapshot. An error path
      // exits 2, and a stale path would rewrite freshness.
      expect(snap.freshness).toBeDefined();
      expect(snap.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      expect(SNAPSHOT_KEYS.filter((k) => r.stdout.includes(M(k)))).toEqual([]);
    } finally {
      rmSync(seedP.home, { recursive: true, force: true });
    }
  }, 30_000);
});
