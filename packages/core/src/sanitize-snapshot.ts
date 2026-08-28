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

/**
 * The same guarantee for every NESTED shape.
 *
 * `SANITIZED_FIELDS` names eleven top-level keys. Fifteen of the boundary's validated leaves live
 * in `source`, `display`, `freshness`, `rawMetadata`, `UsageWindow` and `EnterpriseUsage` — and
 * until sdlc/032's Stage 5 audit none of those had an equivalent list. Measured: adding
 * `newNestedField?: string` to `EnterpriseUsage` typechecked clean and passed all 870 tests, the
 * field silently dropped by the rebuild. A11's headline — "one place names every validated field"
 * — was true of eleven of twenty-six.
 *
 * These are type-level only; each `Exclude<...> = never` fails to compile the moment a shape gains
 * a key no rule here handles.
 */
const _sourceCovered: never = null as unknown as Exclude<
  keyof UsageSnapshot['source'], 'usageEndpoint'>;
const _displayCovered: never = null as unknown as Exclude<
  keyof UsageSnapshot['display'], 'primaryWindow' | 'primaryUtilizationPct' | 'primaryResetsAt'>;
const _freshnessCovered: never = null as unknown as Exclude<
  keyof UsageSnapshot['freshness'], 'isStale' | 'staleReason'>;
const _rawMetadataCovered: never = null as unknown as Exclude<
  keyof UsageSnapshot['rawMetadata'], 'normalizationWarnings'>;
const _windowCovered: never = null as unknown as Exclude<
  keyof UsageWindow, 'utilizationPct' | 'resetsAt'>;
const _enterpriseCovered: never = null as unknown as Exclude<
  keyof EnterpriseUsage,
  'utilizationPct' | 'monthlyLimitCredits' | 'usedCredits' | 'currency' | 'isEnabled' | 'disabledReason'>;
void _sourceCovered; void _displayCovered; void _freshnessCovered;
void _rawMetadataCovered; void _windowCovered; void _enterpriseCovered;

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
/**
 * A POSITIVE whitelist, not a blacklist. The blacklist was the first version and it leaked.
 *
 * sdlc/032's security pass drove these through the four-shape blacklist and into the tooltip
 * verbatim: `host=my-laptop.corp.example.com`, `joe.zuchora`, `C:Users joe`,
 * `Bearer eyJhbGciOi.eyJzdWIi.QWxhZGRpbg`, `token sk_ant_live_abcdef` — and, worse and unnamed in
 * SPEC §12 at the time, CONTROL CHARACTERS: ANSI escapes, newlines, tabs. That string is
 * interpolated into a VS Code tooltip, into the showDiagnostics modal, and serialised whole by
 * `--json`; an escape sequence reaching a terminal is not a cosmetic problem.
 *
 * A blacklist enumerates what you thought of. A whitelist enumerates what the field is FOR — an
 * administrator's sentence — and drops everything else. "Extra usage disabled by your
 * administrator" passes; an FQDN, a Windows path, a JWT and an escape sequence do not.
 */
const ALLOWED_REASON = /^[\p{L}\p{N} .,;:'"()[\]!?%\-–—]+$/u;
/**
 * Control characters, by code point rather than by regex.
 *
 * A character-class regex here trips `no-control-regex`, and that rule is right to ask — matching
 * control characters is usually accidental. Here it is the intent: this is what stops an ANSI
 * escape sequence read off a cache file reaching a terminal through the VS Code tooltip, the
 * showDiagnostics modal, or `--json`. Written as a scan instead of a disable comment, because the
 * explicit form says what it means and the linter has nothing to object to.
 */
function hasControlChars(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/**
 * Structural shapes an administrator's sentence does not contain, and identifiers do.
 *
 * The character whitelist alone still passed `joe.zuchora`, `C:Users joe` and
 * `Bearer eyJhbGciOi.eyJzdWIi.QWxhZGRpbg` — all built from ordinary sentence characters. What
 * separates them from prose is STRUCTURE: a dot or colon wedged between two non-space characters.
 * Prose puts a space after them ("Note: contact IT.", "e.g. your administrator"); identifiers,
 * hostnames, Windows paths and JWTs do not.
 *
 * The cost is real and worth naming: "U.S. policy" is rejected. The benefit is that a username, an
 * FQDN and a JWT all are too.
 */
const IDENTIFIER_SHAPES = [/\w\.\w/, /\S:\S/];

/**
 * REDACT then BOUND — the one rule here that is neither a closed set nor a canonicalisation.
 *
 * `disabledReason`'s text is chosen by the API, so it cannot be enumerated, and it is interpolated
 * straight into the VS Code tooltip (`format.ts:374`), into the `showDiagnostics` modal, and
 * serialised whole by `--json`.
 *
 * Order is load-bearing and was already right: both checks run on the FULL string before the
 * slice, so a 5,000-character value with a token at index 4,000 is dropped entirely rather than
 * truncated into apparent safety. Bound-then-check would have been the exploitable order.
 */
function sanitizeDisabledReason(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  if (hasControlChars(v)) return null;
  if (!ALLOWED_REASON.test(v)) return null;
  if (IDENTIFIER_SHAPES.some((re) => re.test(v))) return null;
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
  let tier = isAccountTier(s.tier) ? s.tier : 'unknown';

  // --- Coherence. Degrading each field independently INVENTS states no producer can emit. ---
  //
  // `normalize()` sets `tier: 'enterprise'` only inside its `enterprise !== null` branch, so that
  // pair is unreachable from the producer. Poison one enterprise number and, without this, `tier`
  // survives because 'enterprise' is a valid member — and the result renders a plausible line with
  // no indication anything is wrong.
  if (enterprise === null && tier === 'enterprise') {
    tier = 'unknown';
    primaryWindow = 'unknown';
  }
  // Added by sdlc/032's security pass: rules 1 and 2 both missed `primaryWindow: 'enterprise'`
  // beside `enterprise: null` under a NON-enterprise tier — rule 1 needs `tier === 'enterprise'`
  // and rule 2 excluded `'enterprise'`. That state rendered a fabricated percentage.
  if (primaryWindow === 'enterprise' && enterprise === null) {
    primaryWindow = 'unknown';
  }
  if (primaryWindow !== 'unknown' && primaryWindow !== 'enterprise'
      && windows[primaryWindow].utilizationPct === null) {
    primaryWindow = 'unknown';
  }

  // `display.primaryUtilizationPct` and `primaryResetsAt` are DERIVED, not accepted.
  //
  // Accepting them on their own merits was a real user-harm bug found by sdlc/032's security pass:
  // `{primaryWindow: 'fiveHour', primaryUtilizationPct: 3}` beside `fiveHour.utilizationPct: 96`
  // passed every check and rendered `⊙ 3%` with `classify()` returning Healthy — a user at 96%
  // shown 3%, and a green VS Code status bar, because the thresholds key off the same field. It
  // UNDERSTATES usage, which is the direction that costs the user something.
  //
  // These two are reconstructible from the window `primaryWindow` names, so this module's own rule
  // applies: return what you constructed, never what you read. SPEC §5.3's invariant — primary is
  // the highest utilization across valid windows — is only meaningful if the pair is consistent.
  const primarySource: UsageWindow | null =
    primaryWindow === 'unknown' ? null
    : primaryWindow === 'enterprise'
      ? (enterprise === null ? null
         : { utilizationPct: enterprise.utilizationPct, resetsAt: null })
      : windows[primaryWindow];

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
      primaryUtilizationPct: primarySource?.utilizationPct ?? null,
      // Enterprise carries no per-window reset, so the stored value is kept for that case only —
      // canonicalised, never echoed.
      primaryResetsAt: primarySource === null
        ? null
        : (primarySource.resetsAt ?? isoOrNull(display.primaryResetsAt)),
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
