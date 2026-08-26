import { describe, test, expect, beforeAll } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Proof that the compile-time guards in `cooldown.ts`, `client.ts` and `main.ts` actually
 * fail a build when the thing they guard against happens.
 *
 * This test exists because sdlc/014's own spec shipped a guard that compiles clean when the
 * member it guards is missing. A guard is indistinguishable from a comment until you have
 * watched it fail, and `tsc` exiting 0 on the whole project cannot tell you which of those
 * two you have.
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
  const proc = Bun.spawnSync(
    ['bunx', 'tsc', '--noEmit', '-p', join(FIXTURE_DIR, 'tsconfig.json')],
    { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' },
  );
  run = {
    exitCode: proc.exitCode ?? -1,
    output: proc.stdout.toString() + proc.stderr.toString(),
  };
});

function diagnosticsFor(fixture: string): string[] {
  return run.output
    .split('\n')
    .filter(line => line.includes(fixture));
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

  test('the fixture project matches every fixture on disk', () => {
    // An `include` glob that silently stops matching is the same failure mode as sdlc/018's
    // `exclude`: green, and checking nothing.
    const fixtures = readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.ts'));
    expect(fixtures.length).toBe(4);
    for (const f of fixtures) {
      expect(f).toMatch(/\.expect-(error|clean)\.ts$/);
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
