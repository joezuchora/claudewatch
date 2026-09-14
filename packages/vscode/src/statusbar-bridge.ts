/**
 * The status bar's view of @claudewatch/core.
 *
 * This module exists to BE MOCKED. `statusbar.test.ts` replaces it wholesale, and Bun applies
 * `mock.module` process-wide with no way to undo it — so whatever this module exports is stubbed
 * for every other test file in the same process.
 *
 * That is why it is separate from `core-bridge.ts`, and why it is narrow. Until sdlc/025 there
 * was one bridge shared by `statusbar.ts`, `tooltip.ts` and `extension.ts`, so mocking it for the
 * status bar also stubbed the tooltip: `tooltip.test.ts` asserted against `formatted: 42%` and
 * loop 002 had to move a planned test out of that file entirely. Splitting gives the mocked
 * module exactly one consumer.
 *
 * Keep this to the symbols `statusbar.ts` actually imports. Anything added here is something
 * `statusbar.test.ts`'s stub must also provide — `mock.module` replaces the module wholesale, so
 * a symbol the stub omits is `undefined` at call time, not a compile error.
 *
 * Value re-binding, not `export … from`: a static re-export keeps the mock linked to the original
 * module and the contamination survives. Loop 001 established that at the cost of 127 tests that
 * were still failing after the first attempt.
 *
 * Re-exports only. Logic here would violate the rule that surface packages carry no domain logic
 * (SPEC.md §8.2) — put it in packages/core.
 */
import * as core from '@claudewatch/core';

export const classify = core.classify;
export const evaluate = core.evaluate;
export const emitProcess = core.emitProcess;
export const renderEvent = core.renderEvent;
export const utilizationBucket = core.utilizationBucket;
