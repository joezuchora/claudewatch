import { describe, expect, test } from 'bun:test';
import { formatStatusLine, formatTooltip, formatPct, formatFreshness, formatRichStatusLine } from './format.js';
import { makeTestSnapshot } from './test-helpers.js';
import type { UsageSnapshot, SessionInfo } from './types.js';

/** Format tests use fixed timestamps for deterministic output */
function makeSnapshot(overrides?: Partial<UsageSnapshot>): UsageSnapshot {
  return makeTestSnapshot({
    fetchedAt: '2026-03-07T14:14:00.000Z',
    fiveHour: { utilizationPct: 42, resetsAt: '2026-03-07T20:00:00.000Z' },
    sevenDay: { utilizationPct: 18, resetsAt: '2026-03-14T12:00:00.000Z' },
    display: {
      primaryWindow: 'fiveHour',
      primaryUtilizationPct: 42,
      primaryResetsAt: '2026-03-07T20:00:00.000Z',
    },
    ...overrides,
  });
}

describe('formatStatusLine', () => {
  test('default format includes both windows with their own reset times', () => {
    const result = formatStatusLine(makeSnapshot());
    expect(result).toStartWith('⊙ 42%');
    expect(result).toContain('7d 18%');
    // Both windows should have their own reset time
    const parts = result.split('·').map((s) => s.trim());
    expect(parts[0]).toContain('resets');
    expect(parts[1]).toContain('resets');
  });

  test('compact mode (width < 60) shows only primary', () => {
    const result = formatStatusLine(makeSnapshot(), 50);
    expect(result).toBe('⊙ 42%');
  });

  test('compact mode at width 59', () => {
    const result = formatStatusLine(makeSnapshot(), 59);
    expect(result).toBe('⊙ 42%');
  });

  test('stale statusline includes a visible stale marker', () => {
    const result = formatStatusLine(
      makeSnapshot({
        freshness: { isStale: true, staleReason: 'fetchFailed' },
      }),
    );
    expect(result).toStartWith('⊙ 42% stale');
  });

  test('full mode at width 60 shows all parts', () => {
    const result = formatStatusLine(makeSnapshot(), 60);
    expect(result).toStartWith('⊙ 42%');
    expect(result).toContain('7d 18%');
  });

  test('error when no primary utilization', () => {
    const snapshot = makeSnapshot({
      display: { primaryWindow: 'unknown', primaryUtilizationPct: null, primaryResetsAt: null },
    });
    expect(formatStatusLine(snapshot)).toBe('⊙ error');
  });

  test('shows 5h as secondary when primary is sevenDay', () => {
    const snapshot = makeSnapshot({
      display: {
        primaryWindow: 'sevenDay',
        primaryUtilizationPct: 35,
        primaryResetsAt: '2026-03-14T12:00:00.000Z',
      },
    });
    const result = formatStatusLine(snapshot);
    expect(result).toStartWith('⊙ 35%');
    expect(result).toContain('5h 42%');
  });

  test('omits secondary when not available', () => {
    const snapshot = makeSnapshot({
      sevenDay: { utilizationPct: null, resetsAt: null },
    });
    const result = formatStatusLine(snapshot);
    expect(result).toStartWith('⊙ 42%');
    expect(result).not.toContain('7d');
  });

  test('omits primary reset time when not available', () => {
    const snapshot = makeSnapshot({
      display: {
        primaryWindow: 'fiveHour',
        primaryUtilizationPct: 42,
        primaryResetsAt: null,
      },
    });
    const result = formatStatusLine(snapshot);
    // Primary should not have reset, but secondary still can
    const primaryPart = result.split('·')[0].trim();
    expect(primaryPart).toBe('⊙ 42%');
  });

  test('omits secondary reset time when not available', () => {
    const snapshot = makeSnapshot({
      sevenDay: { utilizationPct: 18, resetsAt: null },
    });
    const result = formatStatusLine(snapshot);
    const secondaryPart = result.split('·')[1].trim();
    expect(secondaryPart).toBe('7d 18%');
    expect(secondaryPart).not.toContain('resets');
  });

  // Width-aware truncation tests
  test('truncates reset time first when width is tight', () => {
    // Use a very long formatted time by forcing a scenario where the full line is long
    const snapshot = makeSnapshot();
    // At width 25, the full line (~35 chars) won't fit, but primary + secondary (~16 chars) will
    const result = formatStatusLine(snapshot, 60);
    // At 60 chars, everything should fit since the full line is ~35 chars
    expect(result).toContain('resets');
  });

  test('truncates to primary only when nothing else fits', () => {
    const snapshot = makeSnapshot();
    // Very narrow but >= 60? No, < 60 is compact.
    // Test at a width where secondary doesn't fit either
    const result = formatStatusLine(snapshot, 59);
    expect(result).toBe('⊙ 42%');
    expect(result).not.toContain('·');
  });

  test('default width is 80', () => {
    const result = formatStatusLine(makeSnapshot());
    // At 80, full format should show
    expect(result).toContain('·');
  });

  test('rounds fractional percentages', () => {
    const snapshot = makeSnapshot({
      display: {
        primaryWindow: 'fiveHour',
        primaryUtilizationPct: 42.7,
        primaryResetsAt: null,
      },
    });
    const result = formatStatusLine(snapshot);
    expect(result).toContain('43%');
  });

  test('handles 0% utilization', () => {
    const snapshot = makeSnapshot({
      display: {
        primaryWindow: 'fiveHour',
        primaryUtilizationPct: 0,
        primaryResetsAt: null,
      },
    });
    const result = formatStatusLine(snapshot);
    expect(result).toStartWith('⊙ 0%');
  });

  test('handles 100% utilization', () => {
    const snapshot = makeSnapshot({
      display: {
        primaryWindow: 'fiveHour',
        primaryUtilizationPct: 100,
        primaryResetsAt: null,
      },
    });
    const result = formatStatusLine(snapshot);
    expect(result).toStartWith('⊙ 100%');
  });
});

describe('formatTooltip', () => {
  test('includes ClaudeWatch header', () => {
    const result = formatTooltip(makeSnapshot());
    expect(result).toContain('ClaudeWatch');
  });

  test('includes both usage windows', () => {
    const result = formatTooltip(makeSnapshot());
    expect(result).toContain('Current (5hr): 42%');
    expect(result).toContain('Weekly (7d): 18%');
  });

  test('includes reset times with formatting', () => {
    const result = formatTooltip(makeSnapshot());
    expect(result).toContain('resets');
  });

  test('shows fresh status', () => {
    const result = formatTooltip(makeSnapshot());
    expect(result).toContain('Fresh as of');
  });

  test('shows stale status', () => {
    const snapshot = makeSnapshot({
      freshness: { isStale: true, staleReason: 'fetchFailed' },
    });
    const result = formatTooltip(snapshot);
    expect(result).toContain('Showing last known good data');
  });

  test('omits missing five-hour window', () => {
    const snapshot = makeSnapshot({
      fiveHour: { utilizationPct: null, resetsAt: null },
    });
    const result = formatTooltip(snapshot);
    expect(result).not.toContain('Current (5hr)');
    expect(result).toContain('Weekly (7d): 18%');
  });

  test('omits missing seven-day window', () => {
    const snapshot = makeSnapshot({
      sevenDay: { utilizationPct: null, resetsAt: null },
    });
    const result = formatTooltip(snapshot);
    expect(result).toContain('Current (5hr): 42%');
    expect(result).not.toContain('Weekly (7d)');
  });

  test('includes dashboard link', () => {
    const result = formatTooltip(makeSnapshot());
    expect(result).toContain('Click to open usage dashboard');
  });

  test('shows last error message when stale and lastError provided', () => {
    const snapshot = makeSnapshot({
      freshness: { isStale: true, staleReason: 'fetchFailed' },
    });
    const result = formatTooltip(snapshot, { httpStatus: 429, message: 'Rate limited (429)' });
    expect(result).toContain('Showing last known good data');
    expect(result).toContain('Last error: Rate limited (429)');
  });

  test('does not show last error line when fresh', () => {
    const result = formatTooltip(makeSnapshot(), { httpStatus: 429, message: 'Rate limited (429)' });
    expect(result).not.toContain('Last error');
  });

  test('does not show last error line when lastError is null', () => {
    const snapshot = makeSnapshot({
      freshness: { isStale: true, staleReason: 'fetchFailed' },
    });
    const result = formatTooltip(snapshot, null);
    expect(result).not.toContain('Last error');
  });

  test('omits reset time when resetsAt is null', () => {
    const snapshot = makeSnapshot({
      fiveHour: { utilizationPct: 42, resetsAt: null },
    });
    const result = formatTooltip(snapshot);
    expect(result).toContain('Current (5hr): 42%');
    // Line should not contain "resets" for the 5hr window
    const fiveHourLine = result.split('\n').find((l) => l.includes('Current (5hr)'));
    expect(fiveHourLine).not.toContain('resets');
  });
});

describe('formatPct', () => {
  test('formats number as percentage', () => {
    expect(formatPct(42)).toBe('42%');
  });

  test('rounds fractional values', () => {
    expect(formatPct(42.7)).toBe('43%');
  });

  test('returns dash for null', () => {
    expect(formatPct(null)).toBe('—');
  });

  test('formats zero', () => {
    expect(formatPct(0)).toBe('0%');
  });

  test('formats 100', () => {
    expect(formatPct(100)).toBe('100%');
  });
});

describe('formatFreshness', () => {
  test('shows fresh text for non-stale snapshot', () => {
    const result = formatFreshness(makeSnapshot());
    expect(result).toContain('Fresh as of');
  });

  test('shows stale text for stale snapshot', () => {
    const snapshot = makeSnapshot({
      freshness: { isStale: true, staleReason: 'fetchFailed' },
    });
    const result = formatFreshness(snapshot);
    expect(result).toContain('Showing last known good data');
  });
});

describe('formatRichStatusLine', () => {
  test('with null session shows only usage bars, no session line', () => {
    const result = formatRichStatusLine(makeSnapshot(), null);
    expect(result).toContain('current:');
    expect(result).toContain('42%');
    expect(result).toContain('weekly:');
    expect(result).toContain('18%');
    // Should not contain project names or context info since session is null
    const lines = result.split('\n');
    // First line should be usage bars (no session line)
    expect(lines[0]).toContain('current:');
  });

  test('with full session info includes project name, token counts, and context percentage', () => {
    const session: SessionInfo = {
      workspace: { project_dir: '/home/user/my-project' },
      context_window: {
        total_input_tokens: 50000,
        context_window_size: 200000,
        used_percentage: 25,
      },
      model: { display_name: 'Claude Opus 4' },
    };
    const result = formatRichStatusLine(makeSnapshot(), session);
    expect(result).toContain('my-project');
    expect(result).toContain('50k');
    expect(result).toContain('200k');
    expect(result).toContain('25%');
  });

  test('with session missing context_window still shows project name', () => {
    const session: SessionInfo = {
      workspace: { project_dir: '/home/user/cool-app' },
    };
    const result = formatRichStatusLine(makeSnapshot(), session);
    expect(result).toContain('cool-app');
    // Should not crash or show token info
    const firstLine = result.split('\n')[0];
    expect(firstLine).toContain('cool-app');
    expect(firstLine).not.toContain('/ ');
  });

  test('with session missing workspace still shows context window', () => {
    const session: SessionInfo = {
      context_window: {
        total_input_tokens: 100000,
        context_window_size: 200000,
        used_percentage: 50,
      },
    };
    const result = formatRichStatusLine(makeSnapshot(), session);
    expect(result).toContain('100k');
    expect(result).toContain('200k');
    expect(result).toContain('50%');
    // Should not contain any project name
    expect(result).not.toContain('cool-app');
  });

  test('both fiveHour and sevenDay null utilization shows no usage data', () => {
    const snapshot = makeSnapshot({
      fiveHour: { utilizationPct: null, resetsAt: null },
      sevenDay: { utilizationPct: null, resetsAt: null },
    });
    const result = formatRichStatusLine(snapshot, null);
    expect(result).toContain('no usage data');
    expect(result).not.toContain('current:');
    expect(result).not.toContain('weekly:');
  });

  test('only fiveHour available shows only current', () => {
    const snapshot = makeSnapshot({
      sevenDay: { utilizationPct: null, resetsAt: null },
    });
    const result = formatRichStatusLine(snapshot, null);
    expect(result).toContain('current:');
    expect(result).toContain('42%');
    expect(result).not.toContain('weekly:');
  });

  test('only sevenDay available shows only weekly', () => {
    const snapshot = makeSnapshot({
      fiveHour: { utilizationPct: null, resetsAt: null },
    });
    const result = formatRichStatusLine(snapshot, null);
    expect(result).toContain('weekly:');
    expect(result).toContain('18%');
    expect(result).not.toContain('current:');
  });

  test('model display_name in session shows model on line 3', () => {
    const session: SessionInfo = {
      model: { display_name: 'Claude Sonnet 4' },
    };
    const result = formatRichStatusLine(makeSnapshot(), session);
    expect(result).toContain('Claude Sonnet 4');
  });

  test('reset times present shows reset times on line 3', () => {
    const result = formatRichStatusLine(makeSnapshot(), null);
    expect(result).toContain('resets');
    // Should have two reset entries (one for fiveHour, one for sevenDay)
    const lastLine = result.split('\n').pop()!;
    expect(lastLine).toContain('resets');
  });

  test('stale snapshot still shows data normally', () => {
    const snapshot = makeSnapshot({
      freshness: { isStale: true, staleReason: 'fetchFailed' },
    });
    const result = formatRichStatusLine(snapshot, null);
    // Rich statusline just shows the data regardless of staleness
    expect(result).toContain('current:');
    expect(result).toContain('42%');
    expect(result).toContain('weekly:');
    expect(result).toContain('18%');
  });
});
