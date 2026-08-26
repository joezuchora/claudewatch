import type { FetchResult } from './types.js';
import { emitProcess, fetchResultEvent } from './telemetry.js';
import type { StatusClass } from './telemetry.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = 2000;
const MAX_RETRIES = 1;

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

/** Map a result onto the closed status-class enumeration telemetry payloads accept. */
function statusClassOf(result: FetchResult): StatusClass {
  // A status-less failure is either our own 5s timeout or an unreachable endpoint. sdlc/010
  // made those distinguishable via an abort flag rather than message parsing, which is what
  // finally makes StatusClass's 'timeout' reachable instead of decorative.
  if (result.status === null) {
    return result.failureClass === 'timeout' ? 'timeout' : 'network';
  }
  if (result.status >= 500) return '5xx';
  if (result.status >= 400) return '4xx';
  return '2xx';
}

export async function fetchUsage(token: string): Promise<FetchResult> {
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

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await delay(RETRY_DELAY_MS);
    }
    attempts++;
    const attemptStarted = Date.now();

    const controller = new AbortController();
    // The timeout callback is the ONLY code that knows a timeout happened. Reading it from a
    // flag beats parsing err.message, which varies by platform and Bun version and is exactly
    // the free text the telemetry allowlist exists to keep out (sdlc/007, sdlc/010).
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);

    try {
      const result = await singleFetch(token, controller.signal);
      clearTimeout(timeout);
      fetchedMs += Date.now() - attemptStarted;

      // Don't retry auth errors or rate limits — they won't resolve on retry
      if (!result.ok && (result.failureClass === 'authInvalid' || result.status === 429)) {
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
