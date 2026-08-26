import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { shouldRecordVerifyMetrics, VERIFY_METRICS_ENV } from './env.js';
import { parseBooleanEnvValue } from '../packages/core/src/config.js';

const ON = ['1', 'true', 'yes', 'on'];
const OFF = ['0', 'false', 'no', 'off', '', '   '];

/** Collects the warn() calls instead of writing to a real stream. */
function withWarnings(): { warn: (m: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (m: string) => { messages.push(m); }, messages };
}

describe('A2/A3 — the token table', () => {
  for (const value of ON) {
    test(`${JSON.stringify(value)} enables`, () => {
      expect(shouldRecordVerifyMetrics({ [VERIFY_METRICS_ENV]: value })).toBe(true);
    });
  }

  for (const value of OFF) {
    test(`${JSON.stringify(value)} disables`, () => {
      expect(shouldRecordVerifyMetrics({ [VERIFY_METRICS_ENV]: value })).toBe(false);
    });
  }

  test('A3 — case and surrounding whitespace are ignored', () => {
    expect(shouldRecordVerifyMetrics({ [VERIFY_METRICS_ENV]: ' ON ' })).toBe(true);
    expect(shouldRecordVerifyMetrics({ [VERIFY_METRICS_ENV]: 'Off' })).toBe(false);
    expect(shouldRecordVerifyMetrics({ [VERIFY_METRICS_ENV]: 'TRUE' })).toBe(true);
  });

  test('whitespace-only is off, agreeing with config.ts', () => {
    // The case an implementer writing `if (!v) return DEFAULT` gets wrong: it would return the
    // default (off here, but on under any other default) rather than reading "   " as a
    // deliberate empty value. config.ts trims first, so "   " is "" is false.
    expect(shouldRecordVerifyMetrics({ [VERIFY_METRICS_ENV]: '   ' })).toBe(false);
    expect(parseBooleanEnvValue('   ')).toBe(false);
  });
});

describe('A1 — unset means off', () => {
  test('an absent variable disables, and a present one can still enable', () => {
    // The positive half matters: an implementation hard-coded to `false` passes the first
    // assertion alone.
    expect(shouldRecordVerifyMetrics({})).toBe(false);
    expect(shouldRecordVerifyMetrics({ [VERIFY_METRICS_ENV]: '1' })).toBe(true);
  });

  test('an unrelated variable does not enable it', () => {
    expect(shouldRecordVerifyMetrics({ CLAUDEWATCH_TELEMETRY: '1' })).toBe(false);
  });
});

describe('A4 — an unrecognised value is off, and says so', () => {
  test('it disables AND warns, while a valid value is silent', () => {
    const bad = withWarnings();
    expect(shouldRecordVerifyMetrics({ [VERIFY_METRICS_ENV]: 'enabled' }, bad.warn)).toBe(false);
    expect(bad.messages).toHaveLength(1);
    expect(bad.messages[0]).toContain(VERIFY_METRICS_ENV);
    expect(bad.messages[0]).toContain('enabled');

    const good = withWarnings();
    expect(shouldRecordVerifyMetrics({ [VERIFY_METRICS_ENV]: '1' }, good.warn)).toBe(true);
    expect(good.messages).toEqual([]);
  });

  test('an UNSET variable is the ordinary case and warns nothing', () => {
    const w = withWarnings();
    expect(shouldRecordVerifyMetrics({}, w.warn)).toBe(false);
    expect(w.messages).toEqual([]);
  });
});

describe('A8 — the copied table agrees with core, mechanically', () => {
  test('every token resolves the same way in both implementations', () => {
    // scripts/env.ts keeps its own copy because verify.ts must not import packages/core. This is
    // what stops the copy drifting: the TEST imports core, the gate does not. Without it, "matches
    // config.ts" could only compare a hand-copied table against itself.
    for (const value of [...ON, ...OFF, ' ON ', 'Off', 'TRUE']) {
      const core = parseBooleanEnvValue(value);
      const ours = shouldRecordVerifyMetrics({ [VERIFY_METRICS_ENV]: value }, () => {});
      expect(core).not.toBeNull();
      expect(ours).toBe(core!);
    }
  });

  test('core returns null for unrecognised, and we resolve that to the default', () => {
    // The one place the two DIFFER, stated rather than glossed: core is tri-state so
    // resolveTelemetryConfig can fall through to its config file; this switch has no next
    // fallback and resolves to off.
    expect(parseBooleanEnvValue('enabled')).toBeNull();
    expect(shouldRecordVerifyMetrics({ [VERIFY_METRICS_ENV]: 'enabled' }, () => {})).toBe(false);
  });
});

// --- A5/A6/A7: the real script, against a fixture repo ---

const VERIFY = join(import.meta.dir, 'verify.ts');

/**
 * A throwaway repo the gate can run against.
 *
 * Four of the five steps are `bun run <script>` and are satisfied by no-op package.json entries.
 * **The test step is not.** `STEPS` declares it as `['bun', 'test']` — bun's own runner, invoked
 * directly — so no package.json script can override it, and `bun test` in an empty directory
 * exits non-zero with "0 test files matching". The plan's "five no-op scripts" was wrong about
 * this, and running it is what showed that.
 *
 * So the fixture ships a real test file. That is better than a stub would have been: the passing
 * and failing cases now exercise the actual junit reporter path this switch governs.
 *
 * This still does not recurse the way sdlc/020's attempt did — that spawned the whole gate from
 * inside the repo's own suite, so `bun test` re-discovered the file that spawned it. Here the
 * gate runs against a different directory containing exactly one trivial test.
 */
function makeFixture(failing: boolean): { dir: string; home: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cw-fixture-'));
  const home = mkdtempSync(join(tmpdir(), 'cw-home-'));
  // `true`, not `bun -e ''`: verify.ts appends `--samples 40 --report-only` to the perf step, and
  // bun reads the first of those as a script name and errors. `true` ignores its arguments.
  const noop = 'true';
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'fixture',
    scripts: { typecheck: noop, lint: noop, build: noop, perf: noop },
  }), 'utf-8');
  writeFileSync(join(dir, 'fixture.test.ts'), [
    "import { test, expect } from 'bun:test';",
    `test('fixture', () => { expect(1).toBe(${failing ? 2 : 1}); });`,
  ].join('\n'), 'utf-8');
  return { dir, home };
}

function runGate(fixture: { dir: string; home: string }, env: Record<string, string>): number {
  const proc = spawnSync('bun', ['run', VERIFY], {
    cwd: fixture.dir,
    env: { ...process.env, HOME: fixture.home, USERPROFILE: fixture.home, ...env },
    stdio: 'ignore',
    timeout: 120_000,
  });
  return proc.status ?? -1;
}

function spool(home: string): string {
  return join(home, '.cache', 'claudewatch', 'metrics-spool.jsonl');
}

function cacheDir(home: string): string {
  return join(home, '.cache', 'claudewatch');
}

describe('A5/A6/A7 — the switch against the real script', () => {
  test('A6 — enabled: exactly one verify_run event is written', () => {
    const f = makeFixture(false);
    try {
      expect(runGate(f, { CLAUDEWATCH_VERIFY_METRICS: '1' })).toBe(0);
      expect(existsSync(spool(f.home))).toBe(true);
      const lines = readFileSync(spool(f.home), 'utf-8').trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      const ev = JSON.parse(lines[0]!) as { kind: string; source: string };
      expect(ev.kind).toBe('verify_run');
      expect(ev.source).toBe('sdlc');
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
      rmSync(f.home, { recursive: true, force: true });
    }
  }, 180_000);

  test('A5 — disabled: no spool AND no ~/.cache/claudewatch directory at all', () => {
    // The directory is the observable side effect. mkdirSync runs before the size check in
    // record(), so a guard placed next to appendFileSync would leave the directory behind and
    // pass a spool-only assertion.
    const f = makeFixture(false);
    try {
      expect(runGate(f, { CLAUDEWATCH_VERIFY_METRICS: '0' })).toBe(0);
      expect(existsSync(spool(f.home))).toBe(false);
      expect(existsSync(cacheDir(f.home))).toBe(false);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
      rmSync(f.home, { recursive: true, force: true });
    }
  }, 180_000);

  test('A5 — unset behaves as disabled', () => {
    const f = makeFixture(false);
    try {
      expect(runGate(f, {})).toBe(0);
      expect(existsSync(cacheDir(f.home))).toBe(false);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
      rmSync(f.home, { recursive: true, force: true });
    }
  }, 180_000);

  test('A7 — a failing gate exits the same either way, and only the enabled run records', () => {
    // Standalone, "same exit code" is satisfied by an implementation that ignores the variable
    // entirely. Binding it to the spool assertion is what gives it evidence of the feature.
    const off = makeFixture(true);
    const on = makeFixture(true);
    try {
      const offCode = runGate(off, { CLAUDEWATCH_VERIFY_METRICS: '0' });
      const onCode = runGate(on, { CLAUDEWATCH_VERIFY_METRICS: '1' });
      expect(offCode).toBe(onCode);
      expect(offCode).not.toBe(0);
      expect(existsSync(spool(off.home))).toBe(false);
      expect(existsSync(spool(on.home))).toBe(true);
    } finally {
      for (const f of [off, on]) {
        rmSync(f.dir, { recursive: true, force: true });
        rmSync(f.home, { recursive: true, force: true });
      }
    }
  }, 300_000);
});
