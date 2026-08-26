import type { UsageSnapshot, SessionInfo, EnterpriseUsage, UsageWindow } from './types.js';
import { formatLocalTime, formatLocalDateTime } from './time.js';

/**
 * Format an enterprise utilization percentage. The monthly pool typically
 * spans many orders of magnitude (e.g., 0.0001% to 100%), so we keep two
 * decimal places below 1% to avoid rounding micro-usage to "0%".
 */
function formatEnterprisePct(pct: number): string {
  if (pct >= 10) return `${Math.round(pct)}%`;
  if (pct >= 1) return `${pct.toFixed(1)}%`;
  return `${pct.toFixed(2)}%`;
}

/**
 * The usage API reports monetary values in currency minor units (e.g., cents for USD).
 * Convert to major units before display so portal and local output match.
 */
function minorUnitDigits(currency: string): number {
  try {
    const resolved = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).resolvedOptions().maximumFractionDigits;
    return resolved ?? 2;
  } catch {
    return 2;
  }
}

function toMajorUnits(amountMinor: number, currency: string): number {
  const digits = minorUnitDigits(currency);
  return amountMinor / (10 ** digits);
}

function currencySymbol(currency: string): string {
  try {
    const parts = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).formatToParts(0);
    return parts.find((p) => p.type === 'currency')?.value ?? `${currency} `;
  } catch {
    return `${currency} `;
  }
}

function formatMoneyCompact(amountMinor: number, currency: string): string {
  const amount = toMajorUnits(amountMinor, currency);
  const symbol = currencySymbol(currency);
  const abs = Math.abs(amount);

  if (abs >= 1_000_000) return `${symbol}${(amount / 1_000_000).toFixed(1)}m`;
  if (abs >= 1_000) return `${symbol}${Math.round(amount / 1_000)}k`;
  if (abs >= 100) return `${symbol}${Math.round(amount)}`;
  return `${symbol}${amount.toFixed(2)}`;
}

function formatMoneyFull(amountMinor: number, currency: string): string {
  const amount = toMajorUnits(amountMinor, currency);
  const digits = minorUnitDigits(currency);
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: digits,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(digits)}`;
  }
}

function formatEnterpriseStatusLine(
  snapshot: UsageSnapshot,
  enterprise: EnterpriseUsage,
  width: number,
): string {
  const staleLabel = snapshot.freshness.isStale ? ' stale' : '';
  const pct = formatEnterprisePct(enterprise.utilizationPct);
  const primary = `⊙ E ${pct}${staleLabel}`;

  if (width < 60) {
    return primary;
  }

  const used = formatMoneyCompact(enterprise.usedCredits, enterprise.currency);
  const limit = formatMoneyCompact(enterprise.monthlyLimitCredits, enterprise.currency);
  const full = `${primary} · ${used} / ${limit}`;

  if (full.length <= width) {
    return full;
  }
  return primary;
}

// ANSI color helpers
const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

/**
 * Format the statusline output with width-aware progressive truncation.
 *
 * Truncation priority (SPEC §11.3):
 *   1. Remove secondary reset time
 *   2. Remove primary reset time
 *   3. Remove secondary window
 *   4. Preserve primary utilization as long as possible
 *
 * Default (width >= 60): ⊙ 42% resets 3:00pm · 7d 18% resets sat 7:00am
 * Compact (width < 60):  ⊙ 42%
 * Error:                 ⊙ error
 */
export function formatStatusLine(snapshot: UsageSnapshot, width: number = 80): string {
  if (snapshot.tier === 'enterprise' && snapshot.enterprise) {
    return formatEnterpriseStatusLine(snapshot, snapshot.enterprise, width);
  }

  const { display, fiveHour, sevenDay, sevenDayOpus } = snapshot;

  if (display.primaryUtilizationPct === null) {
    return '⊙ error';
  }

  const primaryPct = `${Math.round(display.primaryUtilizationPct)}%`;
  const staleLabel = snapshot.freshness.isStale ? ' stale' : '';
  const primaryBase = `⊙ ${primaryPct}${staleLabel}`;

  // Compact mode: width < 60
  if (width < 60) {
    return primaryBase;
  }

  // Build primary window with its reset time
  const primaryReset = display.primaryResetsAt
    ? ` resets ${formatLocalDateTime(display.primaryResetsAt).toLowerCase()}`
    : '';
  const primaryPart = primaryBase + primaryReset;

  // Build secondary window with its reset time.
  // With three windows the secondary is "the most constrained of the ones that aren't
  // primary". For a fiveHour/sevenDay primary that reduces to the other of the pair, exactly
  // as before Opus existed; only a sevenDayOpus primary reaches the new branch.
  let secondary: UsageWindow;
  let secondaryLabel: string;
  if (display.primaryWindow === 'fiveHour') {
    secondary = sevenDay;
    secondaryLabel = '7d';
  } else if (display.primaryWindow === 'sevenDay') {
    secondary = fiveHour;
    secondaryLabel = '5h';
  } else {
    // Opus is primary — show whichever of the rolling pair is more constrained.
    const fivePct = fiveHour.utilizationPct;
    const sevenPct = sevenDay.utilizationPct;
    const preferFive = fivePct !== null && (sevenPct === null || fivePct >= sevenPct);
    secondary = preferFive ? fiveHour : sevenDay;
    secondaryLabel = preferFive ? '5h' : '7d';
  }

  // The Opus segment appears only when Opus is present and is not already the primary.
  const opusPart =
    display.primaryWindow !== 'sevenDayOpus' && sevenDayOpus.utilizationPct !== null
      ? `opus ${Math.round(sevenDayOpus.utilizationPct)}%`
      : null;
  let secondaryPart: string | null = null;
  let secondaryBase: string | null = null;
  if (secondary.utilizationPct !== null) {
    secondaryBase = `${secondaryLabel} ${Math.round(secondary.utilizationPct)}%`;
    const secondaryReset = secondary.resetsAt
      ? ` resets ${formatLocalDateTime(secondary.resetsAt).toLowerCase()}`
      : '';
    secondaryPart = secondaryBase + secondaryReset;
  }

  // Widest form: primary · secondary · opus. Opus is the first thing dropped when the
  // terminal is narrow, so every pre-Opus width behaviour below is reached unchanged.
  if (secondaryPart && opusPart) {
    const withOpus = `${primaryPart} · ${secondaryPart} · ${opusPart}`;
    if (withOpus.length <= width) {
      return withOpus;
    }
  }

  // Try full format: primary resets X · secondary resets Y
  if (secondaryPart) {
    const fullLine = `${primaryPart} · ${secondaryPart}`;
    if (fullLine.length <= width) {
      return fullLine;
    }
  }

  // Truncation step 1: drop secondary reset time
  if (secondaryBase) {
    const line = `${primaryPart} · ${secondaryBase}`;
    if (line.length <= width) {
      return line;
    }
  }

  // Truncation step 2: drop primary reset time too
  if (secondaryBase) {
    const line = `${primaryBase} · ${secondaryBase}`;
    if (line.length <= width) {
      return line;
    }
  }

  // Truncation step 3: primary with reset only
  if (primaryPart.length <= width) {
    return primaryPart;
  }

  // Truncation step 4: primary pct only
  return primaryBase;
}

/**
 * Build a progress bar using dot characters.
 * Filled dots = ● (colored by threshold), empty = ○ (gray).
 */
function progressBar(pct: number, slots: number = 10): string {
  const filled = Math.round((pct / 100) * slots);
  const empty = slots - filled;
  const color = pct >= 90 ? c.red : pct >= 70 ? c.yellow : c.green;
  return color + '●'.repeat(filled) + c.gray + '○'.repeat(empty) + c.reset;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}

function pctColor(pct: number): string {
  if (pct >= 90) return c.red;
  if (pct >= 70) return c.yellow;
  return c.green;
}

/**
 * Format a multi-line Claude Code statusline with ANSI colors.
 *
 * Line 1: session info (project, branch, context tokens, context %)
 * Line 2: current + weekly usage with progress bars
 * Line 3: model | reset times
 */
export function formatRichStatusLine(
  snapshot: UsageSnapshot,
  session: SessionInfo | null,
): string {
  const lines: string[] = [];

  // --- Line 1: Session info ---
  if (session) {
    const parts: string[] = [];

    if (session.workspace?.project_dir) {
      const dir = session.workspace.project_dir;
      const name = dir.split(/[/\\]/).pop() ?? dir;
      parts.push(`${c.green}${name}${c.reset}`);
    }

    if (session.context_window) {
      const cw = session.context_window;
      const used = cw.total_input_tokens ?? 0;
      const total = cw.context_window_size ?? 200000;
      const pct = cw.used_percentage ?? Math.round((used / total) * 100);
      parts.push(`${formatTokenCount(used)} / ${formatTokenCount(total)}`);
      parts.push(`${pctColor(pct)}${pct}%${c.reset}`);
    }

    if (parts.length > 0) {
      lines.push(parts.join(` ${c.dim}|${c.reset} `));
    }
  }

  // --- Line 2: Usage bars ---
  const { fiveHour, sevenDay, sevenDayOpus, enterprise, tier } = snapshot;

  if (tier === 'enterprise' && enterprise) {
    const pct = enterprise.utilizationPct;
    const pctText = formatEnterprisePct(pct);
    const bar = progressBar(Math.min(100, Math.round(pct)));
    const used = formatMoneyCompact(enterprise.usedCredits, enterprise.currency);
    const limit = formatMoneyCompact(enterprise.monthlyLimitCredits, enterprise.currency);
    const label = `${c.magenta}Enterprise${c.reset}`;
    const value = `${pctColor(pct)}${pctText}${c.reset} ${c.dim}(${used} / ${limit})${c.reset}`;
    lines.push(`${label}: ${bar} ${value}`);
  } else {
    const usageParts: string[] = [];

    if (fiveHour.utilizationPct !== null) {
      const pct = Math.round(fiveHour.utilizationPct);
      usageParts.push(`current: ${progressBar(pct)} ${pctColor(pct)}${pct}%${c.reset}`);
    }

    if (sevenDay.utilizationPct !== null) {
      const pct = Math.round(sevenDay.utilizationPct);
      usageParts.push(`weekly: ${progressBar(pct)} ${pctColor(pct)}${pct}%${c.reset}`);
    }

    if (sevenDayOpus.utilizationPct !== null) {
      const pct = Math.round(sevenDayOpus.utilizationPct);
      usageParts.push(`opus: ${progressBar(pct)} ${pctColor(pct)}${pct}%${c.reset}`);
    }

    if (usageParts.length > 0) {
      lines.push(usageParts.join(` ${c.dim}|${c.reset} `));
    } else {
      lines.push(`${c.red}⊙ no usage data${c.reset}`);
    }
  }

  // --- Line 3: Model + reset times ---
  const line3Parts: string[] = [];

  if (session?.model?.display_name) {
    line3Parts.push(`${c.magenta}${session.model.display_name}${c.reset}`);
  }

  if (fiveHour.resetsAt) {
    line3Parts.push(`resets ${formatLocalDateTime(fiveHour.resetsAt).toLowerCase()}`);
  }
  if (sevenDay.resetsAt) {
    line3Parts.push(`resets ${formatLocalDateTime(sevenDay.resetsAt).toLowerCase()}`);
  }

  if (line3Parts.length > 0) {
    lines.push(line3Parts.join(` ${c.dim}|${c.reset} `));
  }

  return lines.join('\n');
}

/**
 * Format the VS Code tooltip content (SPEC §10.4).
 *
 * Uses formatLocalDateTime so non-today reset times include the day name.
 */
export interface LastErrorInfo {
  httpStatus: number | null;
  message: string | null;
}

export function formatTooltip(snapshot: UsageSnapshot, lastError?: LastErrorInfo | null): string {
  const lines: string[] = ['ClaudeWatch', ''];

  if (snapshot.tier === 'enterprise' && snapshot.enterprise) {
    const e = snapshot.enterprise;
    lines.push('Plan: Enterprise');
    const pctText = formatEnterprisePct(e.utilizationPct);
    const used = formatMoneyFull(e.usedCredits, e.currency);
    const limit = formatMoneyFull(e.monthlyLimitCredits, e.currency);
    lines.push(`Monthly usage: ${pctText} (${used} of ${limit})`);
    if (!e.isEnabled) {
      const reason = e.disabledReason ? ` — ${e.disabledReason}` : '';
      lines.push(`Extra usage disabled${reason}`);
    }
  } else {
    lines.push('Usage Windows');

    if (snapshot.fiveHour.utilizationPct !== null) {
      let line = `Current (5hr): ${Math.round(snapshot.fiveHour.utilizationPct)}%`;
      if (snapshot.fiveHour.resetsAt) {
        line += ` — resets ${formatLocalDateTime(snapshot.fiveHour.resetsAt)}`;
      }
      lines.push(line);
    }

    if (snapshot.sevenDay.utilizationPct !== null) {
      let line = `Weekly (7d): ${Math.round(snapshot.sevenDay.utilizationPct)}%`;
      if (snapshot.sevenDay.resetsAt) {
        line += ` — resets ${formatLocalDateTime(snapshot.sevenDay.resetsAt)}`;
      }
      lines.push(line);
    }

    if (snapshot.sevenDayOpus.utilizationPct !== null) {
      let line = `Opus (7d): ${Math.round(snapshot.sevenDayOpus.utilizationPct)}%`;
      if (snapshot.sevenDayOpus.resetsAt) {
        line += ` — resets ${formatLocalDateTime(snapshot.sevenDayOpus.resetsAt)}`;
      }
      lines.push(line);
    }
  }

  lines.push('', 'Status');

  if (snapshot.freshness.isStale) {
    lines.push('Showing last known good data; latest refresh failed.');
    if (lastError?.message) {
      lines.push(`Last error: ${lastError.message}`);
    }
  } else {
    const freshTime = formatLocalTime(snapshot.fetchedAt);
    lines.push(`Fresh as of ${freshTime}`);
  }

  lines.push('', 'Click to open usage dashboard →');

  return lines.join('\n');
}

/**
 * Format a percentage for display. Returns "—" for null values.
 */
export function formatPct(pct: number | null): string {
  if (pct === null) return '—';
  return `${Math.round(pct)}%`;
}

/**
 * Format freshness text for display.
 */
export function formatFreshness(snapshot: UsageSnapshot): string {
  if (snapshot.freshness.isStale) {
    return 'Showing last known good data; latest refresh failed.';
  }
  return `Fresh as of ${formatLocalTime(snapshot.fetchedAt)}`;
}
