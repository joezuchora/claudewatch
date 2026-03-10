import { describe, expect, test } from 'bun:test';
import type {
  UsageSnapshot,
  CacheEnvelope,
  RawUsageResponse,
  CredentialFile,
  RuntimeState,
  FailureClass,
  ThresholdLevel,
  AuthState,
  FetchResult,
} from './types.js';

describe('types', () => {
  test('UsageSnapshot interface is structurally valid', () => {
    const snapshot: UsageSnapshot = {
      fetchedAt: '2026-03-07T12:00:00.000Z',
      source: { usageEndpoint: 'success' },
      authState: 'valid',
      fiveHour: { utilizationPct: 42, resetsAt: '2026-03-07T17:00:00.000Z' },
      sevenDay: { utilizationPct: 18, resetsAt: '2026-03-14T07:00:00.000Z' },
      display: {
        primaryWindow: 'fiveHour',
        primaryUtilizationPct: 42,
        primaryResetsAt: '2026-03-07T17:00:00.000Z',
      },
      freshness: { isStale: false, staleReason: 'none' },
      rawMetadata: { normalizationWarnings: [] },
    };
    expect(snapshot.fetchedAt).toBe('2026-03-07T12:00:00.000Z');
    expect(snapshot.display.primaryWindow).toBe('fiveHour');
  });

  test('CacheEnvelope wraps snapshot with version', () => {
    const envelope: CacheEnvelope = {
      version: 1,
      snapshot: {
        fetchedAt: '2026-03-07T12:00:00.000Z',
        source: { usageEndpoint: 'success' },
        authState: 'valid',
        fiveHour: { utilizationPct: 10, resetsAt: null },
        sevenDay: { utilizationPct: 20, resetsAt: null },
        display: { primaryWindow: 'sevenDay', primaryUtilizationPct: 20, primaryResetsAt: null },
        freshness: { isStale: false, staleReason: 'none' },
        rawMetadata: { normalizationWarnings: [] },
      },
      cooldownUntil: null,
      lastErrorClass: null,
      lastHttpStatus: null,
      lastErrorMessage: null,
    };
    expect(envelope.version).toBe(1);
  });

  test('RuntimeState union covers all states', () => {
    const states: RuntimeState[] = [
      'Initializing', 'Healthy', 'Stale', 'Degraded',
      'AuthInvalid', 'NotConfigured', 'HardFailure',
    ];
    expect(states).toHaveLength(7);
  });

  test('FailureClass union covers all classes', () => {
    const classes: FailureClass[] = [
      'notConfigured', 'authInvalid', 'serviceUnavailable',
      'malformedResponse', 'unexpectedFailure',
    ];
    expect(classes).toHaveLength(5);
  });

  test('ThresholdLevel union covers all levels', () => {
    const levels: ThresholdLevel[] = ['normal', 'warning', 'critical'];
    expect(levels).toHaveLength(3);
  });
});
