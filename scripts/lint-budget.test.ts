import { describe, expect, test } from 'bun:test';
import {
  diffBudget,
  OXLINT_BIN,
  parseBudget,
  parseOxlintOutput,
  renderBudget,
  report,
  rowsFrom,
  scrubControls,
  type Diagnostic,
  type Row,
} from './lint-budget.js';

/**
 * Fixtures are string/object literals, never files on disk.
 *
 * A fixture `.ts` file under `scripts/` would be picked up by `fence-check`'s symbol index and by
 * `oxlint` itself, so the gate's own test data would perturb the gate's own measurements.
 */

const warn = (code: string, filename: string, message: string, line = 1): Diagnostic => ({
  code,
  filename,
  message,
  severity: 'warning',
  labels: [{ span: { line, column: 1 } }],
});

/** The two rules responsible for all five historic regressions, plus one distinct third. */
const BASE: Diagnostic[] = [
  warn('unicorn(no-array-sort)', 'packages/metrics/src/anomaly.ts', 'Use `Array#toSorted()`.', 216),
  warn('unicorn(no-array-sort)', 'packages/metrics/src/anomaly.ts', 'Use `Array#toSorted()`.', 356),
  warn('eslint(no-shadow)', 'packages/core/src/security.test.ts', "'cleanup' is already declared.", 169),
];

const rowsOf = (d: readonly Diagnostic[]): Row[] => rowsFrom(d);

describe('rowsFrom', () => {
  test('two warnings with an identical message in one file collapse to one row with count 2', () => {
    const rows = rowsOf(BASE);
    expect(rows).toHaveLength(2);
    const sortRow = rows.find((r) => r.code === 'unicorn(no-array-sort)');
    expect(sortRow?.count).toBe(2);
  });

  test('errors are not budgeted — oxlint already fails the gate on those', () => {
    const withError = [...BASE, { ...warn('oxc(no-map-spread)', 'a.ts', 'x'), severity: 'error' }];
    expect(rowsOf(withError)).toHaveLength(2);
  });

  test('a diagnostic missing code, filename or message throws rather than keying on undefined', () => {
    expect(() => rowsFrom([{ severity: 'warning', filename: 'a.ts', message: 'm' }])).toThrow(/missing code/);
  });

  test('backslash filenames are normalised, so a Windows checkout matches the committed budget', () => {
    const win = rowsOf([warn('eslint(no-shadow)', 'packages\\core\\src\\security.test.ts', "'cleanup' is already declared.")]);
    expect(win[0]?.filename).toBe('packages/core/src/security.test.ts');
    expect(diffBudget(win, rowsOf([BASE[2]!]))).toEqual({ added: [], removed: [] });
  });
});

describe('diffBudget', () => {
  test('an added warning is reported as added', () => {
    const actual = rowsOf([...BASE, warn('oxc(no-map-spread)', 'packages/metrics/src/anomaly.test.ts', 'Spreading…')]);
    const diff = diffBudget(actual, rowsOf(BASE));
    expect(diff.removed).toHaveLength(0);
    expect(diff.added.map((r) => r.code)).toEqual(['oxc(no-map-spread)']);
  });

  test('a removed warning is reported as removed — the budget cannot rot upward-only', () => {
    const diff = diffBudget(rowsOf(BASE.slice(0, 2)), rowsOf(BASE));
    expect(diff.added).toHaveLength(0);
    expect(diff.removed.map((r) => r.code)).toEqual(['eslint(no-shadow)']);
  });

  test('a count change surfaces in whichever direction it moved', () => {
    const fewer = diffBudget(rowsOf([BASE[0]!, BASE[2]!]), rowsOf(BASE));
    expect(fewer.removed).toHaveLength(1);
    expect(fewer.removed[0]?.count).toBe(1);

    const more = diffBudget(rowsOf([...BASE, BASE[0]!]), rowsOf(BASE));
    expect(more.added).toHaveLength(1);
    expect(more.added[0]?.count).toBe(1);
  });

  /**
   * The criterion a `code` + `filename` key would fail. Same rule, same file, same count — only the
   * message differs. This is the swap the count-only budget misses one level up, and the reason
   * `message` is in the key at all.
   */
  test('a warning swapped for a different warning of the SAME rule in the SAME file is detected', () => {
    const swapped = rowsOf([
      warn('unicorn(no-array-sort)', 'packages/metrics/src/anomaly.ts', 'Use `Array#toSorted()`.', 216),
      warn('unicorn(no-array-sort)', 'packages/metrics/src/anomaly.ts', 'A DIFFERENT oxlint message.', 356),
      BASE[2]!,
    ]);
    const diff = diffBudget(swapped, rowsOf(BASE));
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
    expect(diff.added[0]?.message).toBe('A DIFFERENT oxlint message.');
  });

  test('a warning whose line moved is not a difference', () => {
    const moved = rowsOf([
      warn('unicorn(no-array-sort)', 'packages/metrics/src/anomaly.ts', 'Use `Array#toSorted()`.', 999),
      warn('unicorn(no-array-sort)', 'packages/metrics/src/anomaly.ts', 'Use `Array#toSorted()`.', 1000),
      warn('eslint(no-shadow)', 'packages/core/src/security.test.ts', "'cleanup' is already declared.", 42),
    ]);
    expect(diffBudget(moved, rowsOf(BASE))).toEqual({ added: [], removed: [] });
  });

  test('reordered diagnostics are not a difference — oxlint order is not stable', () => {
    const shuffled = rowsOf([BASE[2]!, BASE[1]!, BASE[0]!]);
    expect(diffBudget(shuffled, rowsOf(BASE))).toEqual({ added: [], removed: [] });
    expect(shuffled.map((r) => r.code)).toEqual(rowsOf(BASE).map((r) => r.code));
  });
});

describe('report', () => {
  test('additions and removals are worded differently so a reviewer can tell a fix from a regression', () => {
    const added = report({ added: rowsOf([BASE[2]!]), removed: [] });
    const removed = report({ added: [], removed: rowsOf([BASE[2]!]) });
    expect(added[0]).toContain('NEW WARNING');
    expect(removed[0]).toContain('1 fewer');
    expect(removed[0]).toContain('update .oxlint-budget.json in this commit');
    expect(added[0]).not.toContain('fewer');
  });
});

describe('parseOxlintOutput', () => {
  test('a payload with no diagnostics array is a failure, never an empty warning set', () => {
    expect(() => parseOxlintOutput('{}')).toThrow(/no diagnostics array/);
    expect(() => parseOxlintOutput('null')).toThrow(/not an object/);
    expect(() => parseOxlintOutput('{"diagnostics":{}}')).toThrow(/no diagnostics array/);
  });
});

describe('scrubControls', () => {
  test('a terminal escape in a committed record cannot reach stderr intact', () => {
    const esc = String.fromCharCode(27);
    const row = parseBudget(
      JSON.stringify([{ code: 'a', filename: `${esc}[31mevil${esc}[0m`, message: 'm', count: 1 }]),
    );
    expect(row[0]?.filename).not.toContain(esc);
    expect(report({ added: row, removed: [] })[0]).not.toContain(esc);
  });

  test('ordinary text is untouched', () => {
    expect(scrubControls('packages/core/src/a.ts')).toBe('packages/core/src/a.ts');
  });
});

describe('parseBudget', () => {
  test('round-trips what renderBudget writes', () => {
    const rows = rowsOf(BASE);
    expect(parseBudget(renderBudget(rows))).toEqual(rows);
  });

  test('a malformed record fails loudly rather than being healed', () => {
    expect(() => parseBudget('{}')).toThrow(/not an array/);
    expect(() => parseBudget('[{"code":"a","filename":"b","message":"c"}]')).toThrow(/malformed/);
    expect(() => parseBudget('[{"code":"a","filename":"b","message":"c","count":0}]')).toThrow(/malformed/);
    expect(() => parseBudget('[1]')).toThrow(/not an object/);
  });
});

describe('the committed budget', () => {
  test('matches the current tree, and is what the gate compares', async () => {
    const proc = Bun.spawn([OXLINT_BIN, '--format=json'], { stdout: 'pipe', stderr: 'pipe' });
    const raw = await new Response(proc.stdout).text();
    await proc.exited;
    const budget = parseBudget(await Bun.file('.oxlint-budget.json').text());
    expect(diffBudget(rowsFrom(parseOxlintOutput(raw)), budget)).toEqual({ added: [], removed: [] });
  });
});
