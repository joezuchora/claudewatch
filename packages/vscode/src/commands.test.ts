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
import { vscodeStub, resetVscodeStub } from './vscode-stub.js';

// --- the vscode stub ---
//
// One shared factory now — see vscode-stub.ts for why per-file ones do not compose, and for the
// reproduction that killed the composite model. The factory is still required for RESOLUTION:
// `vscode` is not a real package, so without a `mock.module('vscode')` reachable from this file
// `commands.ts`'s `import * as vscode` fails outright with "Cannot find package 'vscode'".
// Measured. (sdlc/039)
mock.module('vscode', () => vscodeStub);

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

beforeEach(async () => {
  shown = []; opened = [];
  // `resetVscodeStub()` restores every leaf this block overwrites, so the save/restore array and
  // its `afterEach` are gone: one shared stub means one place that knows the pristine shape.
  resetVscodeStub();
  const v = (await import('vscode')) as unknown as VscodeSinks;

  v.window.showInformationMessage = (msg: string, opts?: unknown): void => { shown.push({ msg, opts }); };
  v.env.openExternal = (u: unknown): void => { opened.push(u); };

  // NESTED properties are mutable while a module's TOP-LEVEL exports are readonly — `v.Uri = {...}`
  // throws `TypeError: Attempted to assign to readonly property` (measured in sdlc/028), which is
  // why the two assignments above work. With one shared stub the old worry behind this note is
  // gone: there is no composite for a top-level key to fall out of.
});

afterEach(() => {
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

  test('CHARACTERIZATION: the reachable error message is surfaced verbatim', async () => {
    // NOT an approval. §12 says "It must redact sensitive values from all surfaced errors" and
    // "must not include tokens in ... debug output", and showDiagnostics IS the debug-output
    // surface. Nothing in the tree redacts anything — there is no redactor in packages/core at
    // all, so this invariant is unimplemented product-wide, not merely skipped here. Fixing it
    // properly means a core module with its own tests; a surface-local one violates §8.2.
    //
    // AN EARLIER REVISION OF THIS TEST PINNED A THREAT THAT CANNOT HAPPEN. It threw
    // `ENOENT open /home/testuser/.claude/.credentials.json (sk-ant-oat01-FAKE)` and asserted the
    // token and path came through. But `readCache` cannot produce that: `readCacheResult` wraps
    // BOTH `readFileSync` and `JSON.parse` in try/catch and returns null (cache.ts:79-94), and
    // nothing in this call graph opens the credential file — `commands-bridge.ts` re-exports only
    // `readCache` and `formatTooltip`. So the test documented a fake threat model, and a follow-up
    // loop would have been scoped against it. Found by the sdlc/028 security pass.
    //
    // The ONE reachable throw, measured: a cache file lacking `fiveHour` passes
    // `readCacheResult`'s shape check (which validates only fetchedAt/display/freshness) and then
    // `formatTooltip` throws. The message carries no token, no path, no username:
    formatTooltipImpl = () => {
      throw new Error("undefined is not an object (evaluating 'snapshot.fiveHour.utilizationPct')");
    };
    readCacheImpl = () => envelope();
    await showDiagnostics();
    expect(shown[0]!.msg).toContain('Error reading cache: undefined is not an object');
    // So the measured exposure of the §12 gap on THIS surface is nothing. The follow-up redactor
    // is architectural hygiene, not an incident — and it must scope the SUCCESS path too, where
    // `formatTooltip` interpolates `enterprise.disabledReason`, unconstrained free text, verbatim.
    expect(shown[0]!.msg).not.toContain('sk-ant');
  });
});

describe('openDashboard', () => {
  test('opens the Claude usage dashboard', async () => {
    openDashboard();
    expect(opened).toHaveLength(1);
    expect(String(opened[0])).toBe('https://claude.ai/settings/usage');
  });
});
