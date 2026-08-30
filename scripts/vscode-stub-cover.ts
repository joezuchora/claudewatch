#!/usr/bin/env bun
/**
 * Does the one shared `vscode` stub cover what the source actually uses? (sdlc/039)
 *
 * `packages/vscode/src/*.ts` import `vscode`, which does not exist at test time — the tests supply
 * it with `mock.module`. Until this loop there were four such factories, and a consumer does not
 * see their union: each top-level key comes wholesale from one of them, chosen by bun's load
 * order. A key one file declared was simply absent for everyone else. `vscode-stub.ts` is now the
 * single factory; this check is what keeps it single, and what fails loudly when the source starts
 * using a member the stub does not have.
 *
 * TYPE VERSUS VALUE is done by the compiler's own parse, not by a keyword rule. A member used as a
 * value parses as a `PropertyAccessExpression`; one used as a type parses as a `QualifiedName`
 * inside a type node. That distinction handles `as vscode.X`, `=> vscode.X` return types, `typeof`
 * as an operator versus as a type query, and multi-line member chains, all without enumerating
 * anything — and comments and string literals contribute nothing because they are not those nodes.
 * A syntactic rule was specified first and rejected: four shapes in this package defeat it.
 *
 * Presence only. A stub whose `createStatusBarItem` returns nonsense passes here; the tests that
 * use it are what catch that. A key defined as `undefined` or `null` does NOT count as present —
 * that is the shape both of this loop's real mutations produced (`TypeError: undefined is not an
 * object`), and a scanner that only collected key names would call it covered.
 */
import { readdirSync, readFileSync } from 'fs';
import { join, resolve, basename } from 'path';
import ts from 'typescript';

export interface Member {
  object: string;
  property?: string;
}

export interface SourceFile {
  path: string;
  text: string;
}

export interface Coverage {
  required: Member[];
  provided: Member[];
  missing: Array<Member & { neededBy: string[] }>;
  surplus: Member[];
}

export function memberKey(m: Member): string {
  return m.property === undefined ? m.object : `${m.object}.${m.property}`;
}

function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true);
}

/**
 * Members the source uses as VALUES, keyed to the files that use them.
 *
 * Classified per occurrence and unioned, because `tooltip.ts` uses `MarkdownString` as a type on
 * one line and constructs it on the next; a per-member classifier that took the first occurrence
 * would drop it entirely.
 */
export function requiredMembers(files: readonly SourceFile[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const file of files) {
    const seen = (key: string): void => {
      const users = out.get(key) ?? new Set<string>();
      users.add(basename(file.path));
      out.set(key, users);
    };
    const walk = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'vscode') {
        const parent = node.parent;
        // `vscode.a.b` parses as PropertyAccess(PropertyAccess(vscode, a), b) — record the pair,
        // not just `a`, or `workspace` alone would satisfy a need for `workspace.getConfiguration`.
        if (parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.expression === node) {
          seen(memberKey({ object: node.name.text, property: parent.name.text }));
        } else {
          seen(memberKey({ object: node.name.text }));
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(parse(file.path, file.text));
  }
  return out;
}

/** A key written as `undefined` or `null` is declared but not provided — see the docstring. */
function isAbsent(init: ts.Expression | undefined): boolean {
  return (
    init === undefined ||
    init.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(init) && init.text === 'undefined')
  );
}

/** Top-level keys and first-level sub-keys of the object `export const vscodeStub = { … }`. */
export function providedMembers(stub: SourceFile): Set<string> {
  const out = new Set<string>();
  const sf = parse(stub.path, stub.text);
  let literal: ts.ObjectLiteralExpression | undefined;
  const find = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'vscodeStub' &&
      node.initializer !== undefined &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      literal = node.initializer;
    }
    ts.forEachChild(node, find);
  };
  find(sf);
  if (literal === undefined) return out;

  for (const prop of literal.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
    if (isAbsent(prop.initializer)) continue;
    out.add(prop.name.text);
    if (ts.isObjectLiteralExpression(prop.initializer)) {
      for (const sub of prop.initializer.properties) {
        const name = sub.name;
        if (name === undefined || !ts.isIdentifier(name)) continue;
        if (ts.isPropertyAssignment(sub) && isAbsent(sub.initializer)) continue;
        out.add(`${prop.name.text}.${name.text}`);
      }
    }
  }
  return out;
}

export interface Installers {
  /** Files installing the shared stub: `mock.module('vscode', () => vscodeStub)`. */
  shared: string[];
  /** Files building a factory of their own — the arrangement this loop removed. */
  inline: string[];
}

/**
 * Who installs `vscode`, and how.
 *
 * The first version of this returned only the inline list, so the gate enforced "zero inline"
 * while its docstring claimed "exactly one". The Stage 5 audit demonstrated the gap: strip the
 * factory from every test file and the CLI still exited 0 while the package would be entirely
 * red. Reporting both lists is what lets the CLI check the half it was missing.
 *
 * What this canNOT check is that each file which NEEDS `vscode` installs it — that depends on
 * bun's load order, which is the thing this loop removed reliance on. `every vscode test file
 * passes run alone` is what covers it, and no static scan substitutes for it.
 */
export function vscodeInstallers(files: readonly SourceFile[]): Installers {
  const shared: string[] = [];
  const inline: string[] = [];
  for (const file of files) {
    const walk = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'module' &&
        node.arguments.length >= 2 &&
        ts.isStringLiteral(node.arguments[0]!) &&
        node.arguments[0]!.text === 'vscode'
      ) {
        const factory = node.arguments[1]!;
        // `() => vscodeStub` names the shared module; anything else builds its own.
        const isShared =
          ts.isArrowFunction(factory) && ts.isIdentifier(factory.body) && factory.body.text === 'vscodeStub';
        (isShared ? shared : inline).push(basename(file.path));
      }
      ts.forEachChild(node, walk);
    };
    walk(parse(file.path, file.text));
  }
  return { shared, inline };
}

function toMember(key: string): Member {
  const [object, property] = key.split('.');
  return property === undefined ? { object: object! } : { object: object!, property };
}

export function compare(required: Map<string, Set<string>>, provided: Set<string>): Coverage {
  const missing = [...required.keys()]
    .filter((k) => !provided.has(k))
    .toSorted()
    .map((k): Member & { neededBy: string[] } => {
      const m = toMember(k);
      return { object: m.object, property: m.property, neededBy: [...required.get(k)!].toSorted() };
    });
  // A bare parent whose child is required is not surplus — `window` is needed for
  // `window.createStatusBarItem` to mean anything. Reporting it would bury the two entries that
  // are genuinely unused behind five that are not.
  const surplus = [...provided]
    .filter((k) => !required.has(k) && ![...required.keys()].some((r) => r.startsWith(`${k}.`)))
    .toSorted()
    .map(toMember);
  return {
    required: [...required.keys()].toSorted().map(toMember),
    provided: [...provided].toSorted().map(toMember),
    missing,
    surplus,
  };
}

export function readSources(dir: string): { sources: SourceFile[]; tests: SourceFile[] } {
  const sources: SourceFile[] = [];
  const tests: SourceFile[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith('.ts')) {
        const file = { path, text: readFileSync(path, 'utf-8') };
        (entry.name.endsWith('.test.ts') ? tests : sources).push(file);
      }
    }
  };
  walk(dir);
  return { sources, tests };
}

// --- CLI ---

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  // A directory argument makes the CLI's own exit status testable against a fixture tree without
  // mutating the checked-in one. The Stage 5 audit found the criterion for that exit status had no
  // test at all, and that the mutation predicted to catch it was never run.
  const argDir = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const dir = argDir === undefined ? join(root, 'packages', 'vscode', 'src') : resolve(argDir);
  const { sources, tests } = readSources(dir);
  const stubPath = join(dir, 'vscode-stub.ts');
  const stub = sources.find((s) => s.path === stubPath);

  let failed = false;

  if (stub === undefined) {
    console.error(`vscode-stub-cover: no ${stubPath}`);
    process.exit(1);
  }

  const installers = vscodeInstallers(tests);
  if (installers.inline.length > 0) {
    console.error(
      `vscode-stub-cover: ${installers.inline.length} file(s) build their own vscode factory instead of using the shared stub: ${installers.inline.join(', ')}.\n` +
        '  Per-file factories do not compose — see vscode-stub.ts.',
    );
    failed = true;
  }
  if (installers.shared.length === 0) {
    console.error(
      'vscode-stub-cover: no test file installs the shared stub with ' +
        "mock.module('vscode', () => vscodeStub). Nothing would resolve `vscode` at test time.",
    );
    failed = true;
  }

  // The stub is not a consumer of `vscode`; excluding it keeps its own docstring examples out.
  const consumers = sources.filter((s) => s.path !== stubPath);
  const result = compare(requiredMembers(consumers), providedMembers(stub));

  for (const m of result.missing) {
    console.error(`vscode-stub-cover: ${memberKey(m)} is required by ${m.neededBy.join(', ')} and the stub does not provide it`);
    failed = true;
  }
  for (const m of result.surplus) {
    console.log(`  surplus (provided, required by nothing): ${memberKey(m)}`);
  }
  if (!failed) {
    if (process.argv.includes('--list')) {
      for (const m of result.required) console.log(`  required: ${memberKey(m)}`);
    }
    console.log(`vscode-stub-cover: ${result.required.length} required member(s), all provided by one stub.`);
  }
  process.exit(failed ? 1 : 0);
}
