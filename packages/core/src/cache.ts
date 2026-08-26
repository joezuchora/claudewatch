import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import type { CacheEnvelope } from './types.js';
import { emitProcess, cacheEvent } from './telemetry.js';
import { isFailureClass, COOLDOWN_DURATION_MS } from './cooldown.js';

// Bumped to 2 when UsageSnapshot gained sevenDayOpus (sdlc/002-opus-window). A v1 envelope
// deserializes into a snapshot missing that field, so it is discarded and refetched rather
// than rendered from a shape the type system believes is complete.
const CACHE_VERSION = 2;

let cacheBaseDir: string | null = null;

/**
 * Override the cache directory root (e.g. for test isolation).
 * Pass null to reset to the default (~/.cache/claudewatch).
 */
export function setCacheBaseDir(dir: string | null): void {
  cacheBaseDir = dir;
}

export function getCacheDir(): string {
  if (cacheBaseDir !== null) return cacheBaseDir;
  return join(homedir(), '.cache', 'claudewatch');
}

export function getCachePath(): string {
  return join(getCacheDir(), 'usage.json');
}

/**
 * Why a cache read produced no envelope.
 *
 * readCache() returns null for four distinct situations and deletes the file first, so no
 * caller could ever tell them apart. That made cache health unobservable — a version
 * mismatch (the interesting case after loop 002 bumped CACHE_VERSION to 2) looked identical
 * to a cold start. See sdlc/003-metrics-telemetry.
 */
export type CacheReadReason =
  | 'hit'
  | 'miss'
  | 'corruptJson'
  | 'versionMismatch'
  | 'invalidShape';

export interface CacheReadResult {
  envelope: CacheEnvelope | null;
  reason: CacheReadReason;
}

/**
 * Bring a `cooldownUntil` read off disk into the range `isInCooldown` can reason about.
 *
 * Garbage (a non-string, or a string `Date.parse` rejects) becomes `null`: no cooldown, one
 * fetch, and the next failure writes a real one. Failing open is right here because failing
 * closed on an unparseable value would let a corrupt byte wedge the tool permanently.
 *
 * A value beyond one full cooldown from now is clamped down to that ceiling. Failing closed is
 * right there for the mirror reason: `8.64e15` would otherwise pin the tool on stale data
 * forever, and no honest writer of this file ever sets a longer backoff than we do.
 *
 * `now` is injectable for the reason sdlc/019 made `isCacheFresh`'s injectable: a clamp test
 * that reads ambient time can only assert the side it has slack on.
 */
export function sanitizeCooldownUntil(value: unknown, now: number = Date.now()): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const ceiling = now + COOLDOWN_DURATION_MS;
  return ms > ceiling ? new Date(ceiling).toISOString() : value;
}

export function readCacheResult(): CacheReadResult {
  const path = getCachePath();

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    emitProcess(cacheEvent({ outcome: 'miss' }));
    return { envelope: null, reason: 'miss' };
  }

  let parsed: CacheEnvelope;
  try {
    parsed = JSON.parse(raw) as CacheEnvelope;
  } catch {
    // Corrupt JSON — delete and treat as a miss so we never get a stuck failure loop.
    tryDelete(path);
    emitProcess(cacheEvent({ outcome: 'corruptJson' }));
    return { envelope: null, reason: 'corruptJson' };
  }

  // `JSON.parse` returns any JSON value, not necessarily an object. A cache file containing
  // the literal `null` (or `4`, or `[]`) survives the parse and then throws TypeError on
  // `parsed.version` below — out of readCacheResult, out of main(), into the top-level catch,
  // and the file is never deleted. Every subsequent invocation repeats it: exit 3 forever.
  // That is precisely the stuck failure loop SPEC.md §9 exists to prevent, and the `as`
  // assertion above is what hid it. Found by the sdlc/014 security pass.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    tryDelete(path);
    emitProcess(cacheEvent({ outcome: 'corruptJson' }));
    return { envelope: null, reason: 'corruptJson' };
  }

  if (parsed.version !== CACHE_VERSION) {
    tryDelete(path);
    emitProcess(cacheEvent({ outcome: 'versionMismatch' }));
    return { envelope: null, reason: 'versionMismatch' };
  }

  if (
    !parsed.snapshot ||
    typeof parsed.snapshot !== 'object' ||
    typeof parsed.snapshot.fetchedAt !== 'string' ||
    !parsed.snapshot.display ||
    !parsed.snapshot.freshness
  ) {
    tryDelete(path);
    emitProcess(cacheEvent({ outcome: 'invalidShape' }));
    return { envelope: null, reason: 'invalidShape' };
  }

  // Two fields cross the `as CacheEnvelope` assertion unchecked. Both are nulled rather than
  // rejected: neither says anything about the snapshot beside it, and discarding a good
  // snapshot would cost a live token-bearing fetch on every read.

  // `lastErrorClass` is defence in depth, not a closed hole. No consumer passes it to
  // `failurePolicy` today — it is copied into new envelopes and printed by `--debug`, nothing
  // more — so the `throw` there is not currently reachable from a cache file. It is checked
  // here so that the day someone does branch on it, the check already exists. Claiming more
  // than that was a review finding against this very change (sdlc/014).
  if (parsed.lastErrorClass !== null && !isFailureClass(parsed.lastErrorClass)) {
    parsed = { ...parsed, lastErrorClass: null };
  }

  // `cooldownUntil` is the live one, and it guards a security property: the 5-minute backoff
  // is the ONLY throttle on token-bearing requests (SPEC.md §9.4).
  //
  // `isInCooldown` does `Date.now() < new Date(cooldownUntil).getTime()`. An unparseable
  // string gives NaN, every comparison against NaN is false, and the cooldown is silently
  // released — so a corrupt byte in this field turns into a fresh authenticated request on
  // every single prompt render. A far-future value wedges the opposite way, pinning the tool
  // on stale data indefinitely.
  //
  // Nulled on garbage (fail open, one fetch, then a real cooldown is written), and clamped on
  // magnitude (fail closed, never longer than the backoff we would have set ourselves).
  parsed = { ...parsed, cooldownUntil: sanitizeCooldownUntil(parsed.cooldownUntil) };

  return { envelope: parsed, reason: 'hit' };
}

/** Unchanged behaviour, kept so no existing call site has to change. */
export function readCache(): CacheEnvelope | null {
  return readCacheResult().envelope;
}

export function writeCache(envelope: CacheEnvelope): void {
  const path = getCachePath();
  const dir = dirname(path);

  // Create directory if it doesn't exist
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Atomic write: write to temp file, then rename
  const tempPath = join(dir, `.usage-${randomBytes(4).toString('hex')}.tmp`);
  const json = JSON.stringify(envelope, null, 2);

  writeFileSync(tempPath, json, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tempPath, path);
}

/**
 * `now` is a defaulted parameter, not an ambient read, for the same reason `sdlc/011` made
 * fetch timings injectable: time is a property of a CALL, not of the process.
 *
 * With `Date.now()` read inside, a boundary test could only assert the side it had slack on —
 * `age < ttl` computed at assertion time includes however long the test itself took. One such
 * test gave itself a 1 ms budget and went red on a slow container (sdlc/019). Passing `now`
 * makes the boundary exact from both sides, which is the part that was untestable before.
 *
 * Every production caller passes one or two arguments and gets ambient time, unchanged.
 */
export function isCacheFresh(
  envelope: CacheEnvelope,
  ttlSeconds: number = 600,
  now: number = Date.now(),
): boolean {
  const fetchedAt = new Date(envelope.snapshot.fetchedAt).getTime();
  const age = now - fetchedAt;
  return age < ttlSeconds * 1000;
}

export function makeCacheEnvelope(
  snapshot: CacheEnvelope['snapshot'],
  cooldownUntil: string | null = null,
  lastErrorClass: CacheEnvelope['lastErrorClass'] = null,
  lastHttpStatus: number | null = null,
  lastErrorMessage: string | null = null,
): CacheEnvelope {
  return {
    version: CACHE_VERSION,
    snapshot,
    cooldownUntil,
    lastErrorClass,
    lastHttpStatus,
    lastErrorMessage,
  };
}

function tryDelete(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Ignore — file may already be gone
  }
}
