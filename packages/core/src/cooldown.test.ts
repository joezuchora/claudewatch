import { describe, expect, test } from 'bun:test';
import { isInCooldown, enterCooldown, clearCooldown, shouldCooldown } from './cooldown.js';
import { makeTestSnapshot, makeTestEnvelope } from './test-helpers.js';
import type { CacheEnvelope } from './types.js';

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
