// === Domain Types (SPEC.md §5.1) ===

export interface UsageWindow {
  utilizationPct: number | null;
  resetsAt: string | null; // ISO timestamp, always UTC
}

export type AccountTier = 'standard' | 'enterprise' | 'unknown';

export interface EnterpriseUsage {
  utilizationPct: number;       // 0-100, monthly credit consumption
  monthlyLimitCredits: number;  // raw credit cap (currency units; see `currency`)
  usedCredits: number;          // raw credits spent in the current period
  currency: string;             // ISO currency code, e.g. "USD"
  isEnabled: boolean;           // false if the org has disabled extra usage
  disabledReason: string | null;
}

export interface UsageSnapshot {
  // ISO timestamp, always UTC — with ONE documented exception. `readCacheResult` substitutes
  // `UNKNOWN_FETCHED_AT` ('unknown') for a value off disk it cannot parse, rather than deleting the
  // envelope and the cooldown with it (sdlc/031). So a snapshot that came from the CACHE may carry
  // a non-ISO sentinel here; one that came from `normalize()` never does. Every reader handles it:
  // `formatLocalTime` renders the literal 'unknown', `isCacheFresh` returns false, `detectClockSkew`
  // returns false (though it has no production caller today), and `printDebug`'s age arithmetic serialises to null. SPEC.md §11.4 and §14
  // record the same exception against `--json`.
  fetchedAt: string;
  source: {
    usageEndpoint: 'success' | 'failed' | 'unavailable';
  };
  authState: 'valid' | 'invalid' | 'missing' | 'unknown';
  tier: AccountTier;
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  sevenDayOpus: UsageWindow;
  enterprise: EnterpriseUsage | null;
  display: {
    primaryWindow: 'fiveHour' | 'sevenDay' | 'sevenDayOpus' | 'enterprise' | 'unknown';
    primaryUtilizationPct: number | null;
    primaryResetsAt: string | null;
  };
  freshness: {
    isStale: boolean;
    staleReason: StaleReason;
  };
  rawMetadata: {
    normalizationWarnings: string[];
  };
}

export type StaleReason =
  | 'none'
  | 'fetchFailed'
  | 'authInvalid'
  | 'sourceUnavailable'
  | 'malformedResponse';

export type RuntimeState =
  | 'Initializing'
  | 'Healthy'
  | 'Stale'
  | 'Degraded'
  | 'AuthInvalid'
  | 'NotConfigured'
  | 'HardFailure'
  | 'Enterprise';

export type FailureClass =
  | 'notConfigured'
  | 'authInvalid'
  | 'serviceUnavailable'
  /** The 5s hard timeout specifically, as distinct from an unreachable endpoint (sdlc/010). */
  | 'timeout'
  | 'malformedResponse'
  | 'unexpectedFailure';

export type ThresholdLevel = 'normal' | 'warning' | 'critical';

// === Cache Types (SPEC.md §9.6) ===

export interface CacheEnvelope {
  version: number;
  snapshot: UsageSnapshot;
  cooldownUntil: string | null; // ISO timestamp or null
  lastErrorClass: FailureClass | null;
  lastHttpStatus: number | null; // HTTP status code of last failed fetch
  lastErrorMessage: SurfaceableMessage | null; // A closed-set message; see SurfaceableMessage
}

// === API Response Types (SPEC.md §3.2) ===

export interface RawUsageWindow {
  utilization: number;
  resets_at: string | null;
}

export interface RawExtraUsage {
  is_enabled: boolean;
  monthly_limit: number;
  used_credits: number;
  utilization: number; // 0-100 percentage of monthly_limit
  currency: string;
  disabled_reason: string | null;
}

export interface RawUsageResponse {
  five_hour: RawUsageWindow | null;
  seven_day: RawUsageWindow | null;
  seven_day_opus?: RawUsageWindow | null;
  extra_usage?: RawExtraUsage | null; // present on enterprise accounts
  [key: string]: unknown; // forward-compatible with unknown fields
}

// === Credential Types (SPEC.md §4.3) ===

export interface CredentialFile {
  claudeAiOauth: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number; // Unix ms timestamp
    scopes?: string[];
  };
}

export type AuthState = 'valid' | 'invalid' | 'missing' | 'unknown';

export interface CredentialResult {
  authState: AuthState;
  accessToken: string | null;
}

// === Fetch Result ===

export interface FetchSuccess {
  ok: true;
  status: 200;
  data: unknown;
}

/**
 * Every message a fetch failure may carry, as a closed set.
 *
 * SPEC.md §12 requires redaction from all surfaced errors. Before sdlc/029 that clause held by
 * accident: the HTTP messages happened to be constants, and the one uncontrolled string —
 * `err.message` on the network path — happened to be generic on this runtime. `client.ts:180`
 * already called that string "exactly the free text the telemetry allowlist exists to keep out",
 * and four lines later it was assigned here, persisted to the cache as `lastErrorMessage`, and
 * rendered in the VS Code tooltip. The guard existed on one path and not the other.
 *
 * Narrowing this field makes a free-text producer a COMPILE error rather than something a test has
 * to remember to catch. `typefixtures/free-text-message.expect-error.ts` freezes the negative
 * control. `isSurfaceableMessage` re-checks the same set at the cache-read boundary
 * (`readCacheResult`), where a type cannot help because the value comes off disk.
 *
 * CORRECTED by sdlc/030: this said "at the cache-read boundary" while the predicate actually ran in
 * `extractLastError`, a CONSUMER. Two other consumers — the statusline's two `--debug` sites — never
 * called it, so a pre-029 cache file still printed free text. The check now runs where the value
 * enters the program, and this sentence is true.
 */
export type SurfaceableMessage =
  | 'Authentication failed (401)'
  | 'Rate limited (429)'
  | 'Network error'
  | 'Request timed out'
  | 'Malformed response'
  | 'TLS verification failed'
  | `Server error (${number})`
  | `Unexpected status ${number}`;

/**
 * The three members a THROWN fetch can produce, as opposed to an HTTP response.
 *
 * A subset, declared with `Extract` rather than as its own union, so it cannot drift from
 * `SurfaceableMessage` and cannot widen it. `packages/metrics` consumes this and nothing else:
 * `'Authentication failed (401)'`, `'Rate limited (429)'` and `` `Server error (${number})` `` are
 * HTTP outcomes the shipper reports as `{ kind: 'http', status }`, and admitting them here would be
 * two representations of one fact.
 *
 * `SurfaceableMessage` itself is NOT to be widened for a shipping-only message. It is load-bearing
 * for SPEC.md §12's cache-read boundary and frozen by three separate mechanisms — the
 * `free-text-message` type fixture, `isSurfaceableMessage`, and `exhaustive-guard.test.ts`'s count
 * assertion. If the shipper ever needs a message of its own, `packages/metrics` declares its own
 * union at that point. (sdlc/036 m-1)
 */
export type TransportMessage = Extract<
  SurfaceableMessage,
  'Network error' | 'TLS verification failed' | 'Request timed out'
>;

export interface FetchFailure {
  ok: false;
  status: number | null; // null for network errors
  failureClass: FailureClass;
  message: SurfaceableMessage;
}

export type FetchResult = FetchSuccess | FetchFailure;

// === Claude Code Session Info (piped via stdin) ===

export interface SessionInfo {
  model?: { id?: string; display_name?: string };
  workspace?: { current_dir?: string; project_dir?: string };
  context_window?: {
    used_percentage?: number;
    remaining_percentage?: number;
    total_input_tokens?: number;
    total_output_tokens?: number;
    context_window_size?: number;
  };
  cost?: { total_cost_usd?: number; total_duration_ms?: number };
}
