import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { makeTestSnapshot } from '@claudewatch/core/test-helpers';
import type { RuntimeState, UsageSnapshot } from '@claudewatch/core';

// Mock vscode.MarkdownString
class MockMarkdownString {
  value = '';
  appendText(text: string): this {
    this.value += text;
    return this;
  }
}

// Must mock before importing tooltip
mock.module('vscode', () => ({
  MarkdownString: MockMarkdownString,
}));

const { buildTooltip } = await import('./tooltip.js');

/** Tooltip tests use a fixed timestamp for deterministic output */
function makeSnapshot(overrides?: Partial<UsageSnapshot>): UsageSnapshot {
  return makeTestSnapshot({
    fetchedAt: '2026-03-07T12:00:00.000Z',
    ...overrides,
  });
}

describe('buildTooltip', () => {
  test('NotConfigured shows credentials message', () => {
    const md = buildTooltip('NotConfigured', null);
    expect(md.value).toContain('credentials not found');
  });

  test('AuthInvalid shows re-authenticate message', () => {
    const md = buildTooltip('AuthInvalid', null);
    expect(md.value).toContain('invalid or expired');
  });

  test('HardFailure shows endpoint changed message', () => {
    const md = buildTooltip('HardFailure', null);
    expect(md.value).toContain('endpoint may have changed');
  });

  test('Initializing shows loading message', () => {
    const md = buildTooltip('Initializing', null);
    expect(md.value).toContain('Loading usage data');
  });

  test('Healthy with snapshot uses formatTooltip', () => {
    const snapshot = makeSnapshot();
    const md = buildTooltip('Healthy', snapshot);
    // formatTooltip output should be present, not the error fallback
    expect(md.value).not.toContain('unexpected error');
    expect(md.value).toContain('42%');
  });

  test('Healthy without snapshot falls back to error text', () => {
    const md = buildTooltip('Healthy', null);
    expect(md.value).toContain('ClaudeWatch');
  });

  test('Degraded with snapshot shows warning, not formatted data', () => {
    const snapshot = makeSnapshot({
      freshness: { isStale: true, staleReason: 'malformedResponse' },
    });
    const md = buildTooltip('Degraded', snapshot);
    expect(md.value).toContain('endpoint may have changed');
    expect(md.value).not.toContain('42%');
  });

  test('Stale with snapshot uses formatTooltip', () => {
    const snapshot = makeSnapshot({
      freshness: { isStale: true, staleReason: 'fetchFailed' },
    });
    const md = buildTooltip('Stale', snapshot);
    expect(md.value).toContain('42%');
  });

  test('unknown state shows generic fallback', () => {
    const md = buildTooltip('SomeFutureState' as RuntimeState, null);
    expect(md.value).toContain('unexpected error');
  });

  test('every RuntimeState error key has a message', () => {
    const errorStates: RuntimeState[] = [
      'Initializing', 'AuthInvalid', 'NotConfigured', 'HardFailure',
      'Stale', 'Degraded',
    ];
    for (const state of errorStates) {
      const md = buildTooltip(state, null);
      expect(md.value).not.toContain('unexpected error');
    }
  });
});
