import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  isInCooldown,
  enterCooldown,
  clearCooldown,
  shouldCooldown,
  failurePolicy,
  isFailureClass,
  FAILURE_CLASSES,
  type FailurePolicy,
} from './cooldown.js';
import type { FailureClass } from './types.js';
import { makeTestEnvelope } from './test-helpers.js';

describe('cooldown', () => {
  describe('isInCooldown', () => {
    test('returns false when cooldownUntil is null', () => {
      const env = makeTestEnvelope();
      expect(isInCooldown(env)).toBe(false);
    });

    test('returns true when cooldownUntil is in the future', () => {
      const future = new Date(Date.now() + 30_000).toISOString();
      const env = makeTestEnvelope({ cooldownUntil: future });
      expect(isInCooldown(env)).toBe(true);
    });

    test('returns false when cooldownUntil is in the past', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const env = makeTestEnvelope({ cooldownUntil: past });
      expect(isInCooldown(env)).toBe(false);
    });
  });

  describe('enterCooldown', () => {
    test('sets cooldownUntil ~5 minutes in the future', () => {
      const env = makeTestEnvelope();
      const before = Date.now();
      const result = enterCooldown(env, 'serviceUnavailable');
      const after = Date.now();

      expect(result.cooldownUntil).not.toBeNull();
      const until = new Date(result.cooldownUntil!).getTime();
      // Should be approximately 300s (5 min) from now
      expect(until).toBeGreaterThanOrEqual(before + 299_000);
      expect(until).toBeLessThanOrEqual(after + 301_000);
    });

    test('sets lastErrorClass', () => {
      const env = makeTestEnvelope();
      const result = enterCooldown(env, 'serviceUnavailable');
      expect(result.lastErrorClass).toBe('serviceUnavailable');
    });

    test('preserves existing snapshot', () => {
      const env = makeTestEnvelope();
      const result = enterCooldown(env, 'serviceUnavailable');
      expect(result.snapshot).toBe(env.snapshot);
      expect(result.version).toBe(1);
    });
  });

  describe('clearCooldown', () => {
    test('clears cooldownUntil and lastErrorClass', () => {
      const env = makeTestEnvelope({
        cooldownUntil: new Date(Date.now() + 30_000).toISOString(),
        lastErrorClass: 'serviceUnavailable',
      });
      const result = clearCooldown(env);
      expect(result.cooldownUntil).toBeNull();
      expect(result.lastErrorClass).toBeNull();
    });

    test('preserves snapshot and version', () => {
      const env = makeTestEnvelope({
        cooldownUntil: new Date(Date.now() + 30_000).toISOString(),
        lastErrorClass: 'serviceUnavailable',
      });
      const result = clearCooldown(env);
      expect(result.snapshot).toBe(env.snapshot);
      expect(result.version).toBe(env.version);
    });
  });

  describe('shouldCooldown', () => {
    test('returns true for serviceUnavailable', () => {
      expect(shouldCooldown('serviceUnavailable')).toBe(true);
    });

    test('returns false for authInvalid', () => {
      expect(shouldCooldown('authInvalid')).toBe(false);
    });

    test('returns false for notConfigured', () => {
      expect(shouldCooldown('notConfigured')).toBe(false);
    });

    test('returns false for malformedResponse', () => {
      expect(shouldCooldown('malformedResponse')).toBe(false);
    });

    test('returns false for unexpectedFailure', () => {
      expect(shouldCooldown('unexpectedFailure')).toBe(false);
    });
  });
});

describe('shouldCooldown after the timeout split (sdlc/010)', () => {
  test('REGRESSION GUARD: a timeout still enters cooldown', () => {
    // sdlc/010 split 'timeout' out of 'serviceUnavailable'. If shouldCooldown had been left
    // alone, timeouts would have silently stopped entering the 5-minute backoff that exists
    // mainly for a slow endpoint — a behaviour regression wearing a type change's clothes.
    expect(shouldCooldown('timeout')).toBe(true);
  });

  test('serviceUnavailable still enters cooldown', () => {
    expect(shouldCooldown('serviceUnavailable')).toBe(true);
  });

  test('no other class enters cooldown', () => {
    for (const c of ['notConfigured', 'authInvalid', 'malformedResponse', 'unexpectedFailure'] as const) {
      expect(shouldCooldown(c)).toBe(false);
    }
  });
});

describe('failurePolicy (sdlc/014)', () => {
  /**
   * Hand-written, deliberately. Deriving the expectation from `failurePolicy` would assert
   * that the function equals itself. Typed as a total `Record`, so adding a `FailureClass`
   * breaks THIS table at compile time too — the test cannot fall behind the union it covers.
   */
  const EXPECTED: Record<FailureClass, FailurePolicy> = {
    notConfigured: { cooldown: false, retryable: false, presentation: 'missing', statuslineExitCode: 2 },
    authInvalid: { cooldown: false, retryable: false, presentation: 'invalid', statuslineExitCode: 2 },
    serviceUnavailable: { cooldown: true, retryable: true, presentation: 'unknown', statuslineExitCode: 1 },
    timeout: { cooldown: true, retryable: true, presentation: 'unknown', statuslineExitCode: 1 },
    malformedResponse: { cooldown: false, retryable: true, presentation: 'unknown', statuslineExitCode: 1 },
    unexpectedFailure: { cooldown: false, retryable: true, presentation: 'unknown', statuslineExitCode: 1 },
  };

  test('every member has exactly the documented policy', () => {
    for (const fc of FAILURE_CLASSES) {
      expect(failurePolicy(fc)).toEqual(EXPECTED[fc]);
    }
  });

  test('FAILURE_CLASSES holds all six members exactly once', () => {
    // A count, not a spot check: `satisfies` catches a member here that is not in the union,
    // and the `never` assignment in cooldown.ts catches a union member this array lacks, but
    // neither notices a DUPLICATE — which would make every `for (const fc of ...)` loop above
    // silently cover five classes while looking like six.
    expect(FAILURE_CLASSES).toHaveLength(6);
    expect(new Set(FAILURE_CLASSES).size).toBe(6);
  });

  test('shouldCooldown agrees with the policy for every member', () => {
    for (const fc of FAILURE_CLASSES) {
      expect(shouldCooldown(fc)).toBe(failurePolicy(fc).cooldown);
    }
  });

  test('an unknown class throws rather than receiving a default policy', () => {
    // Reachable only past a cast — which is exactly how a corrupt cache file used to deliver
    // one. Before sdlc/014 the same value would have quietly landed in the default bucket.
    expect(() => failurePolicy('somethingElse' as FailureClass)).toThrow(/unhandled FailureClass/);
  });
});

describe('isFailureClass (sdlc/014)', () => {
  test('accepts every member', () => {
    for (const fc of FAILURE_CLASSES) {
      expect(isFailureClass(fc)).toBe(true);
    }
  });

  test('rejects non-members and non-strings', () => {
    for (const value of ['', 'authinvalid', 'AUTHINVALID', 'notConfigured ', null, undefined, 0, {}, ['authInvalid']]) {
      expect(isFailureClass(value)).toBe(false);
    }
  });
});

describe('the surfaces no longer compare FailureClass strings (sdlc/014)', () => {
  /**
   * The point of one exhaustive switch is lost the moment a surface re-derives a decision from
   * an equality check, because that check has no compile-time obligation to the union. This
   * scans for the pattern rather than trusting review to notice it coming back.
   */
  const SURFACES = [
    'packages/statusline/src/main.ts',
    'packages/vscode/src/extension.ts',
  ];

  test('no surface branches on a FailureClass literal', () => {
    for (const surface of SURFACES) {
      // `fileURLToPath`, not `new URL(...).pathname`: the latter stays percent-encoded, so a
      // checkout path containing a space resolves to nothing, and it yields '/C:/...' on
      // Windows. Reading directly also drops a `cat` subprocess. (sdlc/014 security pass.)
      const source = readFileSync(fileURLToPath(new URL(`../../../${surface}`, import.meta.url)), 'utf-8');
      expect(source.length).toBeGreaterThan(0);
      // Comments are allowed to mention the classes — the reasoning for this change does.
      const code = source
        .split('\n')
        .filter(line => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
        .join('\n');
      for (const fc of FAILURE_CLASSES) {
        expect(code).not.toContain(`=== '${fc}'`);
        expect(code).not.toContain(`!== '${fc}'`);
      }
    }
  });
});
