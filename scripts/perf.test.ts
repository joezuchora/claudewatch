import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { evaluate, BUDGET_P50_MS, BUDGET_P95_MS, P95_MIN_SAMPLES, MIN_SAMPLES, WARMUP, SENTINEL_PCT } from './perf.js';

const REPO = join(import.meta.dir, '..');
const SCRIPT = join(import.meta.dir, 'perf.ts');
const BIN = join(REPO, 'packages', 'statusline', 'dist', 'claudewatch');

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-perf-test-'));

  // Build the binary if it is absent, exactly as smoke.test.ts does.
  //
  // `verify` runs `test` BEFORE `build`, and `dist/` is gitignored — so on a fresh checkout the
  // shipped artifact does not exist when this file runs. It passed locally only because a
  // binary was already sitting there from an earlier build, which is precisely the kind of
  // ambient state that makes a test lie. CI found it on the first clean run.
  if (!existsSync(BIN)) {
    const built = spawnSync('bun', ['run', '--filter', '@claudewatch/statusline', 'build'],
      { cwd: REPO, stdio: 'ignore' });
    if (built.status !== 0) throw new Error('could not build the statusline binary for perf tests');
  }
});
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

/**
 * A stub that behaves like a HEALTHY binary: renders the seeded sentinel and exits 0. Needed
 * now that the cache-hit guard proves the child read the sandbox rather than merely inferring
 * it from an undisturbed file — a stub that prints nothing is, correctly, rejected.
 */
function okStub(name: string): string {
  return stub(name, `echo "${SENTINEL_PCT}%"`);
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

/** N identical samples — the distribution does not matter to the deciding half. */
const flat = (ms: number, n: number) => Array.from({ length: n }, () => ms);

/** One [HOME, CLAUDEWATCH_TELEMETRY] pair per child invocation, as the recording stub logged it. */
const childEnv = (logPath: string) =>
  readFileSync(logPath, 'utf-8').trim().split('\n').map((l) => l.split('\t'));

describe('evaluate — the deciding half, which is what makes it right or wrong', () => {
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
    // Guarded: if measure() ever stops pinning HOME, this payload would clobber the
    // developer's REAL ~/.cache/claudewatch/usage.json and the test would still pass. The guard
    // makes that regression a loud exit 9 instead of quiet data loss. (security pass)
    const rewriter = stub('rewriter',
      [
        'case "$HOME" in *cw-perf-*) ;; *) exit 9 ;; esac',
        `echo "${SENTINEL_PCT}%"`,
        'echo "{}" > "$HOME/.cache/claudewatch/usage.json"',
      ].join('\n'));
    const r = run(['--bin', rewriter, '--samples', '30']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('not cache hits');
  });

  test('--report-only still exits 0 on a breach, but says so', () => {
    // The mitigation itself needs a guard: if --report-only ever stopped suppressing the exit
    // code, the gate would go red again for environmental reasons (sdlc/015).
    const r = run(['--bin', okStub('fast5'), '--samples', '30', '--budget-p50', '0', '--report-only']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('BREACH');
    expect(r.out).toContain('report-only');
  });

  test('--report-only does NOT suppress exit 2 — a run that could not measure never passes', () => {
    const r = run(['--bin', join(dir, 'nope'), '--samples', '30', '--report-only']);
    expect(r.code).toBe(2);
  });

  test('an impossible budget exits 1', () => {
    const r = run(['--bin', okStub('fast'), '--samples', '30', '--budget-p50', '0']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('BREACH');
  });

  test('--json carries every percentile and the sample count', () => {
    const r = run(['--bin', okStub('fast3'), '--samples', '30', '--json']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(Object.keys(j)).toEqual(expect.arrayContaining(['samples', 'p50', 'p90', 'p95', 'p99', 'max', 'verdicts']));
    expect(j.samples).toBe(30);
    for (const k of ['p50', 'p90', 'p95', 'p99', 'max']) expect(typeof j[k]).toBe('number');
  });

  /**
   * A stub that records the environment it was handed, one line per invocation.
   *
   * The audit found that deleting `HOME: home` from the child env left every test green: the
   * old test only proved perf did not WRITE into the inherited HOME, which `mkdtempSync` makes
   * true by construction, and an `exit 0` stub cannot reveal what it was given. Asking the
   * child is the difference between testing the claim and testing around it.
   */
  function recordingStub(name: string, logPath: string): string {
    return stub(name, [
      `printf '%s\\t%s\\n' "$HOME" "$CLAUDEWATCH_TELEMETRY" >> ${logPath}`,
      // Satisfy the sentinel probe, so these tests exercise the env plumbing rather than
      // tripping the cache-hit guard first.
      `echo "${SENTINEL_PCT}%"`,
    ].join('\n'));
  }
  test('a binary that does not render the seeded cache is exit 2, before any measuring', () => {
    // The positive half of the cache-hit guard: silence is not proof. A child that prints
    // nothing has not been shown to have read the sandbox, whatever it left undisturbed.
    const r = run(['--bin', stub('silent', 'exit 0'), '--samples', '30']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('did not render the seeded cache');
  });

  test('the child is handed the SANDBOX home, not the ambient one', () => {
    const ambient = mkdtempSync(join(tmpdir(), 'cw-ambient-'));
    const log = join(dir, 'env-home.log');
    try {
      const r = run(['--bin', recordingStub('records-home', log), '--samples', '30'], { HOME: ambient });
      expect(r.code).toBe(0);

      const homes = new Set(childEnv(log).map(([h]) => h));
      expect(homes.size).toBe(1);                                  // one sandbox for the whole run
      const [seen] = [...homes];
      expect(seen).not.toBe(ambient);                              // NOT the inherited HOME
      expect(seen).toContain('cw-perf-');                          // the sandbox seedSandboxHome built
      expect(existsSync(seen!)).toBe(false);                       // and cleaned up afterwards

      // And nothing of ours was written where it was told not to write.
      expect(existsSync(join(ambient, '.claude'))).toBe(false);
      expect(existsSync(join(ambient, '.cache', 'claudewatch'))).toBe(false);
    } finally {
      rmSync(ambient, { recursive: true, force: true });
    }
  });

  test('USERPROFILE is pinned too — HOME alone leaves Windows unprotected', () => {
    // os.homedir() follows HOME on POSIX and USERPROFILE on Windows, a supported build target.
    // Pinning only HOME would run the binary against the developer's REAL credentials and cache
    // there, and the mtime guard would check an untouched sandbox file and report a pass.
    const log = join(dir, 'env-userprofile.log');
    const winStub = stub('records-userprofile',
      `printf '%s\\n' "$USERPROFILE" >> ${log}\necho "${SENTINEL_PCT}%"`);
    const ambient = mkdtempSync(join(tmpdir(), 'cw-ambient-win-'));
    try {
      const r = run(['--bin', winStub, '--samples', '30'], { USERPROFILE: ambient, HOME: ambient });
      expect(r.code).toBe(0);
      const seen = new Set(readFileSync(log, 'utf-8').trim().split('\n'));
      expect(seen.size).toBe(1);
      const [profile] = [...seen];
      expect(profile).not.toBe(ambient);
      expect(profile).toContain('cw-perf-');
    } finally {
      rmSync(ambient, { recursive: true, force: true });
    }
  });

  test('telemetry is PINNED off in the child, not inherited', () => {
    // The spool lives under the cache dir, so an isolated HOME already yields an empty spool —
    // which means an unpinned telemetry setting would change nothing visible and go unnoticed.
    // The budget names a telemetry state, so the run must impose one.
    const log = join(dir, 'env-telemetry.log');
    const r = run(['--bin', recordingStub('records-telemetry', log), '--samples', '30'],
      { CLAUDEWATCH_TELEMETRY: '1' });
    expect(r.code).toBe(0);
    expect(new Set(childEnv(log).map(([, t]) => t))).toEqual(new Set(['0']));
  });

  test('WARMUP is the count SPEC §11.7 states, not whatever the constant happens to be', () => {
    // The test below asserts `WARMUP + 30` against the imported constant, so changing WARMUP
    // moves both sides and the mutation survives — the same tautology the plan-to-diff audit
    // caught in `expect(GENERAL_LIMIT).toBe(1000)` last loop. Pinning the literal is what makes
    // the spec's "5 discarded warm-ups" a claim rather than a description.
    expect(WARMUP).toBe(5);
  });

  test('warm-up runs happen and are excluded from the reported samples', () => {
    const log = join(dir, 'env-warmup.log');
    const r = run(['--bin', recordingStub('records-count', log), '--samples', '30', '--json']);
    expect(r.code).toBe(0);
    expect(childEnv(log)).toHaveLength(WARMUP + 30);   // the binary really ran WARMUP extra times
    expect(JSON.parse(r.out).samples).toBe(30);        // and none of them reached the statistics
  });

  test('a sample that outlives the per-sample timeout is exit 2, naming the index', () => {
    const r = run(['--bin', stub('slow', 'exec sleep 5'), '--samples', '30'],
      { CLAUDEWATCH_PERF_SAMPLE_TIMEOUT_MS: '100' });
    expect(r.code).toBe(2);
    expect(r.err).toContain('timed out');
  });

  test('THE SHIPPED ARTIFACT: the real binary measures clean and makes no network call', () => {
    // Restored after the audit noted no committed test touched the real binary — this repo's
    // recurring finding, five instances deep, is that defects hide exactly there.
    //
    // It also discharges the zero-network criterion, by construction rather than by inspection:
    // the sandbox credential is a fixture that would 401 immediately, so any run that reached
    // the fetch path would exit non-zero and be reported as exit 2. A clean exit 0 across 30
    // samples IS the evidence that no request left the machine.
    // --report-only, deliberately: this asserts the PLUMBING — the sandbox, the cache-hit
    // guard, a clean exit, a printed distribution — not the budget. A latency budget asserted
    // inside `bun test` measures the host's mood, and sdlc/015 is the record of it going red
    // for no code reason. The budget verdict belongs to a deliberate `bun run perf`.
    const r = run(['--samples', '30', '--report-only']);
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' });
    expect(r.out).toMatch(/^n=30 {2}p50=/m);
    expect(r.out).toContain('p95: not evaluated');
  }, 30_000);

  // A test that runs the REAL binary lived here. Removed: `verify`'s own `perf` step runs
  // `--samples 40 --p50-only` against that exact artifact immediately after `build`, so the
  // test was paying ~1.3s to assert what the gate asserts one step later. Everything above
  // uses stubs, which is what the failure paths actually need.
});
