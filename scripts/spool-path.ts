import { isAbsolute, join } from 'path';

/**
 * The gate's own copy of core's cache-directory rule.
 *
 * `scripts/verify.ts` must NOT import `packages/core`. A syntax error in core would then stop the
 * gate from starting at all — no step ever runs, no `verify_run` event is recorded, and the failure
 * arrives as a raw Bun stack trace instead of `verify: fail [typecheck]`. Losing the record in
 * exactly the situation the record exists for is worse than the duplication. Same reasoning as
 * `MAX_LINE_BYTES` in `scripts/junit.ts`.
 *
 * A copy that can drift is only acceptable with a test that fails when it does, and `verify.ts`
 * cannot host one: it exports nothing, runs its steps at top level, and ends in `process.exit()`,
 * so importing it from a test runs the whole gate and kills the test process. That is why this
 * module exists — the pattern `scripts/env.ts` already establishes, and which
 * `packages/core/src/config.ts` documents: *"Exporting this is what lets `scripts/env.test.ts`
 * prove the two agree, instead of comparing a hand-copied table against itself and going green by
 * construction."*
 *
 * `spool-path.test.ts` asserts these agree with core's `getCacheDir()` / `getSpoolPath()`.
 *
 * See sdlc/034-xdg-cache-home/.
 */

/**
 * `home` and `env` are PARAMETERS, deliberately, rather than ambient `homedir()` / `process.env`
 * reads.
 *
 * `homedir()` is resolved once at process start and does not re-read a mutated `process.env.HOME`
 * — already documented at `packages/vscode/src/extension.test.ts:12-16`. So a test that varies the
 * HOME axis in-process is impossible against an ambient reader, and the alternative is a subprocess
 * per matrix cell at the 180s timeouts `scripts/env.test.ts` already pays. Parameters make the
 * agreement test a plain unit test.
 */
export function resolveCacheDir(home: string, env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CACHE_HOME;
  if (xdg !== undefined && isAbsolute(xdg)) return join(xdg, 'claudewatch');
  return join(home, '.cache', 'claudewatch');
}

export function resolveSpoolPath(home: string, env: NodeJS.ProcessEnv): string {
  return join(resolveCacheDir(home, env), 'metrics-spool.jsonl');
}
