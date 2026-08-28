/**
 * Closed sets shared between a producer and the cache reader.
 *
 * **A leaf module on purpose.** `cache.ts` needs the warning set and `normalize.ts` produces it, but
 * a direct `cache.ts -> normalize.ts` edge would close a cycle: `normalize.ts` imports
 * `telemetry.ts`, and `telemetry.ts:26` imports `getCacheDir` from `cache.ts`. Measured, not
 * assumed. sdlc/030 took a review NIT for stating a cycle claim more confidently than its premise
 * supported; this module removes the question rather than re-litigating it. Nothing here imports
 * anything at runtime, so it can never participate in one.
 *
 * `state.ts` was considered as a home for the StaleReason members and rejected: warning strings are
 * not a classification concern, and splitting them across two modules would be worse than either.
 */
import type { AccountTier, StaleReason, UsageSnapshot } from './types.js';

/**
 * What `readCacheResult` substitutes for a `fetchedAt` it cannot parse.
 *
 * Not an ISO timestamp, deliberately, and every downstream behaviour was measured rather than
 * reasoned about: `formatLocalTime` returns the literal `unknown` (so `format.ts:437` renders
 * "Fresh as of unknown" rather than a plausible time), `isCacheFresh` returns false, and
 * `printDebug`'s `Math.round(NaN)` serialises to `cacheAgeSec: null` — the same shape a cache miss
 * emits.
 *
 * The epoch was the obvious alternative and is wrong: `new Date(0)` renders "12:00 AM", so a
 * snapshot of unknowable age would print a confident falsehood on the user's statusline. A
 * documented-contract nuance is the better price. See sdlc/031's spec, Rejected alternatives.
 */
export const UNKNOWN_FETCHED_AT = 'unknown';

/** Every member of `StaleReason`, as values. */
export const STALE_REASONS = [
  'none',
  'fetchFailed',
  'authInvalid',
  'sourceUnavailable',
  'malformedResponse',
] as const satisfies readonly StaleReason[];

// A new StaleReason member that nobody adds here is a compile error, not a silent hole. Mirrors
// `FAILURE_CLASSES`'s guard in cooldown.ts; sdlc/014 established the idiom and typefixtures/
// freezes the form.
const _allReasonsCovered: never = null as unknown as Exclude<
  StaleReason,
  (typeof STALE_REASONS)[number]
>;
void _allReasonsCovered;

const STALE_REASON_SET: ReadonlySet<string> = new Set(STALE_REASONS);

export function isStaleReason(value: unknown): value is StaleReason {
  return typeof value === 'string' && STALE_REASON_SET.has(value);
}

/**
 * Every member of `AccountTier`, as values.
 *
 * `tier` is the only unvalidated snapshot leaf that reaches a PERSISTED FILE rather than stdout:
 * `renderEvent` (telemetry.ts:229) copies it verbatim into a payload leaf, and `emit` appends that
 * to the metrics spool. Measured — a seeded `tier` carrying a home directory and a hostname landed
 * on disk. `telemetry.ts`'s own header forbids an unconstrained string in a payload, and justifies
 * this one by "constrained by their producing unions", which is exactly the argument sdlc/029 and
 * sdlc/030 established is void for a value read off a cache file. Found by sdlc/031's security pass.
 */
export const ACCOUNT_TIERS = ['standard', 'enterprise', 'unknown'] as const satisfies readonly AccountTier[];

const TIER_SET: ReadonlySet<string> = new Set(ACCOUNT_TIERS);

export function isAccountTier(value: unknown): value is AccountTier {
  return typeof value === 'string' && TIER_SET.has(value);
}

/**
 * How far into the future a `fetchedAt` may sit before the cache stops counting as fresh.
 *
 * Matches `detectClockSkew`'s threshold so the two agree on what "skewed" means.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * A ceiling on how many warnings survive a cache read.
 *
 * `normalize()` emits at most five in one pass, so this cannot truncate an honest envelope. It
 * bounds what a hand-edited file can make `--debug` and `--json` print.
 */
export const MAX_NORMALIZATION_WARNINGS = 16;

/**
 * The remaining closed sets on `UsageSnapshot`, for sdlc/032.
 *
 * **Anchored to INDEXED ACCESS, not to the named types.** `usageEndpoint` and `primaryWindow` are
 * anonymous unions with no named type to exclude from; and `authState` is spelled TWICE — inline at
 * `types.ts:30` and as `AuthState` at `:118` — so a guard anchored to `AuthState` would miss a
 * member added to the inline spelling, which is the one `UsageSnapshot` actually uses. Collapsing
 * that duplication is a `types.ts` edit with its own blast radius and is recorded as open rather
 * than smuggled in here.
 */
type UsageEndpointState = UsageSnapshot['source']['usageEndpoint'];
type AuthStateInline = UsageSnapshot['authState'];
type PrimaryWindow = UsageSnapshot['display']['primaryWindow'];

export const USAGE_ENDPOINT_STATES = [
  'success', 'failed', 'unavailable',
] as const satisfies readonly UsageEndpointState[];

export const AUTH_STATES = [
  'valid', 'invalid', 'missing', 'unknown',
] as const satisfies readonly AuthStateInline[];

export const PRIMARY_WINDOWS = [
  'fiveHour', 'sevenDay', 'sevenDayOpus', 'enterprise', 'unknown',
] as const satisfies readonly PrimaryWindow[];

// One `never` guard per set: a member added to the union that nobody adds here is a compile error.
const _endpointCovered: never = null as unknown as Exclude<UsageEndpointState, (typeof USAGE_ENDPOINT_STATES)[number]>;
const _authCovered: never = null as unknown as Exclude<AuthStateInline, (typeof AUTH_STATES)[number]>;
const _windowCovered: never = null as unknown as Exclude<PrimaryWindow, (typeof PRIMARY_WINDOWS)[number]>;
void _endpointCovered; void _authCovered; void _windowCovered;

const ENDPOINT_SET: ReadonlySet<string> = new Set(USAGE_ENDPOINT_STATES);
const AUTH_SET: ReadonlySet<string> = new Set(AUTH_STATES);
const WINDOW_SET: ReadonlySet<string> = new Set(PRIMARY_WINDOWS);

export function isUsageEndpointState(v: unknown): v is UsageEndpointState {
  return typeof v === 'string' && ENDPOINT_SET.has(v);
}
export function isAuthState(v: unknown): v is AuthStateInline {
  return typeof v === 'string' && AUTH_SET.has(v);
}
export function isPrimaryWindow(v: unknown): v is PrimaryWindow {
  return typeof v === 'string' && WINDOW_SET.has(v);
}

/**
 * ISO 4217, moved here from `normalize.ts` where it was a module-private const.
 *
 * `cache.ts` needs it and importing from `normalize.ts` would close the
 * `cache -> normalize -> telemetry -> cache` cycle this module exists to avoid. `normalize.ts`
 * imports it back.
 */
export const ISO_CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * A ceiling on `enterprise.disabledReason`, the ONE snapshot field that is neither enumerable nor
 * canonicalisable — the API chooses the text. See sanitize-snapshot.ts for the redact-then-bound
 * rule and its stated limit.
 */
export const MAX_DISABLED_REASON = 200;

/** The window names `normalize` passes to `parseWindow`. All three are literals at the call sites. */
export const WINDOW_NAMES = ['five_hour', 'seven_day', 'seven_day_opus'] as const;

/** The one interpolated warning form. Closed only because every `name` above is a literal. */
export function resetsAtWarning(name: string): string {
  return `${name}.resets_at is not a valid ISO timestamp`;
}

// Every warning string, named, so `normalize.ts` references them instead of respelling them.
// Commit 1 of sdlc/031 claimed all nine were sourced this way and only five were — the four below
// were still inline literals in normalize.ts, which the Stage 5 audit caught. The property held
// anyway because closed-sets.test.ts re-derives the set by running normalize(), but a structural
// guarantee two artefacts asserted did not exist.
export const WARNING_NOT_AN_OBJECT = 'Response is not an object';
export const WARNING_NO_VALID_WINDOWS = 'No valid usage windows found';
export const WARNING_EXTRA_USAGE_MISSING = 'extra_usage present but missing required fields';
export const WARNING_EXTRA_USAGE_RANGE = 'extra_usage present but has out-of-range values';
export const WARNING_EXTRA_USAGE_LIMIT = 'extra_usage present but has invalid enabled monthly limit';
export const WARNING_CURRENCY_DEFAULTED = 'extra_usage.currency invalid; defaulted to USD';

/**
 * Every string `normalize()` can put into `rawMetadata.normalizationWarnings`.
 *
 * **Nine, and the count is the whole point.** sdlc/031's intent said eight; its spec's first draft
 * said seven and built a table to prove it. The table was assembled by grepping `warnings.push` —
 * and two producers do not use `push`: `normalize.ts:121` and `:165` pass literal arrays to
 * `makeMalformed`. A filter built from that table would have DROPPED the headline warning of the
 * malformed-response path on read, deleting diagnostics from the one cache file where they matter.
 * Found by the Stage 2 review, by driving `normalize()` instead of reading it.
 *
 * `closed-sets.test.ts` re-derives this set from `normalize()` on every run, so the next producer
 * added without a row here is a red test rather than silent data loss.
 */
export const NORMALIZATION_WARNINGS: readonly string[] = [
  // From makeMalformed's literal-array arguments — NOT from warnings.push. These two are the rows
  // the spec's first table lost, because it was built from a `warnings.push` grep.
  WARNING_NOT_AN_OBJECT,
  WARNING_NO_VALID_WINDOWS,
  // From warnings.push.
  WARNING_EXTRA_USAGE_MISSING,
  WARNING_EXTRA_USAGE_RANGE,
  WARNING_EXTRA_USAGE_LIMIT,
  WARNING_CURRENCY_DEFAULTED,
  ...WINDOW_NAMES.map(resetsAtWarning),
];

const WARNING_SET: ReadonlySet<string> = new Set(NORMALIZATION_WARNINGS);

export function isNormalizationWarning(value: unknown): value is string {
  return typeof value === 'string' && WARNING_SET.has(value);
}
