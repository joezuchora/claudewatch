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
    // A value carrying something that must never be logged, to make the point concrete.
    expect(shouldRecordVerifyMetrics({ [VERIFY_METRICS_ENV]: '/home/joe/secret-token' }, bad.warn)).toBe(false);
    expect(bad.messages).toHaveLength(1);
    expect(bad.messages[0]).toContain(VERIFY_METRICS_ENV);
    // The value is deliberately NOT echoed. Under systemd this line goes to journald, and an
    // env value is arbitrary unbounded text — the one place in this change something
    // unsanitized could reach an output channel. An earlier version of this test asserted the
    // opposite. (sdlc/021 security pass, S6.)
    expect(bad.messages[0]).not.toContain('/home/joe');
    expect(bad.messages[0]).not.toContain('secret-token');
    expect(bad.messages[0]).toContain('unrecognised');
    expect(bad.messages[0]).toContain('not recording');

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
    // lintBudget and fenceCheck joined the gate in sdlc/033. Stubbed like the rest: this
    // fixture is about the metrics switch, not about either gate's own behaviour.
    scripts: { typecheck: noop, lint: noop, lintBudget: noop, fenceCheck: noop, vscodeStubCover: noop, build: noop, perf: noop },
  }), 'utf-8');
  writeFileSync(join(dir, 'fixture.test.ts'), [
    "import { test, expect } from 'bun:test';",
    `test('fixture', () => { expect(1).toBe(${failing ? 2 : 1}); });`,
  ].join('\n'), 'utf-8');
  return { dir, home };
}

function runGate(fixture: { dir: string; home: string }, env: Record<string, string>): number {
  // The child env is built by DELETING the switch first, then applying `env`.
  //
  // Spreading `...process.env` alone made the "unset" case a lie: the loop's own runbook now
  // exports CLAUDEWATCH_VERIFY_METRICS=1 before running the gate, so the parent had it set and
  // the child inherited it. The test asserting "unset behaves as disabled" was really asserting
  // "=1 behaves as disabled", and it failed the moment the runbook was followed. Found by the
  // gate going red for real — and named by the very event loop 020 added.
  // An ALLOWLIST, not a spread-and-delete.
  //
  // Spreading `...process.env` handed every secret in the developer's shell to five subprocesses,
  // and — more concretely — leaked CLAUDEWATCH_TELEMETRY and CLAUDEWATCH_VERIFY_TIMEOUT_MS into
  // the fixture, so a developer with a short timeout set ran a different test than CI did. The
  // reasoning that justified deleting the switch applies just as well to those. (sdlc/021
  // security pass, S7.)
  const childEnv: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    HOME: fixture.home,
    USERPROFILE: fixture.home,
    // sdlc/034: getCacheDir() honours $XDG_CACHE_HOME, which bypasses homedir(). Without pinning
    // it here an ambient value would send the gate's spool outside the fixture home and this
    // suite's "no spool at all" assertions would pass for the wrong reason.
    XDG_CACHE_HOME: join(fixture.home, '.cache'),
    ...env,
  };

  const proc = spawnSync('bun', ['run', VERIFY], {
    cwd: fixture.dir,
    env: childEnv,
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
      // Narrowed rather than `as`-asserted — a new instance of the standing item in
      // docs/audit-report.md, even in test code. (sdlc/021 security pass, S5.)
      const parsed: unknown = JSON.parse(lines[0]!);
      expect(typeof parsed === 'object' && parsed !== null).toBe(true);
      const ev = parsed as Record<string, unknown>;
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

  test('A5 — unset behaves as disabled, even when the PARENT has it set', () => {
    // Guards the inheritance bug above: this test is meaningless unless the child genuinely
    // lacks the variable, and the parent process running the suite may well have it.
    const f = makeFixture(false);
    try {
      expect(runGate(f, {})).toBe(0);
      expect(existsSync(cacheDir(f.home))).toBe(false);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
      rmSync(f.home, { recursive: true, force: true });
    }
  }, 180_000);

  test('A7 — a PASSING gate exits the same either way, and only the enabled run records', () => {
    // The half loop 021 shipped without. The failing case was covered; the passing case had its
    // exit codes asserted separately inside A5 and A6 and never COMPARED, which is a different
    // claim. Recorded as unmet in 021's review.md rather than quietly counted as done.
    const off = makeFixture(false);
    const on = makeFixture(false);
    try {
      const offCode = runGate(off, { CLAUDEWATCH_VERIFY_METRICS: '0' });
      const onCode = runGate(on, { CLAUDEWATCH_VERIFY_METRICS: '1' });
      expect(offCode).toBe(onCode);
      expect(offCode).toBe(0);
      expect(existsSync(spool(off.home))).toBe(false);
      expect(existsSync(spool(on.home))).toBe(true);
    } finally {
      for (const f of [off, on]) {
        rmSync(f.dir, { recursive: true, force: true });
        rmSync(f.home, { recursive: true, force: true });
      }
    }
  }, 300_000);

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

// --- A9: the documentation criterion ---

const REPO = join(import.meta.dir, '..');

/**
 * Loop 021 shipped A9's *content* by hand and its *check* not at all, so reverting any doc hunk
 * was uncaught. Recorded as unmet in that loop's review.md; closed here.
 *
 * A grep test is a weak instrument and this comment is where that is admitted: it proves a string
 * is present, never that the prose around it is true or current. What it does catch is the case
 * that actually happens — a documented behaviour quietly deleted or renamed while the code keeps
 * working. That is worth having, and it is all this is.
 */
describe('A9 — the switch is documented where it needs to be', () => {
  const MUST_MENTION = [
    'SPEC.md',
    'SECURITY.md',
    'CONTRIBUTING.md',
    'deploy/README.md',
    'deploy/systemd/claudewatch-sdlc-loop.service',
  ];

  for (const file of MUST_MENTION) {
    test(`${file} names ${VERIFY_METRICS_ENV}`, () => {
      const text = readFileSync(join(REPO, file), 'utf-8');
      expect(text).toContain(VERIFY_METRICS_ENV);
    });
  }

  /**
   * Naming the variable is not the claim worth pinning.
   *
   * The first version of these tests asserted only that each file contained the variable name,
   * and mutations reverting the SPEC.md amendment and the CONTRIBUTING.md paragraph both stayed
   * GREEN — the name survived elsewhere in the file. A vacuous test inside the tests written to
   * close a "no test" finding. What follows pins the sentences that carry meaning.
   */
  const MUST_CLAIM: Array<[string, string[]]> = [
    ['SPEC.md', ['recording is opt-in', 'unset means off']],
    ['SECURITY.md', ['opt-in', 'records nothing']],
    ['CONTRIBUTING.md', ['records nothing about your checkout by default', 'Unset means off']],
    ['deploy/README.md', ['opt-in', 'records nothing unless']],
  ];

  for (const [file, phrases] of MUST_CLAIM) {
    for (const phrase of phrases) {
      test(`${file} still says "${phrase}"`, () => {
        expect(readFileSync(join(REPO, file), 'utf-8')).toContain(phrase);
      });
    }
  }

  test('verify.ts no longer claims the metrics are always recorded', () => {
    // The specific false sentence loop 021 removed. If it returns, the code and the comment
    // disagree again.
    const text = readFileSync(join(REPO, 'scripts', 'verify.ts'), 'utf-8');
    expect(text).not.toContain('always recorded');
    // ...and the positive half, so deleting the whole file would not pass this.
    expect(text).toContain(VERIFY_METRICS_ENV);
  });

  test('the unit file does not promise every firing records an event', () => {
    // It said "records a verify_run event whatever the outcome" before recording became
    // conditional. deploy/README.md now qualifies the same claim; the unit must not restate it
    // unqualified.
    const unit = readFileSync(join(REPO, 'deploy', 'systemd', 'claudewatch-sdlc-loop.service'), 'utf-8');
    expect(unit).not.toContain('records a verify_run event whatever the outcome');
    expect(unit).toContain(`${VERIFY_METRICS_ENV}=1`);
  });

  test('the unit sets the switch INLINE on ExecStart, not only via Environment=', () => {
    // The finding that made loop 021's mitigation real: `Environment=` does not beat a
    // ~/.profile export, because ExecStart runs a login shell and the profile is sourced after
    // systemd hands the environment over. The inline assignment is the one that holds, so it is
    // the one worth pinning.
    const unit = readFileSync(join(REPO, 'deploy', 'systemd', 'claudewatch-sdlc-loop.service'), 'utf-8');
    const execStart = unit.split('\n').find(l => l.startsWith('ExecStart='));
    expect(execStart).toBeDefined();
    expect(execStart!).toContain(`${VERIFY_METRICS_ENV}=1 bun run verify`);
  });

  test('CONTRIBUTING.md tells a contributor the default is off', () => {
    // The one document the affected population actually reads.
    const text = readFileSync(join(REPO, 'CONTRIBUTING.md'), 'utf-8');
    expect(text).toContain(VERIFY_METRICS_ENV);
    expect(text.toLowerCase()).toContain('records nothing');
  });
});

/**
 * sdlc/034 A7 — the gate writes its event to the RESOLVED spool, end to end.
 *
 * This replaces a source-reading assertion that could not catch the defect it named. The first
 * version of A7 grepped `verify.ts` for `join(homedir(), '.cache'` and paired it with a property
 * test over `spool-path.ts`. sdlc/034's audit defeated it in five ways — double quotes, a template
 * literal, a destructured `homedir()`, an extracted constant — and, worst, with the mkdir left
 * DERIVED while the append was independently constructed. That last mutant produced no event
 * anywhere, in the fixture home or under XDG, with the gate still exiting 0: total silent loss of
 * the record, and the old A7 stayed green.
 *
 * A source grep tests spelling. This tests the invariant: the event lands where the resolver says.
 * `XDG_CACHE_HOME` points at a THIRD directory — neither the fixture home's `.cache` nor the
 * ambient one — so the assertion cannot pass by coincidence.
 */
describe('A7 — the spool follows XDG_CACHE_HOME through the real gate (sdlc/034)', () => {
  test('the event lands under $XDG_CACHE_HOME, and not under the fixture home', () => {
    const f = makeFixture(false);
    const xdg = mkdtempSync(join(tmpdir(), 'cw-xdg-'));
    try {
      expect(runGate(f, { CLAUDEWATCH_VERIFY_METRICS: '1', XDG_CACHE_HOME: xdg })).toBe(0);

      const resolved = join(xdg, 'claudewatch', 'metrics-spool.jsonl');
      expect(existsSync(resolved)).toBe(true);
      const lines = readFileSync(resolved, 'utf-8').trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);

      // The other half of the invariant: nothing was left at the legacy location. Without this the
      // test would pass for a gate that wrote to BOTH, which is the state a half-applied fix
      // produces.
      expect(existsSync(spool(f.home))).toBe(false);
      expect(existsSync(cacheDir(f.home))).toBe(false);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
      rmSync(f.home, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
    }
  }, 180_000);
});
