import type { ThresholdLevel } from './types.js';

/**
 * Evaluate a utilization percentage against warning and critical thresholds.
 * Returns the threshold level (SPEC.md §10.3).
 */
export function evaluate(pct: number, warn: number = 70, crit: number = 90): ThresholdLevel {
  if (pct >= crit) return 'critical';
  if (pct >= warn) return 'warning';
  return 'normal';
}
