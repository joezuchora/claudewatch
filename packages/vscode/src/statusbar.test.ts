import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { makeTestSnapshot } from '@claudewatch/core/test-helpers';
import { renderEvent as realRenderEvent, utilizationBucket as realUtilizationBucket } from '@claudewatch/core';
import type { UsageSnapshot, RuntimeState, ThresholdLevel } from '@claudewatch/core';

// Re-register @claudewatch/core with real classify/evaluate to prevent mock leaks
// from other test files (main.test.ts mocks @claudewatch/core globally).
// We inline the real implementations since the leaked mock overrides the package.
function realClassify(snapshot: UsageSnapshot): RuntimeState {
  if (snapshot.authState === 'invalid') return 'AuthInvalid';
  if (snapshot.authState === 'missing') return 'NotConfigured';
  const hasValid = snapshot.fiveHour.utilizationPct !== null || snapshot.sevenDay.utilizationPct !== null;
  if (snapshot.freshness.isStale) {
    if (hasValid) return snapshot.freshness.staleReason === 'malformedResponse' ? 'Degraded' : 'Stale';
    return snapshot.freshness.staleReason === 'malformedResponse' ? 'Degraded' : 'HardFailure';
  }
  return hasValid ? 'Healthy' : 'Degraded';
}

function realEvaluate(pct: number, warnPct: number = 70, critPct: number = 90): ThresholdLevel {
  if (pct >= critPct) return 'critical';
  if (pct >= warnPct) return 'warning';
  return 'normal';
}

// The bridge mock doubles as a spy on telemetry emission. sdlc/003's residual finding is
// that this mock is process-wide within packages/vscode; here that works in our favour.
const emittedEvents: Array<Record<string, unknown>> = [];

mock.module('./core-bridge.js', () => ({
  classify: realClassify,
  evaluate: realEvaluate,
  formatTooltip: (snapshot: UsageSnapshot) => `formatted: ${snapshot.display.primaryUtilizationPct}%`,
  makeTestSnapshot,
  emitProcess: (e: Record<string, unknown>) => { emittedEvents.push(e); },
  renderEvent: realRenderEvent,
  utilizationBucket: realUtilizationBucket,
}));

// --- Mock vscode module ---

class MockThemeColor {
  constructor(public id: string) {}
}

class MockMarkdownString {
  value = '';
  appendText(text: string): MockMarkdownString {
    this.value += text;
    return this;
  }
}

function createMockStatusBarItem() {
  return {
    text: '',
    tooltip: undefined as unknown,
    command: undefined as string | undefined,
    name: undefined as string | undefined,
    color: undefined as unknown,
    backgroundColor: undefined as unknown,
    show: mock(() => {}),
    dispose: mock(() => {}),
  };
}

let mockItem = createMockStatusBarItem();
let configValues: Record<string, unknown> = {};

// Store mock as module-level object so we can reference it directly
// (avoids issues with mock.module leaking across test files in CI)
const vscodeMock = {
  StatusBarAlignment: { Right: 2 },
  ThemeColor: MockThemeColor,
  MarkdownString: MockMarkdownString,
  window: {
    createStatusBarItem: mock((_alignment: number, _priority: number) => mockItem),
  },
  workspace: {
    getConfiguration: mock((_section: string) => ({
      get: <T>(key: string, defaultValue: T): T => {
        if (key in configValues) return configValues[key] as T;
        return defaultValue;
      },
    })),
  },
};

mock.module('vscode', () => vscodeMock);

const { StatusBarManager } = await import('./statusbar.js');

// --- Helpers ---

function makeSnapshot(overrides?: Partial<UsageSnapshot>): UsageSnapshot {
  return makeTestSnapshot({
    fetchedAt: '2026-03-07T12:00:00.000Z',
    ...overrides,
  });
}

// --- Tests ---

describe('StatusBarManager', () => {
  beforeEach(() => {
    mockItem = createMockStatusBarItem();
    configValues = {};
    (vscodeMock.window.createStatusBarItem as ReturnType<typeof mock>).mockImplementation(
      () => mockItem,
    );
  });

  describe('constructor', () => {
    test('creates item with Right alignment and priority 100', () => {
      new StatusBarManager();
      expect(vscodeMock.window.createStatusBarItem).toHaveBeenCalledWith(2, 100);
    });

    test('sets command to claudewatch.openDashboard', () => {
      new StatusBarManager();
      expect(mockItem.command).toBe('claudewatch.openDashboard');
    });

    test('sets name to ClaudeWatch', () => {
      new StatusBarManager();
      expect(mockItem.name).toBe('ClaudeWatch');
    });

    test('shows the item', () => {
      new StatusBarManager();
      expect(mockItem.show).toHaveBeenCalled();
    });
  });

  describe('update with null snapshot', () => {
    test('shows warning icon when not loading', () => {
      const mgr = new StatusBarManager();
      mgr.update(null, false);
      expect(mockItem.text).toBe('$(warning) ClaudeWatch');
    });

    test('shows spinner when loading', () => {
      const mgr = new StatusBarManager();
      mgr.update(null, true);
      expect(mockItem.text).toBe('$(sync~spin) ClaudeWatch');
    });

    test('clears color and backgroundColor', () => {
      const mgr = new StatusBarManager();
      mgr.update(null, false);
      expect(mockItem.color).toBeUndefined();
      expect(mockItem.backgroundColor).toBeUndefined();
    });
  });

  describe('update with healthy snapshot', () => {
    test('shows graph icon with percentage', () => {
      const mgr = new StatusBarManager();
      mgr.update(makeSnapshot());
      expect(mockItem.text).toBe('$(graph) 42%');
    });

    test('shows spinner with percentage when loading', () => {
      const mgr = new StatusBarManager();
      mgr.update(makeSnapshot(), true);
      expect(mockItem.text).toBe('$(sync~spin) 42%');
    });
  });

  describe('update with stale snapshot', () => {
    test('shows graph icon with percentage', () => {
      const mgr = new StatusBarManager();
      const snapshot = makeSnapshot({
        freshness: { isStale: true, staleReason: 'fetchFailed' },
      });
      mgr.update(snapshot);
      expect(mockItem.text).toBe('$(graph) 42%');
    });
  });

  describe('update with null primaryUtilizationPct', () => {
    test('shows em dash when pct is null', () => {
      const mgr = new StatusBarManager();
      const snapshot = makeSnapshot({
        display: {
          primaryWindow: 'fiveHour',
          primaryUtilizationPct: null,
          primaryResetsAt: '2026-03-07T17:00:00.000Z',
        },
      });
      mgr.update(snapshot);
      expect(mockItem.text).toBe('$(graph) —');
    });
  });

  describe('threshold colors', () => {
    test('normal (< 70%) has no color or backgroundColor', () => {
      const mgr = new StatusBarManager();
      mgr.update(makeSnapshot({ display: { primaryWindow: 'fiveHour', primaryUtilizationPct: 50, primaryResetsAt: '2026-03-07T17:00:00.000Z' } }));
      expect(mockItem.color).toBeUndefined();
      expect(mockItem.backgroundColor).toBeUndefined();
    });

    test('warning (70-89%) uses warningForeground and warningBackground', () => {
      const mgr = new StatusBarManager();
      mgr.update(makeSnapshot({ display: { primaryWindow: 'fiveHour', primaryUtilizationPct: 75, primaryResetsAt: '2026-03-07T17:00:00.000Z' } }));
      expect(mockItem.color).toBeInstanceOf(MockThemeColor);
      expect((mockItem.color as MockThemeColor).id).toBe('statusBarItem.warningForeground');
      expect(mockItem.backgroundColor).toBeInstanceOf(MockThemeColor);
      expect((mockItem.backgroundColor as MockThemeColor).id).toBe('statusBarItem.warningBackground');
    });

    test('critical (>= 90%) uses errorForeground and errorBackground', () => {
      const mgr = new StatusBarManager();
      mgr.update(makeSnapshot({ display: { primaryWindow: 'fiveHour', primaryUtilizationPct: 95, primaryResetsAt: '2026-03-07T17:00:00.000Z' } }));
      expect(mockItem.color).toBeInstanceOf(MockThemeColor);
      expect((mockItem.color as MockThemeColor).id).toBe('statusBarItem.errorForeground');
      expect(mockItem.backgroundColor).toBeInstanceOf(MockThemeColor);
      expect((mockItem.backgroundColor as MockThemeColor).id).toBe('statusBarItem.errorBackground');
    });
  });

  describe('custom thresholds', () => {
    test('uses configured warning and critical thresholds', () => {
      configValues = {
        warningThresholdPct: 50,
        criticalThresholdPct: 80,
      };
      const mgr = new StatusBarManager();
      // 60% would be normal with defaults, but warning with custom warn=50
      mgr.update(makeSnapshot({ display: { primaryWindow: 'fiveHour', primaryUtilizationPct: 60, primaryResetsAt: '2026-03-07T17:00:00.000Z' } }));
      expect((mockItem.color as MockThemeColor).id).toBe('statusBarItem.warningForeground');
      expect((mockItem.backgroundColor as MockThemeColor).id).toBe('statusBarItem.warningBackground');
    });

    test('custom critical threshold triggers critical color', () => {
      configValues = {
        warningThresholdPct: 50,
        criticalThresholdPct: 80,
      };
      const mgr = new StatusBarManager();
      // 85% would be warning with defaults, but critical with custom crit=80
      mgr.update(makeSnapshot({ display: { primaryWindow: 'fiveHour', primaryUtilizationPct: 85, primaryResetsAt: '2026-03-07T17:00:00.000Z' } }));
      expect((mockItem.color as MockThemeColor).id).toBe('statusBarItem.errorForeground');
      expect((mockItem.backgroundColor as MockThemeColor).id).toBe('statusBarItem.errorBackground');
    });
  });

  describe('Degraded state', () => {
    test('shows warning text with errorForeground', () => {
      const mgr = new StatusBarManager();
      const snapshot = makeSnapshot({
        freshness: { isStale: true, staleReason: 'malformedResponse' },
      });
      mgr.update(snapshot);
      expect(mockItem.text).toBe('$(warning) ClaudeWatch');
      expect((mockItem.color as MockThemeColor).id).toBe('errorForeground');
      expect(mockItem.backgroundColor).toBeUndefined();
    });
  });

  describe('AuthInvalid state', () => {
    test('shows warning text with errorForeground', () => {
      const mgr = new StatusBarManager();
      const snapshot = makeSnapshot({ authState: 'invalid' });
      mgr.update(snapshot);
      expect(mockItem.text).toBe('$(warning) ClaudeWatch');
      expect((mockItem.color as MockThemeColor).id).toBe('errorForeground');
      expect(mockItem.backgroundColor).toBeUndefined();
    });
  });

  describe('NotConfigured state', () => {
    test('shows warning text with errorBackground', () => {
      const mgr = new StatusBarManager();
      const snapshot = makeSnapshot({ authState: 'missing' });
      mgr.update(snapshot);
      expect(mockItem.text).toBe('$(warning) ClaudeWatch');
      expect(mockItem.color).toBeUndefined();
      expect((mockItem.backgroundColor as MockThemeColor).id).toBe('statusBarItem.errorBackground');
    });
  });

  describe('HardFailure state', () => {
    test('shows warning text with errorForeground', () => {
      const mgr = new StatusBarManager();
      const snapshot = makeSnapshot({
        fiveHour: { utilizationPct: null, resetsAt: null },
        sevenDay: { utilizationPct: null, resetsAt: null },
        freshness: { isStale: true, staleReason: 'fetchFailed' },
      });
      mgr.update(snapshot);
      expect(mockItem.text).toBe('$(warning) ClaudeWatch');
      expect((mockItem.color as MockThemeColor).id).toBe('errorForeground');
      expect(mockItem.backgroundColor).toBeUndefined();
    });
  });

  describe('updateThresholds', () => {
    test('reads updated thresholds from configuration', () => {
      const mgr = new StatusBarManager();
      // Initially default thresholds (70/90)
      mgr.update(makeSnapshot({ display: { primaryWindow: 'fiveHour', primaryUtilizationPct: 60, primaryResetsAt: '2026-03-07T17:00:00.000Z' } }));
      // 60% is normal with defaults
      expect(mockItem.color).toBeUndefined();

      // Now change config to lower thresholds
      configValues = {
        warningThresholdPct: 50,
        criticalThresholdPct: 80,
      };
      mgr.updateThresholds();

      // Now 60% should be warning with new thresholds
      mgr.update(makeSnapshot({ display: { primaryWindow: 'fiveHour', primaryUtilizationPct: 60, primaryResetsAt: '2026-03-07T17:00:00.000Z' } }));
      expect((mockItem.color as MockThemeColor).id).toBe('statusBarItem.warningForeground');
    });
  });

  describe('dispose', () => {
    test('calls item.dispose()', () => {
      const mgr = new StatusBarManager();
      mgr.dispose();
      expect(mockItem.dispose).toHaveBeenCalled();
    });
  });
});

describe('StatusBarManager: telemetry emission', () => {
  test('a render emits exactly one render event carrying enumerated leaves only', () => {
    emittedEvents.length = 0;
    const bar = new StatusBarManager();
    bar.update(makeTestSnapshot());

    expect(emittedEvents).toHaveLength(1);
    const e = emittedEvents[0] as { kind: string; source: string; payload: Record<string, unknown> };
    expect(e.kind).toBe('render');
    expect(e.source).toBe('product');
    expect(e.payload.surface).toBe('vscode');
    expect(e.payload.runtimeState).toBe('Healthy');
    expect(e.payload.tier).toBe('standard');
    // A decile, never the raw 42.
    expect(e.payload.utilizationBucket).toBe(4);
    expect(JSON.stringify(e.payload)).not.toContain('42');
  });

  test('every update emits, since update() is the render funnel', () => {
    emittedEvents.length = 0;
    const bar = new StatusBarManager();
    bar.update(makeTestSnapshot());
    bar.update(makeTestSnapshot());
    bar.update(makeTestSnapshot());
    expect(emittedEvents).toHaveLength(3);
  });

  test('the initializing path emits nothing — there is no snapshot to describe', () => {
    emittedEvents.length = 0;
    const bar = new StatusBarManager();
    bar.update(null, true);
    bar.update(null, false);
    expect(emittedEvents).toHaveLength(0);
  });

  test('a degraded snapshot still emits, with its state', () => {
    emittedEvents.length = 0;
    const bar = new StatusBarManager();
    bar.update(makeTestSnapshot({
      fiveHour: { utilizationPct: null, resetsAt: null },
      sevenDay: { utilizationPct: null, resetsAt: null },
      display: { primaryWindow: 'unknown', primaryUtilizationPct: null, primaryResetsAt: null },
    }));
    expect(emittedEvents).toHaveLength(1);
    const e = emittedEvents[0] as { payload: Record<string, unknown> };
    expect(e.payload.utilizationBucket).toBeNull();
  });
});
