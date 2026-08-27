import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { makeTestSnapshot } from '@claudewatch/core/test-helpers';
import {
  renderEvent as realRenderEvent,
  utilizationBucket as realUtilizationBucket,
  classify as realClassify,
  evaluate as realEvaluate,
} from '@claudewatch/core';
import type { UsageSnapshot } from '@claudewatch/core';

// `classify` and `evaluate` come straight from the package.
//
// They used to be reimplemented here — 16 lines of domain logic in a surface package, against
// SPEC.md §8.2 — justified by a comment reading "main.test.ts mocks @claudewatch/core globally".
// That was false. Nothing in this repo mocks `@claudewatch/core`; main.test.ts mocks
// './core-deps.js', which is the whole reason core-deps.ts exists (sdlc/001). The comment
// outlived the fix that made it wrong, and the duplicate logic outlived the comment. (sdlc/025)

// The bridge mock doubles as a spy on telemetry emission.
//
// It mocks './statusbar-bridge.js', which `statusbar.ts` alone imports. It used to mock the
// shared './core-bridge.js', and because `mock.module` is process-wide, that also stubbed
// `formatTooltip` for `tooltip.test.ts` — whose subject reaches it through `tooltip.ts`. The
// keys below must match statusbar-bridge.ts's exports exactly: `mock.module` replaces the module
// wholesale, so a missing key is `undefined` at call time rather than a compile error.
const emittedEvents: Array<Record<string, unknown>> = [];

mock.module('./statusbar-bridge.js', () => ({
  classify: realClassify,
  evaluate: realEvaluate,
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

    /**
     * The tooltip is rendered by the REAL formatter, and this is the only assertion in this file
     * that looks at it.
     *
     * statusbar.ts imports buildTooltip from tooltip.js, which imports formatTooltip from
     * core-bridge.js — a module this file no longer mocks. So every mgr.update() here now goes
     * through the real formatter instead of the `formatted: N%` stub. That is a change of subject,
     * not just of wiring, and before sdlc/025 NOTHING in this file read mockItem.tooltip: the
     * tooltip could have been the empty string, or the formatter could have thrown and been
     * swallowed, and all 26 tests stayed green. "Usage Windows" is emitted by format.ts:373 and
     * by nothing the stub ever produced.
     */
    test('renders its tooltip through the real formatter', () => {
      const mgr = new StatusBarManager();
      mgr.update(makeSnapshot());
      const tooltip = mockItem.tooltip as { value: string };
      expect(tooltip.value).toContain('Usage Windows');
      expect(tooltip.value).not.toContain('formatted:');
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
