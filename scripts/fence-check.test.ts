import { describe, expect, test } from 'bun:test';
import {
  buildIndex,
  checkLoop,
  classifyToken,
  compareToBaseline,
  extractFence,
  gitFiles,
  indexScripts,
  NO_STAT,
  headingTokens,
  parseBaseline,
  scrubControls,
  type ScriptIndex,
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
  'packages/core/src/telemetry.ts':
    'export function renderEvent() {}\nexport const MAX_LINE_BYTES = 4096;\nexport interface MetricEvent {}',
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

/**
 * Deliberately includes one script whose target is NOT in `CORPUS` (`scripts/ghost.ts`). A7's second
 * half asserts it does not resolve, which is what stops `indexScripts` inventing paths.
 */
const MANIFEST = JSON.stringify({
  scripts: {
    verify: 'bun run scripts/verify.ts',
    lint: 'oxlint',
    ghost: 'bun run scripts/ghost.ts',
    'verify:plain': 'bun run scripts/junit.ts --plain',
  },
});
const SCRIPTS: ScriptIndex = indexScripts(MANIFEST, CORPUS);

const run = (spec: string, plan: string) => checkLoop('fixture', spec, plan, INDEX, CORPUS, SCRIPTS);

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

  /**
   * SPLIT in sdlc/035, and the reason matters more than the change.
   *
   * This test used to assert `unresolved === ['MetricEvent.payload']`, and adding Rule 4 does NOT
   * make it fail on its own: the fixture `telemetry.ts` declared `renderEvent` and `MAX_LINE_BYTES`
   * and no `MetricEvent`, so the prefix lookup found nothing and the token still fell through. It
   * would have stayed green while its name stopped being true — worse than failing. The fixture now
   * declares `MetricEvent` so Rule 4's test below can fire, and a token no rule can reach is
   * asserted separately here.
   */
  test('an unresolvable token is recorded, not silently dropped', () => {
    const res = run('### B1 — `noSuchSymbol` must not widen\n', '**Not touched:** `packages/core/src/telemetry.ts`\n\n');
    expect(res?.findings).toEqual([]);
    expect(res?.unresolved).toEqual(['noSuchSymbol']);
    expect(res?.notASymbol).toEqual([]);
  });
});

/**
 * A7 — Rule 3. A root manifest script name resolves to the file it runs.
 *
 * Not a heuristic: `"verify": "bun run scripts/verify.ts"` is a declared mapping from a name to a
 * file, hand-written in a committed file exactly as `export function verify` would be. Before this,
 * loops 033 and 034 both left `verify` unresolved, and loop 034 therefore moved the baselined count
 * by 1 for a reason carrying no information — the defect that motivated sdlc/035.
 */
describe('checkLoop — script-name resolution', () => {
  test('a script name resolves to the file it runs', () => {
    const res = run('### B1 — `verify` gains a step\n', '**Not touched:** `scripts/verify.ts`\n\n');
    expect(res?.findings).toEqual([
      { loop: 'fixture', specToken: 'verify', file: 'scripts/verify.ts', fenceEntry: 'scripts/verify.ts' },
    ]);
    expect(res?.unresolved).toEqual([]);
    // A7 says "neither `unresolved` nor `notASymbol`". Implied by the finding above, but the
    // criterion is cheap to assert literally, so it is asserted literally.
    expect(res?.notASymbol).toEqual([]);
  });

  test('a script whose target is not tracked does not resolve — the map never invents a path', () => {
    expect(indexScripts(MANIFEST, CORPUS).has('ghost')).toBe(false);
    const res = run('### B1 — `ghost` gains a step\n', '**Not touched:** `scripts/junit.ts`\n\n');
    expect(res?.findings).toEqual([]);
    expect(res?.unresolved).toEqual(['ghost']);
  });

  test('a script naming no file at all contributes nothing', () => {
    expect(indexScripts(MANIFEST, CORPUS).has('lint')).toBe(false);
  });

  test('the RAW token is tried before bareSymbol, or a colon-bearing script name is lost', () => {
    // `bareSymbol('verify:plain')` is `verify`, which would resolve to the WRONG file.
    expect(indexScripts(MANIFEST, CORPUS).get('verify:plain')).toBe('scripts/junit.ts');
    const res = run('### B1 — `verify:plain` changes\n', '**Not touched:** `scripts/junit.ts`\n\n');
    expect(res?.findings.map((f) => f.file)).toEqual(['scripts/junit.ts']);
  });

  test('a malformed manifest yields an empty map rather than throwing', () => {
    expect(indexScripts('{not json', CORPUS).size).toBe(0);
    expect(indexScripts('null', CORPUS).size).toBe(0);
    expect(indexScripts('{}', CORPUS).size).toBe(0);
  });

  test('the symbol index wins over the script map', () => {
    const manifest = JSON.stringify({ scripts: { extractLastError: 'bun run scripts/junit.ts' } });
    const res = checkLoop(
      'fixture',
      '### B1 — `extractLastError` moves\n',
      '**Not touched:** `packages/core/src/snapshot.ts`, `scripts/junit.ts`\n\n',
      INDEX,
      CORPUS,
      indexScripts(manifest, CORPUS),
    );
    expect(res?.findings.map((f) => f.file)).toEqual(['packages/core/src/snapshot.ts']);
  });
});

/**
 * A8 — Rule 4. A dotted token resolves by its prefix, against the index that already exists.
 *
 * No member indexing: `MetricEvent` is an ordinary top-level export. sdlc/035 measured the
 * alternative — indexing type members — at four new findings across two loops, all four false
 * positives, because a bare field name in a heading names the field's behaviour rather than the file
 * that declares it. A dot is the author saying which declaration they mean.
 */
describe('checkLoop — dotted-prefix resolution', () => {
  test('Owner.member resolves to the file where Owner is declared', () => {
    const res = run('### B1 — `MetricEvent.payload` must not widen\n', '**Not touched:** `packages/core/src/telemetry.ts`\n\n');
    expect(res?.findings).toEqual([
      {
        loop: 'fixture',
        specToken: 'MetricEvent.payload',
        file: 'packages/core/src/telemetry.ts',
        fenceEntry: 'packages/core/src/telemetry.ts',
      },
    ]);
  });

  // NAME CORRECTED at Stage 5. It read "stays unresolved" while asserting `notASymbol` — and in a
  // loop whose entire subject is that those two words name different populations, a test name that
  // swaps them is the wrong kind of mistake to leave in the file. The behaviour was always right.
  test('an unknown prefix does not resolve, and falls to not-a-symbol on the dot', () => {
    const res = run('### B1 — `enterprise.utilizationPct` is validated\n', '**Not touched:** `packages/core/src/format.ts`\n\n');
    expect(res?.findings).toEqual([]);
    expect(res?.notASymbol).toEqual(['enterprise.utilizationPct']);
  });

  test('a signature-stripped dotted token is reached, and still fails on its prefix', () => {
    const res = run('### B1 — `response.json()` is guarded\n', '**Not touched:** `packages/core/src/format.ts`\n\n');
    expect(res?.findings).toEqual([]);
    expect(res?.notASymbol).toEqual(['response.json()']);
  });

  test('a token with a dot but not an identifier chain never reaches the prefix rule', () => {
    const res = run('### B1 — `SPEC.md §12` is amended\n', '**Not touched:** `packages/core/src/format.ts`\n\n');
    expect(res?.findings).toEqual([]);
    expect(res?.notASymbol).toEqual(['SPEC.md §12']);
  });
});

/**
 * A2 — the classifier. One named test per shape rule, plus the narrowing that separates a module
 * constant from an environment variable. Not one loop over a table: sdlc/032 shipped four silent
 * bugs behind a single guard, and per-rule coverage is the standing correction.
 */
describe('classifyToken', () => {
  test('a flag is not a symbol', () => {
    expect(classifyToken('--json')).toBe('not-a-symbol');
    expect(classifyToken('--debug')).toBe('not-a-symbol');
  });

  test('an underscored ALLCAPS name is an environment variable, not a symbol', () => {
    expect(classifyToken('XDG_CACHE_HOME')).toBe('not-a-symbol');
  });

  test('an ALLCAPS name with NO underscore is left unresolved', () => {
    // `MARKERS`, `HEADING`, `TOKEN` and `EXPORTED` are module-private constants in fence-check.ts
    // itself. Calling them "not a symbol" is the silent false negative sdlc/035 exists to remove.
    expect(classifyToken('MARKERS')).toBe('unresolved');
    expect(classifyToken('HEADING')).toBe('unresolved');
    // Still missed, and recorded rather than fixed: no shape rule separates this from TMPDIR.
    expect(classifyToken('PATH_RE')).toBe('not-a-symbol');
  });

  test('an ECMAScript reserved word is not a symbol', () => {
    expect(classifyToken('try')).toBe('not-a-symbol');
    expect(classifyToken('class')).toBe('not-a-symbol');
  });

  test('a TypeScript type keyword is not a symbol — and `any` is not a reserved word', () => {
    expect(classifyToken('any')).toBe('not-a-symbol');
    expect(classifyToken('unknown')).toBe('not-a-symbol');
  });

  test('a non-identifier is not a symbol', () => {
    expect(classifyToken('⊙ error')).toBe('not-a-symbol');
    expect(classifyToken('SPEC.md §12')).toBe('not-a-symbol');
  });

  test('a plain identifier is unresolved — the class that stays baselined', () => {
    expect(classifyToken('freshness')).toBe('unresolved');
    expect(classifyToken('vscode')).toBe('unresolved');
    expect(classifyToken('doRefresh')).toBe('unresolved');
  });

  test('the rules are applied to bareSymbol, so a signature does not flip the class', () => {
    expect(classifyToken('XDG_CACHE_HOME: string')).toBe('not-a-symbol');
    expect(classifyToken('freshness: number')).toBe('unresolved');
    expect(classifyToken('doRefresh(): Promise<void>')).toBe('unresolved');
  });
});

/**
 * A5 and A6 — the intent's headline requirement, and the precondition without which it is vacuous.
 */
describe('the split does what the intent asked for', () => {
  const FENCE = '**Not touched:** `packages/core/src/format.ts`\n\n';

  test('a loop naming only flags and env vars does not move the baselined count', () => {
    const res = run('### B1 — `--debug` reports `XDG_CACHE_HOME`\n', FENCE);
    expect(res?.unresolved).toEqual([]);
    expect(res?.notASymbol).toEqual(['--debug', 'XDG_CACHE_HOME']);
  });

  test('a loop naming an identifier the index does not know DOES move it', () => {
    const res = run('### B1 — `refreshInFlight` is cleared\n', FENCE);
    expect(res?.unresolved).toEqual(['refreshInFlight']);
    expect(res?.notASymbol).toEqual([]);
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
      SCRIPTS,
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
      SCRIPTS,
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
  const BASE = { uncheckable: 13, unresolvedSymbols: 22, findings: [{ ...FINDING, note: 'known' }] };
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
    expect(compareToBaseline({ ...MATCH, unresolved: 23 }, BASE)[0]).toContain(
      'unresolved symbol-shaped heading tokens is 23',
    );
    expect(compareToBaseline({ ...MATCH, unresolved: 21 }, BASE)[0]).toContain(
      'unresolved symbol-shaped heading tokens is 21',
    );
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
        unresolvedSymbols: 0,
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
    expect(() => parseBaseline('{"uncheckable":1,"unresolvedSymbols":2,"findings":[{}]}')).toThrow(/malformed/);
    expect(() => parseBaseline('null')).toThrow(/not an object/);
  });

  /**
   * The rename is enforced, not merely intended. sdlc/035 redefined what the number counts (symbols
   * only, not flags and env vars too), and a baseline still carrying the old key would otherwise
   * read `undefined` for the new one \u2014 which `Number.isInteger` rejects, but only because it is
   * checked. Asserting it here is what makes the rename a migration rather than a hope.
   */
  test('a baseline still carrying the pre-035 key is rejected, not read as zero', () => {
    const old = '{"uncheckable":13,"unresolvedTokens":25,"findings":[]}';
    expect(() => parseBaseline(old)).toThrow(/malformed/);
  });
});

describe('the live tree', () => {
  test('matches the committed baseline: one finding, and it is loop 030\u2019s', async () => {
    const corpus = await gitFiles();
    const index = buildIndex(corpus);
    const baseline = parseBaseline(await Bun.file('sdlc/fence-baseline.json').text());

    const { readdirSync, existsSync, readFileSync } = await import('fs');
    const scripts = indexScripts(readFileSync('package.json', 'utf8'), corpus);

    const findings = [];
    let uncheckable = 0;
    const unresolved: string[] = [];
    const notASymbol: string[] = [];
    for (const loop of readdirSync('sdlc').filter((d) => /^\d{3}-/.test(d)).toSorted()) {
      const spec = `sdlc/${loop}/spec.md`;
      const plan = `sdlc/${loop}/plan.md`;
      if (!existsSync(spec) || !existsSync(plan)) continue;
      const res = checkLoop(loop, readFileSync(spec, 'utf8'), readFileSync(plan, 'utf8'), index, corpus, scripts);
      if (res === null) {
        uncheckable += 1;
        continue;
      }
      findings.push(...res.findings);
      unresolved.push(...res.unresolved.map((t) => `${loop}: ${t}`));
      notASymbol.push(...res.notASymbol.map((t) => `${loop}: ${t}`));
    }

    expect(findings).toHaveLength(1);
    expect(findings[0]?.loop).toBe('030-cache-read-validation');
    expect(findings[0]?.specToken).toBe('extractLastError');
    expect(findings[0]?.file).toBe('packages/core/src/snapshot.ts');
    expect(uncheckable).toBe(baseline.uncheckable);
    expect(unresolved).toHaveLength(baseline.unresolvedSymbols);

    /**
     * A3, as an INVARIANT rather than two constants.
     *
     * sdlc/033, sdlc/034 and sdlc/035's own first draft each hardcoded a token count and each got
     * it wrong, because a loop's artifacts join the corpus the moment its `plan.md` lands. The
     * Two things this test does NOT do, both found by the Stage 5 audit and recorded rather than
     * papered over:
     *
     * 1. It does not verify A3's sum clause. `checkLoop` pushes each failed token into exactly ONE
     *    array, so `unresolved.length + notASymbol.length` equals the failed-resolution count by
     *    construction and asserting it would be tautological. `checkLoop` exposes no independent
     *    failed-resolution count to compare against, and inventing one here would be a second
     *    reading of the same rule. What is left — disjointness, no duplicates, and a classification
     *    round-trip — is real.
     * 2. It does not catch mutation 6 (deleting the dotted-prefix fallback), which the plan
     *    predicted it would. `MetricEvent.payload` would simply fall into `notASymbol`: disjoint,
     *    duplicate-free, and self-consistent. What catches it is the next test, which names the
     *    tokens the two new rules are supposed to resolve.
     */
    const both = unresolved.filter((t) => notASymbol.includes(t));
    expect(both).toEqual([]);
    expect(new Set([...unresolved, ...notASymbol]).size).toBe(unresolved.length + notASymbol.length);
    for (const t of unresolved) expect(classifyToken(t.slice(t.indexOf(': ') + 2))).toBe('unresolved');
    for (const t of notASymbol) expect(classifyToken(t.slice(t.indexOf(': ') + 2))).toBe('not-a-symbol');
  });

  /**
   * The three tokens sdlc/035's two new rules resolve, asserted by NAME against the live tree.
   *
   * This is the assertion that fails when either fallback is deleted, and it is specific on purpose:
   * a count-based assertion cannot distinguish "the rule stopped working" from "a loop's artifacts
   * changed", and every count in this area has been got wrong at least once.
   */
  test('the two resolution rules still resolve the three tokens they were added for', async () => {
    const corpus = await gitFiles();
    const index = buildIndex(corpus);
    const { readdirSync, existsSync, readFileSync } = await import('fs');
    const scripts = indexScripts(readFileSync('package.json', 'utf8'), corpus);

    const seen: string[] = [];
    for (const loop of readdirSync('sdlc').filter((d) => /^\d{3}-/.test(d)).toSorted()) {
      const spec = `sdlc/${loop}/spec.md`;
      const plan = `sdlc/${loop}/plan.md`;
      if (!existsSync(spec) || !existsSync(plan)) continue;
      const res = checkLoop(loop, readFileSync(spec, 'utf8'), readFileSync(plan, 'utf8'), index, corpus, scripts);
      if (res === null) continue;
      seen.push(...res.unresolved.map((t) => `${loop}: ${t}`), ...res.notASymbol.map((t) => `${loop}: ${t}`));
    }

    // Rule 3 \u2014 without it, loop 034 moves the baselined count by 1 for no informative reason,
    // which is the defect that motivated this whole loop.
    expect(seen).not.toContain('033-harness-gates: verify');
    expect(seen).not.toContain('034-xdg-cache-home: verify');
    // Rule 4 \u2014 loop 020's fence protects this token as the telemetry security boundary.
    expect(seen).not.toContain('032-snapshot-validation: MetricEvent.payload');
    // Positive precondition: these ARE tokens this corpus produces, so the assertions above are not
    // green merely because nothing was scanned.
    expect(seen).toContain('034-xdg-cache-home: XDG_CACHE_HOME');
    expect(seen).toContain('027-extension-tests: vscode');
  });

  /**
   * A9. Read with RAW `JSON.parse`, not `parseBaseline`.
   *
   * `parseBaseline`'s return type structurally cannot contain either key, so asserting their absence
   * through it would be vacuous \u2014 exactly the defect sdlc/035's Stage 2 review found in the spec's
   * first draft, and the same shape as sdlc/033's vacuous portability test.
   */
  test('the committed baseline records neither notASymbol nor the pre-035 key', async () => {
    const raw: unknown = JSON.parse(await Bun.file('sdlc/fence-baseline.json').text());
    expect(typeof raw).toBe('object');
    const keys = Object.keys(raw as Record<string, unknown>);
    expect(keys).toContain('unresolvedSymbols');
    expect(keys).not.toContain('notASymbol');
    expect(keys).not.toContain('unresolvedTokens');
  });
});
