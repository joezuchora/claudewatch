// === Domain Types (SPEC.md §5.1) ===

export interface UsageWindow {
  utilizationPct: number | null;
  resetsAt: string | null; // ISO timestamp, always UTC
}

export interface UsageSnapshot {
  fetchedAt: string; // ISO timestamp, always UTC
  source: {
    usageEndpoint: 'success' | 'failed' | 'unavailable';
  };
  authState: 'valid' | 'invalid' | 'missing' | 'unknown';
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  display: {
    primaryWindow: 'fiveHour' | 'sevenDay' | 'unknown';
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
  | 'HardFailure';

export type FailureClass =
  | 'notConfigured'
  | 'authInvalid'
  | 'serviceUnavailable'
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
  lastErrorMessage: string | null; // Human-readable error message
}

// === API Response Types (SPEC.md §3.2) ===

export interface RawUsageWindow {
  utilization: number;
  resets_at: string | null;
}

export interface RawUsageResponse {
  five_hour: RawUsageWindow | null;
  seven_day: RawUsageWindow | null;
  seven_day_opus?: RawUsageWindow | null;
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

export interface FetchFailure {
  ok: false;
  status: number | null; // null for network errors
  failureClass: FailureClass;
  message: string;
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
