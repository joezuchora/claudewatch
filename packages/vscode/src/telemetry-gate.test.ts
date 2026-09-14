import { describe, expect, test } from 'bun:test';
import { resolveExtensionTelemetry } from './telemetry-gate.js';

describe('resolveExtensionTelemetry', () => {
  test('VS Code telemetry OFF overrides our setting being ON', () => {
    // The case VS Code's guidance exists for, and the one that would have blocked publishing.
    expect(resolveExtensionTelemetry(false, true)).toBe(false);
  });

  test('both on is the only combination that emits', () => {
    expect(resolveExtensionTelemetry(true, true)).toBe(true);
  });

  test('our setting off means nothing, whatever VS Code says', () => {
    expect(resolveExtensionTelemetry(true, false)).toBe(false);
    expect(resolveExtensionTelemetry(false, false)).toBe(false);
  });

  test('VS Code can only ever subtract — it never enables on our behalf', () => {
    // There is no input where the global switch turns telemetry on by itself.
    for (const setting of [false, undefined, null, 0, '']) {
      expect(resolveExtensionTelemetry(true, setting)).toBe(false);
    }
  });

  test('an undefined global fails closed — a host predating the API is not consent', () => {
    expect(resolveExtensionTelemetry(undefined, true)).toBe(false);
  });

  test('non-boolean inputs fail closed rather than coercing', () => {
    // 'true', 1 and {} are all truthy. None of them is a user saying yes.
    for (const v of ['true', 1, {}, [], 'yes']) {
      expect(resolveExtensionTelemetry(v, true)).toBe(false);
      expect(resolveExtensionTelemetry(true, v)).toBe(false);
    }
  });

  test('the sentinel a caller passes after a read threw fails closed', () => {
    expect(resolveExtensionTelemetry(null, true)).toBe(false);
    expect(resolveExtensionTelemetry(true, null)).toBe(false);
  });
});
