import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import type { CacheEnvelope } from './types.js';

const CACHE_VERSION = 1;

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

export function readCache(): CacheEnvelope | null {
  const path = getCachePath();

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as CacheEnvelope;
    if (
      parsed.version !== CACHE_VERSION ||
      !parsed.snapshot ||
      typeof parsed.snapshot !== 'object' ||
      typeof parsed.snapshot.fetchedAt !== 'string' ||
      !parsed.snapshot.display ||
      !parsed.snapshot.freshness
    ) {
      // Incompatible version or structurally invalid snapshot — treat as corrupt
      tryDelete(path);
      return null;
    }
    return parsed;
  } catch {
    // Corrupt JSON — delete and treat as miss
    tryDelete(path);
    return null;
  }
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
