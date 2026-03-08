import type { UsageSnapshot, RawUsageResponse, UsageWindow } from './types.js';


function isRawWindow(val: unknown): val is { utilization: number; resets_at: string | null } {
  if (val === null || val === undefined || typeof val !== 'object') return false;
  const obj = val as Record<string, unknown>;
  return typeof obj.utilization === 'number' && !isNaN(obj.utilization) && isFinite(obj.utilization);
}

function parseWindow(raw: unknown, warnings: string[], name: string): UsageWindow {
  if (!isRawWindow(raw)) {
    return { utilizationPct: null, resetsAt: null };
  }

  const utilizationPct = raw.utilization;

  let resetsAt: string | null = null;
  if (typeof raw.resets_at === 'string' && raw.resets_at.length > 0) {
    const parsed = new Date(raw.resets_at);
    if (isNaN(parsed.getTime())) {
      warnings.push(`${name}.resets_at is not a valid ISO timestamp`);
    } else {
      resetsAt = parsed.toISOString();
    }
  }

  return { utilizationPct, resetsAt };
}

function computePrimaryDisplay(fiveHour: UsageWindow, sevenDay: UsageWindow): UsageSnapshot['display'] {
  const fiveValid = fiveHour.utilizationPct !== null;
  const sevenValid = sevenDay.utilizationPct !== null;

  if (!fiveValid && !sevenValid) {
    return { primaryWindow: 'unknown', primaryUtilizationPct: null, primaryResetsAt: null };
  }

  if (fiveValid && !sevenValid) {
    return { primaryWindow: 'fiveHour', primaryUtilizationPct: fiveHour.utilizationPct, primaryResetsAt: fiveHour.resetsAt };
  }

  if (!fiveValid && sevenValid) {
    return { primaryWindow: 'sevenDay', primaryUtilizationPct: sevenDay.utilizationPct, primaryResetsAt: sevenDay.resetsAt };
  }

  // Both valid — primary is the higher utilization (more constrained)
  if (fiveHour.utilizationPct! >= sevenDay.utilizationPct!) {
    return { primaryWindow: 'fiveHour', primaryUtilizationPct: fiveHour.utilizationPct, primaryResetsAt: fiveHour.resetsAt };
  }
  return { primaryWindow: 'sevenDay', primaryUtilizationPct: sevenDay.utilizationPct, primaryResetsAt: sevenDay.resetsAt };
}

export function normalize(raw: unknown, fetchedAt?: string): UsageSnapshot {
  const warnings: string[] = [];
  const now = fetchedAt ?? new Date().toISOString();

  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return makeMalformed(now, ['Response is not an object']);
  }

  const obj = raw as Record<string, unknown>;

  const fiveHour = parseWindow(obj.five_hour, warnings, 'five_hour');
  const sevenDay = parseWindow(obj.seven_day, warnings, 'seven_day');

  // At least one window must be present
  if (fiveHour.utilizationPct === null && sevenDay.utilizationPct === null) {
    return makeMalformed(now, [...warnings, 'No valid usage windows found']);
  }

  const display = computePrimaryDisplay(fiveHour, sevenDay);

  return {
    fetchedAt: now,
    source: { usageEndpoint: 'success' },
    authState: 'valid',
    fiveHour,
    sevenDay,
    display,
    freshness: { isStale: false, staleReason: 'none' },
    rawMetadata: { normalizationWarnings: warnings },
  };
}

function makeMalformed(fetchedAt: string, warnings: string[]): UsageSnapshot {
  return {
    fetchedAt,
    source: { usageEndpoint: 'failed' },
    authState: 'valid',
    fiveHour: { utilizationPct: null, resetsAt: null },
    sevenDay: { utilizationPct: null, resetsAt: null },
    display: { primaryWindow: 'unknown', primaryUtilizationPct: null, primaryResetsAt: null },
    freshness: { isStale: true, staleReason: 'malformedResponse' },
    rawMetadata: { normalizationWarnings: warnings },
  };
}
