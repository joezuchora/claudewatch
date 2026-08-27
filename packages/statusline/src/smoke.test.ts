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
import { rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import * as net from 'net';
import { seedSandboxHome, type SandboxSeed } from '@claudewatch/core/test-helpers';

const BIN = resolve(import.meta.dir, '..', 'dist', 'claudewatch');
const REPO = resolve(import.meta.dir, '..', '..', '..');

let seed: SandboxSeed;

beforeAll(() => {
  if (!existsSync(BIN)) {
    const built = spawnSync('bun', ['run', '--filter', '@claudewatch/statusline', 'build'],
      { cwd: REPO, stdio: 'ignore' });
    if (built.status !== 0) throw new Error('could not build the statusline binary for smoke tests');
  }
  // One seeded HOME for every case here. The helper is shared with scripts/perf.ts so the two
  // cannot drift again; see sdlc/024.
  seed = seedSandboxHome({
    prefix: 'cw-smoke-',
    utilizationPct: 42,
    accessToken: 'sk-ant-oat01-SMOKE-TEST-NOT-REAL',
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
