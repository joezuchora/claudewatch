/**
 * Tests for the mock-topology guard.
 *
 * Two halves, deliberately. The SYNTHETIC half feeds in-memory file sets to `analyze` and is
 * where every rule is proven both red and green — it is the primary artifact. The REAL-TREE half
 * runs the analyzer over this repository and is the regression anchor; it is expected green from
 * the first run and so proves nothing on its own.
 *
 * The split also means no criterion requires writing a fixture into the repo. A previous
 * reviewer's probe file was swept up by `git add -A` and turned CI red.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { analyze, findImporters, findMocks, lineImportsValue, type SourceFile } from './mock-topology.js';

const f = (path: string, text: string): SourceFile => ({ path, text });

describe('R1 — a mocked module may have at most one non-test importer', () => {
  test('A2: two importers in the mocking test\'s directory is a violation', () => {
    const v = analyze([
      f('pkg/src/a.test.ts', `mock.module('./dep.js', () => ({}));`),
      f('pkg/src/dep.ts', `export const x = 1;`),
      f('pkg/src/one.ts', `import { x } from './dep.js';`),
      f('pkg/src/two.ts', `import { x } from './dep.js';`),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]!.rule).toBe('R1');
    expect(v[0]!.files).toEqual(['pkg/src/one.ts', 'pkg/src/two.ts']);
  });

  test('A2b control: one importer is fine', () => {
    expect(analyze([
      f('pkg/src/a.test.ts', `mock.module('./dep.js', () => ({}));`),
      f('pkg/src/dep.ts', `export const x = 1;`),
      f('pkg/src/one.ts', `import { x } from './dep.js';`),
    ])).toEqual([]);
  });

  test('A9: mocking a module that ALREADY has two importers is a violation', () => {
    // The literal sdlc/025 recurrence, and the direction the intent demanded that revision 1 of
    // the spec had no criterion for.
    const v = analyze([
      f('pkg/src/bridge.ts', `export const x = 1;`),
      f('pkg/src/alpha.ts', `import { x } from './bridge.js';`),
      f('pkg/src/beta.ts', `import { x } from './bridge.js';`),
      f('pkg/src/new.test.ts', `mock.module('./bridge.js', () => ({}));`),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]!.files).toEqual(['pkg/src/alpha.ts', 'pkg/src/beta.ts']);
  });

  test('A8: same specifier, different directories, different files — green', () => {
    // Measured case 1: no leak, so no violation.
    expect(analyze([
      f('a/src/x.test.ts', `mock.module('./dep.js', () => ({}));`),
      f('a/src/dep.ts', `export const x = 1;`),
      f('a/src/use.ts', `import { x } from './dep.js';`),
      f('b/src/dep.ts', `export const x = 2;`),
      f('b/src/use.ts', `import { x } from './dep.js';`),
    ])).toEqual([]);
  });

  test('A7: one file reached by two different specifier strings — green', () => {
    // Measured case 3, and the case the Stage 2 reviewer measured differently. Three load orders
    // on bun 1.3.11 showed no leak. If their result reproduces, this is a false negative and the
    // guard has a hole here.
    expect(analyze([
      f('a/src/x.test.ts', `mock.module('./dep.js', () => ({}));`),
      f('a/src/dep.ts', `export const x = 1;`),
      f('a/src/use.ts', `import { x } from './dep.js';`),
      f('b/src/use.ts', `import { x } from '../../a/src/dep.js';`),
    ])).toEqual([]);
  });
});

describe('R1 — bare specifiers are counted tree-wide', () => {
  test('A3: a bare mock with importers in two packages is a violation', () => {
    const v = analyze([
      f('a/src/x.test.ts', `mock.module('@claudewatch/core', () => ({}));`),
      f('a/src/one.ts', `import { x } from '@claudewatch/core';`),
      f('b/src/two.ts', `import { x } from '@claudewatch/core';`),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]!.specifier).toBe('@claudewatch/core');
    expect(v[0]!.files).toEqual(['a/src/one.ts', 'b/src/two.ts']);
  });

  test('A3b control: a bare mock with exactly ONE importer tree-wide is fine', () => {
    // Proves A3's red came from the COUNT, not from "bare and not allowlisted". Without this,
    // an implementation that flagged every bare specifier would pass A3 and never exercise the
    // counting path at all.
    expect(analyze([
      f('a/src/x.test.ts', `mock.module('@claudewatch/core', () => ({}));`),
      f('a/src/one.ts', `import { x } from '@claudewatch/core';`),
    ])).toEqual([]);
  });

  test('the ambient allowlist exempts vscode even with many importers', () => {
    expect(analyze([
      f('a/src/x.test.ts', `mock.module('vscode', () => ({}));`),
      f('a/src/one.ts', `import * as vscode from 'vscode';`),
      f('a/src/two.ts', `import * as vscode from 'vscode';`),
      f('a/src/three.ts', `import * as vscode from 'vscode';`),
    ])).toEqual([]);
  });
});

describe('importer forms', () => {
  const base = (extra: SourceFile[]) => analyze([
    f('pkg/src/a.test.ts', `mock.module('./dep.js', () => ({}));`),
    f('pkg/src/dep.ts', `export const x = 1;`),
    f('pkg/src/one.ts', `import { x } from './dep.js';`),
    ...extra,
  ]);

  test('A4: type-only references do not count, in all three forms', () => {
    expect(base([f('pkg/src/t1.ts', `import type { X } from './dep.js';`)])).toEqual([]);
    expect(base([f('pkg/src/t2.ts', `export type { X } from './dep.js';`)])).toEqual([]);
    expect(base([f('pkg/src/t3.ts', `import { type A, type B } from './dep.js';`)])).toEqual([]);
  });

  test('A4b control: the SAME lines without the type keyword do count', () => {
    // Differs by one token from A4, so green-vs-red isolates `type` rather than "the file was
    // ignored" — a green-expected criterion alone is satisfied by a broken or absent analyzer.
    expect(base([f('pkg/src/t1.ts', `import { X } from './dep.js';`)])).toHaveLength(1);
    expect(base([f('pkg/src/t2.ts', `export { X } from './dep.js';`)])).toHaveLength(1);
    expect(base([f('pkg/src/t3.ts', `import { A, B } from './dep.js';`)])).toHaveLength(1);
  });

  test('A4b: a mixed inline binding IS a value import', () => {
    expect(base([f('pkg/src/m.ts', `import { a, type B } from './dep.js';`)])).toHaveLength(1);
  });

  test('A5: dynamic import counts, relative and bare', () => {
    expect(base([f('pkg/src/d.ts', `const m = await import('./dep.js');`)])).toHaveLength(1);
    const bare = analyze([
      f('a/src/x.test.ts', `mock.module('@claudewatch/core', () => ({}));`),
      f('a/src/one.ts', `import { x } from '@claudewatch/core';`),
      f('a/src/two.ts', `const c = await import('@claudewatch/core');`),
    ]);
    expect(bare).toHaveLength(1);
  });

  test('A6: side-effect-only import counts', () => {
    expect(base([f('pkg/src/s.ts', `import './dep.js';`)])).toHaveLength(1);
  });

  test('A6b: re-export counts — sdlc/001 established a static re-export does not isolate a mock', () => {
    expect(base([f('pkg/src/r.ts', `export * from './dep.js';`)])).toHaveLength(1);
  });
});

describe('R2 — no two test files may mock the same specifier string', () => {
  test('A10: two mockers of the same non-allowlisted string is a violation', () => {
    const v = analyze([
      f('a/src/x.test.ts', `mock.module('./deps.js', () => ({}));`),
      f('b/src/y.test.ts', `mock.module('./deps.js', () => ({}));`),
    ]);
    expect(v.some((x) => x.rule === 'R2')).toBe(true);
  });

  test('A10 control: one mocker is fine, and the allowlist exempts duplicates', () => {
    expect(analyze([f('a/src/x.test.ts', `mock.module('./deps.js', () => ({}));`)])).toEqual([]);
    expect(analyze([
      f('a/src/x.test.ts', `mock.module('vscode', () => ({}));`),
      f('b/src/y.test.ts', `mock.module('vscode', () => ({}));`),
    ])).toEqual([]);
  });
});

describe('discovery', () => {
  test('tolerates whitespace, newlines and double quotes', () => {
    const m = findMocks([f('a/x.test.ts', `mock.module(\n  "./dep.js",\n  () => ({}),\n);`)]);
    expect(m).toEqual([{ testPath: 'a/x.test.ts', specifier: './dep.js' }]);
  });

  test('prose mentioning mock.module in a comment is not a mock', () => {
    expect(findMocks([f('a/x.ts', `// bun applies mock.module process-wide`)])).toEqual([]);
  });

  test('lineImportsValue is exported and directly testable', () => {
    expect(lineImportsValue(`import { a } from './d.js';`, './d.js')).toBe(true);
    expect(lineImportsValue(`import type { A } from './d.js';`, './d.js')).toBe(false);
    expect(lineImportsValue(`import { a } from './other.js';`, './d.js')).toBe(false);
  });

  test('findImporters ignores test files', () => {
    expect(findImporters([
      f('p/a.test.ts', `import { x } from './d.js';`),
      f('p/b.ts', `import { x } from './d.js';`),
    ], './d.js', 'p')).toEqual(['p/b.ts']);
  });
});

// --- the real tree ---

const ROOT = join(import.meta.dir, '..');
const SELF = 'scripts/mock-topology.test.ts';

function collect(dir: string, out: SourceFile[] = []): SourceFile[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e === 'typefixtures') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) collect(p, out);
    else if (e.endsWith('.ts')) out.push({ path: p.replace(ROOT + '/', ''), text: readFileSync(p, 'utf-8') });
  }
  return out;
}

function realTree(): SourceFile[] {
  const files: SourceFile[] = [];
  for (const e of readdirSync(join(ROOT, 'packages'))) {
    const src = join(ROOT, 'packages', e, 'src');
    try { if (statSync(src).isDirectory()) collect(src, files); } catch { /* no src */ }
  }
  collect(join(ROOT, 'scripts'), files);
  // This file quotes mock.module(...) in its own synthetic cases; it is not a mocker of anything.
  return files.filter((x) => x.path !== SELF);
}

describe('the real tree', () => {
  test('has no mock-topology violations', () => {
    expect(analyze(realTree())).toEqual([]);
  });

  test('A1(a): the discovered (test file, specifier) PAIRS are exactly these', () => {
    // Pairs, not specifiers: asserting the specifier set alone stayed green when a mock MOVED to
    // a different test file, or when a third mocker was added.
    expect(findMocks(realTree()).map((m) => [m.testPath, m.specifier]).toSorted()).toEqual([
      ['packages/statusline/src/main.test.ts', './core-deps.js'],
      ['packages/vscode/src/statusbar.test.ts', './statusbar-bridge.js'],
      ['packages/vscode/src/statusbar.test.ts', 'vscode'],
      ['packages/vscode/src/tooltip.test.ts', 'vscode'],
    ]);
  });

  test('A1(b): the importer SETS are exactly these', () => {
    // The assertion revision 1 of the spec omitted. Without it, breaking the importer regex makes
    // every count 0, zero satisfies at-most-one, and the guard is permanently green with the
    // property false.
    const files = realTree();
    expect(findImporters(files, './core-deps.js', 'packages/statusline/src'))
      .toEqual(['packages/statusline/src/main.ts']);
    expect(findImporters(files, './statusbar-bridge.js', 'packages/vscode/src'))
      .toEqual(['packages/vscode/src/statusbar.ts']);
    // Not mocked, but two importers — the shape sdlc/025 fixed. Pinned so a future mock of it
    // is a visible change rather than a silent one.
    expect(findImporters(files, './core-bridge.js', 'packages/vscode/src'))
      .toEqual(['packages/vscode/src/extension.ts', 'packages/vscode/src/tooltip.ts']);
  });
});
