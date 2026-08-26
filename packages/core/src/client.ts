import type { FailureClass, FetchResult } from './types.js';
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
    const data: unknown = await response.json();
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

    try {
      const result = await singleFetch(token, controller.signal);
      clearTimeout(timeout);
      fetchedMs += Date.now() - attemptStarted;

      // Don't retry auth errors or rate limits — they won't resolve on retry.
      //
      // The two halves cannot merge. `retryable` is a property of the CLASS, and 429 and 5xx
      // are the same class (`serviceUnavailable`) with opposite answers: a rate limit will not
      // clear in 2 s, a server error might. Deriving retry from the class alone would start
      // retrying every 429; deriving it from the status alone would lose `notConfigured`.
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
    } catch (err) {
      clearTimeout(timeout);
      fetchedMs += Date.now() - attemptStarted;
      const message = err instanceof Error ? err.message : 'Unknown network error';
      lastError = {
        ok: false,
        status: null,
        failureClass: timedOut ? 'timeout' : 'serviceUnavailable',
        message,
      };
    }
  }

  return report(lastError!);
}
