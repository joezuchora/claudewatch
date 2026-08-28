import type { FailureClass, FetchResult, SurfaceableMessage } from './types.js';
import { failurePolicy } from './cooldown.js';
import { emitProcess, fetchResultEvent } from './telemetry.js';
import type { StatusClass } from './telemetry.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/**
 * Production timings (SPEC.md §3.1, §9.3). Exported so a test asserting production behaviour
 * references the real value instead of duplicating a literal that drifts silently.
 */
export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_RETRY_DELAY_MS = 2000;
export const DEFAULT_MAX_RETRIES = 1;

/**
 * Per-call timing overrides.
 *
 * Deliberately a parameter, not a module setter. Timing is a property of a CALL, not of a
 * process — a global setter would leak one test's override into another's expectations, and
 * this repository has already lost a loop to process-wide test state (sdlc/001: Bun's
 * mock.module is global and non-restorable). Introducing a second instance of that shape
 * voluntarily would be hard to defend.
 */
export interface FetchOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
  maxRetries?: number;
}

export interface ResolvedTiming {
  timeoutMs: number;
  retryDelayMs: number;
  maxRetries: number;
}

/**
 * A zero or negative timeout would abort every request instantly, which no caller means.
 * Non-finite input falls back rather than reaching a timer: setTimeout coerces NaN to 0, so an
 * unguarded NaN is a zero timeout wearing a disguise.
 */
function positiveAtMost(value: unknown, ceiling: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, ceiling)
    : ceiling;
}

/** Zero IS meaningful for a delay or a retry count — it is exactly what a test asks for. */
function nonNegativeAtMost(value: unknown, ceiling: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(value, ceiling)
    : ceiling;
}

/**
 * Resolve per-call overrides against the production defaults.
 *
 * Overrides may only make timing **tighter**, never looser — the defaults are ceilings, not
 * suggestions. SPEC.md §3.1 and §11.7 call the 5 s timeout a hard kill, and §9.3 allows a single retry;
 * a caller able to raise either could hold a credential-bearing request open far past that
 * ceiling, or turn the retry loop into a flood of authenticated requests. Every override this
 * change exists to serve asks for *shorter*, so the ceiling costs it nothing.
 *
 * Exported because it is a pure function of its input: testing it directly covers every
 * boundary instantly, which is rather the point of a loop about not waiting.
 */
export function resolveFetchTiming(options: FetchOptions = {}): ResolvedTiming {
  return {
    timeoutMs: positiveAtMost(options.timeoutMs, DEFAULT_TIMEOUT_MS),
    retryDelayMs: nonNegativeAtMost(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS),
    maxRetries: nonNegativeAtMost(options.maxRetries, DEFAULT_MAX_RETRIES),
  };
}

async function singleFetch(token: string, signal?: AbortSignal): Promise<FetchResult> {
  const response = await fetch(USAGE_URL, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
    },
    signal,
  });

  if (response.status === 200) {
    // `response.json()` gets its own try. Unguarded, a 200 with an unparseable body propagated to
    // fetchUsage's catch and became a status-less `serviceUnavailable` carrying err.message — a
    // SEVENTH failure path, found by sdlc/029's spec review. It is also the only path whose message
    // could be influenced by remote data (the body). `malformedResponse` is the class SPEC.md §7.2
    // already defines for exactly this, and which cooldown.ts noted was never constructed anywhere.
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return { ok: false, status: 200, failureClass: 'malformedResponse', message: 'Malformed response' };
    }
    return { ok: true, status: 200, data };
  }

  if (response.status === 401) {
    return { ok: false, status: 401, failureClass: 'authInvalid', message: 'Authentication failed (401)' };
  }

  if (response.status === 429) {
    return { ok: false, status: 429, failureClass: 'serviceUnavailable', message: 'Rate limited (429)' };
  }

  if (response.status >= 500) {
    return { ok: false, status: response.status, failureClass: 'serviceUnavailable', message: `Server error (${response.status})` };
  }

  return { ok: false, status: response.status, failureClass: 'unexpectedFailure', message: `Unexpected status ${response.status}` };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * How a status-less failure maps onto the telemetry enumeration.
 *
 * A status-less failure is either our own 5s timeout or an unreachable endpoint. sdlc/010
 * made those distinguishable via an abort flag rather than message parsing, which is what
 * finally makes StatusClass's 'timeout' reachable instead of decorative.
 *
 * Exhaustive rather than `=== 'timeout' ? ... : 'network'` so that a new `FailureClass` has to
 * declare which side it lands on. Unlike `failurePolicy` this does NOT throw on an unhandled
 * member: it runs inside telemetry reporting on the return path of every fetch, and losing a
 * successful fetch result to a telemetry mapping would be a worse failure than one mislabelled
 * event. The compile error is the enforcement; 'network' is the degradation. (sdlc/014)
 */
function statusLessClassOf(fc: FailureClass): 'timeout' | 'network' {
  switch (fc) {
    case 'timeout':
      return 'timeout';
    case 'notConfigured':
    case 'authInvalid':
    case 'serviceUnavailable':
    case 'malformedResponse':
    case 'unexpectedFailure':
      return 'network';
  }
  const unhandled: never = fc;
  void unhandled;
  return 'network';
}

/** Map a result onto the closed status-class enumeration telemetry payloads accept. */
function statusClassOf(result: FetchResult): StatusClass {
  if (result.status === null) {
    return statusLessClassOf(result.failureClass);
  }
  if (result.status >= 500) return '5xx';
  if (result.status >= 400) return '4xx';
  return '2xx';
}

/**
 * Is this string one of the messages this repo produces?
 *
 * The type closes the set at the PRODUCER; this closes it at the CONSUMER, where a type cannot
 * reach: `extractLastError` reads `lastErrorMessage` off disk, and a cache file written by an older
 * version may hold free text. Exactly seven literal forms, one per `SurfaceableMessage` member —
 * sdlc/029's mutation table has one row per form, so the shape is load-bearing.
 */
/**
 * OpenSSL verification failures, as a closed set. Reading a CODE and mapping it to one of our own
 * literals adds no free text — which is what makes preserving this signal compatible with §12.
 */
const TLS_FAILURE_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export function isSurfaceableMessage(m: string | null | undefined): m is SurfaceableMessage {
  if (typeof m !== 'string') return false;
  return (
    m === 'Authentication failed (401)' ||
    m === 'Rate limited (429)' ||
    m === 'Network error' ||
    m === 'Request timed out' ||
    m === 'Malformed response' ||
    m === 'TLS verification failed' ||
    /^Server error \(\d+\)$/.test(m) ||
    /^Unexpected status \d+$/.test(m)
  );
}

export async function fetchUsage(
  token: string,
  options: FetchOptions = {},
): Promise<FetchResult> {
  const { timeoutMs, retryDelayMs, maxRetries } = resolveFetchTiming(options);

  let lastError: FetchResult | null = null;

  // Wall-clock spent actually fetching. The 2000ms retry sleep is deliberately excluded so
  // durationMs stays a latency signal rather than a bimodal constant — a p95 that silently
  // includes a fixed 2s tells you nothing about the endpoint. See sdlc/007.
  let fetchedMs = 0;
  let attempts = 0;

  const report = (result: FetchResult): FetchResult => {
    emitProcess(fetchResultEvent({
      ok: result.ok,
      statusClass: statusClassOf(result),
      attempts,
      durationMs: Math.round(fetchedMs),
    }));
    return result;
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await delay(retryDelayMs);
    }
    attempts++;
    const attemptStarted = Date.now();

    const controller = new AbortController();
    // The timeout callback is the ONLY code that knows a timeout happened. Reading it from a
    // flag beats parsing err.message, which varies by platform and Bun version and is exactly
    // the free text the telemetry allowlist exists to keep out (sdlc/007, sdlc/010).
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

    // The `try` covers the network call and NOTHING else.
    //
    // It used to wrap the retry decision too, which meant `failurePolicy`'s deliberate `throw`
    // — the one that exists so a bad value fails loudly — was caught two lines below, relabelled
    // as a synthetic `serviceUnavailable` network error, retried, and then persisted into the
    // cache as `lastErrorMessage`. A guard whose failure is indistinguishable from a flaky
    // network is not a guard. Found by the sdlc/014 security pass; the catch now only sees what
    // it was written for.
    let result: FetchResult;
    try {
      result = await singleFetch(token, controller.signal);
    } catch (err) {
      // Reads `err.code`, NEVER `err.message`. A code is a closed set of OpenSSL identifiers that
      // maps to a literal we choose; a message is free text that varies by platform and Bun
      // version. That distinction is the whole of sdlc/029.
      //
      // Why this exists: B1 collapsed every network failure to 'Network error', and the sdlc/029
      // SECURITY PASS measured that this threw away a real signal. A self-signed cert on a local
      // server gives message "self signed certificate", code DEPTH_ZERO_SELF_SIGNED_CERT — not the
      // "Unable to connect..." string that refused/DNS give. So a TLS INTERCEPTION ATTEMPT had
      // become indistinguishable from a dead link on every surface. `failureClass` does not carry
      // it either: both are `serviceUnavailable`. The spec's "information lost is nil" was wrong.
      clearTimeout(timeout);
      fetchedMs += Date.now() - attemptStarted;
      // A constant, chosen by the same flag that picks failureClass — for the reason the comment
      // above already gives. `err` is deliberately unread: its message is free text, and this is
      // the value that gets persisted to the cache and rendered in the tooltip. Measured on bun
      // 1.3.11: connection-refused/TLS/DNS give "Unable to connect...", a timeout gives "The
      // operation was aborted." (a DOMException, which IS instanceof Error). Both generic today;
      // neither is a property this repo controls. (sdlc/029)
      const code = (err as { code?: unknown } | null)?.code;
      const message: SurfaceableMessage =
        timedOut ? 'Request timed out'
        : (typeof code === 'string' && TLS_FAILURE_CODES.has(code)) ? 'TLS verification failed'
        : 'Network error';
      lastError = {
        ok: false,
        status: null,
        failureClass: timedOut ? 'timeout' : 'serviceUnavailable',
        message,
      };
      continue;
    }

    clearTimeout(timeout);
    fetchedMs += Date.now() - attemptStarted;

    // Don't retry auth errors or rate limits — they won't resolve on retry.
    //
    // The two halves cannot merge. `retryable` is a property of the CLASS, and 429 and 5xx are
    // the same class (`serviceUnavailable`) with opposite answers: a rate limit will not clear
    // in 2 s, a server error might. So deriving retry from the class alone would start retrying
    // every 429 — and deriving it from the status alone would start retrying `authInvalid`,
    // which is a 401 and will never clear. Mutation testing confirmed both directions.
    // (sdlc/014)
    if (
      !result.ok &&
      (!failurePolicy(result.failureClass).retryable || result.status === 429)
    ) {
      return report(result);
    }

    if (result.ok) {
      return report(result);
    }

    lastError = result;
  }

  return report(lastError!);
}
