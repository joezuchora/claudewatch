/**
 * Rebuild a `UsageSnapshot` read from a cache file, field by field, from known keys.
 *
 * **A whitelist, not a validator.** The difference is the whole design (sdlc/032). Loop 031 fixed
 * `freshness` and `rawMetadata` by rebuilding them and left every other object passed through by
 * reference — and its Stage 5 audit then found unknown sibling keys surviving on exactly those.
 * A rebuild makes completeness structural: a field that is not named here does not survive, so the
 * failure mode is a DROPPED field, which the strict round-trip test catches, rather than a LEAKED
 * one, which nothing catches.
 *
 * Measured before this existed: **26 of 26** poisoned values survived `readCacheResult`, 24 of them
 * inside the snapshot, plus every unknown key at every depth. The first count taken was 14, from a
 * probe that missed two of the three windows and half of `enterprise`.
 *
 * Everything here DEGRADES; nothing rejects. Rejecting deletes the cache file and takes
 * `cooldownUntil` with it, and that cooldown is §9.4's only throttle on token-bearing requests.
 */
import type { EnterpriseUsage, UsageSnapshot, UsageWindow } from './types.js';
import {
  UNKNOWN_FETCHED_AT, ISO_CURRENCY_RE, MAX_DISABLED_REASON,
  isAccountTier, isAuthState, isNormalizationWarning, isPrimaryWindow, isStaleReason,
  isUsageEndpointState, MAX_NORMALIZATION_WARNINGS,
} from './closed-sets.js';

/**
 * Every key of `UsageSnapshot` this module knows a rule for.
 *
 * `sanitize-snapshot.test.ts` reflects over a real snapshot and fails if any key is missing from
 * this list, so a field added to `UsageSnapshot` without a rule is RED rather than silently dropped.
 * That is `intent.md`'s outcome 7 — the one thing that stops the next loop re-running loops
 * 029-032's arithmetic.
 */
export const SANITIZED_FIELDS = [
  'fetchedAt', 'source', 'authState', 'tier',
  'fiveHour', 'sevenDay', 'sevenDayOpus', 'enterprise',
  'display', 'freshness', 'rawMetadata',
] as const satisfies readonly (keyof UsageSnapshot)[];

const _fieldsCovered: never = null as unknown as Exclude<
  keyof UsageSnapshot, (typeof SANITIZED_FIELDS)[number]
>;
void _fieldsCovered;

/** A finite number, or null. Rejects strings, NaN, Infinity — none of which `typeof` catches. */
function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A finite number >= 0, or null. */
function nonNegativeOrNull(v: unknown): number | null {
  const n = finiteOrNull(v);
  return n !== null && n >= 0 ? n : null;
}

/**
 * An ISO timestamp we constructed, or null.
 *
 * No sentinel, unlike `fetchedAt`: `null` is already in this field's type and already means "no
 * reset known", so inventing a second sentinel would add a state every reader must learn for no
 * gain. `Date.parse` accepts far more than ISO-8601 and its legacy parser ignores parenthesised
 * trailing text, so the value is reconstructed rather than echoed.
 */
function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function sanitizeWindow(raw: unknown): UsageWindow {
  const w = (raw ?? {}) as Record<string, unknown>;
  return {
    // NOT bounded to 0-100. `normalize()` bounds only the ENTERPRISE utilization; a window's is
    // copied through unbounded, so an honest `utilization: 105` would be nulled on the first cache
    // read — the same snapshot rendering 105% fresh and an error a second later, with the window
    // keeping 105 while `display` went null. contract.test.ts also seeds exactly 100.
    utilizationPct: nonNegativeOrNull(w.utilizationPct),
    resetsAt: isoOrNull(w.resetsAt),
  };
}

/**
 * `null`, or an enterprise block with all six fields checked.
 *
 * **Any failing numeric nulls the WHOLE object.** A half-degraded block is what renders `$NaN`, and
 * a non-numeric `utilizationPct` currently THROWS — `pct.toFixed is not a function`, out of
 * `main()`, into the top-level catch, exit 3, with the cache file never deleted, so every render
 * repeats it forever. That is the stuck-failure loop §9 exists to prevent, and no artefact in this
 * loop claimed it until the Stage 2 review found it.
 */
function sanitizeEnterprise(raw: unknown): EnterpriseUsage | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;

  const utilizationPct = finiteOrNull(e.utilizationPct);
  const monthlyLimitCredits = nonNegativeOrNull(e.monthlyLimitCredits);
  const usedCredits = nonNegativeOrNull(e.usedCredits);
  if (utilizationPct === null || monthlyLimitCredits === null || usedCredits === null) return null;
  if (typeof e.isEnabled !== 'boolean') return null;

  const rawCurrency = typeof e.currency === 'string' ? e.currency : '';
  return {
    utilizationPct,
    monthlyLimitCredits,
    usedCredits,
    currency: ISO_CURRENCY_RE.test(rawCurrency) ? rawCurrency : 'USD',
    isEnabled: e.isEnabled,
    disabledReason: sanitizeDisabledReason(e.disabledReason),
  };
}

/**
 * REDACT then BOUND — the one rule here that is neither a closed set nor a canonicalisation.
 *
 * `disabledReason`'s text is chosen by the API, so it cannot be enumerated, and it is interpolated
 * straight into the VS Code tooltip (`format.ts:374`) and serialised whole by `--json`. Rejecting
 * anything path- or host-shaped keeps the legitimate message ("Extra usage disabled by your
 * administrator") while removing the shapes §12 actually cares about; the length bound then stops
 * an unbounded blob reaching a tooltip.
 *
 * **This is the weakest rule in the module and is labelled rather than hidden.** It does not stop a
 * short poisoned string that avoids every listed shape. Nulling the field outright was the
 * alternative, and it would delete a real user-facing explanation from every cached render.
 */
const REDACT_SHAPES = [/[/\\]/, /sk-ant-/i, /@/, /\.local\b/i];

function sanitizeDisabledReason(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  if (REDACT_SHAPES.some((re) => re.test(v))) return null;
  return v.slice(0, MAX_DISABLED_REASON);
}

export function sanitizeSnapshot(raw: unknown): UsageSnapshot {
  const s = (raw ?? {}) as Record<string, unknown>;

  const fetchedAtMs = typeof s.fetchedAt === 'string' ? Date.parse(s.fetchedAt) : NaN;
  const enterprise = sanitizeEnterprise(s.enterprise);

  const freshness = (s.freshness ?? {}) as Record<string, unknown>;
  const rawMetadata = (s.rawMetadata ?? {}) as Record<string, unknown>;
  const source = (s.source ?? {}) as Record<string, unknown>;
  const display = (s.display ?? {}) as Record<string, unknown>;

  const fiveHour = sanitizeWindow(s.fiveHour);
  const sevenDay = sanitizeWindow(s.sevenDay);
  const sevenDayOpus = sanitizeWindow(s.sevenDayOpus);
  const windows = { fiveHour, sevenDay, sevenDayOpus };

  let primaryWindow = isPrimaryWindow(display.primaryWindow) ? display.primaryWindow : 'unknown';
  let primaryUtilizationPct = nonNegativeOrNull(display.primaryUtilizationPct);
  let tier = isAccountTier(s.tier) ? s.tier : 'unknown';

  // --- Coherence. Degrading each field independently INVENTS states no producer can emit. ---
  //
  // `normalize()` sets `tier: 'enterprise'` only inside its `enterprise !== null` branch, so that
  // pair is unreachable from the producer. Poison one enterprise number and, without this, `tier`
  // survives because 'enterprise' is a valid member — and the result renders a plausible line with
  // no indication anything is wrong. Coupling is also what makes the `null` percentage degrade
  // honest on all four renderers rather than only on `formatStatusLine`, which is the fallback and
  // the only one the first spec draft measured.
  if (enterprise === null && tier === 'enterprise') {
    tier = 'unknown';
    primaryWindow = 'unknown';
    primaryUtilizationPct = null;
  }
  if (primaryWindow !== 'unknown' && primaryWindow !== 'enterprise'
      && windows[primaryWindow].utilizationPct === null) {
    primaryWindow = 'unknown';
    primaryUtilizationPct = null;
  }

  return {
    fetchedAt: Number.isFinite(fetchedAtMs)
      ? new Date(fetchedAtMs).toISOString()
      : UNKNOWN_FETCHED_AT,
    source: {
      usageEndpoint: isUsageEndpointState(source.usageEndpoint)
        ? source.usageEndpoint
        : 'unavailable',
    },
    authState: isAuthState(s.authState) ? s.authState : 'unknown',
    tier,
    fiveHour,
    sevenDay,
    sevenDayOpus,
    enterprise,
    display: {
      primaryWindow,
      primaryUtilizationPct,
      primaryResetsAt: isoOrNull(display.primaryResetsAt),
    },
    freshness: {
      isStale: typeof freshness.isStale === 'boolean' ? freshness.isStale : false,
      staleReason: isStaleReason(freshness.staleReason) ? freshness.staleReason : 'none',
    },
    rawMetadata: {
      normalizationWarnings: Array.isArray(rawMetadata.normalizationWarnings)
        ? rawMetadata.normalizationWarnings
            .filter(isNormalizationWarning)
            .slice(0, MAX_NORMALIZATION_WARNINGS)
        : [],
    },
  };
}
