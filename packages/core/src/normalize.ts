import type { UsageSnapshot, UsageWindow, EnterpriseUsage } from './types.js';
import { emitProcess, schemaDriftEvent, categorizeWarning } from './telemetry.js';
// The reader filters `normalizationWarnings` against this same set (sdlc/031). Sourcing the strings
// here rather than spelling them twice is what stops producer and filter drifting into a state
// where a real warning is silently dropped on read.
import {
  WINDOW_NAMES, resetsAtWarning, WARNING_NOT_AN_OBJECT, WARNING_NO_VALID_WINDOWS,
} from './closed-sets.js';

const ISO_CURRENCY_RE = /^[A-Z]{3}$/;


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
      warnings.push(resetsAtWarning(name));
    } else {
      resetsAt = parsed.toISOString();
    }
  }

  return { utilizationPct, resetsAt };
}

function computePrimaryDisplay(
  fiveHour: UsageWindow,
  sevenDay: UsageWindow,
  sevenDayOpus: UsageWindow,
): UsageSnapshot['display'] {
  // Primary is the most constrained window: the highest valid utilization across all three
  // (SPEC.md §5.3). Ties resolve fiveHour > sevenDay > sevenDayOpus, which preserves the
  // fiveHour >= sevenDay precedence that predates the Opus window.
  const candidates: Array<{ key: 'fiveHour' | 'sevenDay' | 'sevenDayOpus'; window: UsageWindow }> = [
    { key: 'fiveHour', window: fiveHour },
    { key: 'sevenDay', window: sevenDay },
    { key: 'sevenDayOpus', window: sevenDayOpus },
  ];

  let best: { key: 'fiveHour' | 'sevenDay' | 'sevenDayOpus'; window: UsageWindow } | null = null;
  for (const candidate of candidates) {
    if (candidate.window.utilizationPct === null) continue;
    // Strict > keeps the earlier candidate on a tie, giving the precedence above.
    if (best === null || candidate.window.utilizationPct > best.window.utilizationPct!) {
      best = candidate;
    }
  }

  if (best === null) {
    return { primaryWindow: 'unknown', primaryUtilizationPct: null, primaryResetsAt: null };
  }

  return {
    primaryWindow: best.key,
    primaryUtilizationPct: best.window.utilizationPct,
    primaryResetsAt: best.window.resetsAt,
  };
}

// An enterprise account is identified by the presence of an `extra_usage` object
// on the usage response (SPEC §3.5). Standard accounts omit this field entirely.
function parseExtraUsage(raw: unknown, warnings: string[]): EnterpriseUsage | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const utilization = obj.utilization;
  const monthlyLimit = obj.monthly_limit;
  const usedCredits = obj.used_credits;
  const isEnabled = obj.is_enabled;

  // Require the core numeric fields; without them we cannot render a tier display.
  if (
    typeof utilization !== 'number' || !isFinite(utilization) ||
    typeof monthlyLimit !== 'number' || !isFinite(monthlyLimit) ||
    typeof usedCredits !== 'number' || !isFinite(usedCredits) ||
    typeof isEnabled !== 'boolean'
  ) {
    warnings.push('extra_usage present but missing required fields');
    return null;
  }

  if (utilization < 0 || utilization > 100 || usedCredits < 0 || monthlyLimit < 0) {
    warnings.push('extra_usage present but has out-of-range values');
    return null;
  }

  if (isEnabled && monthlyLimit <= 0) {
    warnings.push('extra_usage present but has invalid enabled monthly limit');
    return null;
  }

  const rawCurrency = typeof obj.currency === 'string' ? obj.currency.trim().toUpperCase() : 'USD';
  const currency = ISO_CURRENCY_RE.test(rawCurrency) ? rawCurrency : 'USD';
  if (currency === 'USD' && rawCurrency !== 'USD') {
    warnings.push('extra_usage.currency invalid; defaulted to USD');
  }
  const disabledReason = typeof obj.disabled_reason === 'string' ? obj.disabled_reason : null;

  return {
    utilizationPct: utilization,
    monthlyLimitCredits: monthlyLimit,
    usedCredits,
    currency,
    isEnabled,
    disabledReason,
  };
}

export function normalize(raw: unknown, fetchedAt?: string): UsageSnapshot {
  const warnings: string[] = [];
  const now = fetchedAt ?? new Date().toISOString();

  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return makeMalformed(now, [WARNING_NOT_AN_OBJECT]);
  }

  const obj = raw as Record<string, unknown>;

  // Names come from WINDOW_NAMES so the closed set and the call sites cannot disagree; they are
  // still literals, which is what makes resetsAtWarning's output a closed set at all.
  const [FIVE_HOUR, SEVEN_DAY, SEVEN_DAY_OPUS] = WINDOW_NAMES;
  const fiveHour = parseWindow(obj.five_hour, warnings, FIVE_HOUR);
  const sevenDay = parseWindow(obj.seven_day, warnings, SEVEN_DAY);
  const sevenDayOpus = parseWindow(obj.seven_day_opus, warnings, SEVEN_DAY_OPUS);

  // Detect enterprise tier from the presence of extra_usage. This signal is
  // distinct from "both windows are null" — standard accounts omit extra_usage
  // entirely even when degraded, so we treat its presence as authoritative.
  const enterprise = 'extra_usage' in obj
    ? parseExtraUsage(obj.extra_usage, warnings)
    : null;

  if (enterprise !== null) {
    return {
      fetchedAt: now,
      source: { usageEndpoint: 'success' },
      authState: 'valid',
      tier: 'enterprise',
      fiveHour,
      sevenDay,
      sevenDayOpus,
      enterprise,
      display: {
        primaryWindow: 'enterprise',
        primaryUtilizationPct: enterprise.utilizationPct,
        primaryResetsAt: null, // enterprise pool has no exposed reset timestamp
      },
      freshness: { isStale: false, staleReason: 'none' },
      rawMetadata: { normalizationWarnings: warnings },
    };
  }

  // Standard path — at least one window must be present. sevenDayOpus counts: since it is
  // now a tracked window, a response carrying only an Opus window is valid data, not a
  // malformed response. Before sdlc/002-opus-window that case was reported as malformed.
  if (
    fiveHour.utilizationPct === null &&
    sevenDay.utilizationPct === null &&
    sevenDayOpus.utilizationPct === null
  ) {
    return makeMalformed(now, [...warnings, WARNING_NO_VALID_WINDOWS]);
  }

  // One event per successful normalize, never per warning: a malformed response with eight
  // warnings is one drift, not eight. Emitted on the FETCH path only — warnings live on the
  // snapshot and are re-read from cache for up to 600s, so emitting at render time would turn
  // a single drift into hundreds of duplicates. See sdlc/003 and sdlc/007.
  if (warnings.length > 0) {
    emitProcess(schemaDriftEvent({
      category: categorizeWarning(warnings[0]!),
      count: warnings.length,
    }));
  }

  const display = computePrimaryDisplay(fiveHour, sevenDay, sevenDayOpus);

  return {
    fetchedAt: now,
    source: { usageEndpoint: 'success' },
    authState: 'valid',
    tier: 'standard',
    fiveHour,
    sevenDay,
    sevenDayOpus,
    enterprise: null,
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
    tier: 'unknown',
    fiveHour: { utilizationPct: null, resetsAt: null },
    sevenDay: { utilizationPct: null, resetsAt: null },
    sevenDayOpus: { utilizationPct: null, resetsAt: null },
    enterprise: null,
    display: { primaryWindow: 'unknown', primaryUtilizationPct: null, primaryResetsAt: null },
    freshness: { isStale: true, staleReason: 'malformedResponse' },
    rawMetadata: { normalizationWarnings: warnings },
  };
}
