/**
 * The view of @claudewatch/core for `tooltip.ts`, and only `tooltip.ts`.
 *
 * Nothing mocks this module, and that is the point — it is the unmocked residue. Note it is NOT
 * named for its consumer the way statusbar-bridge.ts and extension-bridge.ts are; those are named
 * for the single test that mocks them, and this one has no mocker to be named for. Renaming it
 * `tooltip-bridge.ts` would be tidier and is deliberately not done here, because it would touch a
 * file this loop has no other reason to open. (sdlc/027)
 *
 * Its previous docstring named the status bar's test as the reason this module existed, and it
 * used to serve the status bar too. Because `mock.module` is process-wide, mocking
 * it for the status bar also stubbed `formatTooltip` for `tooltip.test.ts`, whose subject reaches
 * it through `tooltip.ts` — so those tests asserted against `formatted: 42%` for four loops, and
 * loop 002 had to relocate a planned test out of that file. The status bar now has its own
 * `statusbar-bridge.ts`; this module exists to NOT be mocked. If you are about to mock it, split
 * it again instead. (sdlc/025)
 *
 * Bun applies `mock.module` process-wide and `mock.restore()` does not undo it, so a test
 * that mocks '@claudewatch/core' replaces the real module for packages/core's own tests too.
 * In a whole-suite `bun test` run that produced false failures in core, hidden by CI running
 * each package in a separate process. See sdlc/001-quality-gate/.
 *
 * Value re-binding (not `export ... from`) is deliberate: a static re-export keeps the mock
 * linked to the original module and the contamination survives.
 *
 * Re-exports only. Any logic added here would violate the architecture rule that surface
 * packages contain no domain logic (SPEC.md §8.2) — put it in packages/core instead.
 */
import * as core from '@claudewatch/core';

export const formatTooltip = core.formatTooltip;

export type {
  UsageSnapshot,
  CacheEnvelope,
  LastErrorInfo,
  RuntimeState,
  ThresholdLevel,
} from '@claudewatch/core';
