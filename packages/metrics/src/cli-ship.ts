#!/usr/bin/env bun
/** Ship spooled product telemetry to the metrics service. Run from a timer, or by verify. */
import { basename, dirname } from 'path';
import { realpathSync } from 'fs';
import { combineResults, ship, shouldDrainLegacy } from './agent.js';
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
const primary = await ship({ spoolPath, endpoint, token });

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
  result = combineResults(primary, await ship({ spoolPath: legacyPath, endpoint, token }));
}

console.log(
  `shipped ${result.shipped} events from ${result.filesShipped} file(s)` +
  `${drained ? ' (including a legacy spool)' : ''}; ` +
  `retained ${result.filesRetained}, dropped ${result.filesDropped}, ` +
  `skipped ${result.skippedUnparseable} unparseable line(s)`,
);
// The COMBINED result. Exiting on `primary` alone would report success to systemd forever while a
// failing legacy drain accumulated toward the 20-file drop.
process.exit(result.filesRetained > 0 ? 1 : 0);
