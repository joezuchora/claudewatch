/**
 * Tests for the two registered commands.
 *
 * WHY THE VSCODE SINKS ARE INSTALLED BY MUTATION, not by this file's own mock factory:
 *
 * `mock.module('vscode', …)` across several files does NOT produce last-writer-wins, and does not
 * produce a union either. It produces a per-key COMPOSITE, and a key defined by only one file can
 * vanish. Measured in a whole-package run (sdlc/028 B5a):
 *
 *     PROBE top-level keys: [MarkdownString, StatusBarAlignment, ThemeColor, commands, env,
 *                            window, workspace]
 *     PROBE has Uri: false            <- extension.test.ts's stub defines Uri
 *     PROBE window keys: [createStatusBarItem]   <- a DIFFERENT stub's window
 *
 * So a file-local factory is not sufficient: this file green alone went red in a package run with
 * `TypeError: undefined is not an object (evaluating 'vscode.Uri.parse')`. Each test therefore
 * reaches into the RESOLVED module and installs its sinks there, and restores them afterwards.
 * `commands.ts` does `import * as vscode` at module scope, so it reads through the same object.
 *
 * A9 for this file is `bun test packages/vscode` passing, not just this file passing — see the
 * criterion A10, which names both runs for exactly this reason.
 */
import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { makeTestSnapshot } from '@claudewatch/core/test-helpers';
import type { CacheEnvelope } from '@claudewatch/core';

// --- the vscode stub ---
//
// This factory is required for RESOLUTION: `vscode` is not a real package, so without a
// `mock.module('vscode')` in this file, `commands.ts`'s `import * as vscode` fails outright with
// "Cannot find package 'vscode'". Measured. The per-key composite described above is a SEPARATE
// problem: the factory makes the module exist, the mutation in `beforeEach` makes the sinks
// reliable. An earlier draft of the plan treated these as alternatives; they are both needed.

mock.module('vscode', () => ({
  window: { showInformationMessage: (): void => {}, showErrorMessage: (): void => {} },
  env: { openExternal: (): void => {}, isTelemetryEnabled: false },
  Uri: { parse: (s: string) => s },
  commands: { registerCommand: (): { dispose(): void } => ({ dispose(): void {} }) },
  workspace: {
    getConfiguration: () => ({ get: <T,>(_k: string, d: T): T => d }),
    onDidChangeConfiguration: (): { dispose(): void } => ({ dispose(): void {} }),
  },
  StatusBarAlignment: { Right: 2 },
  ThemeColor: class { constructor(public id: string) {} },
  MarkdownString: class { value = ''; appendText(t: string): this { this.value += t; return this; } },
}));

// --- the bridge mock ---

let readCacheImpl: () => CacheEnvelope | null = () => null;
let formatTooltipImpl: () => string = () => 'FORMATTED-TOOLTIP';

mock.module('./commands-bridge.js', () => ({
  readCache: () => readCacheImpl(),
  formatTooltip: () => formatTooltipImpl(),
}));

const { showDiagnostics, openDashboard } = await import('./commands.js');

// --- the resolved-module sinks ---

interface Shown { msg: string; opts: unknown }
let shown: Shown[] = [];
let opened: unknown[] = [];

interface VscodeSinks {
  window: { showInformationMessage: (m: string, o?: unknown) => void };
  env: { openExternal: (u: unknown) => void };
  Uri: { parse: (s: string) => string };
}

let restore: Array<() => void> = [];

beforeEach(async () => {
  shown = []; opened = []; restore = [];
  const v = (await import('vscode')) as unknown as VscodeSinks;

  const prevShow = v.window.showInformationMessage;
  v.window.showInformationMessage = (msg: string, opts?: unknown): void => { shown.push({ msg, opts }); };
  restore.push(() => { v.window.showInformationMessage = prevShow; });

  const prevOpen = v.env.openExternal;
  v.env.openExternal = (u: unknown): void => { opened.push(u); };
  restore.push(() => { v.env.openExternal = prevOpen; });

  // `Uri.parse`, not `Uri`. A module's TOP-LEVEL exports are readonly — `v.Uri = {...}` throws
  // `TypeError: Attempted to assign to readonly property` (measured) — while NESTED properties are
  // mutable, which is why the two assignments above work. So a top-level key missing from the
  // merged composite CANNOT be rescued from here: it has to come from a stub that survives the
  // merge. That is precisely why statusbar.test.ts and tooltip.test.ts must also carry `Uri`, and
  // why this file passing alone proves nothing about the package run (criterion A10).
  const prevParse = v.Uri.parse;
  v.Uri.parse = (u: string) => u;
  restore.push(() => { v.Uri.parse = prevParse; });
});

afterEach(() => {
  for (const r of restore) r();
  readCacheImpl = () => null;
  formatTooltipImpl = () => 'FORMATTED-TOOLTIP';
});

const envelope = (): CacheEnvelope => ({
  version: 2, snapshot: makeTestSnapshot(), cooldownUntil: null, lastErrorClass: null,
  lastHttpStatus: null, lastErrorMessage: null,
});

describe('showDiagnostics', () => {
  test('formats the snapshot when the cache has one, and shows it MODALLY', async () => {
    readCacheImpl = () => envelope();
    await showDiagnostics();
    expect(shown).toHaveLength(1);
    expect(shown[0]!.msg).toContain('FORMATTED-TOOLTIP');
    expect(shown[0]!.msg).toContain('**ClaudeWatch Diagnostics**');
    // The modal flag is part of the contract: a non-modal message truncates, which defeats the
    // point of a diagnostic. Deleting it must redden exactly this test.
    expect(shown[0]!.opts).toEqual({ modal: true });
  });

  test('says so when there is no cache at all', async () => {
    // Reaches the else-branch via `cache === null`. The `&& cache.snapshot` half of that guard is
    // unreachable under CacheEnvelope's non-nullable snapshot and is retained deliberately —
    // nothing here asserts it, and review.md says so rather than claiming the branch is covered.
    readCacheImpl = () => null;
    await showDiagnostics();
    expect(shown[0]!.msg).toContain('No cache or snapshot found.');
    expect(shown[0]!.msg).not.toContain('FORMATTED-TOOLTIP');
  });

  test('a throw from readCache lands in the catch instead of escaping', async () => {
    readCacheImpl = () => { throw new Error('disk on fire'); };
    await showDiagnostics();                        // must resolve, not reject
    expect(shown[0]!.msg).toContain('Error reading cache: disk on fire');
    // Positive precondition for the negative above: the success path really would have produced
    // the formatted string, as the first test in this block shows.
    expect(shown[0]!.msg).not.toContain('FORMATTED-TOOLTIP');
  });

  test('CHARACTERIZATION: a raw error message is surfaced verbatim — SPEC.md §12 unmet', async () => {
    // NOT an approval. §12 says "It must redact sensitive values from all surfaced errors" and
    // "must not include tokens in issue templates, screenshots, or debug output", and
    // showDiagnostics IS the debug-output surface. Nothing in the tree redacts anything: there is
    // no redactor in packages/core at all, so this invariant is unimplemented product-wide, not
    // merely skipped here.
    //
    // Fixing it properly means a redactor in packages/core with its own tests — a surface-local one
    // would violate SPEC.md §8.2. That is a loop, not a step in this one, so sdlc/028 records the
    // finding and this test pins the CURRENT behaviour so the follow-up has something to break.
    // When the redactor lands, this test should FAIL and be rewritten as the assertion §12 wants.
    readCacheImpl = () => {
      throw new Error('ENOENT open /home/testuser/.claude/.credentials.json (sk-ant-oat01-FAKE)');
    };
    await showDiagnostics();
    expect(shown[0]!.msg).toContain('sk-ant-oat01-FAKE');
    expect(shown[0]!.msg).toContain('.credentials.json');
  });
});

describe('openDashboard', () => {
  test('opens the Claude usage dashboard', async () => {
    openDashboard();
    expect(opened).toHaveLength(1);
    expect(String(opened[0])).toBe('https://claude.ai/settings/usage');
  });
});
