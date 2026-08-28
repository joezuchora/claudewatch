import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import type { CacheEnvelope, SurfaceableMessage } from './types.js';
import { emitProcess, cacheEvent } from './telemetry.js';
import { isFailureClass, COOLDOWN_DURATION_MS } from './cooldown.js';
// Mirrors the isFailureClass import above: the module that OWNS a policy also owns its predicate.
// No cycle THROUGH client.ts — it does not import cache.ts. It does import telemetry.ts, which
// imports getCacheDir from here, so cache -> client -> telemetry -> cache is a cycle; but that
// arm is the pre-existing cache <-> telemetry cycle, unchanged by this edge. Benign because
// everything crossing it is a hoisted function declaration. A module-level `const` added to
// client.ts and read at cache.ts load time would TDZ. (sdlc/030 security pass, finding 4.)
import { isSurfaceableMessage } from './client.js';
// A leaf module with no runtime imports, so this edge cannot close a cycle — unlike an import of
// `normalize.ts`, which reaches back here through `telemetry.ts`. See closed-sets.ts's header.
import {
  UNKNOWN_FETCHED_AT, isStaleReason, isNormalizationWarning,
} from './closed-sets.js';

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
 * Everything that survives is CANONICALISED — the return value is always a string this function
 * constructed, never the one it read. See the comment on the return statement for the §12 leak
 * that made the difference matter.
 *
 * `now` is injectable for the reason sdlc/019 made `isCacheFresh`'s injectable: a clamp test
 * that reads ambient time can only assert the side it has slack on.
 */
export function sanitizeCooldownUntil(value: unknown, now: number = Date.now()): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const ceiling = now + COOLDOWN_DURATION_MS;
  // CANONICALISED, never echoed. Returning `value` verbatim on the in-range path was a §12 leak
  // found by sdlc/030's security pass: `Date.parse` accepts far more than ISO-8601, and the
  // legacy parser ignores parenthesised trailing text entirely. `Date.parse('2026-01-01
  // (/home/someone/.claude sk-ant-…)')` is finite and below the ceiling, so the whole string —
  // path, hostname and all — was returned and printed by `--debug` (main.ts:140, :168). The clamp
  // branch already returned a constructed ISO string; only the passthrough echoed its input.
  // Every consumer reads this through `new Date(...)`, so canonicalising costs nothing.
  return new Date(Math.min(ms, ceiling)).toISOString();
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

  // `fetchedAt` USED to be checked here, and a non-string one deleted the whole envelope — taking
  // the live `cooldownUntil` with it, which is §9.4's only throttle on token-bearing requests.
  // sdlc/031 measured that: `cooldownActive: false` and `usage.json` gone. It moved below, where a
  // sentinel exists to degrade to.
  //
  // What is left rejects because there is nothing coherent to substitute. That is the line — not
  // "shape rejects, value degrades", which was a taxonomy this loop's own draft used to excuse the
  // hazard above. **These paths keep their §9.4 exposure**: a structurally broken envelope still
  // discards the cooldown. Named, not closed; closing it needs the cooldown stored separably from
  // the snapshot. See sdlc/031's spec.
  if (
    !parsed.snapshot ||
    typeof parsed.snapshot !== 'object' ||
    !parsed.snapshot.display ||
    !parsed.snapshot.freshness
  ) {
    tryDelete(path);
    emitProcess(cacheEvent({ outcome: 'invalidShape' }));
    return { envelope: null, reason: 'invalidShape' };
  }

  // Seven fields are VALIDATED below. All are degraded rather than rejected: discarding a good
  // snapshot would cost a live token-bearing fetch on every read, and delete the cooldown that
  // throttles one.
  //
  // **This does not make the envelope fully validated, and saying so was a defect in sdlc/031's own
  // draft.** `--json` (main.ts:241, :256 -> :371) serialises the WHOLE snapshot, so
  // `source.usageEndpoint`, `authState`, `tier`, `display.*` and every window field still reach
  // stdout verbatim. That surface was missed for a structural reason worth remembering: a search
  // for readers of a field BY NAME cannot find a caller that stringifies the whole object. The
  // question is what gets serialised, not what gets read. Snapshot-level validation is sdlc/032.

  // `lastErrorClass` is defence in depth, not a closed hole. No consumer passes it to
  // `failurePolicy` today — it is copied into new envelopes and printed by `--debug`, nothing
  // more — so the `throw` there is not currently reachable from a cache file. It is checked
  // here so that the day someone does branch on it, the check already exists. Claiming more
  // than that was a review finding against this very change (sdlc/014).
  if (parsed.lastErrorClass !== null && !isFailureClass(parsed.lastErrorClass)) {
    parsed = { ...parsed, lastErrorClass: null };
  }

  // `lastErrorMessage` is printed by `--debug` (main.ts:140, :168) and rendered in the VS Code
  // tooltip. Before sdlc/030 those sites read it straight off the envelope, so a cache file written
  // before sdlc/029 — when the network path assigned `err.message` verbatim — still surfaced free
  // text. Validating HERE fixes every consumer at once, including the two that never call
  // `extractLastError`. SPEC.md §12 already claimed this check ran "at the cache-read boundary";
  // this is the commit that makes that sentence true.
  if (parsed.lastErrorMessage !== null && !isSurfaceableMessage(parsed.lastErrorMessage)) {
    parsed = { ...parsed, lastErrorMessage: null };
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
  // Nulled on garbage (fail open, one fetch, then a real cooldown is written), clamped on
  // magnitude (fail closed, never longer than the backoff we would have set ourselves), and
  // canonicalised so the string that comes out is one we constructed rather than one we read.
  // `fetchedAt` reaches `--debug` as `lastFetchedAt` and `--json` as part of the whole snapshot.
  // Canonicalised when it parses (the `cooldownUntil` rule, for the same reason: `Date.parse`
  // accepts far more than ISO-8601 and its legacy parser ignores parenthesised trailing text), and
  // replaced with a sentinel when it does not — including when it is not a string at all, which is
  // the case that used to delete the cache.
  //
  // NOT clamped, unlike `cooldownUntil`: the hazards are opposite. A far-future cooldown suppresses
  // fetches forever; a far-future `fetchedAt` suppresses one and is exactly what `detectClockSkew`
  // reports. Clamping would delete that signal.
  {
    const rawFetchedAt = parsed.snapshot.fetchedAt;
    const ms = typeof rawFetchedAt === 'string' ? Date.parse(rawFetchedAt) : NaN;
    const fetchedAt = Number.isFinite(ms) ? new Date(ms).toISOString() : UNKNOWN_FETCHED_AT;
    if (fetchedAt !== rawFetchedAt) {
      parsed = { ...parsed, snapshot: { ...parsed.snapshot, fetchedAt } };
    }
  }

  // `freshness` is emitted whole by `printDebug` (main.ts:145), so both its fields are surfaces.
  //
  // `staleReason` falls back to `'none'` because that changes NO observable classification: every
  // consumer tests for a specific reason, so an unknown string and `'none'` take identical branches
  // at all five sites (state.ts:30,43,49, main.ts:250, extension.ts:175). Measured before the
  // change and recorded in sdlc/031's plan.md, with positive controls showing the classifier does
  // distinguish real members. `isStale` is left alone when it is a boolean: inventing a cause for a
  // staleness we cannot explain is worse than recording none.
  {
    const f = parsed.snapshot.freshness;
    const staleReason = isStaleReason(f.staleReason) ? f.staleReason : 'none';
    const isStale = typeof f.isStale === 'boolean' ? f.isStale : false;
    if (staleReason !== f.staleReason || isStale !== f.isStale) {
      parsed = { ...parsed, snapshot: { ...parsed.snapshot, freshness: { isStale, staleReason } } };
    }
  }

  // `normalizationWarnings` is printed by `--debug` and serialised by `--json`. Filtered rather than
  // emptied, so a poisoned entry costs only itself: a real warning beside it survives, which is the
  // whole value of the field on the path where it appears.
  {
    const w: unknown = parsed.snapshot.rawMetadata?.normalizationWarnings;
    const kept = Array.isArray(w) ? w.filter(isNormalizationWarning) : [];
    if (!Array.isArray(w) || kept.length !== w.length) {
      parsed = {
        ...parsed,
        snapshot: { ...parsed.snapshot, rawMetadata: { normalizationWarnings: kept } },
      };
    }
  }

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
  lastErrorMessage: SurfaceableMessage | null = null,
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
