/**
 * The extension's view of @claudewatch/core.
 *
 * Extension source imports the core API through this module rather than directly, so that
 * statusbar.test.ts can mock a module that packages/vscode owns.
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

export const classify = core.classify;
export const evaluate = core.evaluate;
export const formatTooltip = core.formatTooltip;
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
export const setTelemetryConfig = core.setTelemetryConfig;
export const emit = core.emit;
export const emitProcess = core.emitProcess;
export const renderEvent = core.renderEvent;
export const utilizationBucket = core.utilizationBucket;

export type {
  UsageSnapshot,
  CacheEnvelope,
  LastErrorInfo,
  RuntimeState,
  ThresholdLevel,
} from '@claudewatch/core';
