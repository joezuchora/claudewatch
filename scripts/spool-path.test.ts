import { describe, expect, test, afterEach } from 'bun:test';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { getCacheDir, getSpoolPath, setCacheBaseDir } from '../packages/core/src/index.js';
import { resolveCacheDir, resolveSpoolPath } from './spool-path.js';

/**
 * The gate keeps its own copy of core's cache-directory rule, deliberately — `verify.ts` must not
 * import `packages/core`, or a syntax error there would stop the gate from starting and lose the
 * `verify_run` record in exactly the case the record exists for.
 *
 * This file is the price of keeping that copy honest. Without it the duplication is free to drift,
 * and the failure mode is silent: product telemetry and the gate append to different files, the
 * shipper reads one of them, and the hourly run count goes flat with no error and no gap marker.
 *
 * A6 in sdlc/034's spec. Its first draft asserted the two agree "across a matrix of HOME ×
 * XDG_CACHE_HOME" against `verify.ts` directly — unsatisfiable, because `verify.ts` exports nothing
 * and ends in `process.exit()`. The resolvers take `home` as a parameter precisely so this is a
 * plain unit test rather than a subprocess matrix at 180s per cell.
 */

const XDG_VALUES: ReadonlyArray<readonly [label: string, value: string | undefined]> = [
  ['unset', undefined],
  ['absolute', '/xdg-abs'],
  ['relative', 'relative/path'],
  ['empty', ''],
  ['trailing slash', '/xdg-abs/'],
  ['tilde', '~/cache'],
];

const savedXdg = process.env.XDG_CACHE_HOME;

function withXdg(value: string | undefined): NodeJS.ProcessEnv {
  if (value === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = value;
  return process.env;
}

afterEach(() => {
  setCacheBaseDir(null);
  if (savedXdg === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedXdg;
});

describe('scripts/spool-path agrees with @claudewatch/core (sdlc/034 A6)', () => {
  for (const [label, value] of XDG_VALUES) {
    test(`the two resolvers agree with XDG_CACHE_HOME ${label}`, () => {
      setCacheBaseDir(null);
      const env = withXdg(value);
      // homedir() is the same input core uses; it cannot be varied in-process, which is why the
      // script side takes it as a parameter rather than reading it.
      expect(resolveCacheDir(homedir(), env)).toBe(getCacheDir());
      expect(resolveSpoolPath(homedir(), env)).toBe(getSpoolPath());
    });
  }

  /**
   * The HOME axis, which core cannot be asked about in-process. Asserted against the RULE rather
   * than against core, so the test still fails if the script copy drifts on this axis.
   */
  test('a different home moves the result, and only via the legacy branch', () => {
    const env = withXdg(undefined);
    expect(resolveCacheDir('/home/alice', env)).toBe(join('/home/alice', '.cache', 'claudewatch'));
    expect(resolveCacheDir('/home/bob', env)).toBe(join('/home/bob', '.cache', 'claudewatch'));
  });

  test('an absolute XDG value ignores home entirely', () => {
    const env = withXdg('/xdg-abs');
    expect(resolveCacheDir('/home/alice', env)).toBe(resolveCacheDir('/home/bob', env));
    expect(resolveCacheDir('/home/alice', env)).toBe(join('/xdg-abs', 'claudewatch'));
  });

  test('the spool sits directly under the resolved cache dir', () => {
    const env = withXdg('/xdg-abs');
    expect(resolveSpoolPath('/home/alice', env)).toBe(
      join(resolveCacheDir('/home/alice', env), 'metrics-spool.jsonl'),
    );
  });
});

/**
 * A7 — the directory `verify.ts` creates must be DERIVED from the file it appends to.
 *
 * This is the defect sdlc/034's Stage 2 review found: `verify.ts:169` constructed the cache
 * directory independently of `spoolPath()`, so honouring $XDG_CACHE_HOME in the resolver alone made
 * `record()` create the legacy directory and append to an XDG path whose parent did not exist. The
 * append threw ENOENT, the catch swallowed it, the gate exited 0, and every verify_run event was
 * lost silently.
 *
 * The property test below is necessary but NOT sufficient — it would still pass if someone
 * reintroduced an independent construction in `verify.ts`. So the second test reads the source.
 * A test that cannot fail on the regression it names is worse than no test (sdlc/032, sdlc/033).
 */
describe('the gate derives its spool directory rather than rebuilding it (A7)', () => {
  test('dirname of the spool path is exactly the resolved cache dir', () => {
    for (const [, value] of XDG_VALUES) {
      const env = withXdg(value);
      expect(dirname(resolveSpoolPath('/home/alice', env))).toBe(resolveCacheDir('/home/alice', env));
    }
  });

  test('verify.ts contains no second construction of the cache directory', () => {
    const src = readFileSync(new URL('./verify.ts', import.meta.url), 'utf8');
    // Positive precondition: we are reading the right file, and it does use the resolver.
    expect(src).toContain('resolveSpoolPath(homedir(), process.env)');
    expect(src).toContain('mkdirSync(dirname(spoolPath())');
    // The regression: any hand-built `.cache` path in the gate is a definition that can drift.
    expect(src).not.toMatch(/join\(\s*homedir\(\)\s*,\s*'\.cache'/);
  });
});
