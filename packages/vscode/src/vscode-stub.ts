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
 * `resetVscodeStub()` would trade an accidental coupling for a global one. Every test file that
 * imports this module calls it in `beforeEach`, and `scripts/vscode-stub-cover.ts` fails the build
 * when one does not.
 *
 * The reset restores exactly the set of leaves `pristineLeafPaths()` reports, because it restores
 * from a snapshot taken at load rather than from a list of names — that set equality is the claim
 * this file makes, and `vscode-stub.test.ts` checks it against an independent AST walk. The earlier
 * version of this sentence claimed to be "the only place that knows this stub's pristine shape"
 * while knowing 6 of 13 leaves, which is worse than no docstring: it is the sentence a future
 * author reads instead of checking. (sdlc/040)
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

/**
 * Every `mock()` leaf in `vscodeStub` is built through here, and the reason is a measured one.
 *
 * `mockReset()` drops a mock's implementation (measured on bun 1.3.11 — `mockClear()` does NOT,
 * which is why the reset uses the former), and a snapshot cannot read an implementation back out of
 * a bun mock. So something has to reinstall it, and that something is this map.
 *
 * KEYED BY THE MOCK OBJECT, NOT BY A PATH STRING, AND IT MUST STAY THAT WAY. With a string key, a
 * bijective permutation of two paths — the copy-paste where the second string is edited to another
 * REAL path rather than left duplicated — leaves every path registered exactly once. No
 * missing-registration check fires, and the two implementations silently swap at the first reset:
 * correct before the first `beforeEach` and wrong after it. No test can catch that, because there is
 * no wrong state to observe until the reset runs. With the object as the key the arrangement is not
 * expressible. (sdlc/040 Stage 2 review)
 *
 * The registry records the CONSTRUCTION-TIME implementation. Two consequences worth knowing: a
 * `mockImplementation` applied at construction reverts at the first reset (which is the right
 * reading of "pristine"), and a mock hidden behind a plain-function wrapper is not a mock leaf, so
 * it is captured by reference and its history is never cleared.
 */
const impls = new Map<object, (...args: never[]) => unknown>();

function stubMock<F extends (...args: never[]) => unknown>(impl: F): ReturnType<typeof mock<F>> {
  const m = mock(impl);
  impls.set(m, impl as (...args: never[]) => unknown);
  return m;
}

export const vscodeStub = {
  StatusBarAlignment: { Right: 2 },
  ThemeColor: MockThemeColor,
  MarkdownString: MockMarkdownString,
  Uri: { parse: (s: string) => s },
  env: {
    isTelemetryEnabled: false as unknown,
    openExternal: noop as (u?: unknown) => void,
    // extension.ts subscribes to this behind a `typeof … === 'function'` guard, so its absence
    // fails closed and the subscription is simply skipped. It was absent until the Stage 5
    // security pass fixed the coverage walker's blind spot for cast-wrapped reads, at which point
    // the gate reported it missing. Present now so the branch is reachable — though no test yet
    // drives it, which is recorded in review.md rather than fixed here.
    onDidChangeTelemetryEnabled: ((_cb: () => void) => disposable()) as (cb: () => void) => { dispose(): void },
  },
  window: {
    // Returns the CURRENT item, so `resetVscodeStub()` swaps the item rather than the function —
    // which is what lets `statusbar.test.ts` hold a reference and assert on it.
    createStatusBarItem: stubMock((_alignment?: number, _priority?: number) => state.item),
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
    getConfiguration: stubMock((_section?: string) => ({
      get: <T>(key: string, defaultValue: T): T =>
        key in state.configValues ? (state.configValues[key] as T) : defaultValue,
    })),
    // Defensive, and honestly labelled as such: deleting it and running the package gives 0
    // failures, so unlike `env` it is not load-bearing in the current order. It stays because
    // `extension.ts` calls it unguarded and the order is not a guarantee. (sdlc/027 Stage 5)
    onDidChangeConfiguration: disposable,
  },
};

/** Leaves captured at load. Recursive: `{ env: { isTelemetryEnabled: false, … }, … }`. */
export type Pristine = Record<string, unknown>;

/** A plain `{}`, as opposed to a class instance, an array, a Map or a null-prototype object. */
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && (v as object).constructor === Object;

const isMock = (v: unknown): v is ReturnType<typeof mock> =>
  typeof v === 'function' && 'mockReset' in v;

/**
 * Snapshot every leaf, recursively, so the reset does not need a list of names.
 *
 * Descends into PLAIN OBJECTS ONLY. Functions, classes, primitives, `null` and `undefined` are
 * captured by value or reference — `MockThemeColor` must come back as the SAME constructor or
 * `instanceof` assertions break.
 *
 * THROWS, naming the path, on any other object-valued leaf: an array, a `Map`, a `Date`, a class
 * instance, an `Object.create(null)`. Those would be captured by REFERENCE, which makes the
 * snapshot the live value — it would then corrupt along with the stub, which is the exact failure
 * the recursion exists to prevent, one container up. Refusing loudly beats covering silently. If a
 * future stub needs one of those shapes, extending this is that change's work.
 *
 * `null` is checked before `.constructor` is touched: `typeof null === 'object'`, so the naive
 * order raises a TypeError instead of the named throw.
 */
export function captureLeaves(obj: Record<string, unknown>, prefix = ''): Pristine {
  const out: Pristine = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'object' && value !== null) {
      if (!isPlainObject(value)) {
        throw new Error(
          `captureLeaves: leaf at "${path}" is a ${value.constructor?.name ?? 'null-prototype object'}, ` +
            'which can only be captured by reference — the snapshot would corrupt along with the stub. ' +
            'Extend captureLeaves if the stub needs this shape.',
        );
      }
      out[key] = captureLeaves(value, path);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Walk the snapshot and assign every captured value back onto the live object at the same path.
 *
 * Assignment, not replacement, at every level: replacing a nested object breaks the reference
 * sharing consumers depend on. Assignment also re-adds a leaf a test DELETED, which is free.
 *
 * A mock leaf is reset and its construction-time implementation reinstalled from `registry`. A mock
 * leaf that is not in `registry` THROWS, naming the path the walk found it at — so the name in the
 * message is always the offending leaf, never an innocent one.
 */
export function restoreLeaves(
  obj: Record<string, unknown>,
  pristine: Pristine,
  registry: Map<object, (...args: never[]) => unknown>,
  prefix = '',
): void {
  for (const [key, captured] of Object.entries(pristine)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (isPlainObject(captured)) {
      // The LIVE side may no longer be a container: a test can delete or replace a whole nested
      // object. Without this guard the recursion raises a bare `undefined is not an object`
      // instead of the named error this module promises. (Stage 5 security pass)
      if (!isPlainObject(obj[key])) {
        throw new Error(
          `restoreLeaves: container at "${path}" is no longer an object (found ${String(obj[key])}). ` +
            'A test replaced or deleted it; the reset restores leaves, not container shapes.',
        );
      }
      restoreLeaves(obj[key] as Record<string, unknown>, captured, registry, path);
      continue;
    }
    obj[key] = captured;
    if (isMock(captured)) {
      const impl = registry.get(captured);
      if (impl === undefined) {
        throw new Error(
          `restoreLeaves: mock leaf at "${path}" has no registered implementation. ` +
            'Build it with stubMock(impl) rather than mock(impl).',
        );
      }
      captured.mockReset();
      captured.mockImplementation(impl);
    }
  }
}

/**
 * Captured once, at module load. NOT lazily on the first reset: anything a test mutated between
 * importing this module and its first `beforeEach` would be baked in as "pristine".
 */
const PRISTINE = captureLeaves(vscodeStub as unknown as Record<string, unknown>);

/** The leaf paths the reset restores. Compared in `vscode-stub.test.ts` against an AST oracle. */
export function pristineLeafPaths(): string[] {
  const walk = (o: Pristine, prefix: string): string[] =>
    Object.entries(o).flatMap(([k, v]) => {
      const path = prefix === '' ? k : `${prefix}.${k}`;
      return isPlainObject(v) ? walk(v, path) : [path];
    });
  return walk(PRISTINE, '').toSorted();
}

/**
 * Restore the stub to its pristine shape and hand back the fresh state. Call in `beforeEach` —
 * `scripts/vscode-stub-cover.ts` enforces that, so it is a check rather than a convention.
 *
 * Restores EVERY leaf `pristineLeafPaths()` reports, because it restores from a snapshot rather
 * than from a list of names. That equality is the claim, and `vscode-stub.test.ts` checks it against
 * an independent AST walk of this file. The previous docstring named a leaf count and was stale by
 * four the day it was written. (sdlc/040)
 *
 * The `mock.module` call at the end is not decoration. A resolved module namespace snapshots its
 * TOP-LEVEL keys, and re-registering is what re-syncs them: without it, restoring `ThemeColor` or
 * `MarkdownString` fixes this object while every consumer goes on reading the corrupted namespace.
 * Measured — and the corruption is invisible in the file that causes it, surfacing in the next one.
 */
export function resetVscodeStub(): StubState {
  state = freshState();
  try {
    restoreLeaves(vscodeStub as unknown as Record<string, unknown>, PRISTINE, impls);
  } finally {
    // In a `finally` because the walk is non-atomic: a leaf it cannot restore throws partway, and
    // without this the module namespace would ALSO be left un-re-synced, making the documented
    // limit ("later keys are not restored") quietly broader than stated. The keys that WERE
    // restored still reach consumers. (Stage 5 security pass)
    mock.module('vscode', () => vscodeStub);
  }
  return state;
}
