/**
 * Tests for the shared `vscode` stub's reset. (sdlc/040)
 *
 * The loop's premise is that `resetVscodeStub()` restored 6 of the stub's 13 leaves while its
 * docstring claimed to know the pristine shape. The fix is a snapshot rather than a list of names,
 * so the tests here are mostly ENUMERATIONS: they walk the stub and assert a property of every
 * leaf, rather than naming the leaves anyone happened to think of.
 *
 * This file imports `providedMembers` from `scripts/vscode-stub-cover.ts`. That is a deliberate
 * cross-boundary import and it is the point of A9: an AST parse is an INDEPENDENT oracle for the
 * leaf set, where a second runtime walk written here would assert `A === A` and hold for any broken
 * implementation. Test-only; nothing bundled reaches across.
 */
import { beforeEach, describe, expect, test, mock } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  captureLeaves,
  restoreLeaves,
  pristineLeafPaths,
  resetVscodeStub,
  vscodeStub,
  type StubState,
} from './vscode-stub.js';
import { providedMembers } from '../../../scripts/vscode-stub-cover.js';

const STUB_PATH = join(import.meta.dir, 'vscode-stub.ts');
const TOOLTIP_TEST_PATH = join(import.meta.dir, 'tooltip.test.ts');

let state: StubState;
// This file imports `vscodeStub`, so the gate it tests requires this hook of it too.
beforeEach(() => {
  state = resetVscodeStub();
});

type Rec = Record<string, unknown>;

/** An independent walker: the tests must not share the implementation's idea of what a leaf is. */
function walkLeaves(obj: Rec, prefix = ''): { path: string; value: unknown }[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const path = prefix === '' ? k : `${prefix}.${k}`;
    const plain = typeof v === 'object' && v !== null && (v as object).constructor === Object;
    return plain ? walkLeaves(v as Rec, path) : [{ path, value: v }];
  });
}

function setAtPath(obj: Rec, path: string, value: unknown): void {
  const parts = path.split('.');
  const last = parts.pop() as string;
  let cur = obj;
  for (const p of parts) cur = cur[p] as Rec;
  cur[last] = value;
}

function getAtPath(obj: Rec, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, p) => (acc as Rec)[p], obj);
}

describe('A1 — every leaf is restored, enumerated rather than listed', () => {
  test('restores every leaf of vscodeStub', () => {
    const stub = vscodeStub as unknown as Rec;
    const leaves = walkLeaves(stub);
    // Not an equality: a leaf added tomorrow must not redden this. A floor stops an enumeration
    // that silently found nothing from passing, which is the only way this test can lie.
    expect(leaves.length).toBeGreaterThanOrEqual(13);

    for (const { path } of leaves) {
      const original = getAtPath(stub, path);
      const sentinel = `SENTINEL-${path}`;
      setAtPath(stub, path, sentinel);
      // The overwrite must actually change the value, or the round-trip proves nothing:
      // `env.isTelemetryEnabled` is `false`, and a walker writing `false` would pass vacuously.
      expect(`${path}: ${String(getAtPath(stub, path) === original)}`).toBe(`${path}: false`);

      resetVscodeStub();

      // Identity against the recorded original, not inequality against the sentinel: the latter
      // passes for any value that merely differs from the sentinel.
      expect(`${path}: ${String(getAtPath(stub, path) === original)}`).toBe(`${path}: true`);
    }
  });
});

const constructedImpl = (): string => 'CONSTRUCTED';

describe('A3 — the snapshot covers what it claims, and refuses what it cannot', () => {
  const noRegistry = new Map<object, (...args: never[]) => unknown>();

  test('(a) a one-deep plain leaf is restored without being named', () => {
    const o: Rec = { env: { neverNamed: 'PRISTINE' } };
    const snap = captureLeaves(o);
    (o.env as Rec).neverNamed = 'CORRUPT';
    restoreLeaves(o, snap, noRegistry);
    expect((o.env as Rec).neverNamed).toBe('PRISTINE');
  });

  test('(b) a TWO-deep leaf is restored, and the snapshot did not corrupt with it', () => {
    const o: Rec = { workspace: { fs: { readFile: 'PRISTINE' } } };
    const snap = captureLeaves(o);
    ((o.workspace as Rec).fs as Rec).readFile = 'CORRUPT';
    // A shallow capture would have stored the LIVE `fs` object, so the snapshot would now read
    // CORRUPT too and the restore would be a no-op. This is the case that made B3 blocking.
    expect(((snap.workspace as Rec).fs as Rec).readFile).toBe('PRISTINE');
    restoreLeaves(o, snap, noRegistry);
    expect(((o.workspace as Rec).fs as Rec).readFile).toBe('PRISTINE');
  });

  test('(c) a registered mock leaf loses its override and its call history', () => {
    const m = mock(constructedImpl);
    const registry = new Map<object, (...args: never[]) => unknown>([[m, constructedImpl as (...args: never[]) => unknown]]);
    const o: Rec = { window: { thing: m } };
    const snap = captureLeaves(o);

    m.mockImplementation(() => 'HIJACKED');
    m();
    m();
    expect(`${m()} calls=${m.mock.calls.length}`).toBe('HIJACKED calls=3');

    restoreLeaves(o, snap, registry);
    expect(m.mock.calls.length).toBe(0);
    expect(m()).toBe('CONSTRUCTED');
  });

  test('(c) an UNREGISTERED mock leaf throws, naming the path the walk found it at', () => {
    const o: Rec = { window: { orphan: mock(() => 1) } };
    const snap = captureLeaves(o);
    expect(() => restoreLeaves(o, snap, noRegistry)).toThrow(/window\.orphan/);
  });

  test('(d) an array leaf is refused at CAPTURE time rather than captured by reference', () => {
    const o: Rec = { workspace: { folders: ['a'] } };
    expect(() => captureLeaves(o)).toThrow(/workspace\.folders/);
  });

  test('a class instance and a Map are refused too; a class CONSTRUCTOR is not', () => {
    class Thing {
      readonly kind = 'thing';
    }
    expect(() => captureLeaves({ a: { b: new Thing() } })).toThrow(/a\.b/);
    expect(() => captureLeaves({ a: { b: new Map() } })).toThrow(/a\.b/);
    // Positive control: MockThemeColor is a constructor and must survive by reference, or
    // `instanceof` assertions in statusbar.test.ts break.
    const snap = captureLeaves({ ThemeColor: Thing });
    expect(snap.ThemeColor).toBe(Thing);
  });

  test('null and undefined leaves are captured by value, not treated as objects', () => {
    const o: Rec = { env: { a: null, b: undefined } };
    const snap = captureLeaves(o);
    (o.env as Rec).a = 'CORRUPT';
    restoreLeaves(o, snap, noRegistry);
    expect((o.env as Rec).a).toBe(null);
  });
});

describe('A4 — both mock leaves are reset AND reimplemented against the new state', () => {
  test('createStatusBarItem has no recorded calls and returns the CURRENT item', () => {
    vscodeStub.window.createStatusBarItem();
    expect(vscodeStub.window.createStatusBarItem.mock.calls.length).toBeGreaterThan(0);

    const fresh = resetVscodeStub();
    expect(vscodeStub.window.createStatusBarItem.mock.calls.length).toBe(0);
    // Restoring the function REFERENCE alone would satisfy a weaker version of this and leave the
    // implementation closed over a stale `state`.
    expect(vscodeStub.window.createStatusBarItem()).toBe(fresh.item);
  });

  test('getConfiguration reads the NEW configValues', () => {
    const fresh = resetVscodeStub();
    fresh.configValues['claudewatch.thing'] = 'from-the-new-state';
    expect(vscodeStub.workspace.getConfiguration('claudewatch').get('claudewatch.thing', 'default')).toBe(
      'from-the-new-state',
    );
  });

  test('a mockImplementation override installed before the reset does not survive it', () => {
    vscodeStub.workspace.getConfiguration.mockImplementation(() => ({
      get: <T>(_k: string, _d: T): T => 'HIJACKED' as unknown as T,
    }));
    expect(vscodeStub.workspace.getConfiguration('x').get('k', 'd')).toBe('HIJACKED');

    resetVscodeStub();
    expect(vscodeStub.workspace.getConfiguration('x').get('k', 'd')).toBe('d');
  });
});

describe('A9 — the docstrings say what the code does, checked against an independent oracle', () => {
  test('pristineLeafPaths equals the AST oracle under the dotted-boundary prefix rule', () => {
    const text = readFileSync(STUB_PATH, 'utf-8');
    const members = [...providedMembers({ path: STUB_PATH, text })].toSorted();
    // A leaf is a member that is no other member's prefix ON A DOTTED BOUNDARY. A bare
    // `startsWith` would mistake a future `env.open` beside `env.openExternal` for a container.
    const derived = members.filter((m) => !members.some((o) => o !== m && o.startsWith(`${m}.`))).toSorted();

    expect(derived.length).toBeGreaterThan(0);
    expect(pristineLeafPaths()).toEqual(derived);
  });

  test('the module docstring states the equality rather than a leaf count', () => {
    const text = readFileSync(STUB_PATH, 'utf-8');
    const COUNT_CLAIM = /restores the (two|six|seven|thirteen|\d+) leaves/i;
    // Positive control: the pattern matches the text the claim actually had, so a typo in the
    // regex cannot make this green forever.
    expect(COUNT_CLAIM.test('Restores the two leaves tests overwrite, clears the two mocks')).toBe(true);
    expect(COUNT_CLAIM.test(text)).toBe(false);
  });

  test('the removed "only place that knows" claim is gone', () => {
    const text = readFileSync(STUB_PATH, 'utf-8');
    const OLD_CLAIM = /it is the only place that knows this stub's pristine shape/;
    expect(OLD_CLAIM.test("in `beforeEach`; it is the only place that knows this stub's pristine shape.")).toBe(true);
    expect(OLD_CLAIM.test(text)).toBe(false);
  });

  test("tooltip.test.ts no longer says it needs no reset", () => {
    const text = readFileSync(TOOLTIP_TEST_PATH, 'utf-8');
    const OLD_CLAIM = /depends on nothing mutable in it, so it needs no reset/;
    expect(OLD_CLAIM.test('This file depends on nothing mutable in it, so it needs no reset. (sdlc/039)')).toBe(true);
    expect(OLD_CLAIM.test(text)).toBe(false);
  });
});

// --- A11: the cross-file criterion ---------------------------------------------------------

const CONSUMER = `import * as vscode from 'vscode';
const v = vscode as unknown as { ThemeColor: unknown; Uri: { parse: (s: string) => string } };
export const readTop = (): unknown => v.ThemeColor;
export const readNested = (): string => v.Uri.parse('PRISTINE-NESTED');
`;

/**
 * Both fixture files have the SAME shape, so the criterion does not depend on bun's file order —
 * which is stable but is NOT argument order (measured). Whichever runs second enters carrying the
 * other's corruption and must be cleaned by its own `beforeEach`.
 *
 * The `mock.module` call is ASSEMBLED, not written literally: `scripts/mock-topology.ts` scans for
 * it as text and cannot tell a call from the same characters in a string, so a literal here would
 * add this file to that guard's pinned inventory of files that mock `vscode` — which it does not.
 * Same reason as `scripts/vscode-stub-cover.test.ts:37`. (sdlc/039, sdlc/040)
 */
const fixtureFile = (name: string): string => `import { beforeEach, expect, test, mock } from 'bun:test';
import { vscodeStub, resetVscodeStub } from './vscode-stub.js';
mock.${'module'}('vscode', () => vscodeStub);
const { readTop, readNested } = await import('./consumer.js');
beforeEach(() => { resetVscodeStub(); });
test('${name} sees a pristine consumer', () => {
  expect(typeof readTop()).toBe('function');
  expect(readNested()).toBe('PRISTINE-NESTED');
  (vscodeStub as unknown as { ThemeColor: unknown }).ThemeColor = 'CORRUPT-FROM-${name}';
  vscodeStub.Uri.parse = () => 'CORRUPT-FROM-${name}';
});
`;

function crossFileTree(stubText: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-crossfile-'));
  writeFileSync(join(dir, 'vscode-stub.ts'), stubText);
  writeFileSync(join(dir, 'consumer.ts'), CONSUMER);
  writeFileSync(join(dir, 'a.test.ts'), fixtureFile('a'));
  writeFileSync(join(dir, 'b.test.ts'), fixtureFile('b'));
  return dir;
}

const runPair = (dir: string): { status: number; out: string } => {
  const p = spawnSync('bun', ['test', join(dir, 'a.test.ts'), join(dir, 'b.test.ts')], {
    cwd: dir,
    encoding: 'utf-8',
  });
  // bun writes the summary and the `Ran …` line to STDERR, not stdout.
  return { status: p.status ?? -1, out: `${p.stderr ?? ''}${p.stdout ?? ''}` };
};

describe('A11 — corruption does not cross a file boundary', () => {
  test('a consumer in the next file reads pristine top-level AND nested values', () => {
    const dir = crossFileTree(readFileSync(STUB_PATH, 'utf-8'));
    try {
      const { status, out } = runPair(dir);
      // NOT the exit status. A bare argument to `bun test` is a FILTER: one that matches nothing is
      // silently dropped and the run still exits 0 having run only the vacuous half (measured, and
      // the `./`-prefixed form does not fix it). The counts are what make this criterion real.
      expect(out).toContain('2 pass');
      expect(out).toContain('0 fail');
      expect(out).toContain('Ran 2 tests across 2 files');
      expect(status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('A13 — the guards fail loudly, at the right moment', () => {
  test('an unregistered mock throws on the first RESET; a bad container throws at CAPTURE', () => {
    // Different moments, deliberately: the capture runs at module load, which is earlier and
    // louder than the first `beforeEach` and is why the snapshot is not taken lazily.
    expect(() => captureLeaves({ a: { b: [1] } })).toThrow(/captureLeaves/);
    const o: Rec = { a: { b: mock(() => 1) } };
    expect(() => restoreLeaves(o, captureLeaves(o), new Map())).toThrow(/restoreLeaves/);
  });
});

// Referenced so `state` is not an unused write; the hook exists to satisfy the gate.
test('the beforeEach hook hands back a fresh state', () => {
  expect(state.registered.size).toBe(0);
  expect(resolve(STUB_PATH).endsWith('vscode-stub.ts')).toBe(true);
});
