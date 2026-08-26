import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import type { CacheEnvelope } from './types.js';
import { emitProcess, cacheEvent } from './telemetry.js';

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

export function isCacheFresh(envelope: CacheEnvelope, ttlSeconds: number = 600): boolean {
  const fetchedAt = new Date(envelope.snapshot.fetchedAt).getTime();
  const age = Date.now() - fetchedAt;
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
