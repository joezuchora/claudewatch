import { describe, expect, test } from 'bun:test';
import {
  buildIndex,
  checkLoop,
  compareToBaseline,
  extractFence,
  gitFiles,
  NO_STAT,
  headingTokens,
  parseBaseline,
  scrubControls,
  type SymbolIndex,
} from './fence-check.js';

/**
 * Fixtures are string literals, never files on disk. A fixture `.ts` under `scripts/` would enter
 * this check's own symbol index and `oxlint`'s own warning set — the gate's test data perturbing
 * the gate's own measurements.
 *
 * Every test here names one RULE, not one guard. Loop 032 shipped four silent bugs behind a single
 * guard that had been mutated once and declared load-bearing; per-rule coverage is the correction.
 */

const CORPUS = [
  'packages/core/src/snapshot.ts',
  'packages/core/src/telemetry.ts',
  'packages/core/src/format.ts',
  'packages/vscode/src/statusbar-bridge.ts',
  'packages/core/src/typefixtures/leaky.expect-error.ts',
  'scripts/junit.ts',
  'scripts/verify.ts',
  'SPEC.md',
] as const;

const SOURCES: Record<string, string> = {
  'packages/core/src/snapshot.ts': 'export function extractLastError() {}',
  'packages/core/src/telemetry.ts': 'export function renderEvent() {}\nexport const MAX_LINE_BYTES = 4096;',
  'packages/core/src/format.ts': 'export function formatTooltip() {}',
  'packages/vscode/src/statusbar-bridge.ts': 'export const renderEvent = coreRenderEvent;',
  'packages/core/src/typefixtures/leaky.expect-error.ts': 'export const leaky = 1;',
  'scripts/junit.ts': 'export const MAX_LINE_BYTES = 4096;\nexport function parseJunitFailures() {}',
  'scripts/verify.ts': 'export const STEPS = [];',
  'SPEC.md': '',
};

const read = ((f: string): string => SOURCES[f] ?? '') as unknown as typeof import('fs').readFileSync;
// NO_STAT: this corpus is string literals with no files behind it, so the lstat guard that
// protects the live run from symlinks and huge files must be bypassed here.
const INDEX: SymbolIndex = buildIndex(CORPUS, read, NO_STAT);

const run = (spec: string, plan: string) => checkLoop('fixture', spec, plan, INDEX, CORPUS);

describe('extractFence', () => {
  test('a plan with no marker is UNCHECKABLE, not passing', () => {
    expect(extractFence('## Scope fence\n\nSome prose with `snapshot.ts` in it.')).toBeNull();
    expect(run('### B1 — `extractLastError`', '## Scope fence\n\nprose only')).toBeNull();
  });

  test('all three committed marker phrasings are recognised', () => {
    for (const marker of ['Explicitly not touched:', 'Not touched, deliberately:', 'Not touched:']) {
      expect(extractFence(`**${marker}** \`snapshot.ts\`, \`client.ts\`\n\n`)).toEqual(['snapshot.ts', 'client.ts']);
    }
  });

  test('the EARLIEST marker wins when a plan carries two forms', () => {
    const plan = '**Not touched:** `alpha.ts`\n\n## Later\n\n**Explicitly not touched:** `omega.ts`\n\n';
    expect(extractFence(plan)).toEqual(['alpha.ts']);
  });

  test('a parenthetical aside is stripped, even when it spans a newline', () => {
    const plan = '**Explicitly not touched:** `snapshot.ts` (the tree is illustrative and\nomits `core-bridge.ts`), `client.ts`\n\n';
    expect(extractFence(plan)).toEqual(['snapshot.ts', 'client.ts']);
  });

  test('the fence stops at the first sentence end, so following prose is not fenced', () => {
    const plan = '**Not touched:** `telemetry.ts`. Only `verify.ts`\u2019s annotation moves.\n\n';
    expect(extractFence(plan)).toEqual(['telemetry.ts']);
  });

  test('the fence stops at the first blank line', () => {
    expect(extractFence('**Explicitly not touched:** `a.ts`\n\nLater prose names `b.ts`\n')).toEqual(['a.ts']);
  });
});

describe('headingTokens', () => {
  test('only requirement headings are read — body prose is not a requirement', () => {
    const spec = '### B3 — `extractLastError` is relabelled\n\nBody prose names `formatTooltip` descriptively.\n';
    expect(headingTokens(spec)).toEqual(['extractLastError']);
  });

  test('h1 is not a requirement heading', () => {
    expect(headingTokens('# Spec: `snapshot.ts`\n')).toEqual([]);
  });
});

describe('checkLoop — the motivating shape', () => {
  const FENCE = '**Explicitly not touched:** `snapshot.ts`, `packages/vscode`\n\n';

  test('a symbol named in a heading whose defining file is fenced is a finding', () => {
    const res = run('### B3 — `extractLastError`\u2019s gate is KEPT, and relabelled\n', FENCE);
    expect(res?.findings).toEqual([
      { loop: 'fixture', specToken: 'extractLastError', file: 'packages/core/src/snapshot.ts', fenceEntry: 'snapshot.ts' },
    ]);
  });

  test('NEAR MISS: the same symbol in body prose only is not a finding', () => {
    const res = run('### B3 — the reader\n\n`extractLastError` is discussed here.\n', FENCE);
    expect(res?.findings).toEqual([]);
  });

  test('NEAR MISS: a heading naming a file the fence does not cover is not a finding', () => {
    const res = run('### B1 — `formatTooltip` gains a case\n', FENCE);
    expect(res?.findings).toEqual([]);
  });

  test('a path-shaped heading token resolves against the corpus', () => {
    expect(run('### B1 — `snapshot.ts` is rewritten\n', FENCE)?.findings).toHaveLength(1);
  });

  test('a non-.ts path resolves too — five committed fences name SPEC.md or CLAUDE.md', () => {
    expect(run('### B1 — `SPEC.md` \u00a712 is amended\n', '**Not touched:** `SPEC.md`\n\n')?.findings).toHaveLength(1);
  });
});

describe('checkLoop — the normalisations are load-bearing', () => {
  test('without the parenthetical strip this would be a false positive', () => {
    const plan = '**Explicitly not touched:** `SPEC.md` (the tree already omits `format.ts`)\n\n';
    expect(run('### B1 — `formatTooltip` gains a case\n', plan)?.findings).toEqual([]);
    // Prove the aside really did contain the trap: without stripping, `format.ts` would be fenced.
    expect(plan).toContain('`format.ts`');
  });

  test('without the sentence truncation this would be a false positive', () => {
    const plan = '**Not touched:** `snapshot.ts`. Only `format.ts`\u2019s annotation moves.\n\n';
    expect(run('### B1 — `formatTooltip` gains a case\n', plan)?.findings).toEqual([]);
    expect(plan).toContain('`format.ts`');
  });
});

describe('checkLoop — symbol resolution', () => {
  test('core wins over a surface re-export, so a shim does not fire against a package fence', () => {
    const res = run('### B1 — `renderEvent` gains a field\n', '**Explicitly not touched:** `packages/vscode`\n\n');
    expect(res?.findings).toEqual([]);
  });

  test('a scripts/ definition stays an independent candidate and is NOT lost to core', () => {
    const res = run('### B1 — `MAX_LINE_BYTES` moves\n', '**Explicitly not touched:** `scripts/junit.ts`\n\n');
    expect(res?.findings.map((f) => f.file)).toEqual(['scripts/junit.ts']);
  });

  test('a trailing call signature is stripped before lookup — the 020-022 heading style', () => {
    const res = run('### B1 — `parseJunitFailures(xml: string): FailedTest[]`\n', '**Not touched:** `scripts/junit.ts`\n\n');
    expect(res?.findings).toHaveLength(1);
  });

  test('typefixtures are excluded from the index, so their double-defined exports cannot fire', () => {
    const res = run('### B1 — `leaky` is added\n', '**Explicitly not touched:** `packages/core/src/typefixtures/`\n\n');
    expect(res?.findings).toEqual([]);
    expect(res?.unresolved).toEqual(['leaky']);
  });

  test('an unresolvable token is recorded, not silently dropped', () => {
    const res = run('### B1 — `MetricEvent.payload` must not widen\n', '**Not touched:** `packages/core/src/telemetry.ts`\n\n');
    expect(res?.findings).toEqual([]);
    expect(res?.unresolved).toEqual(['MetricEvent.payload']);
  });
});

describe('checkLoop — portability', () => {
  /**
   * The FIRST version of this test converted the backslash corpus back to POSIX before calling
   * anything, so it held with `toPosix` replaced by the identity function — sdlc/033's audit proved
   * that by mutation. The backslash array is now passed straight in, which is what forced `toPosix`
   * to move to the entry of `buildIndex` and `checkLoop` rather than living only in `gitFiles`.
   */
  test('a backslash corpus yields the same findings as a POSIX one', () => {
    const winCorpus = CORPUS.map((f) => f.split('/').join('\\'));
    const winSources: Record<string, string> = {};
    for (const [k, v] of Object.entries(SOURCES)) winSources[k.split('/').join('\\')] = v;
    const winRead = ((f: string): string => winSources[f] ?? '') as unknown as typeof import('fs').readFileSync;

    const res = checkLoop(
      'fixture',
      '### B3 — `extractLastError` is relabelled\n',
      '**Explicitly not touched:** `snapshot.ts`\n\n',
      buildIndex(winCorpus, winRead, NO_STAT),
      winCorpus,
    );
    expect(res?.findings).toEqual([
      { loop: 'fixture', specToken: 'extractLastError', file: 'packages/core/src/snapshot.ts', fenceEntry: 'snapshot.ts' },
    ]);
  });

  test('a path-shaped heading token resolves against a backslash corpus too', () => {
    const winCorpus = CORPUS.map((f) => f.split('/').join('\\'));
    const res = checkLoop(
      'fixture',
      '### B1 — `snapshot.ts` is rewritten\n',
      '**Explicitly not touched:** `snapshot.ts`\n\n',
      buildIndex([], read, NO_STAT),
      winCorpus,
    );
    expect(res?.findings.map((f) => f.file)).toEqual(['packages/core/src/snapshot.ts']);
  });
});

describe('compareToBaseline — the four ways this gate fails', () => {
  const FINDING = {
    loop: '030-cache-read-validation',
    specToken: 'extractLastError',
    file: 'packages/core/src/snapshot.ts',
    fenceEntry: 'snapshot.ts',
  };
  const BASE = { uncheckable: 13, unresolvedTokens: 22, findings: [{ ...FINDING, note: 'known' }] };
  const MATCH = { findings: [FINDING], uncheckable: 13, unresolved: 22 };

  test('a matching run reports nothing', () => {
    expect(compareToBaseline(MATCH, BASE)).toEqual([]);
  });

  test('a NEW contradiction names the spec token, the file and the fence entry', () => {
    const extra = { loop: '034-next', specToken: 'formatTooltip', file: 'packages/core/src/format.ts', fenceEntry: 'format.ts' };
    const out = compareToBaseline({ ...MATCH, findings: [FINDING, extra] }, BASE);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('NEW CONTRADICTION');
    expect(out[0]).toContain('034-next');
    expect(out[0]).toContain('formatTooltip');
    expect(out[0]).toContain('packages/core/src/format.ts');
    expect(out[0]).toContain('format.ts');
  });

  test('a baselined contradiction that disappeared must be removed from the record', () => {
    const out = compareToBaseline({ ...MATCH, findings: [] }, BASE);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('no longer found');
    expect(out[0]).toContain('sdlc/fence-baseline.json');
  });

  test('the uncheckable count moves in either direction', () => {
    expect(compareToBaseline({ ...MATCH, uncheckable: 14 }, BASE)[0]).toContain('uncheckable is 14');
    expect(compareToBaseline({ ...MATCH, uncheckable: 12 }, BASE)[0]).toContain('uncheckable is 12');
  });

  test('the unresolved-token count moves in either direction, so the silence cannot grow quietly', () => {
    expect(compareToBaseline({ ...MATCH, unresolved: 23 }, BASE)[0]).toContain('unresolved heading tokens is 23');
    expect(compareToBaseline({ ...MATCH, unresolved: 21 }, BASE)[0]).toContain('unresolved heading tokens is 21');
  });
});

/**
 * Module scope, not nested inside the describe.
 *
 * As a nested helper capturing nothing it trips `unicorn(consistent-function-scoping)` — one of the
 * two rules behind all five historic budget regressions. This is the first time that rule was
 * caught by the gate instead of by a human, and it caught it in the very commit adding the gate.
 */
const statAs = (kind: 'file' | 'symlink' | 'huge') =>
  ((_p: string) => ({
    isFile: () => kind === 'file',
    size: kind === 'huge' ? 99_000_000 : 10,
  })) as unknown as typeof import('fs').lstatSync;

describe('buildIndex — what it refuses to read', () => {
  test('a regular file under the cap is indexed', () => {
    const idx = buildIndex(['packages/core/src/snapshot.ts'], read, statAs('file'));
    expect(idx.get('extractLastError')).toEqual(['packages/core/src/snapshot.ts']);
  });

  test('a SYMLINK is refused — lstat, not stat, so it is not followed out of the repo', () => {
    const idx = buildIndex(['packages/core/src/snapshot.ts'], read, statAs('symlink'));
    expect(idx.get('extractLastError')).toBeUndefined();
  });

  test('a file over the size cap is refused, so a tracked link to /dev/zero cannot OOM the gate', () => {
    const idx = buildIndex(['packages/core/src/snapshot.ts'], read, statAs('huge'));
    expect(idx.get('extractLastError')).toBeUndefined();
  });

  test('a tracked path missing from the working tree is skipped, not fatal', () => {
    const throwing = (() => {
      throw new Error('ENOENT');
    }) as unknown as typeof import('fs').lstatSync;
    expect(() => buildIndex(['packages/core/src/gone.ts'], read, throwing)).not.toThrow();
  });
});

describe('scrubControls', () => {
  test('a terminal escape in the baseline cannot reach stderr intact', () => {
    const esc = String.fromCharCode(27);
    const base = parseBaseline(
      JSON.stringify({
        uncheckable: 0,
        unresolvedTokens: 0,
        findings: [{ loop: 'l', specToken: 't', file: 'f', fenceEntry: `${esc}[31mx${esc}[0m`, note: 'n' }],
      }),
    );
    expect(base.findings[0]?.fenceEntry).not.toContain(esc);
  });

  test('ordinary text is untouched', () => {
    expect(scrubControls('packages/core/src/a.ts')).toBe('packages/core/src/a.ts');
  });
});

describe('parseBaseline', () => {
  test('a malformed baseline fails loudly rather than being healed', () => {
    expect(() => parseBaseline('[]')).toThrow(/malformed/);
    expect(() => parseBaseline('{"uncheckable":1,"unresolvedTokens":2,"findings":[{}]}')).toThrow(/malformed/);
    expect(() => parseBaseline('null')).toThrow(/not an object/);
  });
});

describe('the live tree', () => {
  test('matches the committed baseline: one finding, and it is loop 030\u2019s', async () => {
    const corpus = await gitFiles();
    const index = buildIndex(corpus);
    const baseline = parseBaseline(await Bun.file('sdlc/fence-baseline.json').text());

    const findings = [];
    let uncheckable = 0;
    let unresolved = 0;
    const { readdirSync, existsSync, readFileSync } = await import('fs');
    for (const loop of readdirSync('sdlc').filter((d) => /^\d{3}-/.test(d)).toSorted()) {
      const spec = `sdlc/${loop}/spec.md`;
      const plan = `sdlc/${loop}/plan.md`;
      if (!existsSync(spec) || !existsSync(plan)) continue;
      const res = checkLoop(loop, readFileSync(spec, 'utf8'), readFileSync(plan, 'utf8'), index, corpus);
      if (res === null) {
        uncheckable += 1;
        continue;
      }
      findings.push(...res.findings);
      unresolved += res.unresolved.length;
    }

    expect(findings).toHaveLength(1);
    expect(findings[0]?.loop).toBe('030-cache-read-validation');
    expect(findings[0]?.specToken).toBe('extractLastError');
    expect(findings[0]?.file).toBe('packages/core/src/snapshot.ts');
    expect(uncheckable).toBe(baseline.uncheckable);
    expect(unresolved).toBe(baseline.unresolvedTokens);
  });
});
