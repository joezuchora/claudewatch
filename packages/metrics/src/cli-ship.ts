#!/usr/bin/env bun
/**
 * Ship spooled product telemetry to the metrics service.
 *
 * Run from `claudewatch-ship.timer` (every 5 minutes), or by hand. **NOT by `verify`** — the header
 * said "or by verify" until sdlc/036, and `scripts/verify.ts` has no ship step and never had one.
 * That mattered: it was the only claimed path by which a human saw this output, and it was false.
 * `deploy/README.md`'s "Operating it" section now names the journal command instead.
 */
import { basename, dirname } from 'path';
import { realpathSync } from 'fs';
import {
  MAX_RETAINED_SHIPPING_FILES, combineResults, formatAge, ship, shouldDrainLegacy, summariseFailures,
} from './agent.js';
import type { ShipResult } from './types.js';
import { getLegacySpoolPath, getSpoolPath } from '@claudewatch/core';

const endpoint = process.env.CLAUDEWATCH_METRICS_ENDPOINT;
if (!endpoint) {
  // Not an error: the overwhelmingly common case is telemetry simply not being configured.
  console.log('CLAUDEWATCH_METRICS_ENDPOINT not set — nothing to do.');
  process.exit(0);
}

/** Resolves symlinks where it can; falls back to a string compare when a path does not exist. */
function sameFile(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(dirname(a)) === realpathSync(dirname(b)) && basename(a) === basename(b);
  } catch {
    return false;
  }
}

const token = process.env.CLAUDEWATCH_METRICS_TOKEN ?? null;
const spoolPath = getSpoolPath();

// Re-bound after the guard above. The `if (!endpoint) process.exit(0)` narrows straight-line code
// but not a closure body, and widening `ShipOptions.endpoint` to accept undefined would be a type
// change made to satisfy a control-flow limitation.
const configuredEndpoint: string = endpoint;

/**
 * Wrapped HERE as well as inside `ship()`, deliberately.
 *
 * `ship()` now guards its own filesystem operations, but a guard that exists only one level down is
 * a guard the next refactor removes without noticing. Before sdlc/036 there was no `try` on this
 * path at all: an EPERM from `renameSync` killed the process before `console.log` below, so a
 * permanently failing shipper printed NOTHING — no reason, no backlog, no data-loss warning — and
 * the unhandled rejection exited 1, which `SuccessExitStatus=0 1` maps to unit success.
 */
async function shipSafely(path: string): Promise<ShipResult> {
  try {
    return await ship({ spoolPath: path, endpoint: configuredEndpoint, token });
  } catch (e) {
    console.error(`ship failed before it could report: ${e instanceof Error ? e.name : 'unknown error'}`);
    return {
      shipped: 0, skippedUnparseable: 0, filesShipped: 0, filesRetained: 1, filesDropped: 0,
      failures: [{ kind: 'spool', op: 'rotate', code: 'other' }], backlog: 0, oldestPendingAtMs: null,
    };
  }
}

const primary = await shipSafely(spoolPath);

/**
 * Drain the pre-sdlc/034 location when $XDG_CACHE_HOME moved the spool.
 *
 * A lost `usage.json` costs one refetch; a lost spool costs measurements of runs that already
 * happened and exist nowhere else. `ship()` holds no module-level state and no lock file — it keys
 * entirely off `opts.spoolPath` — so calling it twice in one process is safe. Verified, not assumed.
 */
const legacyPath = getLegacySpoolPath();
let result = primary;
let drained = false;
// realpath, not a string compare. Two different strings can name the same file — sdlc/034's
// security pass set XDG_CACHE_HOME to a symlink resolving to $HOME/.cache and watched the same
// event POST twice in one run. `ship()` is at-least-once so a duplicate is tolerable, but shipping
// a file twice in a single invocation is a bug, not a retry.
if (!sameFile(legacyPath, spoolPath) && shouldDrainLegacy(legacyPath)) {
  drained = true;
  result = combineResults(primary, await shipSafely(legacyPath));
}

console.log(
  `shipped ${result.shipped} events from ${result.filesShipped} file(s)` +
  `${drained ? ' (including a legacy spool)' : ''}; ` +
  `retained ${result.filesRetained}, dropped ${result.filesDropped}, ` +
  `skipped ${result.skippedUnparseable} unparseable line(s)`,
);

// WHY, not just how many. Before sdlc/036 the line above was the entire diagnostic surface, and a
// permanent 404 from a misconfigured base URL printed identically to a service down for thirty
// seconds.
for (const { text, count } of summariseFailures(result.failures)) {
  console.log(`  retained: ${count > 1 ? `${count} × ` : ''}${text}`);
}

if (result.backlog > 0) {
  const age = result.oldestPendingAtMs === null ? 'unknown age' : `oldest ${formatAge(Date.now() - result.oldestPendingAtMs)} old`;
  console.log(
    `  backlog: ${result.backlog} file(s), ${age}. Cap is ${MAX_RETAINED_SHIPPING_FILES}; ` +
    'at the cap each run deletes the oldest.',
  );
}

if (result.filesDropped > 0) {
  // UNCONDITIONAL, and the reason it is unconditional is worth keeping.
  //
  // The Stage 2 review found this sentence false in the recovery case — measured `filesDropped=1`
  // with `backlog=0`, so it announced continuous loss at the moment the outage cleared — and the fix
  // looked like making it conditional on the post-run backlog. Then the prune moved AFTER the
  // delivery loop (C2), and that recovery case stopped existing: a healthy run now delivers
  // everything and drops nothing. Measured after the reorder: 25 pending against a failing endpoint
  // gives `dropped=5, backlog=20`; 45 pending against a healthy one gives `shipped=45, dropped=0`.
  //
  // So `filesDropped > 0` now implies the backlog is AT THE CAP, the conditional's other branch is
  // unreachable, and a branch no test can distinguish from its absence gets deleted rather than kept
  // as documentation (sdlc/035 M1). `dropCanOnlyHappenAtTheCap` asserts the implication, so this
  // sentence is backed by a check rather than by my reading of the ordering.
  // States the backlog it MEASURED rather than asserting the cap. The Stage 5 audit found two ways
  // the cap claim can be false while `filesDropped > 0`: `pendingShippingFiles` swallows a readdir
  // error and returns `[]`, so a spool directory that vanishes mid-run reports `backlog: 0`; and
  // `combineResults` sums two capped spools, which can report 40 above a sentence claiming 20. Both
  // are narrow, and both are the same shape as the defect this loop exists to remove — a value that
  // means "I could not tell" printed as if it meant "zero".
  console.error(
    `  DATA LOST: ${result.filesDropped} spool file(s) deleted, and they exist nowhere else. ` +
    `Backlog is now ${result.backlog} file(s); the cap is ${MAX_RETAINED_SHIPPING_FILES} per spool ` +
    'and every run at the cap deletes the oldest.',
  );
}
// The COMBINED result. Exiting on `primary` alone would report success to systemd forever while a
// failing legacy drain accumulated toward the 20-file drop.
process.exit(result.filesRetained > 0 ? 1 : 0);
