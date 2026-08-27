import { describe, expect, test, mock } from 'bun:test';
import { makeTestSnapshot } from '@claudewatch/core/test-helpers';
import type { RuntimeState, UsageSnapshot } from '@claudewatch/core';

// Mock vscode module — include all properties needed by any file that imports vscode,
// since bun's mock.module leaks globally across test files.
class MockMarkdownString {
  value = '';
  appendText(text: string): this {
    this.value += text;
    return this;
  }
}

class MockThemeColor {
  constructor(public id: string) {}
}

mock.module('vscode', () => ({
  // env + commands are here for extension.test.ts, not for this file.
  //
  // `mock.module('vscode')` is process-wide and last-writer-wins, and which file writes last
  // depends on when each module scope happens to evaluate, so a stub here can end up serving
  // extension.ts. What is MEASURED, by deleting each key and running the package (sdlc/027
  // Stage 5): removing `env` -> 16 failures, the whole doRefresh suite. It is load-bearing.
  //
  // This is NOT a superset of what every file needs, and an earlier revision of this comment
  // claimed it was. Still absent from both stubs: `Uri`, `window.showInformationMessage`,
  // `window.showErrorMessage`, `env.openExternal` — all reached from commands.ts. Latent only
  // because openDashboard/showDiagnostics are registered and never invoked; the moment
  // extension.test.ts's third `test.todo` becomes a test, this breaks.
  env: { isTelemetryEnabled: false },
  commands: { registerCommand: (): { dispose(): void } => ({ dispose(): void {} }) },
  MarkdownString: MockMarkdownString,
  ThemeColor: MockThemeColor,
  StatusBarAlignment: { Right: 2 },
  window: {
    createStatusBarItem: mock(() => ({
      text: '',
      tooltip: undefined,
      command: undefined,
      name: undefined,
      color: undefined,
      backgroundColor: undefined,
      show: mock(() => {}),
      dispose: mock(() => {}),
    })),
  },
  workspace: {
    // Defensive, and honestly labelled as such: deleting this from both stubs and running the
    // package gives 0 failures, so unlike `env` it is NOT load-bearing in the current evaluation
    // order. It stays because extension.ts:115 calls it unguarded and the order is not a
    // guarantee. An earlier revision justified it by a whole-package throw that does not occur —
    // asserting an invariant the code does not have, which is the exact shape this comment block
    // exists to prevent. (sdlc/027 Stage 5, measured)
    onDidChangeConfiguration: (): { dispose(): void } => ({ dispose(): void {} }),
    getConfiguration: mock(() => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    })),
  },
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
    // The assertion the stub CANNOT satisfy. `toContain('42%')` above matches both the real
    // formatter ("Current (5hr): 42%") and statusbar.test.ts's stub ("formatted: 42%"), which
    // is why these tests passed for four loops while asserting against a stub. format.ts:373
    // emits this line; the stub emits nothing like it. (sdlc/025)
    expect(md.value).toContain('Usage Windows');
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
    expect(md.value).toContain('endpoint may have been updated');
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

// Opus tooltip rendering is covered in packages/core/src/format.test.ts.
//
// It was relocated there because it COULD NOT be asserted here: statusbar.test.ts mocked the
// shared './core-bridge.js' process-wide, so formatTooltip in this file was a stub returning
// "formatted: N%" and a test here would have verified the stub. sdlc/025 split the bridge, so
// that obstacle is gone — this file now sees the real formatter, which is what the
// `toContain('Usage Windows')` assertion above depends on.
//
// The Opus coverage has been LEFT in format.test.ts rather than moved back: where it belongs is
// a separate judgement from whether it can live here, and moving it is not this loop's job.
// See sdlc/002-opus-window/review.md and sdlc/025-vscode-bridge-split/.
