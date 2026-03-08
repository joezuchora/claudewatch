import {
  readCache,
  writeCache,
  isCacheFresh,
  makeCacheEnvelope,
  getCachePath,
  isInCooldown,
  enterCooldown,
  clearCooldown,
  shouldCooldown,
  resolveCredentials,
  getCredentialPath,
  fetchUsage,
  normalize,
  classify,
  formatStatusLine,
  formatRichStatusLine,
  markStale,
  makeErrorSnapshot,
  type UsageSnapshot,
  type CacheEnvelope,
  type SessionInfo,
} from '@claudewatch/core';

const VERSION = '0.1.0';

// --- CLI flag parsing ---

export interface CliFlags {
  version: boolean;
  json: boolean;
  refresh: boolean;
  debug: boolean;
}

export function parseFlags(args: string[]): CliFlags {
  return {
    version: args.includes('--version'),
    json: args.includes('--json'),
    refresh: args.includes('--refresh'),
    debug: args.includes('--debug'),
  };
}

// --- Terminal width ---

export function getTerminalWidth(): number {
  return process.stdout.columns || 80;
}

// --- Parse and validate session JSON ---

export function parseSessionInfo(raw: string): SessionInfo | null {
  try {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as SessionInfo;
  } catch {
    return null;
  }
}

// --- Read session info from stdin (Claude Code pipes JSON) ---

function readStdin(): SessionInfo | null {
  try {
    // stdin is piped by Claude Code with session JSON
    if (process.stdin.isTTY) return null;
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(4096);
    const fd = process.stdin.fd;
    try {
      let bytesRead: number;
      do {
        bytesRead = require('fs').readSync(fd, buf, 0, buf.length, null);
        if (bytesRead > 0) chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
      } while (bytesRead > 0);
    } catch {
      // EOF or read error
    }
    if (chunks.length === 0) return null;
    const raw = Buffer.concat(chunks).toString('utf-8');
    return parseSessionInfo(raw);
  } catch {
    return null;
  }
}

// --- Debug output ---

function printDebug(cache: CacheEnvelope | null): void {
  const info: Record<string, unknown> = {
    credentialPath: getCredentialPath(),
    cachePath: getCachePath(),
    terminalWidth: getTerminalWidth(),
  };

  if (cache) {
    const fetchedAt = new Date(cache.snapshot.fetchedAt);
    const ageMs = Date.now() - fetchedAt.getTime();
    const ageSec = Math.round(ageMs / 1000);

    info.lastFetchedAt = cache.snapshot.fetchedAt;
    info.cacheAgeSec = ageSec;
    info.stateClassification = classify(cache.snapshot);
    info.cooldownActive = isInCooldown(cache);
    info.cooldownUntil = cache.cooldownUntil;
    info.lastErrorClass = cache.lastErrorClass;
    info.lastHttpStatus = cache.lastHttpStatus;
    info.lastErrorMessage = cache.lastErrorMessage;
    info.normalizationWarnings = cache.snapshot.rawMetadata.normalizationWarnings;
    info.freshness = cache.snapshot.freshness;
  } else {
    info.cacheAgeSec = null;
    info.stateClassification = 'Initializing';
    info.cooldownActive = false;
  }

  console.log(JSON.stringify(info, null, 2));
}

// --- Main ---

export async function main(): Promise<never> {
  const flags = parseFlags(process.argv.slice(2));

  // --version
  if (flags.version) {
    console.log(`claudewatch ${VERSION}`);
    return process.exit(0);
  }

  // Read session info from stdin (Claude Code pipes JSON)
  const session = readStdin();

  // Read cache (handles corruption: deletes and returns null)
  let cache = readCache();

  // --debug
  if (flags.debug) {
    printDebug(cache);
    return process.exit(0);
  }

  // If cache is fresh and not --refresh → output and exit
  if (cache && isCacheFresh(cache) && !flags.refresh) {
    output(cache.snapshot, flags, session);
    return process.exit(0);
  }

  // If in cooldown → output stale and exit (--refresh still respects cooldown)
  if (cache && isInCooldown(cache)) {
    const stale = markStale(cache.snapshot, 'fetchFailed');
    if (
      !cache.snapshot.freshness.isStale ||
      cache.snapshot.freshness.staleReason !== 'fetchFailed'
    ) {
      writeCache(
        makeCacheEnvelope(stale, cache.cooldownUntil, cache.lastErrorClass)
      );
    }
    output(stale, flags, session);
    return process.exit(0);
  }

  // Resolve credentials
  const creds = resolveCredentials();

  if (creds.authState === 'missing' || !creds.accessToken) {
    if (flags.json) {
      const snapshot = makeErrorSnapshot('missing');
      console.log(JSON.stringify(snapshot, null, 2));
    } else {
      console.log('⊙ no credentials');
    }
    return process.exit(2);
  }

  if (creds.authState === 'invalid') {
    if (flags.json) {
      const snapshot = makeErrorSnapshot('invalid');
      console.log(JSON.stringify(snapshot, null, 2));
    } else {
      console.log('⊙ auth expired');
    }
    return process.exit(2);
  }

  // Fetch usage
  const result = await fetchUsage(creds.accessToken);

  if (result.ok) {
    // Normalize → write cache → output
    const snapshot = normalize(result.data);
    const envelope = clearCooldown(makeCacheEnvelope(snapshot));
    writeCache(envelope);
    output(snapshot, flags, session);
    return process.exit(0);
  }

  // Fetch failed
  const { failureClass } = result;

  // If we have stale cache data, show it
  if (cache && cache.snapshot.display.primaryUtilizationPct !== null) {
    const stale = markStale(cache.snapshot, 'fetchFailed');
    let envelope = makeCacheEnvelope(
      stale,
      cache.cooldownUntil,
      cache.lastErrorClass
    );
    if (shouldCooldown(failureClass)) {
      envelope = enterCooldown(envelope, failureClass, result.status, result.message);
    }
    writeCache(envelope);
    output(stale, flags, session);
    return process.exit(0);
  }

  // Enter cooldown if appropriate
  if (cache && shouldCooldown(failureClass)) {
    const cooledDown = enterCooldown(cache, failureClass, result.status, result.message);
    writeCache(cooledDown);
  } else if (!cache && shouldCooldown(failureClass)) {
    // No cache — create a minimal envelope for cooldown tracking
    const minimalEnvelope = makeCacheEnvelope(makeErrorSnapshot('unknown'));
    const cooledDown = enterCooldown(minimalEnvelope, failureClass, result.status, result.message);
    writeCache(cooledDown);
  }

  // Auth failure
  if (failureClass === 'authInvalid') {
    if (flags.json) {
      const snapshot = makeErrorSnapshot('invalid');
      console.log(JSON.stringify(snapshot, null, 2));
    } else {
      console.log('⊙ auth invalid');
    }
    return process.exit(2);
  }

  // No cache, fetch failed
  if (flags.json) {
    const snapshot = makeErrorSnapshot('unknown');
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    console.log('⊙ error');
  }
  return process.exit(1);
}

// --- Output helper ---

function output(snapshot: UsageSnapshot, flags: CliFlags, session: SessionInfo | null = null): void {
  if (flags.json) {
    console.log(JSON.stringify(snapshot, null, 2));
  } else if (session) {
    console.log(formatRichStatusLine(snapshot, session));
  } else {
    console.log(formatStatusLine(snapshot, getTerminalWidth()));
  }
}

// --- Run with top-level error catch ---

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[claudewatch] fatal: ${err instanceof Error ? err.message : String(err)}`);
    console.log('⊙ error');
    process.exit(3);
  });
}
