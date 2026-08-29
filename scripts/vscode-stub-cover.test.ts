/**
 * Tests for the vscode stub coverage gate. (sdlc/039)
 *
 * Two kinds of test here, and they are not equally important. Most exercise the checker against
 * synthetic fixtures. ONE — `every vscode test file passes run alone` — exercises the
 * CONSOLIDATION, which is the risky half of this loop: a shared stub is a shared mutable object,
 * and an incomplete `resetVscodeStub()` shows up when a file runs by itself, not in a suite where
 * some other file happened to leave the right state behind.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import {
  compare,
  inlineFactories,
  memberKey,
  providedMembers,
  requiredMembers,
  type SourceFile,
} from './vscode-stub-cover.js';

const REPO = resolve(import.meta.dir, '..');
const VSCODE_SRC = join(REPO, 'packages', 'vscode', 'src');
const SCRIPT = join(REPO, 'scripts', 'vscode-stub-cover.ts');

/**
 * Builds a `mock.module('vscode', …)` call as fixture TEXT.
 *
 * Assembled rather than written literally on purpose: `scripts/mock-topology.ts` scans for that
 * call as a string and cannot tell a real one from the same characters inside a fixture, so a
 * literal here would put this file into that guard's inventory of files that mock `vscode` — which
 * it does not. Recorded as a finding in sdlc/039; the guard is not weakened to accommodate this.
 */
const factorySrc = (body: string): string => `mock.${'module'}('vscode', () => ${body});`;

const src = (text: string, path = 'a.ts'): SourceFile => ({ path, text });
const keys = (m: Map<string, Set<string>>): string[] => [...m.keys()].toSorted();

describe('the consolidation', () => {
  test('every vscode test file passes run alone', () => {
    // Enumerated, not hard-coded: a seventh file is covered the day it appears. The count is
    // asserted so an empty glob cannot make this pass vacuously — which it would have, and the
    // earlier drafts of this loop said "five files" when there are six.
    const files = readdirSync(VSCODE_SRC).filter((f) => f.endsWith('.test.ts')).toSorted();
    expect(files.length).toBeGreaterThanOrEqual(6);

    for (const file of files) {
      const proc = spawnSync('bun', ['test', join(VSCODE_SRC, file)], { cwd: REPO, encoding: 'utf-8' });
      expect(`${file}: ${proc.status}`).toBe(`${file}: 0`);
    }
  }, 120_000);

  test('exactly one file supplies a vscode factory body', () => {
    const tests = readdirSync(VSCODE_SRC)
      .filter((f) => f.endsWith('.test.ts'))
      .map((f) => src(readFileSync(join(VSCODE_SRC, f), 'utf-8'), f));
    expect(inlineFactories(tests)).toEqual([]);
  });
});

describe('required members', () => {
  test('a type-only reference is not required', () => {
    const r = requiredMembers([src('let a: vscode.ExtensionContext; let b: vscode.Disposable;')]);
    expect(keys(r)).toEqual([]);
  });

  test('a constructed reference is required', () => {
    const r = requiredMembers([src('const t = new vscode.ThemeColor("x");')]);
    expect(keys(r)).toEqual(['ThemeColor']);
  });

  test('the same member in both positions is required', () => {
    // tooltip.ts does exactly this, two lines apart. A classifier that decided per MEMBER rather
    // than per OCCURRENCE would drop it, and the two tests above would both still pass.
    const r = requiredMembers([src('function f(): vscode.MarkdownString { return new vscode.MarkdownString(); }')]);
    expect(keys(r)).toEqual(['MarkdownString']);
  });

  test('a cast target is a type, not a value', () => {
    // No preceding colon, so the syntactic rule this design replaced would have demanded a runtime
    // stub for an interface and turned the gate red on a legal edit.
    const r = requiredMembers([src('const i = x as vscode.StatusBarItem;')]);
    expect(keys(r)).toEqual([]);
  });

  test('a member chain split across lines keeps its sub-key', () => {
    const r = requiredMembers([src('const j = vscode.workspace\n  .getConfiguration("s")\n  .get("k", false);')]);
    expect(keys(r)).toEqual(['workspace.getConfiguration']);
  });

  test('comments and string literals contribute nothing', () => {
    // Load-bearing for this repo, not hypothetical: the docstrings this loop corrects mention
    // `window.showErrorMessage`, so a scanner that read comments would demand the very member the
    // checker exists to report as unneeded.
    const r = requiredMembers([
      src('// vscode.window.showErrorMessage\n/* vscode.env.openExternal */\nconst s = "vscode.Uri.parse";'),
    ]);
    expect(keys(r)).toEqual([]);
    // ...and the positive precondition, so this cannot pass because the walker is broken.
    expect(keys(requiredMembers([src('vscode.window.showErrorMessage("x");')]))).toEqual(['window.showErrorMessage']);
  });

  test('the file needing a member is recorded', () => {
    const r = requiredMembers([src('vscode.env.openExternal(u);', 'commands.ts')]);
    expect([...r.get('env.openExternal')!]).toEqual(['commands.ts']);
  });
});

describe('provided members', () => {
  const stub = (body: string): SourceFile => src(`export const vscodeStub = {\n${body}\n};`, 'vscode-stub.ts');

  test('top-level keys and sub-keys are both provided', () => {
    const p = providedMembers(stub('  window: { createStatusBarItem: () => ({}) },\n  Uri: { parse: (s) => s },'));
    expect([...p].toSorted()).toEqual(['Uri', 'Uri.parse', 'window', 'window.createStatusBarItem']);
  });

  test('a key defined as undefined is not provided', () => {
    // The shape both of this loop's real mutations produced: present to a key-collecting scanner,
    // `TypeError: undefined is not an object` at runtime.
    const p = providedMembers(stub('  Uri: undefined,\n  env: null,\n  window: { showErrorMessage: undefined },'));
    expect([...p].toSorted()).toEqual(['window']);
  });
});

const req = (...ks: string[]): Map<string, Set<string>> =>
  new Map(ks.map((k) => [k, new Set(['src.ts'])]));

describe('compare', () => {
  test('a required member with no provider is missing, and names its user', () => {
    const r = compare(req('Uri.parse'), new Set(['window']));
    expect(r.missing.map(memberKey)).toEqual(['Uri.parse']);
    expect(r.missing[0]!.neededBy).toEqual(['src.ts']);
  });

  test('a bare parent does not satisfy a sub-key requirement', () => {
    // The difference between a check and a formality.
    expect(compare(req('window.createStatusBarItem'), new Set(['window'])).missing.map(memberKey))
      .toEqual(['window.createStatusBarItem']);
  });

  test('a surplus member is reported, not failed', () => {
    const r = compare(req('Uri.parse'), new Set(['Uri', 'Uri.parse', 'ThemeColor']));
    expect(r.missing).toEqual([]);
    expect(r.surplus.map(memberKey)).toEqual(['ThemeColor']);
  });

  test('a bare parent whose child is required is not surplus', () => {
    expect(compare(req('window.createStatusBarItem'), new Set(['window', 'window.createStatusBarItem'])).surplus)
      .toEqual([]);
  });

  test('an empty provided set fails loudly rather than passing vacuously', () => {
    expect(compare(req('Uri.parse', 'env'), new Set()).missing.map(memberKey)).toEqual(['Uri.parse', 'env']);
  });
});

describe('inline factories', () => {
  test('a shared-stub factory is not counted', () => {
    expect(inlineFactories([src(factorySrc('vscodeStub'), 'a.test.ts')])).toEqual([]);
  });

  test('a file building its own factory is named', () => {
    expect(inlineFactories([
      src(factorySrc('vscodeStub'), 'a.test.ts'),
      src(factorySrc('({ window: {} })'), 'b.test.ts'),
    ])).toEqual(['b.test.ts']);
  });
});

describe('the gate', () => {
  test('the CLI exits 0 on the real tree', () => {
    const proc = spawnSync('bun', ['run', SCRIPT], { cwd: REPO, encoding: 'utf-8' });
    expect(`${proc.status}: ${proc.stderr}`).toBe('0: ');
  }, 60_000);

  test('verify runs the step, and package.json declares it', () => {
    // Both halves. `verify.ts` invokes steps as PACKAGE SCRIPTS, not paths, because
    // `scripts/env.test.ts`'s sandbox stubs them by script name — sdlc/033 shipped that wrong once.
    const verify = readFileSync(join(REPO, 'scripts', 'verify.ts'), 'utf-8');
    expect(verify).toContain("{ name: 'vscodeStubCover', cmd: ['bun', 'run', 'vscodeStubCover'] }");
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.vscodeStubCover).toBe('bun run scripts/vscode-stub-cover.ts');
    // ...and the env sandbox stubs it, or its four cases go red.
    expect(readFileSync(join(REPO, 'scripts', 'env.test.ts'), 'utf-8')).toContain('vscodeStubCover: noop');
  });
});

describe('the docstrings this loop corrected', () => {
  test('commands.ts requires showInformationMessage and not showErrorMessage', () => {
    // Checked against the code, not pinned as a phrase. `scripts/env.test.ts:312` records why a
    // phrase-pin is weak: it passes the moment the phrase is typed and never checks it is true.
    const r = requiredMembers([
      src(readFileSync(join(VSCODE_SRC, 'commands.ts'), 'utf-8'), 'commands.ts'),
    ]);
    expect(keys(r)).toContain('window.showInformationMessage');
    expect(keys(r)).toContain('env.openExternal');
    expect(keys(r)).toContain('Uri.parse');
    expect(keys(r)).not.toContain('window.showErrorMessage');
  });

  test('neither stale claim survives in the two files that made it', () => {
    // The claim was "`window.showInformationMessage` and `window.showErrorMessage`, both reached
    // from commands.ts". It did not survive consolidation because it lived inside the inline
    // factories that were replaced — deleted with its paragraph rather than rewritten, which is a
    // weaker outcome than "corrected" and is recorded as such in review.md.
    //
    // The positive precondition matters here: without it this passes for any file that never made
    // the claim, including an empty one.
    for (const f of ['statusbar.test.ts', 'tooltip.test.ts']) {
      const text = readFileSync(join(VSCODE_SRC, f), 'utf-8');
      expect(`${f}: reads the shared stub`).toBe(`${f}: ${text.includes(factorySrc('vscodeStub').slice(0, -1)) ? 'reads the shared stub' : 'does not'}`);
      expect(`${f}: ${/showErrorMessage[\s\S]{0,80}reached from/.test(text)}`).toBe(`${f}: false`);
    }
  });
});
