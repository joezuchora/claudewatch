/**
 * Tests for the vscode stub coverage gate. (sdlc/039)
 *
 * Two kinds of test here, and they are not equally important. Most exercise the checker against
 * synthetic fixtures. ONE — `every vscode test file passes run alone` — exercises the
 * CONSOLIDATION, which is the risky half of this loop: a shared stub is a shared mutable object,
 * and an incomplete `resetVscodeStub()` shows up when a file runs by itself, not in a suite where
 * some other file happened to leave the right state behind.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  compare,
  readSources,
  vscodeInstallers,
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

/** The walker only looks at files that import vscode, so fixtures must say so. */
const IMPORT = "import * as vscode from 'vscode';\n";
const src = (text: string, path = 'a.ts'): SourceFile => ({ path, text: text.startsWith('import') ? text : IMPORT + text });
/** Verbatim, for the cases that are ABOUT the import line. */
const rawSrc = (text: string, path = 'a.ts'): SourceFile => ({ path, text });
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

  test('every installer uses the shared stub, and at least one does', () => {
    // readSources walks recursively, as the CLI does; a flat readdirSync here could not see a
    // subdirectory the gate would. (Stage 5 audit)
    const { tests } = readSources(VSCODE_SRC);
    const { shared, inline } = vscodeInstallers(tests);
    expect(inline).toEqual([]);
    // The half the first version was missing: it enforced "zero inline" while claiming "exactly
    // one". The Stage 5 audit stripped the factory from every file and the CLI still exited 0.
    expect(shared.length).toBeGreaterThan(0);
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

  test('a cast between the two accesses does not lose the sub-key', () => {
    // extension.ts:45. The gate reported `env.isTelemetryEnabled` as SURPLUS until this was fixed
    // — telling a maintainer the member gating telemetry was dead weight. (Stage 5 security pass)
    const r = requiredMembers([src(IMPORT + '(vscode.env as { x?: unknown }).isTelemetryEnabled;')]);
    expect(keys(r)).toEqual(['env.isTelemetryEnabled']);
  });

  test('a namespace import under another name is still found', () => {
    const r = requiredMembers([src("import * as vs from 'vscode';\nvs.Uri.parse(x);")]);
    expect(keys(r)).toEqual(['Uri.parse']);
  });

  test('a file that does not import vscode contributes nothing', () => {
    // Also stops a local variable happening to be called `vscode` from being counted.
    expect(keys(requiredMembers([rawSrc('const vscode = {}; vscode.window.createStatusBarItem();')]))).toEqual([]);
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

/** A fixture package the CLI can be pointed at, so its EXIT STATUS is testable. */
const fixtureDirs: string[] = [];
afterEach(() => {
  // Each call leaked a temp directory until the Stage 5 security pass counted 18 of them on this
  // machine. Hygiene rather than exposure — mkdtemp is 0700 and the contents are synthetic — but
  // a test suite that grows the filesystem every run is a test suite nobody will run twice.
  for (const d of fixtureDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const fixtureTree = (stubBody: string, sourceBody: string, testBody: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-stubcover-'));
  fixtureDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'vscode-stub.ts'), `export const vscodeStub = {\n${stubBody}\n};\n`);
  writeFileSync(join(dir, 'thing.ts'), IMPORT + sourceBody);
  writeFileSync(join(dir, 'thing.test.ts'), testBody);
  return dir;
};
const runCli = (dir: string): { status: number; stderr: string } => {
  const p = spawnSync('bun', ['run', SCRIPT, dir], { cwd: REPO, encoding: 'utf-8' });
  return { status: p.status ?? -1, stderr: p.stderr ?? '' };
};


/** The shape of the claim the two files used to make, as it was actually written. */
const STALE_CLAIM = /showErrorMessage[\s\S]{0,80}reached from/;

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

describe('installers', () => {
  test('a shared-stub factory is shared, not inline', () => {
    expect(vscodeInstallers([src(factorySrc('vscodeStub'), 'a.test.ts')]))
      .toEqual({ shared: ['a.test.ts'], inline: [] });
  });

  test('two files building their own factories are BOTH named', () => {
    // The criterion says "naming both files". The first version paired one shared with one inline
    // and asserted a single name, so the plural it promised went unasserted.
    expect(vscodeInstallers([
      src(factorySrc('({ window: {} })'), 'b.test.ts'),
      src(factorySrc('({ env: {} })'), 'c.test.ts'),
    ])).toEqual({ shared: [], inline: ['b.test.ts', 'c.test.ts'] });
  });

  test('a tree where nothing installs the stub has no shared installer', () => {
    expect(vscodeInstallers([src('import { vscodeStub } from "./vscode-stub.js";', 'a.test.ts')]).shared)
      .toEqual([]);
  });
});

describe('the gate', () => {
  test('a missing member makes the CLI exit non-zero', () => {
    // A13. It had no test at all until the Stage 5 audit ran the mutation that proves it: making
    // the CLI unconditionally `process.exit(0)` left all 22 tests green. That mutation was in the
    // plan as M7 and is the one I did not run. Without this, A1 and A11 are both satisfied by a
    // script that never fails — which is the exact wording of A13's own rationale.
    const dir = fixtureTree(
      '  window: { createStatusBarItem: () => ({}) },',
      'vscode.Uri.parse("x");',
      factorySrc('vscodeStub'),
    );
    const r = runCli(dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Uri.parse');
    expect(r.stderr).toContain('thing.ts');
  }, 60_000);

  test('a covered fixture tree exits 0', () => {
    // The positive precondition: without it the test above passes for any reason the CLI fails,
    // including a fixture the CLI cannot read at all.
    const dir = fixtureTree(
      '  Uri: { parse: (s: string) => s },',
      'vscode.Uri.parse("x");',
      factorySrc('vscodeStub'),
    );
    expect(runCli(dir).status).toBe(0);
  }, 60_000);

  test('a tree whose tests install nothing fails', () => {
    const dir = fixtureTree('  Uri: { parse: (s: string) => s },', 'vscode.Uri.parse("x");', '// no factory');
    const r = runCli(dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('no test file installs the shared stub');
  }, 60_000);

  test('the real stub, with Uri removed in memory, no longer covers commands.ts', () => {
    // A2's stated method: read the CHECKED-IN stub rather than a synthetic fixture. Nothing
    // exercised `providedMembers` against the real file except transitively.
    const stubText = readFileSync(join(VSCODE_SRC, 'vscode-stub.ts'), 'utf-8');
    const withUri = providedMembers(src(stubText, 'vscode-stub.ts'));
    expect(withUri.has('Uri.parse')).toBe(true);
    const without = providedMembers(src(stubText.replace('  Uri: { parse: (s: string) => s },', ''), 'vscode-stub.ts'));
    expect(without.has('Uri.parse')).toBe(false);
    const required = requiredMembers([src(readFileSync(join(VSCODE_SRC, 'commands.ts'), 'utf-8'), 'commands.ts')]);
    expect(compare(required, without).missing.map(memberKey)).toContain('Uri.parse');
  });

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
    // A negative regex assertion with no positive control is green forever after a typo in the
    // pattern. This one is checked against the text the claim actually had. (Stage 5 security pass)
    expect(STALE_CLAIM.test('`window.showErrorMessage`, both\n  // reached from commands.ts')).toBe(true);
    for (const f of ['statusbar.test.ts', 'tooltip.test.ts']) {
      const text = readFileSync(join(VSCODE_SRC, f), 'utf-8');
      expect(`${f}: reads the shared stub`).toBe(`${f}: ${text.includes(factorySrc('vscodeStub').slice(0, -1)) ? 'reads the shared stub' : 'does not'}`);
      expect(`${f}: ${STALE_CLAIM.test(text)}`).toBe(`${f}: false`);
    }
  });
});
