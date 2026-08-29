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

/** Test files that supply a `mock.module('vscode', …)` factory with a body of their own. */
export function inlineFactories(files: readonly SourceFile[]): string[] {
  const out: string[] = [];
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
        const shared = ts.isArrowFunction(factory) && ts.isIdentifier(factory.body) && factory.body.text === 'vscodeStub';
        if (!shared) out.push(basename(file.path));
      }
      ts.forEachChild(node, walk);
    };
    walk(parse(file.path, file.text));
  }
  return out;
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
  const dir = join(root, 'packages', 'vscode', 'src');
  const { sources, tests } = readSources(dir);
  const stubPath = join(dir, 'vscode-stub.ts');
  const stub = sources.find((s) => s.path === stubPath);

  let failed = false;

  if (stub === undefined) {
    console.error(`vscode-stub-cover: no ${stubPath}`);
    process.exit(1);
  }

  const extra = inlineFactories(tests);
  if (extra.length > 0) {
    console.error(
      `vscode-stub-cover: ${extra.length} file(s) build their own vscode factory instead of using the shared stub: ${extra.join(', ')}.\n` +
        '  Per-file factories do not compose — see vscode-stub.ts.',
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
