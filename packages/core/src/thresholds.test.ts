import { describe, expect, test } from 'bun:test';
import { evaluate } from './thresholds.js';

describe('thresholds', () => {
  describe('with default thresholds (warn=70, crit=90)', () => {
    test('returns normal for 0%', () => {
      expect(evaluate(0)).toBe('normal');
    });

    test('returns normal for 69%', () => {
      expect(evaluate(69)).toBe('normal');
    });

    test('returns warning at exactly 70%', () => {
      expect(evaluate(70)).toBe('warning');
    });

    test('returns warning for 85%', () => {
      expect(evaluate(85)).toBe('warning');
    });

    test('returns warning for 89%', () => {
      expect(evaluate(89)).toBe('warning');
    });

    test('returns critical at exactly 90%', () => {
      expect(evaluate(90)).toBe('critical');
    });

    test('returns critical for 100%', () => {
      expect(evaluate(100)).toBe('critical');
    });
  });

  describe('with custom thresholds', () => {
    test('respects custom warning threshold', () => {
      expect(evaluate(50, 50, 90)).toBe('warning');
      expect(evaluate(49, 50, 90)).toBe('normal');
    });

    test('respects custom critical threshold', () => {
      expect(evaluate(80, 70, 80)).toBe('critical');
      expect(evaluate(79, 70, 80)).toBe('warning');
    });

    test('handles warn == crit (no warning zone)', () => {
      expect(evaluate(69, 70, 70)).toBe('normal');
      expect(evaluate(70, 70, 70)).toBe('critical');
    });
  });
});
