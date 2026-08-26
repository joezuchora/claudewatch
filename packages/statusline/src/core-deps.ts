/**
 * Statusline's view of @claudewatch/core.
 *
 * main.ts imports the core API through this module rather than directly, so that
 * main.test.ts can mock a module that statusline owns.
 *
 * Bun applies `mock.module` process-wide and `mock.restore()` does not undo it, so a test
 * that mocks '@claudewatch/core' replaces the real module for packages/core's own tests too.
 * That produced 128 false failures in a whole-suite `bun test` run, hidden by CI running each
 * package in a separate process. See sdlc/001-quality-gate/.
 *
 * Re-exports only. Any logic added here would violate the architecture rule that surface
 * packages contain no domain logic (SPEC.md §8.2) — put it in packages/core instead.
 */
import * as core from '@claudewatch/core';

export const readCache = core.readCache;
export const writeCache = core.writeCache;
export const isCacheFresh = core.isCacheFresh;
export const makeCacheEnvelope = core.makeCacheEnvelope;
export const getCachePath = core.getCachePath;
export const isInCooldown = core.isInCooldown;
export const enterCooldown = core.enterCooldown;
export const clearCooldown = core.clearCooldown;
export const shouldCooldown = core.shouldCooldown;
export const resolveCredentials = core.resolveCredentials;
export const getCredentialPath = core.getCredentialPath;
export const fetchUsage = core.fetchUsage;
export const normalize = core.normalize;
export const classify = core.classify;
export const formatStatusLine = core.formatStatusLine;
export const formatRichStatusLine = core.formatRichStatusLine;
export const markStale = core.markStale;
export const makeErrorSnapshot = core.makeErrorSnapshot;
export const resolveTelemetryConfig = core.resolveTelemetryConfig;
export const emit = core.emit;
export const renderEvent = core.renderEvent;
export const utilizationBucket = core.utilizationBucket;

export type {
  UsageSnapshot,
  CacheEnvelope,
  SessionInfo,
  FailureClass,
} from '@claudewatch/core';
