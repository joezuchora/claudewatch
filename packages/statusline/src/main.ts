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
  failurePolicy,
  resolveCredentials,
  getCredentialPath,
  fetchUsage,
  normalize,
  classify,
  formatStatusLine,
  formatRichStatusLine,
  markStale,
  makeErrorSnapshot,
  resolveTelemetryConfig,
  setTelemetryConfig,
  emit,
  renderEvent,
  utilizationBucket,
  type UsageSnapshot,
  type CacheEnvelope,
  type SessionInfo,
  type FailureClass,
  type FailurePolicy,
} from './core-deps.js';

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

/** Ceiling on the stdin read. */
function stdinTimeoutMs(): number {
  const raw = Number(process.env.CLAUDEWATCH_STDIN_TIMEOUT_MS);
  // 0, negative and unparseable all fall back to the default rather than disabling the
  // bound. An unbounded read is the defect this function exists to prevent.
  return Number.isFinite(raw) && raw > 0 ? raw : 250;
}

/**
 * Read Claude Code's session JSON from stdin, bounded.
 *
 * The descriptor type cannot be used to decide whether reading is safe. libuv creates child
 * stdio pipes as UNIX domain SOCKETS, so the session channel and the descriptor that hung
 * are the same kind of thing — an earlier fix gated on `isFIFO()` and silently rejected the
 * real Claude Code path. `process.stdin.isTTY` is likewise `undefined` rather than `true` for
 * a socket, which is why the original guard never fired. See sdlc/004 and sdlc/005.
 *
 * What actually distinguishes the two cases is time: the session channel delivers
 * immediately, and a descriptor nobody will ever write to delivers nothing. So the read is
 * bounded rather than gated, and a timeout degrades to plain output — which is already a
 * supported state.
 */
async function readStdin(): Promise<SessionInfo | null> {
  try {
    // Cheap and correct where it applies; a terminal never carries session JSON.
    if (process.stdin.isTTY) return null;

    const timeout = new Promise<null>((res) => {
      const t = setTimeout(() => res(null), stdinTimeoutMs());
      // Do not hold the process open for the timer we may not need.
      if (typeof t === 'object' && t !== null && 'unref' in t) {
        (t as unknown as { unref: () => void }).unref();
      }
    });

    const raw = await Promise.race([
      Bun.stdin.text().catch(() => null),
      timeout,
    ]);

    if (raw === null || raw.length === 0) return null;
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

function printLiveDebug(
  cache: CacheEnvelope | null,
  snapshot: UsageSnapshot,
  fetchError?: { failureClass: FailureClass; status: number | null; message: string },
): void {
  const info: Record<string, unknown> = {
    credentialPath: getCredentialPath(),
    cachePath: getCachePath(),
    terminalWidth: getTerminalWidth(),
    lastFetchedAt: snapshot.fetchedAt,
    cacheAgeSec: cache ? Math.round((Date.now() - new Date(cache.snapshot.fetchedAt).getTime()) / 1000) : null,
    stateClassification: classify(snapshot),
    cooldownActive: cache ? isInCooldown(cache) : false,
    cooldownUntil: cache?.cooldownUntil ?? null,
    lastErrorClass: cache?.lastErrorClass ?? null,
    lastHttpStatus: cache?.lastHttpStatus ?? null,
    lastErrorMessage: cache?.lastErrorMessage ?? null,
    normalizationWarnings: snapshot.rawMetadata.normalizationWarnings,
    freshness: snapshot.freshness,
  };

  if (fetchError) {
    info.fetchError = fetchError;
  }

  console.log(JSON.stringify(info, null, 2));
}

// --- Main ---

export async function main(): Promise<never> {
  // The surface owns consent; core never resolves it. See sdlc/007.
  setTelemetryConfig(resolveTelemetryConfig());

  const flags = parseFlags(process.argv.slice(2));

  // --version
  if (flags.version) {
    console.log(`claudewatch ${VERSION}`);
    return process.exit(0);
  }

  // Read session info from stdin (Claude Code pipes JSON)
  const session = await readStdin();

  // Read cache (handles corruption: deletes and returns null)
  let cache = readCache();

  // --debug
  if (flags.debug && !flags.refresh) {
    printDebug(cache);
    return process.exit(0);
  }

  if (flags.debug && flags.refresh) {
    const creds = resolveCredentials();

    if (creds.authState === 'missing' || !creds.accessToken) {
      printLiveDebug(cache, makeErrorSnapshot('missing'));
      return process.exit(2);
    }

    if (creds.authState === 'invalid') {
      printLiveDebug(cache, makeErrorSnapshot('invalid'));
      return process.exit(2);
    }

    const result = await fetchUsage(creds.accessToken);

    if (result.ok) {
      const snapshot = normalize(result.data);
      printLiveDebug(cache, snapshot);
      return process.exit(0);
    }

    const policy = failurePolicy(result.failureClass);
    printLiveDebug(cache, makeErrorSnapshot(policy.presentation), {
      failureClass: result.failureClass,
      status: result.status,
      message: result.message,
    });
    return process.exit(policy.statuslineExitCode);
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

  // Nothing renderable. Presentation and exit code both come from the policy: before sdlc/014
  // they were two independent `=== 'authInvalid'` comparisons, so a new FailureClass could
  // have picked up 'unknown' rendering with an exit code that disagreed with it.
  //
  // The stale-cache branch above returns before reaching here and exits 0 whatever the class
  // says — a rendered number is a success from the caller's point of view (SPEC.md §11.7).
  const policy = failurePolicy(failureClass);
  if (flags.json) {
    console.log(JSON.stringify(makeErrorSnapshot(policy.presentation), null, 2));
  } else {
    console.log(errorLineFor(policy.presentation));
  }
  return process.exit(policy.statuslineExitCode);
}

/**
 * The one-line non-JSON rendering of a failed fetch.
 *
 * Exhaustive over the three presentations rather than an `=== 'invalid'` ternary, for the same
 * reason `failurePolicy` is exhaustive over FailureClass: a fourth presentation must not be
 * able to silently inherit '⊙ error'. The strings match the credential-resolution paths above,
 * which reach the same states without going through a fetch.
 */
function errorLineFor(presentation: FailurePolicy['presentation']): string {
  switch (presentation) {
    case 'invalid':
      return '⊙ auth invalid';
    case 'missing':
      return '⊙ no credentials';
    case 'unknown':
      return '⊙ error';
  }
  const unhandled: never = presentation;
  throw new Error(`unhandled presentation: ${String(unhandled)}`);
}

// --- Output helper ---

function output(snapshot: UsageSnapshot, flags: CliFlags, session: SessionInfo | null = null): void {
  const started = Bun.nanoseconds();

  if (flags.json) {
    console.log(JSON.stringify(snapshot, null, 2));
  } else if (session) {
    console.log(formatRichStatusLine(snapshot, session));
  } else {
    console.log(formatStatusLine(snapshot, getTerminalWidth()));
  }

  // Emitted AFTER the output is written, so telemetry can never delay what the user sees.
  // Disabled by default: resolveTelemetryConfig short-circuits before any filesystem access.
  // The statusline has no settings file of its own, so this resolves from the environment
  // (CLAUDEWATCH_TELEMETRY) or ~/.config/claudewatch/config.json — see sdlc/003.
  emit(
    resolveTelemetryConfig(),
    renderEvent({
      surface: 'statusline',
      runtimeState: classify(snapshot),
      tier: snapshot.tier,
      utilizationBucket: utilizationBucket(snapshot.display.primaryUtilizationPct),
      durationMs: Math.round((Bun.nanoseconds() - started) / 1e6),
    }),
  );
}

// --- Run with top-level error catch ---

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[claudewatch] fatal: ${err instanceof Error ? err.message : String(err)}`);
    console.log('⊙ error');
    process.exit(3);
  });
}
