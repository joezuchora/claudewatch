import { describe, expect, test } from 'bun:test';
import { renderDashboard } from './dashboard.js';
import type { Stats, StoredEvent } from './types.js';

const emptyStats: Stats = {
  totalEvents: 0, bySource: [],
  verify: { runs: 0, passRate: null, p50DurationMs: null, p95DurationMs: null, maxDurationMs: null, timeouts: 0 },
  oldestReceivedAt: null, newestReceivedAt: null,
};

const run = (o: Partial<StoredEvent> & { payload?: Record<string, unknown> } = {}): StoredEvent => ({
  eventId: crypto.randomUUID(), ts: '2026-08-26T03:00:00.000Z', receivedAt: '2026-08-26T03:00:01.000Z',
  source: 'sdlc', kind: 'verify_run', ok: true, durationMs: 35000, schemaVersion: 1,
  payload: { outcome: 'pass' }, ...o,
});

describe('dashboard', () => {
  test('renders with no data without throwing', () => {
    const html = renderDashboard(emptyStats, []);
    expect(html).toContain('ClaudeWatch Metrics');
    expect(html).toContain('No verify runs recorded yet');
  });

  test('references no external assets — it must work offline on a NUC', () => {
    const html = renderDashboard(emptyStats, [run()]);
    expect(html).not.toMatch(/src\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/href\s*=\s*["']https?:/i);
    expect(html).not.toContain('cdn');
    expect(html).not.toContain('fonts.googleapis');
  });

  test('shows recent runs with their outcome and duration', () => {
    const html = renderDashboard(
      { ...emptyStats, verify: { ...emptyStats.verify, runs: 2, passRate: 0.5 } },
      [run(), run({ ok: false, payload: { outcome: 'fail', failedStep: 'lint' } })],
    );
    expect(html).toContain('35.0s');
    expect(html).toContain('lint');
    expect(html).toContain('50%');
  });

  test('flags a suspected hang when the slowest run dwarfs p95', () => {
    const html = renderDashboard({
      ...emptyStats,
      verify: { runs: 20, passRate: 0.9, p50DurationMs: 34000, p95DurationMs: 36000, maxDurationMs: 550000, timeouts: 1 },
    }, [run({ durationMs: 550000, ok: false, payload: { outcome: 'timeout' } })]);
    expect(html).toContain('Possible hang detected');
    expect(html).toContain('timeout');
  });

  test('does not flag a hang when durations are consistent', () => {
    const html = renderDashboard({
      ...emptyStats,
      verify: { runs: 20, passRate: 1, p50DurationMs: 34000, p95DurationMs: 36000, maxDurationMs: 38000, timeouts: 0 },
    }, [run()]);
    expect(html).not.toContain('Possible hang detected');
  });

  test('escapes payload content rather than interpolating it raw', () => {
    const html = renderDashboard(emptyStats, [run({ payload: { outcome: 'pass', failedStep: '<script>alert(1)</script>' } })]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
