import { describe, expect, test } from 'bun:test';
import { normalize } from './normalize.js';
import {
  NORMALIZATION_WARNINGS, STALE_REASONS, isStaleReason, isNormalizationWarning,
  UNKNOWN_FETCHED_AT, resetsAtWarning, WINDOW_NAMES,
} from './closed-sets.js';

/**
 * The set is the whole game (sdlc/031).
 *
 * Everything else in that loop is mechanical; a wrong `NORMALIZATION_WARNINGS` is silent data loss
 * on the diagnostic path, because `readCacheResult` filters against it. The Stage 2 review caught
 * exactly that: the spec's first table was built by grepping `warnings.push` and lost the two
 * warnings `makeMalformed` passes as literal arrays.
 */
/** Every distinct warning string reachable from `normalize`, collected by RUNNING it. */
function producedByNormalize(): Set<string> {
  const seen = new Set<string>();
  const collect = (raw: unknown): void => {
    for (const w of normalize(raw).rawMetadata.normalizationWarnings) seen.add(w);
  };

  // The two fixtures named in the spec because omitting them is how the draft's table lost
  // two rows. Neither reaches a `warnings.push`.
  collect(null);                                    // -> makeMalformed(['Response is not an object'])
  collect({ five_hour: { utilization: null } });    // -> makeMalformed([... 'No valid usage windows found'])

  // Every `warnings.push` branch.
  const win = { utilization: 1, resets_at: 'not-a-timestamp' };
  collect({ five_hour: win, seven_day: win, seven_day_opus: win });
  const ok = { five_hour: { utilization: 1, resets_at: '2099-01-01T00:00:00.000Z' } };
  // The field names are `utilization` / `monthly_limit` / `used_credits` / `is_enabled`. My first
  // draft of these fixtures wrote `enabled` and omitted `utilization`, so all four fell into the
  // FIRST branch and three producers were never reached — and the subset assertion below still
  // passed. Only the positive precondition caught it. That is the whole argument for having one.
  collect({ ...ok, extra_usage: {} });
  collect({ ...ok, extra_usage: { utilization: 150, monthly_limit: 100, used_credits: 1, is_enabled: true } });
  collect({ ...ok, extra_usage: { utilization: 50, monthly_limit: 0, used_credits: 1, is_enabled: true } });
  collect({ ...ok, extra_usage: { utilization: 50, monthly_limit: 100, used_credits: 1, is_enabled: true, currency: 'zz' } });
  return seen;
}


describe('NORMALIZATION_WARNINGS is what normalize() can actually emit', () => {
  test('every string normalize() produces is in the set', () => {
    const produced = [...producedByNormalize()].toSorted();
    // Positive precondition: the fixtures above must actually exercise the producers. An empty or
    // near-empty set would make the subset assertion below trivially true.
    expect(produced.length).toBeGreaterThanOrEqual(9);
    expect(produced.filter((w) => !isNormalizationWarning(w))).toEqual([]);
  });

  test('the set has no member normalize() cannot produce', () => {
    const produced = producedByNormalize();
    expect([...NORMALIZATION_WARNINGS].filter((w) => !produced.has(w))).toEqual([]);
  });

  test('the set is exactly nine, and the two makeMalformed rows are in it', () => {
    // NINE. The intent said eight, the spec's first draft said seven. Both were built by reading;
    // the number below is checked against a set built by running.
    expect(NORMALIZATION_WARNINGS.length).toBe(9);
    // Named explicitly because these are the two a `warnings.push` grep cannot see, and dropping
    // them deletes the headline diagnostic of the malformed-response path on read.
    expect(NORMALIZATION_WARNINGS).toContain('Response is not an object');
    expect(NORMALIZATION_WARNINGS).toContain('No valid usage windows found');
  });

  test('the nine strings match HARD-CODED literals, not the exported constant', () => {
    // A7. `normalize.ts` now sources its strings from `closed-sets.ts`, so any assertion phrased
    // against that constant is a tautology: a typo lands in the producer and the set together and
    // stays green. These literals are the only copy in the repo that is not derived from it.
    expect([...NORMALIZATION_WARNINGS].toSorted()).toEqual([
      'Response is not an object',
      'No valid usage windows found',
      'extra_usage present but missing required fields',
      'extra_usage present but has out-of-range values',
      'extra_usage present but has invalid enabled monthly limit',
      'extra_usage.currency invalid; defaulted to USD',
      'five_hour.resets_at is not a valid ISO timestamp',
      'seven_day.resets_at is not a valid ISO timestamp',
      'seven_day_opus.resets_at is not a valid ISO timestamp',
    ].toSorted());
  });

  test('the interpolated form is closed only because the names are', () => {
    expect([...WINDOW_NAMES]).toEqual(['five_hour', 'seven_day', 'seven_day_opus']);
    expect(resetsAtWarning('five_hour')).toBe('five_hour.resets_at is not a valid ISO timestamp');
    // The predicate rejects the same form built from a name that is NOT one of ours — which is the
    // property that would break if a call site ever passed an API-response key.
    expect(isNormalizationWarning(resetsAtWarning('attacker_window'))).toBe(false);
  });
});

describe('the other closed sets', () => {
  test('isStaleReason accepts every member and nothing else', () => {
    for (const r of STALE_REASONS) expect(isStaleReason(r)).toBe(true);
    for (const bad of ['', 'None', 'fetchfailed', '/home/someone', null, 42, {}, undefined]) {
      expect(isStaleReason(bad)).toBe(false);
    }
  });

  test('UNKNOWN_FETCHED_AT is not parseable as a date, in any casing', () => {
    // The whole substitution depends on this. If a Date parser ever accepts it, `isCacheFresh`
    // starts returning true for an unknowable age.
    for (const s of [UNKNOWN_FETCHED_AT, 'Unknown', 'UNKNOWN']) {
      expect(Number.isNaN(Date.parse(s))).toBe(true);
    }
  });
});
