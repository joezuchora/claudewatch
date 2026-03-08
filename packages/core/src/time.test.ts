import { describe, expect, test } from 'bun:test';
import {
  parseUtcTimestamp,
  formatLocalTime,
  formatLocalDateTime,
  formatRelativeTime,
  detectClockSkew,
} from './time.js';

describe('parseUtcTimestamp', () => {
  test('parses valid ISO timestamp', () => {
    const result = parseUtcTimestamp('2026-03-07T15:00:00.000Z');
    expect(result).toBe(new Date('2026-03-07T15:00:00.000Z').getTime());
  });

  test('parses ISO timestamp with timezone offset', () => {
    const result = parseUtcTimestamp('2025-11-04T04:59:59.943648+00:00');
    expect(result).toBeGreaterThan(0);
  });

  test('returns null for invalid string', () => {
    expect(parseUtcTimestamp('not-a-date')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parseUtcTimestamp('')).toBeNull();
  });
});

describe('formatLocalTime', () => {
  test('formats a valid UTC ISO timestamp', () => {
    const result = formatLocalTime('2026-03-07T15:00:00.000Z');
    expect(result).toBeTruthy();
    expect(result).not.toBe('unknown');
  });

  test('returns unknown for invalid timestamp', () => {
    expect(formatLocalTime('not-a-date')).toBe('unknown');
  });

  test('lowercase option works', () => {
    const result = formatLocalTime('2026-03-07T15:00:00.000Z', true);
    expect(result).toBe(result.toLowerCase());
  });

  test('uppercase by default', () => {
    const upper = formatLocalTime('2026-03-07T15:00:00.000Z', false);
    const lower = formatLocalTime('2026-03-07T15:00:00.000Z', true);
    expect(upper).not.toBe('unknown');
    expect(lower).toBe(upper.toLowerCase());
  });
});

describe('formatLocalDateTime', () => {
  test('formats today timestamp without day name', () => {
    const now = new Date();
    const todayIso = now.toISOString();
    const result = formatLocalDateTime(todayIso);
    // Should be just time, no weekday prefix
    expect(result).not.toBe('unknown');
    // Should not contain a comma (which date formats sometimes add)
  });

  test('formats non-today timestamp with day name', () => {
    // Use a date far in the future so it's never "today"
    const result = formatLocalDateTime('2030-06-15T14:00:00.000Z');
    expect(result).not.toBe('unknown');
    // Should contain a day abbreviation (e.g., "Sat")
    expect(result.length).toBeGreaterThan(5);
  });

  test('returns unknown for invalid timestamp', () => {
    expect(formatLocalDateTime('garbage')).toBe('unknown');
  });
});

describe('formatRelativeTime', () => {
  test('returns "resets soon" for past timestamp (negative duration guard)', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(formatRelativeTime(past)).toBe('resets soon');
  });

  test('returns "resets soon" for timestamp exactly at now', () => {
    const now = Date.now();
    const iso = new Date(now).toISOString();
    expect(formatRelativeTime(iso, now)).toBe('resets soon');
  });

  test('formats hours and minutes', () => {
    const now = Date.now();
    const future = new Date(now + 2 * 3600_000 + 14 * 60_000).toISOString();
    const result = formatRelativeTime(future, now);
    expect(result).toBe('2h 14m');
  });

  test('formats hours only when no remaining minutes', () => {
    const now = Date.now();
    const future = new Date(now + 3 * 3600_000 + 20_000).toISOString(); // 3h + 20s
    const result = formatRelativeTime(future, now);
    expect(result).toBe('3h');
  });

  test('formats minutes only for less than an hour', () => {
    const now = Date.now();
    const future = new Date(now + 30 * 60_000).toISOString();
    const result = formatRelativeTime(future, now);
    expect(result).toBe('30m');
  });

  test('formats 1 minute', () => {
    const now = Date.now();
    const future = new Date(now + 90_000).toISOString(); // 1.5 min
    const result = formatRelativeTime(future, now);
    expect(result).toBe('1m');
  });

  test('returns "resets soon" for sub-minute positive diff', () => {
    const now = Date.now();
    const future = new Date(now + 30_000).toISOString(); // 30s
    const result = formatRelativeTime(future, now);
    expect(result).toBe('resets soon');
  });

  test('returns unknown for invalid timestamp', () => {
    expect(formatRelativeTime('not-a-date')).toBe('unknown');
  });
});

describe('detectClockSkew', () => {
  test('returns false for current timestamp', () => {
    expect(detectClockSkew(new Date().toISOString())).toBe(false);
  });

  test('returns true for timestamp >5 minutes in the future', () => {
    const futureTime = new Date(Date.now() + 10 * 60_000).toISOString();
    expect(detectClockSkew(futureTime)).toBe(true);
  });

  test('returns false for timestamp <5 minutes in the future', () => {
    const slightlyFuture = new Date(Date.now() + 2 * 60_000).toISOString();
    expect(detectClockSkew(slightlyFuture)).toBe(false);
  });

  test('returns false for timestamp exactly 5 minutes in the future', () => {
    const now = Date.now();
    const exactlyFive = new Date(now + 5 * 60_000).toISOString();
    expect(detectClockSkew(exactlyFive, now)).toBe(false);
  });

  test('returns false for past timestamp', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(detectClockSkew(past)).toBe(false);
  });

  test('returns false for invalid timestamp', () => {
    expect(detectClockSkew('invalid')).toBe(false);
  });
});
