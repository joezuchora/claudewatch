import type { FetchResult } from './types.js';

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

export async function fetchUsage(token: string): Promise<FetchResult> {
  let lastError: FetchResult | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await delay(RETRY_DELAY_MS);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const result = await singleFetch(token, controller.signal);
      clearTimeout(timeout);

      // Don't retry auth errors or rate limits — they won't resolve on retry
      if (!result.ok && (result.failureClass === 'authInvalid' || result.status === 429)) {
        return result;
      }

      if (result.ok) {
        return result;
      }

      lastError = result;
    } catch (err) {
      clearTimeout(timeout);
      const message = err instanceof Error ? err.message : 'Unknown network error';
      lastError = { ok: false, status: null, failureClass: 'serviceUnavailable', message };
    }
  }

  return lastError!;
}
