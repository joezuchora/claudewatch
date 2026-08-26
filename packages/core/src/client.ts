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
  // 'network' covers every status-less failure, including the 5s timeout. FailureClass has
  // no 'timeout' member (types.ts), so a timeout and a DNS failure are indistinguishable
  // here without parsing the error message — and error messages are exactly the free text
  // that must never reach a payload. StatusClass's 'timeout' is therefore currently
  // unreachable from this call site; recorded in sdlc/007's review rather than faked.
  if (result.status === null) return 'network';
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
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

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
      lastError = { ok: false, status: null, failureClass: 'serviceUnavailable', message };
    }
  }

  return report(lastError!);
}
