import { describe, test, expect, beforeAll } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Two separate things, and it matters which is which.
 *
 * 1. **The fixtures prove the FORM is live.** Each is a miniature of a guard shipped in
 *    `cooldown.ts`, `client.ts` or `main.ts`, with the thing it guards against deliberately
 *    present. They use local stand-in unions, so they cannot see the shipped guards at all —
 *    delete `_allCovered` from `cooldown.ts` and every fixture assertion below stays green.
 *    An earlier version of this header claimed otherwise; the sdlc/014 review caught it,
 *    which is the same overstatement the loop was opened to fix, one level up.
 *
 * 2. **`the guards are still present in the shipped files` observes the guards themselves.**
 *    It is a text search, with all the brittleness that implies, and it is the only check here
 *    that fails if someone deletes one. The evidence that the shipped guards actually FIRE is
 *    the mutation table in sdlc/014-exhaustive-failure-class/review.md — M1, M2, M8 and M11
 *    each broke a real switch and recorded the resulting TS2322.
 *
 * All of it exists because sdlc/014's own spec shipped a guard that compiles clean when the
 * member it guards is missing. A guard is indistinguishable from a comment until you have
 * watched it fail, and `tsc` exiting 0 on the whole project cannot tell you which you have.
 *
 * Lives outside `typefixtures/` deliberately: that directory is excluded from the root
 * tsconfig, and sdlc/018's finding was that a test inside an excluded directory is a test
 * nobody typechecks.
 */

const FIXTURE_DIR = join(import.meta.dir, 'typefixtures');
const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

interface TscRun {
  exitCode: number;
  output: string;
}

let run: TscRun;

/**
 * One `tsc` invocation for the whole fixture project, not one per fixture.
 *
 * Four separate runs would have cost ~8 s on a ~13 s gate (the risk sdlc/014's plan called
 * out). tsc prefixes every diagnostic with its file, so per-fixture assertions read the same
 * either way.
 */
beforeAll(() => {
  // The LOCAL binary, explicitly, not `bunx tsc`. On a pruned or half-installed tree `bunx`
  // falls back to fetching and running a registry package named `tsc` — which is not
  // TypeScript — so a missing devDependency would become a download and an execution during
  // `bun test`. This way it is just a red test. (sdlc/014 security pass.)
  const proc = Bun.spawnSync(
    [
      join(REPO_ROOT, 'node_modules', '.bin', 'tsc'),
      '--noEmit',
      '--listFiles',
      '-p',
      join(FIXTURE_DIR, 'tsconfig.json'),
    ],
    { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' },
  );
  run = {
    exitCode: proc.exitCode ?? -1,
    output: proc.stdout.toString() + proc.stderr.toString(),
  };
});

/** Diagnostic lines only. `--listFiles` also prints every compiled path, which is not one. */
function diagnosticsFor(fixture: string): string[] {
  return run.output
    .split('\n')
    .filter(line => line.includes(fixture) && line.includes('error TS'));
}

/** The paths `tsc` actually compiled, from `--listFiles`. */
function compiledFiles(): string[] {
  return run.output
    .split('\n')
    .filter(line => line.endsWith('.ts') && !line.includes('error TS'))
    .map(line => line.trim());
}

describe('type fixture harness', () => {
  test('tsc actually ran and reported failures', () => {
    // Guards the harness itself: a tsc that failed to start, or a fixture project that
    // matched no files, would exit 0 and make every assertion below vacuous.
    expect(run.exitCode).not.toBe(0);
    expect(run.output).toContain('error TS');
    // TS18003 is "no inputs were found": a non-zero exit that means the project matched
    // nothing. It is exactly the vacuous green this harness exists to prevent, and it is not
    // hypothetical — the first version of the fixture tsconfig inherited the root `exclude`,
    // which excludes this very directory, and produced it.
    expect(run.output).not.toContain('TS18003');
  });

  test('tsc compiled every fixture on disk, not just the ones that fail', () => {
    // An `include` glob that silently stops matching is the same failure mode as sdlc/018's
    // `exclude`: green, and checking nothing. Checking the directory listing alone was not
    // enough — it never consulted what tsc resolved, and the negative control's assertion
    // ("this file produced no diagnostics") is VACUOUS for a file tsc never opened. So this
    // reads `--listFiles` output and matches it against the directory. (sdlc/014 review.)
    const onDisk = readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.ts'));
    expect(onDisk.length).toBe(5);   // sdlc/029 added free-text-message.expect-error.ts

    const compiled = compiledFiles();
    for (const f of onDisk) {
      expect(f).toMatch(/\.expect-(error|clean)\.ts$/);
      expect(compiled.some(path => path.endsWith(`/${f}`))).toBe(true);
    }
  });
});

describe('the guards fail when their subject is missing', () => {
  test('a member missing from an exhaustive switch fails typecheck', () => {
    const errors = diagnosticsFor('switch-missing-case.expect-error.ts');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toContain('error TS2322');
    // The message names the member, which is what makes the failure actionable rather than
    // merely red.
    expect(errors.join('\n')).toContain('"blue"');
  });

  test('a member missing from a satisfies-array fails typecheck', () => {
    const errors = diagnosticsFor('array-missing-member.expect-error.ts');
    expect(errors.join('\n')).toContain('error TS2322');
    expect(errors.join('\n')).toContain('"blue"');
  });

  test('the guard catches an omission from the real FailureClass union', () => {
    const errors = diagnosticsFor('real-union-omission.expect-error.ts');
    expect(errors.join('\n')).toContain('error TS2322');
    expect(errors.join('\n')).toContain('"timeout"');
  });

  test('a free-text fetch-failure message fails typecheck', () => {
    // sdlc/029. DECLARED FENCE EXCURSION: plan.md listed the fixture but not this file. A fixture
    // with no assertion is a fixture that proves nothing — the harness above only checks that each
    // file on disk compiles, not that it errors for the right reason. Recorded rather than slipped
    // in, because an unasserted guard is the exact vacuity this repo keeps catching.
    const errors = diagnosticsFor('free-text-message.expect-error.ts');
    expect(errors.join('\n')).toContain('error TS2322');
    // Names the offending shape, so the failure is actionable rather than merely red.
    expect(errors.join('\n')).toContain('SurfaceableMessage');
  });
});

describe('the negative control', () => {
  test('the inert empty-array form compiles clean, as it did when it shipped', () => {
    // If this ever starts failing, TypeScript has changed and the `Exclude<...>[] = []` form
    // has become a real guard. Good news — but read sdlc/014 before deleting anything, because
    // the reasoning in three files points at this file for why that form is not used.
    expect(diagnosticsFor('inert-empty-array.expect-clean.ts')).toEqual([]);
  });
});

describe('tsconfig exclusions', () => {
  test('typecheck skips exactly three paths and no more', () => {
    // sdlc/018: `scripts` was in this list for eleven loops, so `bun run typecheck` never
    // looked at the gate's own runner. Every addition here is a hole, and holes should cost
    // an explicit test edit rather than a quiet one-line diff.
    const raw = readFileSync(join(REPO_ROOT, 'tsconfig.json'), 'utf-8');
    const config = JSON.parse(raw) as { exclude: string[] };
    expect(config.exclude).toEqual([
      'dist',
      'node_modules',
      'packages/core/src/typefixtures',
    ]);
  });
});

describe('the shipped guards are still present', () => {
  /**
   * The only check in this file that looks at production code.
   *
   * A text search is a weak instrument — it cannot tell a live guard from one that has been
   * commented out into a string — but a weak check on the real thing beats a strong check on a
   * stand-in, and every fixture above is a stand-in. Deleting any of these four lines is a
   * silent removal of a compile-time guarantee that nothing else here would notice.
   *
   * The `statusLessClassOf` row is also the only coverage of the plan's "statusClassOf
   * exhaustive" criterion, which shipped without a test of its own.
   */
  const SHIPPED = [
    {
      file: 'packages/core/src/cooldown.ts',
      needle: 'const _allCovered: never',
      guards: 'FAILURE_CLASSES covers every member of the union',
    },
    {
      file: 'packages/core/src/cooldown.ts',
      needle: 'const unhandled: never = fc;',
      guards: "failurePolicy's switch is exhaustive",
    },
    {
      file: 'packages/core/src/client.ts',
      needle: 'const unhandled: never = fc;',
      guards: "statusLessClassOf's switch is exhaustive",
    },
    {
      file: 'packages/statusline/src/main.ts',
      needle: 'const unhandled: never = presentation;',
      guards: "errorLineFor's switch is exhaustive",
    },
  ];

  for (const { file, needle, guards } of SHIPPED) {
    test(`${file} still guards that ${guards}`, () => {
      const source = readFileSync(join(REPO_ROOT, file), 'utf-8');
      expect(source).toContain(needle);
    });
  }
});
