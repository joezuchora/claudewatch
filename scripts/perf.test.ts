import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { evaluate, makeSandbox, BUDGET_P50_MS, BUDGET_P95_MS, P95_MIN_SAMPLES, MIN_SAMPLES } from './perf.js';

const REPO = join(import.meta.dir, '..');
const SCRIPT = join(import.meta.dir, 'perf.ts');

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'cw-perf-test-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

/**
 * A stub standing in for the binary. Lets every failure path be exercised in milliseconds
 * instead of paying ~40ms x N for the real one — the failing paths are what matter here, and
 * they are indifferent to what the child actually is.
 */
function stub(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

function run(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(['bun', 'run', SCRIPT, ...args], {
    cwd: REPO,
    env: { ...process.env, ...env } as Record<string, string>,
    stdout: 'pipe', stderr: 'pipe',
  });
  return {
    code: proc.exitCode,
    out: new TextDecoder().decode(proc.stdout),
    err: new TextDecoder().decode(proc.stderr),
  };
}

describe('evaluate — the deciding half, which is what makes it right or wrong', () => {
  const flat = (ms: number, n: number) => Array.from({ length: n }, () => ms);
  const budgets = { p50: BUDGET_P50_MS, p95: BUDGET_P95_MS };

  test('under both budgets is ok', () => {
    const v = evaluate(flat(42, P95_MIN_SAMPLES), budgets);
    expect(v.map((x) => [x.label, x.evaluated, x.ok])).toEqual([['p50', true, true], ['p95', true, true]]);
  });

  test('exactly AT the p50 budget is a breach — the budget is `< 50`, not `<= 50`', () => {
    expect(evaluate(flat(BUDGET_P50_MS, P95_MIN_SAMPLES), budgets)[0]!.ok).toBe(false);
  });

  test('one ms under the p50 budget passes', () => {
    expect(evaluate(flat(BUDGET_P50_MS - 1, P95_MIN_SAMPLES), budgets)[0]!.ok).toBe(true);
  });

  test('below the p95 sample floor, p95 is DECLINED rather than estimated', () => {
    // A p95 over 40 samples is the 38th order statistic wearing a percentile's name — the
    // small-sample artifact sdlc/012 found in the anomaly detector, in a new place.
    const v = evaluate(flat(42, P95_MIN_SAMPLES - 1), budgets);
    expect(v[1]!.evaluated).toBe(false);
    expect(v[1]!.reason).toContain(String(P95_MIN_SAMPLES));
    // Declined must not mean failed: a run that cannot judge p95 still passes on p50.
    expect(v[1]!.ok).toBe(true);
  });

  test('a declined p95 does not mask a breached p50', () => {
    const v = evaluate(flat(999, P95_MIN_SAMPLES - 1), budgets);
    expect(v[0]!.ok).toBe(false);
  });
});

describe('makeSandbox', () => {
  test('seeds an isolated HOME with a 0600 fixture credential and a v2 envelope', () => {
    const home = makeSandbox();
    try {
      const credPath = join(home, '.claude', '.credentials.json');
      expect(existsSync(credPath)).toBe(true);
      expect(statSync(credPath).mode & 0o777).toBe(0o600);

      const envelope = JSON.parse(
        readFileSync(join(home, '.cache', 'claudewatch', 'usage.json'), 'utf-8'),
      );
      expect(envelope.version).toBe(2);
      // Fresh, or the binary would fetch instead of hitting the cache.
      expect(envelope.snapshot.freshness.isStale).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('the fixture token is self-evidently not real', () => {
    const home = makeSandbox();
    try {
      const raw = readFileSync(join(home, '.claude', '.credentials.json'), 'utf-8');
      expect(raw).toContain('NOT-REAL');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('the CLI, run the way the gate runs it', () => {
  test('a missing binary exits 2, never 0', () => {
    const r = run(['--bin', join(dir, 'does-not-exist'), '--samples', '30']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('binary not found');
    expect(r.err).toContain('bun run --filter @claudewatch/statusline build');
  });

  test('--samples below the floor is refused', () => {
    const r = run(['--samples', '10']);
    expect(r.code).toBe(2);
    expect(r.err).toContain(String(MIN_SAMPLES));
  });

  test('a sample that exits non-zero is exit 2, not a fast measurement', () => {
    const r = run(['--bin', stub('fails', 'exit 3'), '--samples', '30']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('exited 3');
  });

  test('THE LOAD-BEARING GUARD: a rewritten cache means the samples were not cache hits', () => {
    // Every cache-miss path calls writeCache. If the seed is ever rejected, the run silently
    // becomes ~200 authenticated API calls and still reports a pass. This stub reproduces the
    // symptom — a rewritten envelope — without needing to break the real binary.
    const rewriter = stub('rewriter', 'echo "{}" > "$HOME/.cache/claudewatch/usage.json"');
    const r = run(['--bin', rewriter, '--samples', '30']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('not cache hits');
  });

  test('an impossible budget exits 1', () => {
    const r = run(['--bin', stub('fast', 'exit 0'), '--samples', '30', '--budget-p50', '0']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('BREACH');
  });

  test('--p50-only suppresses the p95 line entirely', () => {
    const r = run(['--bin', stub('fast2', 'exit 0'), '--samples', '30', '--p50-only']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('p50:');
    expect(r.out).not.toContain('p95:');
  });

  test('--json carries every percentile and the sample count', () => {
    const r = run(['--bin', stub('fast3', 'exit 0'), '--samples', '30', '--json']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(Object.keys(j)).toEqual(expect.arrayContaining(['samples', 'p50', 'p90', 'p95', 'p99', 'max', 'verdicts']));
    expect(j.samples).toBe(30);
    for (const k of ['p50', 'p90', 'p95', 'p99', 'max']) expect(typeof j[k]).toBe('number');
  });

  test('the run writes no claudewatch state into the ambient HOME', () => {
    // Handed a HOME perf must ignore: if it ever read or seeded the INHERITED home instead of
    // its own sandbox, `.claude` or `.cache/claudewatch` would appear here.
    //
    // The first version of this asserted the directory stayed ENTIRELY empty, and CI failed:
    // `bun run` itself creates `$HOME/.bun` when BUN_INSTALL is not redirected elsewhere, which
    // is true on the runner and not in my container. That assertion was a claim about bun, not
    // about perf.ts. Third time this session I have asserted something broader than the
    // property that matters — see sdlc/013/review.md.
    const ambient = mkdtempSync(join(tmpdir(), 'cw-ambient-'));
    try {
      const r = run(['--bin', stub('fast4', 'exit 0'), '--samples', '30'], { HOME: ambient });
      expect(r.code).toBe(0);
      expect(existsSync(join(ambient, '.claude'))).toBe(false);
      expect(existsSync(join(ambient, '.cache', 'claudewatch'))).toBe(false);
      // Anything else that appeared belongs to the toolchain, not to us — named, so a future
      // reader sees what was tolerated rather than a bare `true`.
      expect(readdirSync(ambient).filter((e) => e !== '.bun' && e !== '.cache')).toEqual([]);
    } finally {
      rmSync(ambient, { recursive: true, force: true });
    }
  });

  // A test that runs the REAL binary lived here. Removed: `verify`'s own `perf` step runs
  // `--samples 40 --p50-only` against that exact artifact immediately after `build`, so the
  // test was paying ~1.3s to assert what the gate asserts one step later. Everything above
  // uses stubs, which is what the failure paths actually need.
});
