/**
 * The one `vscode` stub for this package's tests. (sdlc/039)
 *
 * WHY THERE IS EXACTLY ONE. `mock.module` is process-wide, and when several files each supply a
 * factory for the same specifier, a consumer does NOT see their union — each top-level key's value
 * comes wholesale from one factory, and which one wins is decided by bun's load order (measured:
 * `statusbar, telemetry-gate, manifest, extension, commands, tooltip` — neither alphabetical nor
 * documented).
 *
 * The reproduction, if you are tempted to split this back up: remove `Uri` from the `statusbar`,
 * `commands` and `tooltip` factories, leave it defined in `extension.test.ts`, and run
 * `bun test packages/vscode/src/`. Result — 72 pass, 5 fail, `TypeError: undefined is not an
 * object (evaluating 'v.Uri.parse')`. A key that one file declares is simply absent for everyone
 * else. That is the configuration `sdlc/028` was opened to fix, and it is why per-file stubs are
 * not a style preference.
 *
 * WHY IT IS ALSO A RESET. One shared object is one shared MUTABLE object: `commands.test.ts`
 * replaces `window.showInformationMessage` and `env.openExternal` with recording sinks, and
 * `statusbar.test.ts` needs a fresh status-bar item per test. Consolidating without
 * `resetVscodeStub()` would trade an accidental coupling for a global one. Every test file calls
 * it in `beforeEach`; it is the only place that knows this stub's pristine shape.
 *
 * Not a `*.test.ts`, so `bun test` does not run it. It is imported, never mocked, so
 * `scripts/mock-topology.ts` has nothing to say about it — and if a future edit ever mocks it,
 * that guard should and will complain.
 */
import { mock } from 'bun:test';

export class MockThemeColor {
  constructor(public id: string) {}
}

export class MockMarkdownString {
  value = '';
  appendText(text: string): this {
    this.value += text;
    return this;
  }
}

export interface MockStatusBarItem {
  text: string;
  tooltip: unknown;
  command: string | undefined;
  name: string | undefined;
  color: unknown;
  backgroundColor: unknown;
  show: ReturnType<typeof mock>;
  dispose: ReturnType<typeof mock>;
}

export function createMockStatusBarItem(): MockStatusBarItem {
  return {
    text: '',
    tooltip: undefined,
    command: undefined,
    name: undefined,
    color: undefined,
    backgroundColor: undefined,
    show: mock(() => {}),
    dispose: mock(() => {}),
  };
}

export interface StubState {
  /** The item every `createStatusBarItem()` call returns until the next reset. */
  item: MockStatusBarItem;
  /** Consulted by `workspace.getConfiguration().get`; empty means "always the default". */
  configValues: Record<string, unknown>;
  /** Written by `commands.registerCommand`, so a test can invoke a command the way a user does. */
  registered: Map<string, (...args: unknown[]) => unknown>;
}

function freshState(): StubState {
  return { item: createMockStatusBarItem(), configValues: {}, registered: new Map() };
}

let state: StubState = freshState();

const noop = (): void => {};
const disposable = (): { dispose(): void } => ({ dispose: noop });

export const vscodeStub = {
  StatusBarAlignment: { Right: 2 },
  ThemeColor: MockThemeColor,
  MarkdownString: MockMarkdownString,
  Uri: { parse: (s: string) => s },
  env: { isTelemetryEnabled: false as unknown, openExternal: noop as (u?: unknown) => void },
  window: {
    // Returns the CURRENT item, so `resetVscodeStub()` swaps the item rather than the function —
    // which is what lets `statusbar.test.ts` hold a reference and assert on it.
    createStatusBarItem: mock((_alignment?: number, _priority?: number) => state.item),
    showInformationMessage: noop as (msg?: string, opts?: unknown) => void,
    showErrorMessage: noop as (msg?: string) => void,
  },
  commands: {
    registerCommand: (id: string, cb: (...args: unknown[]) => unknown): { dispose(): void } => {
      state.registered.set(id, cb);
      return {
        dispose(): void {
          state.registered.delete(id);
        },
      };
    },
  },
  workspace: {
    getConfiguration: mock((_section?: string) => ({
      get: <T>(key: string, defaultValue: T): T =>
        key in state.configValues ? (state.configValues[key] as T) : defaultValue,
    })),
    // Defensive, and honestly labelled as such: deleting it and running the package gives 0
    // failures, so unlike `env` it is not load-bearing in the current order. It stays because
    // `extension.ts` calls it unguarded and the order is not a guarantee. (sdlc/027 Stage 5)
    onDidChangeConfiguration: disposable,
  },
};

/**
 * Restore the stub to its pristine shape and hand back the fresh state. Call in `beforeEach`.
 *
 * Restores the two leaves tests overwrite, clears the two `mock()`s so call counts do not leak
 * between tests, and installs a new item, config map and command registry.
 */
export function resetVscodeStub(): StubState {
  state = freshState();
  vscodeStub.env.isTelemetryEnabled = false;
  vscodeStub.env.openExternal = noop;
  vscodeStub.window.showInformationMessage = noop;
  vscodeStub.window.showErrorMessage = noop;
  vscodeStub.window.createStatusBarItem.mockClear();
  vscodeStub.workspace.getConfiguration.mockClear();
  return state;
}
