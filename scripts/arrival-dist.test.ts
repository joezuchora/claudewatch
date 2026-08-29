import { describe, expect, test } from 'bun:test';
import { distributionsFor, gapDistribution, renderDistribution } from './arrival-dist.js';

/**
 * `cli-ship.ts` went four loops with no test file and only got one when sdlc/036 happened to need a
 * subprocess. A percentile function is exactly the kind of code that is silently wrong, so this one
 * ships with its test rather than waiting for a loop that needs it.
 *
 * The distribution function takes an array, so none of this touches a database.
 */

const iso = (minutes: number): string => new Date(Date.parse('2026-08-01T00:00:00.000Z') + minutes * 60_000).toISOString();

describe('gapDistribution', () => {
  test('the percentiles match a known distribution', () => {
    // Ten timestamps at 0,1,2,…,9 minutes → nine gaps of exactly one minute.
    const d = gapDistribution(Array.from({ length: 10 }, (_, i) => iso(i)))!;
    expect(d.n).toBe(9);
    expect(d.p50).toBe(60_000);
    expect(d.max).toBe(60_000);
    expect(d.overOneHour).toBe(0);
  });

  test('a long gap lands in the tail and is counted', () => {
    const d = gapDistribution([iso(0), iso(1), iso(2), iso(200)])!;
    expect(d.max).toBe(198 * 60_000);
    expect(d.overOneHour).toBe(1);
    expect(d.overTwoHours).toBe(1);
    expect(d.p50).toBe(60_000);          // the tail does not drag the median
  });

  test('DISTINCT timestamps only — a shipped batch must not report a p50 of zero', () => {
    // Five events sharing one arrival time plus one later: the real store's shape, where 311 events
    // share 70 receivedAt values. Counting the zero-gaps inside the batch would give p50 = 0 and
    // hide the cadence completely.
    const batched = [iso(0), iso(0), iso(0), iso(0), iso(0), iso(60)];
    const d = gapDistribution(batched)!;
    expect(d.n).toBe(1);
    expect(d.p50).toBe(60 * 60_000);
    // Positive precondition: without the de-duplication there would be five gaps, four of them zero.
    expect(batched).toHaveLength(6);
  });

  test('fewer than two distinct timestamps yields null, not a divide by zero', () => {
    expect(gapDistribution([])).toBeNull();
    expect(gapDistribution([iso(0)])).toBeNull();
    expect(gapDistribution([iso(0), iso(0), iso(0)])).toBeNull();
  });

  test('unparseable timestamps are dropped rather than poisoning the sort', () => {
    const d = gapDistribution([iso(0), 'not a date', iso(5)])!;
    expect(d.n).toBe(1);
    expect(d.max).toBe(5 * 60_000);
  });
});

describe('renderDistribution', () => {
  test('the label survives rendering', () => {
    const d = gapDistribution([iso(0), iso(30)])!;
    const line = renderDistribution('receivedAt-gaps', d);
    expect(line).toContain('receivedAt-gaps');
    expect(line).toContain('p50=30.0m');
    expect(line).toContain('>1h=0');
  });

  test('a null distribution says so instead of printing zeros', () => {
    expect(renderDistribution('ts-gaps', null)).toContain('fewer than two distinct timestamps');
  });
});

/**
 * The mutation this guards: report `ts` for both clocks — sdlc/037's first spec draft's actual
 * defect, a distribution measured on one clock and published under the other's name.
 *
 * The first version of this suite could NOT catch it. Its test was called `both clocks are reported`
 * and it called `renderDistribution` directly with a hand-built distribution, so it asserted the
 * renderer preserves a label and never that the caller passes the right column. The M9 mutation
 * produced zero failures. Found by running the mutation, not by reading the test.
 */
describe('distributionsFor pairs each column with its own clock (sdlc/037 M9)', () => {
  // Deliberately asymmetric: the two columns have DIFFERENT gaps, so reporting one for both is
  // detectable. Identical columns would make the mutation invisible again.
  const rows = [
    { ts: iso(0), receivedAt: iso(0) },
    { ts: iso(1), receivedAt: iso(90) },
    { ts: iso(2), receivedAt: iso(180) },
  ];

  test('the ts distribution comes from ts', () => {
    expect(distributionsFor(rows).ts!.p50).toBe(60_000);
  });

  test('the receivedAt distribution comes from receivedAt', () => {
    expect(distributionsFor(rows).receivedAt!.p50).toBe(90 * 60_000);
  });

  test('the two are not the same object, nor the same numbers', () => {
    // The positive precondition that makes the two assertions above mean something: if the fixture
    // ever became symmetric, both would pass against a single-column implementation.
    const d = distributionsFor(rows);
    expect(d.ts!.p50).not.toBe(d.receivedAt!.p50);
    expect(d.ts!.overOneHour).toBe(0);
    expect(d.receivedAt!.overOneHour).toBe(2);
  });
});
