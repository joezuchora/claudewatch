/**
 * Mock topology analysis — a tripwire for the mock that stubs code under test.
 *
 * Bun applies `mock.module` process-wide and `mock.restore()` does not undo it. So when a test
 * mocks a module that MORE THAN ONE source file imports, it stubs the others' dependency too,
 * silently, in a green suite. This repo has paid for that twice:
 *
 *   sdlc/001  a surface test mocked '@claudewatch/core' and broke 128 of 341 tests in
 *             packages/core itself, hidden because CI ran each package in its own process.
 *   sdlc/025  statusbar.test.ts mocked './core-bridge.js', which three files imported, so
 *             tooltip.test.ts asserted against a stub for four loops while reading as green.
 *
 * Measured on bun 1.3.11 (see mock-topology.test.ts for the four experiments):
 *
 *   two dirs, own dep.ts, both mock './dep.js'   no leak
 *   ONE file, two different specifier strings    no leak   <- DISPUTED, see below
 *   one dir, victim reaches dep via consumer     LEAKS     <- sdlc/025's shape
 *
 * The rules follow those OBSERVATIONS, not a model of bun's internals. The sdlc/026 Stage 2
 * reviewer measured a leak in the disputed case and concluded bun keys mocks by resolved absolute
 * path; three load orders here said otherwise. If their result is reproducible somewhere, R1 has
 * a false negative for that shape — a hole, not a wrong answer. R2 exists partly so the guard
 * does not depend on which of us is right.
 *
 * KNOWN LIMIT — this counts DIRECT importers. A module with exactly one non-test importer P still
 * contaminates every test that reaches it through P; measured, and out of scope. Do not read
 * "exactly one consumer" as safety.
 *
 * KNOWN HOLE — discovery only sees packages/{*}/src and scripts/. A `mock.module` anywhere else
 * is invisible.
 *
 * KNOWN HOLE — a `mock.module('../bridge.js')` from a subdirectory is effectively unguarded. R1
 * scopes local specifiers to the mocking test's own directory, so it can only count files in that
 * subdirectory writing that same '../' string; the module's real neighbours one level up
 * necessarily write './bridge.js' and are never counted. Not live (no src/ has subdirectories
 * today) — which is exactly why nobody will notice when the first one appears. Found by the
 * sdlc/026 plan-to-diff audit; the hole is in the rule, not the implementation.
 */

export interface SourceFile {
  path: string;
  text: string;
}

export interface Violation {
  rule: 'R1' | 'R2';
  specifier: string;
  detail: string;
  files: string[];
}

/**
 * Modules with no real implementation available under `bun test`, which therefore MUST be mocked
 * by every test that touches them. An allowlist, deliberately, and not a test on specifier shape:
 * exempting everything that does not start with './' would exempt `@claudewatch/core`, which is
 * sdlc/001's actual 128-test failure.
 */
export const AMBIENT_ALLOWLIST: readonly string[] = ['vscode'];

/**
 * Exported WITHOUT the `g` flag. A global regex carries `lastIndex` between calls, so a consumer
 * doing `MOCK_CALL.test(x)` twice would silently skip matches. `findMocks` builds its own global
 * copy from `.source`. (sdlc/026 security pass)
 */
export const MOCK_CALL = /mock\.module\(\s*['"]([^'"]+)['"]/;

export function isTestFile(path: string): boolean {
  return path.endsWith('.test.ts');
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** Every (test file, specifier) pair. Pairs, not specifiers: moving a mock to another file must
 *  be visible, and asserting the specifier set alone left that change invisible. */
export function findMocks(files: readonly SourceFile[]): Array<{ testPath: string; specifier: string }> {
  const out: Array<{ testPath: string; specifier: string }> = [];
  for (const f of files) {
    if (!isTestFile(f.path)) continue;
    // normalizeForScan, not raw text. Comment-stripping was applied to importer COUNTING in
    // sdlc/026 and never to mock DISCOVERY — an asymmetry that bit for real in sdlc/027, where a
    // comment reading `mock.module('vscode')` (written to explain this very mechanism) was
    // discovered as a second mocker and turned A1(a) red. sdlc/026's review had noted this
    // module's own docstring "came within one word" of the same thing.
    for (const m of normalizeForScan(f.text).matchAll(new RegExp(MOCK_CALL.source, 'g'))) {
      out.push({ testPath: f.path, specifier: m[1]! });
    }
  }
  return out;
}

/**
 * Normalize a source file for import scanning.
 *
 * Two things this has to survive, both found by the sdlc/026 plan-to-diff audit and both
 * reproduced before fixing:
 *
 *  - **Wrapped imports.** `lineImportsValue` works per line, and in
 *    `import type {\n  A,\n} from './dep.js';` the line carrying the specifier is `} from './dep.js';`
 *    — no `{`, no leading `import type`, so both guards miss it and a pure TYPE import was counted
 *    as a value importer. That is a straight deviation from the spec's own table, and it is
 *    live-shaped: `main.ts:31` and `extension.ts:20` are wrapped-import tails today.
 *  - **Comments.** A commented-out `// import { x } from './dep.js';` counted as a real importer,
 *    and so did prose. This module's own header came within one word of tripping it: line 10 says
 *    `mocked './core-bridge.js', which three files imported` — had it read `imported from
 *    './core-bridge.js'`, the analyzer would have counted its own docstring as a third importer.
 *
 * The `(?<!:)` guard on line comments keeps `https://` intact.
 */
export function normalizeForScan(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')       // block comments, including docstrings
    .replace(/(?<!:)\/\/[^\n]*/g, ' ')        // line comments, but not the // in a URL
    .replace(/\{[^{}]*\}/g, (m) => m.replace(/\s+/g, ' ')); // collapse wrapped brace groups
}

/**
 * Does this line reference `spec` as a VALUE?
 *
 * Type-only references are erased at compile time and cannot be contaminated. The subtlety:
 * `import { a, type B } from 'x'` is a value import, while `import { type A, type B } from 'x'`
 * is not — and this repo already uses inline `type` modifiers in cli-detect.ts, verify.ts and
 * smoke.test.ts. Callers should pass `normalizeForScan`'d text.
 */
export function lineImportsValue(line: string, spec: string): boolean {
  const esc = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mentions = new RegExp(`from\\s*['"]${esc}['"]|import\\(\\s*['"]${esc}['"]|import\\s*['"]${esc}['"]`);
  if (!mentions.test(line)) return false;

  // `import type ...` / `export type ...` — wholly erased.
  if (/^\s*(?:import|export)\s+type\b/.test(line)) return false;

  // Braced bindings: a value import unless EVERY binding carries `type`.
  const braces = line.match(/\{([^}]*)\}/);
  if (braces) {
    const bindings = braces[1]!.split(',').map((b) => b.trim()).filter(Boolean);
    if (bindings.length > 0 && bindings.every((b) => /^type\s/.test(b))) {
      // A default or namespace binding alongside all-type braces is STILL a value import:
      // `import Def, { type A } from 'x'` imports Def at runtime. Untested until the sdlc/026
      // audit gutted this line to `return false` and all 23 tests stayed green.
      return /^\s*import\s+[A-Za-z_$*]/.test(line);
    }
  }
  return true;
}

/** Distinct files that import `spec` as a value. `scope` null means tree-wide (bare specifiers). */
export function findImporters(
  files: readonly SourceFile[],
  spec: string,
  scope: string | null,
): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (isTestFile(f.path)) continue;
    if (scope !== null && dirOf(f.path) !== scope) continue;
    if (normalizeForScan(f.text).split('\n').some((line) => lineImportsValue(line, spec))) {
      out.push(f.path);
    }
  }
  return out.toSorted();
}

export function analyze(files: readonly SourceFile[]): Violation[] {
  const mocks = findMocks(files);
  const violations: Violation[] = [];

  // R1 — topology. A mocked module may have at most one non-test importer in scope.
  const seenR1 = new Set<string>();
  for (const { testPath, specifier } of mocks) {
    if (AMBIENT_ALLOWLIST.includes(specifier)) continue;
    const local = specifier.startsWith('./') || specifier.startsWith('../');
    const scope = local ? dirOf(testPath) : null;
    const key = `${scope ?? '*'}::${specifier}`;
    if (seenR1.has(key)) continue;
    seenR1.add(key);

    const importers = findImporters(files, specifier, scope);
    if (importers.length > 1) {
      violations.push({
        rule: 'R1',
        specifier,
        detail: `mocked by ${testPath} but imported by ${importers.length} non-test files`,
        files: importers,
      });
    }
  }

  // R2 — no two test files may mock the same specifier STRING unless allowlisted.
  //
  // Free today (only 'vscode' is duplicated, and it is allowlisted) and it makes the guard
  // independent of which mock-keying model is correct — it catches sdlc/001's './deps.js' under
  // string keying, path keying, or the behaviour measured here.
  const byString = new Map<string, Set<string>>();
  for (const { testPath, specifier } of mocks) {
    if (AMBIENT_ALLOWLIST.includes(specifier)) continue;
    if (!byString.has(specifier)) byString.set(specifier, new Set());
    byString.get(specifier)!.add(testPath);
  }
  for (const [specifier, testers] of byString) {
    if (testers.size > 1) {
      violations.push({
        rule: 'R2',
        specifier,
        detail: `mocked by ${testers.size} different test files`,
        files: [...testers].toSorted(),
      });
    }
  }

  return violations.toSorted((a, b) => (a.rule + a.specifier).localeCompare(b.rule + b.specifier));
}
