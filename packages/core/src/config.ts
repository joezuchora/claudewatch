/**
 * Telemetry configuration resolution.
 *
 * The statusline binary has no settings file and no CLI flag for this — its flag list is
 * contractual (SPEC.md §11.4) — so the environment is the channel that actually reaches it.
 * The VS Code extension passes its settings object as an explicit override.
 *
 * The endpoint is deliberately NOT product configuration. The product never sends anything;
 * it appends to a local spool. Only the agent needs a URL, and it reads its own env var.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface TelemetryConfig {
  enabled: boolean;
}

export const TELEMETRY_DISABLED: TelemetryConfig = { enabled: false };

let configBaseDir: string | null = null;

/** Override the config directory root (for test isolation). Pass null to reset. */
export function setConfigBaseDir(dir: string | null): void {
  configBaseDir = dir;
}

export function getConfigPath(): string {
  const base = configBaseDir ?? join(homedir(), '.config', 'claudewatch');
  return join(base, 'config.json');
}

function fromEnv(env: Record<string, string | undefined>): boolean | null {
  const raw = env.CLAUDEWATCH_TELEMETRY;
  if (raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off' || v === '') return false;
  // Anything else is not a decision — fall through rather than guessing.
  return null;
}

function fromFile(): boolean | null {
  // An absent or unparseable config file is treated as absent, never as an error.
  // Telemetry configuration must not be able to break the product.
  try {
    const raw = readFileSync(getConfigPath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    const telemetry = (parsed as Record<string, unknown>).telemetry;
    if (telemetry === null || typeof telemetry !== 'object') return null;
    const enabled = (telemetry as Record<string, unknown>).enabled;
    return typeof enabled === 'boolean' ? enabled : null;
  } catch {
    return null;
  }
}

/**
 * Precedence: explicit override > environment > config file > disabled.
 *
 * Disabled is the default and the only state a user who changes nothing can be in.
 */
export function resolveTelemetryConfig(
  overrides?: Partial<TelemetryConfig>,
  env: Record<string, string | undefined> = process.env,
): TelemetryConfig {
  if (overrides?.enabled !== undefined) return { enabled: overrides.enabled };

  const envValue = fromEnv(env);
  if (envValue !== null) return { enabled: envValue };

  const fileValue = fromFile();
  if (fileValue !== null) return { enabled: fileValue };

  return TELEMETRY_DISABLED;
}
