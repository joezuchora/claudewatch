import { describe, expect, test } from 'bun:test';
import { distributionsFor, formatCensus, gapDistribution, renderDistribution } from './arrival-dist.js';

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

/**
 * sdlc/037's security pass, finding 1 — the census line was the first human-facing print site for
 * `kind` anywhere in the repo, and `kind` is free text from an ingest endpoint that binds loopback
 * with no token by default.
 *
 * Reproduced before fixing: a planted row whose `kind` carries `ESC[2J ESC[1;1H` cleared the
 * operator's screen, printed a FORGED census, and used `ESC[8m` to conceal the gap lines the script
 * was run to read. An instrument anyone able to write one row can forge is not an improvement on
 * the untrustworthy measurement this script replaced.
 */
describe('formatCensus bounds what a planted row can print (security pass F1)', () => {
  const ESC = String.fromCharCode(27);

  test('terminal escapes are scrubbed, so a row cannot drive the cursor', () => {
    const out = formatCensus([{ kind: `${ESC}[2J${ESC}[1;1Hforged`, c: 1 }]);
    expect(out).not.toContain(ESC);
    // Positive precondition: the row IS reported, scrubbed rather than dropped — a guard that
    // silently discarded it would also pass the assertion above and would hide a real kind.
    expect(out).toContain('forged');
  });

  test('a megabyte of kind is truncated', () => {
    const out = formatCensus([{ kind: 'k'.repeat(1_000_000), c: 1 }]);
    expect(out.length).toBeLessThan(200);
    expect(out).toContain('k'.repeat(64));
  });

  test('a non-string kind or non-numeric count is dropped, not coerced', () => {
    // SQLite type affinity: TEXT NOT NULL does not guarantee a string comes back.
    expect(formatCensus([{ kind: 42, c: 1 }])).toBe('kinds: (empty store)');
    expect(formatCensus([{ kind: 'ok', c: 'not a number' }])).toBe('kinds: (empty store)');
    expect(formatCensus([])).toBe('kinds: (empty store)');
  });

  test('ordinary rows are unchanged', () => {
    expect(formatCensus([{ kind: 'verify_run', c: 320 }, { kind: 'render', c: 4 }]))
      .toBe('kinds: verify_run=320 render=4');
  });
});
