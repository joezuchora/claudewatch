/**
 * The extension host's view of @claudewatch/core.
 *
 * This module exists to BE MOCKED, by extension.test.ts, and it has exactly one consumer for the
 * reason sdlc/026's guard enforces: `mock.module` is process-wide, so a bridge with two consumers
 * stubs the second one's dependency silently. Before sdlc/027, extension.ts and tooltip.ts shared
 * `core-bridge.ts`, and a test mocking it would have re-created sdlc/025's defect exactly —
 * tooltip.test.ts asserting against a stubbed formatTooltip again.
 *
 * Keep this to the symbols extension.ts imports — but not for the reason an earlier revision of
 * this docstring gave. It claimed a symbol the stub omits is `undefined` at call time, surfacing
 * as a TypeError swallowed by doRefresh's catch-all and yielding a green, meaningless test. That
 * is false on this runtime, and it was asserted rather than measured. What actually happens:
 *
 *     SyntaxError: Export named 'markStale' not found in module '…/extension-bridge.ts'
 *     0 pass, 1 fail
 *
 * ES module linking rejects a MISSING key before a single test runs, so that direction needs no
 * assertion. A SURPLUS key is the direction nothing else catches — a symbol the stub provides and
 * extension.ts no longer imports links fine and quietly widens the fake. That is what
 * extension.test.ts's key-set assertion earns its place on, and the only thing it does.
 * (Measured in sdlc/027 Stage 5, in both directions.)
 *
 * Value re-binding, not `export … from`: a static re-export keeps the mock linked to the original
 * module and the contamination survives (sdlc/001, at the cost of 127 tests).
 *
 * Re-exports only — logic here would violate SPEC.md §8.2.
 */
import * as core from '@claudewatch/core';

export const setTelemetryConfig = core.setTelemetryConfig;
export const resolveCredentials = core.resolveCredentials;
export const fetchUsage = core.fetchUsage;
export const normalize = core.normalize;
export const readCache = core.readCache;
export const writeCache = core.writeCache;
export const isCacheFresh = core.isCacheFresh;
export const makeCacheEnvelope = core.makeCacheEnvelope;
export const isInCooldown = core.isInCooldown;
export const enterCooldown = core.enterCooldown;
export const clearCooldown = core.clearCooldown;
export const shouldCooldown = core.shouldCooldown;
export const failurePolicy = core.failurePolicy;
export const markStale = core.markStale;
export const makeErrorSnapshot = core.makeErrorSnapshot;
export const extractLastError = core.extractLastError;

export type { UsageSnapshot, CacheEnvelope, LastErrorInfo } from '@claudewatch/core';
