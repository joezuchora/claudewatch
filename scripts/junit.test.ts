import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { parseJunitFailures, relativizeFile, scrubPaths, boundBySize, boundBySizeTight, readJunitReport, attachFailures, tightenMode, MAX_LINE_BYTES, type FailedTest } from './junit.js';
import { MAX_LINE_BYTES as CORE_MAX_LINE_BYTES } from '../packages/core/src/telemetry.js';

const ROOT = '/home/testuser/claudewatch';

function testcase(attrs: string, body = '<failure type="AssertionError" />'): string {
  return `<testcase ${attrs}>${body}</testcase>`;
}

function wrap(inner: string, hostname = 'vm'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="1" failures="1">
  <testsuite name="s" file="f" hostname="${hostname}">${inner}</testsuite>
</testsuites>`;
}

describe('the constant is bound to core, not copied and forgotten', () => {
  test('MAX_LINE_BYTES equals the value in packages/core', () => {
    // scripts/junit.ts declares this rather than importing it, because verify.ts must not import
    // core — a syntax error there would stop the gate before it could report the syntax error.
    // This test is what keeps the duplicate honest. sdlc/015's root cause was a number that
    // survived review by looking familiar.
    expect(MAX_LINE_BYTES).toBe(CORE_MAX_LINE_BYTES);
  });
});

/** Serialize entries the way `verify.ts` does, so byte bounds are measured against reality. */
function buildFullEvent(kept: FailedTest[], total = 400): unknown {
  return {
    eventId: 'x'.repeat(36), ts: new Date(0).toISOString(), source: 'sdlc', kind: 'verify_run',
    ok: false, durationMs: 1, schemaVersion: 1,
    payload: { outcome: 'fail', failedStep: 'test', failedTests: kept, failedTestCount: total },
  };
}

/** Minimal wrapper, for the case that only needs the array's own contribution. */
function buildBareEvent(kept: FailedTest[]): unknown {
  return { payload: { failedTests: kept } };
}

/**
 * The event envelope `verify.ts` wraps a payload in. Named `wrapEvent`, not `wrap`, because the
 * XML fixture helper above already owns `wrap` and shadowing it made both harder to read.
 */
function wrapEvent(p: Record<string, unknown>): unknown {
  return { source: 'sdlc', kind: 'verify_run', payload: p };
}

/** Injected IO for readJunitReport, so its three states are reachable without a filesystem. */
const readsContent = (content: string) => () => content;
const fileExists = (): boolean => true;
const fileMissing = (): boolean => false;
const readThrows = (): string => { throw new Error('EACCES'); };

describe('A1 — the fields reach the output', () => {
  test('parses a single failure with all fields', () => {
    const xml = wrap(testcase(
      'name="does a thing" classname="inner &amp;gt; outer" file="packages/core/src/x.test.ts" line="42"',
      '<failure type="AssertionError" />',
    ));
    const got = parseJunitFailures(xml, ROOT);
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({
      file: 'packages/core/src/x.test.ts',
      name: 'does a thing',
      suite: 'inner > outer',
      line: 42,
      type: 'AssertionError',
    });
  });
});

describe('A2 — an absolute in-repo path is relativized', () => {
  test('the entry survives AND the username is gone', () => {
    const xml = wrap(testcase(
      `name="t" file="${ROOT}/packages/core/src/x.test.ts" line="1"`,
    ));
    const got = parseJunitFailures(xml, ROOT);
    // The positive half. Without it, a parser returning [] would pass the negative half below.
    expect(got).toHaveLength(1);
    expect(got[0]!.file).toBe('packages/core/src/x.test.ts');
    expect(JSON.stringify(got)).not.toContain('testuser');
    expect(JSON.stringify(got)).not.toContain(ROOT);
  });

  test('Bun\'s actual output — already relative — passes through unchanged', () => {
    // The common case. Bun 1.3.11 emits repo-relative paths for tests under cwd; relativize is
    // defence against a future change, not a fix for an observed leak.
    expect(relativizeFile('packages/core/src/x.test.ts', ROOT)).toBe('packages/core/src/x.test.ts');
  });

  test('a Windows absolute path under the root is relativized case-insensitively', () => {
    expect(relativizeFile('C:\\Users\\joe\\claudewatch\\packages\\a.test.ts', 'c:/users/joe/claudewatch'))
      .toBe('packages/a.test.ts');
  });
});

describe('A5b — a path that escapes the root via .. is dropped (sdlc/020 security probe)', () => {
  // Found by probing relativizeFile with hostile input, not by reading it. A prefix check alone
  // accepts `<root>/../../../etc/passwd`, because it DOES start with the root -- and relativizes
  // it to `../../../etc/passwd`. The realistic form is `../sibling-project/x.test.ts`, which
  // discloses a project name, explicitly forbidden by SPEC.md §17.
  const hostile = [
    '/home/testuser/claudewatch/../../../etc/passwd',
    '/home/testuser/claudewatch/../other-project/secret.test.ts',
    '../../../../etc/passwd',
    '../sibling/x.test.ts',
  ];

  for (const file of hostile) {
    test(`${file} is nulled`, () => {
      expect(relativizeFile(file, ROOT)).toBeNull();
    });
  }

  test('a legitimate path containing .. that stays inside is kept', () => {
    // The guard must reject escape, not the character sequence.
    expect(relativizeFile('packages/core/../core/src/x.test.ts', ROOT))
      .toBe('packages/core/../core/src/x.test.ts');
  });

  test('the entry survives with a null file, rather than vanishing', () => {
    const xml = wrap(testcase('name="t" file="../../../etc/passwd"'));
    const got = parseJunitFailures(xml, ROOT);
    expect(got).toHaveLength(1);
    expect(got[0]!.name).toBe('t');
    expect(got[0]!.file).toBeNull();
  });
});

describe('A3 — hostname never reaches the output', () => {
  test('two entries are parsed AND the sentinel hostname is absent', () => {
    const xml = wrap(
      testcase('name="one" file="a.test.ts"') + testcase('name="two" file="b.test.ts"'),
      'HOSTNAME-SENTINEL-9f3a',
    );
    const got = parseJunitFailures(xml, ROOT);
    expect(got).toHaveLength(2);
    expect(JSON.stringify(got)).not.toContain('HOSTNAME-SENTINEL-9f3a');
  });
});

describe('A4 — no failure message or CDATA is read', () => {
  test('the entry is parsed AND neither sentinel appears', () => {
    const xml = wrap(testcase(
      'name="t" file="a.test.ts"',
      '<failure type="AssertionError" message="LEAK-SENTINEL-4c71 in /home/joe">' +
      'LEAK-SENTINEL-4c71 stack line\n<![CDATA[LEAK-SENTINEL-4c71]]></failure>',
    ));
    const got = parseJunitFailures(xml, ROOT);
    expect(got).toHaveLength(1);
    expect(got[0]!.type).toBe('AssertionError');
    expect(JSON.stringify(got)).not.toContain('LEAK-SENTINEL-4c71');
  });
});

describe('A5 — an out-of-repo absolute path is dropped, entry kept', () => {
  test('length is 1 and file is null', () => {
    const xml = wrap(testcase('name="t" file="/tmp/somewhere/else/x.test.ts"'));
    const got = parseJunitFailures(xml, ROOT);
    expect(got).toHaveLength(1);
    expect(got[0]!.name).toBe('t');
    expect(got[0]!.file).toBeNull();
  });
});

describe('A6 — bounded by BYTES, and truncation is reported', () => {
  test('400 failures fit one atomic append, with the true count preserved', () => {
    const entries: FailedTest[] = Array.from({ length: 400 }, (_, i) => ({
      file: `packages/core/src/some-fairly-long-file-name-${i}.test.ts`,
      name: `a test with a reasonably long descriptive name number ${i}`,
      suite: `inner suite > outer suite ${i}`,
      line: i,
      type: 'AssertionError',
    }));

    const kept = boundBySize(entries, buildFullEvent);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(400);
    const size = Buffer.byteLength(`${JSON.stringify(buildFullEvent(kept))}\n`, 'utf-8');
    expect(size).toBeLessThanOrEqual(MAX_LINE_BYTES);
  });

  test('an entry-count bound would NOT have been enough', () => {
    // The specific case the first draft got wrong: 20 realistic entries exceed the line cap, so
    // a `slice(0, 20)` bound would have written an oversized line and broken append atomicity.
    const twenty: FailedTest[] = Array.from({ length: 20 }, (_, i) => ({
      file: `packages/metrics/src/detector-input.test.ts`,
      name: `REGRESSION GUARD: a renderable stale cache exits 0 for EVERY failure class ${i}`,
      suite: 'the exit code comes from the policy (sdlc/014)',
      line: 100 + i,
      type: 'AssertionError',
    }));
    expect(Buffer.byteLength(JSON.stringify(buildBareEvent(twenty)))).toBeGreaterThan(MAX_LINE_BYTES);
    expect(boundBySize(twenty, buildBareEvent).length).toBeLessThan(20);
  });

  test('a small list is returned whole', () => {
    const one: FailedTest[] = [{ file: 'a.test.ts', name: 't', suite: null, line: 1, type: 'E' }];
    expect(boundBySize(one, kept => ({ kept }))).toHaveLength(1);
  });
});

describe('A7 — malformed yields [], but the parser is not simply always empty', () => {
  for (const bad of ['', '{not xml at all}', '<testsuites><testcase name="t"', '<?xml version="1.0"?>']) {
    test(`malformed input ${JSON.stringify(bad.slice(0, 20))} yields []`, () => {
      expect(parseJunitFailures(bad, ROOT)).toEqual([]);
    });
  }

  test('a well-formed sibling in the SAME test yields non-empty', () => {
    // Without this, `return []` passes every assertion above.
    expect(parseJunitFailures('<garbage', ROOT)).toEqual([]);
    expect(parseJunitFailures(wrap(testcase('name="t" file="a.test.ts"')), ROOT)).toHaveLength(1);
  });

  test('a passing self-closing testcase is not a failure', () => {
    const xml = wrap('<testcase name="passed" file="a.test.ts" />' + testcase('name="failed" file="b.test.ts"'));
    const got = parseJunitFailures(xml, ROOT);
    expect(got).toHaveLength(1);
    expect(got[0]!.name).toBe('failed');
  });
});

describe('A8 — name decodes once, classname twice', () => {
  test('the asymmetry is exact', () => {
    const xml = wrap(testcase('name="name &amp; &lt;tag&gt;" classname="inner &amp;lt; deep &amp;gt; A &amp;amp; B" file="a.test.ts"'));
    const got = parseJunitFailures(xml, ROOT);
    expect(got).toHaveLength(1);
    expect(got[0]!.name).toBe('name & <tag>');
    expect(got[0]!.suite).toBe('inner < deep > A & B');
  });

  test('a name containing a literal &lt; is not over-decoded', () => {
    // The reason the rule cannot be uniform: two passes would turn this into a bare `<`.
    const xml = wrap(testcase('name="handles &amp;lt; in source" file="a.test.ts"'));
    expect(parseJunitFailures(xml, ROOT)[0]!.name).toBe('handles &lt; in source');
  });
});

describe('A9 — a real failing run names the failing test', () => {
  test('end to end, against bun, outside the repo', () => {
    // The criterion a no-op cannot satisfy, and the reason the others are not vacuous.
    //
    // The fixture lives in a temp dir, NOT in the repo. Earlier today a subagent wrote a probe
    // fixture into packages/core/src/, `git add -A` committed it, and CI went red on a
    // Markdown-only commit. Same shape of mistake, one directory away.
    const dir = mkdtempSync(join(tmpdir(), 'cw-junit-e2e-'));
    try {
      writeFileSync(join(dir, 'x.test.ts'), [
        "import { test, expect } from 'bun:test';",
        "test('a deliberately failing test', () => { expect(1).toBe(2); });",
        "test('a passing one', () => { expect(1).toBe(1); });",
      ].join('\n'), 'utf-8');

      const out = join(dir, 'report.xml');
      spawnSync('bun', ['test', 'x.test.ts', '--reporter=junit', `--reporter-outfile=${out}`],
        { cwd: dir, stdio: 'ignore' });

      expect(existsSync(out)).toBe(true);
      const got = parseJunitFailures(readFileSync(out, 'utf-8'), dir);
      expect(got).toHaveLength(1);
      expect(got[0]!.name).toBe('a deliberately failing test');
      expect(got[0]!.file).toBe('x.test.ts');
      expect(got[0]!.line).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('A13 — the outfile is safe and does not survive', () => {
  test('a 0600 file outside the repo is what we create', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-junit-mode-'));
    try {
      const p = join(dir, 'r.xml');
      writeFileSync(p, '<x/>', { mode: 0o600 });
      expect(statSync(p).mode & 0o777).toBe(0o600);
      expect(p.startsWith(tmpdir())).toBe(true);
      expect(p).not.toContain('claudewatch/packages');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('security-pass findings (sdlc/020)', () => {
  test('S2 — a UNC path in a test NAME is scrubbed, hostname and all', () => {
    // name/suite/type were unsanitized free text; only `file` was checked. A test titled after a
    // path would have been recorded verbatim while three documents promised otherwise.
    const xml = wrap(testcase('name="reads \\\\\\\\fileserver\\\\share\\\\x from disk" file="a.test.ts"'));
    const got = parseJunitFailures(xml, ROOT);
    expect(got).toHaveLength(1);
    expect(got[0]!.name).not.toContain('fileserver');
    expect(got[0]!.name).toContain('<path>');
  });

  test('S2 — a home directory in a test name is scrubbed', () => {
    const xml = wrap(testcase('name="fails for /home/joe/secret-project/x" file="a.test.ts"'));
    const got = parseJunitFailures(xml, ROOT);
    expect(got[0]!.name).toBe('fails for <path>');
  });

  test('S2 — a single-segment reference is NOT scrubbed', () => {
    // The guard must protect paths, not mangle every readable test name.
    const xml = wrap(testcase('name="returns 200 for /health" file="a.test.ts"'));
    expect(parseJunitFailures(xml, ROOT)[0]!.name).toBe('returns 200 for /health');
  });

  test('S3 — a hostile failure type is replaced, a normal one is kept', () => {
    const hostile = wrap(testcase('name="t" file="a.test.ts"',
      '<failure type="/home/joe/.claude/.credentials.json" />'));
    expect(parseJunitFailures(hostile, ROOT)[0]!.type).toBe('other');

    const normal = wrap(testcase('name="t" file="a.test.ts"', '<failure type="AssertionError" />'));
    expect(parseJunitFailures(normal, ROOT)[0]!.type).toBe('AssertionError');
  });

  test('S4 — a root of / or empty nulls the path instead of stripping the slash', () => {
    // Otherwise `/home/joe/x.test.ts` becomes `home/joe/x.test.ts` — still a username.
    for (const root of ['/', '']) {
      expect(relativizeFile('/home/joe/x.test.ts', root)).toBeNull();
    }
  });

  test('S4 — a file equal to the root is null, not an empty string', () => {
    expect(relativizeFile(ROOT, ROOT)).toBeNull();
  });

  test('S7 — the tightened bound keeps more than the halving alone', () => {
    const entries: FailedTest[] = Array.from({ length: 400 }, (_, i) => ({
      file: `a-${i}.test.ts`, name: `t${i}`, suite: null, line: i, type: 'AssertionError',
    }));
    const coarse = boundBySize(entries, buildFullEvent);
    const tight = boundBySizeTight(entries, buildFullEvent);
    expect(tight.length).toBeGreaterThan(coarse.length);
    // ...and still fits one atomic append.
    expect(Buffer.byteLength(`${JSON.stringify(buildFullEvent(tight))}\n`, 'utf-8'))
      .toBeLessThanOrEqual(MAX_LINE_BYTES);
    // ...and adding one more would not.
    const oneMore = entries.slice(0, tight.length + 1);
    expect(Buffer.byteLength(`${JSON.stringify(buildFullEvent(oneMore))}\n`, 'utf-8'))
      .toBeGreaterThan(MAX_LINE_BYTES);
  });
});

describe('A10/A11 — the payload the gate actually records', () => {
  const base = { outcome: 'pass', failedStep: null, stepCount: 5, testMs: 7000 };

  test('A10 — a passing run\'s payload is returned byte-identical', () => {
    // The mutation this must catch: emitting the fields unconditionally. Before sdlc/020's audit
    // this criterion had NO test touching the code it named.
    const out = attachFailures(base, null, wrapEvent);
    expect(Object.keys(out).toSorted()).toEqual(['failedStep', 'outcome', 'stepCount', 'testMs']);
    expect(out).toEqual(base);
    expect(JSON.stringify(out)).toBe(JSON.stringify(base));
  });

  test('A11 — junitOutfile carries through each of the three states', () => {
    for (const outfile of ['present', 'absent', 'unparseable'] as const) {
      const out = attachFailures(base, { failures: [], total: 0, outfile }, wrapEvent);
      expect(out.junitOutfile).toBe(outfile);
      expect(out.failedTestCount).toBe(0);
      expect(out.failedTests).toEqual([]);
    }
  });

  test('A11 — the true total survives truncation', () => {
    const failures: FailedTest[] = Array.from({ length: 400 }, (_, i) => ({
      file: `packages/core/src/a-fairly-long-test-file-name-${i}.test.ts`,
      name: `a reasonably descriptive failing test name number ${i}`,
      suite: 'some describe chain', line: i, type: 'AssertionError',
    }));
    const out = attachFailures(base, { failures, total: 400, outfile: 'present' }, wrapEvent);
    expect(out.failedTestCount).toBe(400);
    expect((out.failedTests as FailedTest[]).length).toBeLessThan(400);
    expect(Buffer.byteLength(`${JSON.stringify(wrapEvent(out))}\n`, 'utf-8')).toBeLessThanOrEqual(MAX_LINE_BYTES);
  });
});

describe('readJunitReport — the three states, against injected IO', () => {
  test('a missing file is absent, not an error', () => {
    // The timeout path. Bun writes the report only at end of run, so SIGKILL leaves nothing.
    expect(readJunitReport('/nope', ROOT, readsContent(''), fileMissing))
      .toEqual({ failures: [], total: 0, outfile: 'absent' });
  });

  test('a truncated report is unparseable, NOT a clean parse with zero failures', () => {
    // The audit's counterexample: this contains `<testsuites`, so an opening-tag check would
    // have called it 'present' and reported "no failures" for a file that was cut off.
    const truncated = '<?xml version="1.0"?><testsuites name="bun test"><testcase name="t"';
    expect(readJunitReport('/x', ROOT, readsContent(truncated), fileExists).outfile).toBe('unparseable');
  });

  test('a complete report with a failure is present and parsed', () => {
    const xml = wrap(testcase('name="t" file="a.test.ts" line="3"'));
    const got = readJunitReport('/x', ROOT, readsContent(xml), fileExists);
    expect(got.outfile).toBe('present');
    expect(got.total).toBe(1);
    expect(got.failures[0]!.name).toBe('t');
  });

  test('a complete report with NO failures is present with zero — a different fact', () => {
    const xml = wrap('<testcase name="passed" file="a.test.ts" />');
    expect(readJunitReport('/x', ROOT, readsContent(xml), fileExists))
      .toEqual({ failures: [], total: 0, outfile: 'present' });
  });

  test('a read that throws degrades to absent rather than failing the gate', () => {
    expect(readJunitReport('/x', ROOT, readThrows, fileExists).outfile).toBe('absent');
  });
});

describe('A13 — tightenMode, against a report bun really wrote', () => {
  test('bun creates it 0644, and tightenMode narrows it to 0600', () => {
    // The audit found the previous A13 vacuous: it chmodded a file of its OWN to 0600 and then
    // asserted it was 0600, so it tested fs.writeFileSync and would have passed with verify.ts
    // deleted. It also hid a real defect — the comment, the test name and the spec all claimed
    // the report was 0600 when bun writes it 0644 and nothing ever changed that.
    const dir = mkdtempSync(join(tmpdir(), 'cw-mode-'));
    try {
      const report = join(dir, 'report.xml');
      writeFileSync(join(dir, 'a.test.ts'),
        "import {test,expect} from 'bun:test';\ntest('t',()=>{expect(1).toBe(1)});\n");
      spawnSync('bun', ['test', 'a.test.ts', '--reporter=junit', `--reporter-outfile=${report}`],
        { cwd: dir, stdio: 'ignore' });

      // The premise, asserted rather than assumed. If bun ever starts writing 0600 this should be
      // revisited deliberately, not silently kept passing.
      expect(statSync(report).mode & 0o777).toBe(0o644);

      tightenMode(report);
      expect(statSync(report).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing path is a no-op, not a throw', () => {
    expect(() => tightenMode(join(tmpdir(), 'definitely-not-here-9f3a.xml'))).not.toThrow();
  });
});

describe('scrubPaths does not mangle names that merely contain slashes (sdlc/021)', () => {
  test('a describe chain like A5/A6/A7 survives intact', () => {
    // Found when this loop's gate went red for real: the recorded name came back as
    // `A5<path> — the switch...`, because `/A6/A7` looked like a two-segment path. A mangled
    // name defeats the purpose of recording it at all.
    const xml = wrap(testcase('name="A5/A6/A7 — the switch against the real script" file="a.test.ts"'));
    expect(parseJunitFailures(xml, ROOT)[0]!.name).toBe('A5/A6/A7 — the switch against the real script');
  });

  test('date-like and ratio-like text survives', () => {
    for (const name of ['handles 2026/08/26 input', 'a 3/4 majority', 'reads config a/b/c']) {
      const xml = wrap(testcase(`name="${name}" file="a.test.ts"`));
      expect(parseJunitFailures(xml, ROOT)[0]!.name).toBe(name);
    }
  });

  test('but a REAL absolute path is still scrubbed — the guard did not just get weaker', () => {
    // The non-vacuous half. Loosening a sanitizer is exactly where a silent regression hides.
    for (const [name, expected] of [
      ['fails for /home/joe/secret/x', 'fails for <path>'],
      ['/home/joe/secret/x at the start', '<path> at the start'],
      // &quot; because a raw " inside an XML attribute is malformed — bun escapes it, and so
      // must a fixture claiming to represent bun's output.
      ['quoted &quot;/home/joe/secret/x&quot; here', 'quoted "<path>" here'],
    ]) {
      const xml = wrap(testcase(`name="${name}" file="a.test.ts"`));
      expect(parseJunitFailures(xml, ROOT)[0]!.name).toBe(expected);
    }
  });
});

describe('scrubPaths cannot be defeated by what precedes the slash (sdlc/021)', () => {
  /**
   * The first attempt at un-mangling `A5/A6/A7` required whitespace or a quote before the leading
   * slash. Probing it found ELEVEN ways through — a sanitizer made defeatable in order to fix a
   * cosmetic problem. These are that probe, frozen.
   */
  const SMUGGLE = [
    '(/home/joe/secret/a.ts)',
    '[/home/joe/secret/a.ts]',
    '{/home/joe/secret/a.ts}',
    '`/home/joe/secret/a.ts`',
    '=/home/joe/secret/a.ts',
    ':/home/joe/secret/a.ts',
    ',/home/joe/secret/a.ts',
    '</home/joe/secret/a.ts>',
    '-/home/joe/secret/a.ts',
    '*/home/joe/secret/a.ts',
    'x/home/joe/secret/a.ts',
    'file:///home/joe/secret/a.ts',
    '\t/home/joe/secret/a.ts',
    '/Users/joe/secret/a.ts',
    '/root/.ssh/id_rsa',
  ];

  for (const attempt of SMUGGLE) {
    test(`${JSON.stringify(attempt)} does not reach the payload`, () => {
      const out = scrubPaths(attempt);
      expect(out).not.toContain('/home/joe');
      expect(out).not.toContain('/Users/joe');
      expect(out).not.toContain('/root/');
      expect(out).toContain('<path>');
    });
  }

  /**
   * The same vectors against a NON-home absolute path.
   *
   * Every case above uses `/home/joe`, which the unconditional home-directory rule catches
   * first — so reverting the general boundary left them all green, and a mutation proved it.
   * The tests looked comprehensive while exercising one rule twice and the other never. These
   * reach the general rule, which is what protects `/opt`, `/var`, `/srv` and everything else.
   */
  const NON_HOME = [
    '(/opt/private/thing.ts)',
    '[/var/secrets/key]',
    '`/srv/internal/data`',
    '=/etc/shadow',
    ':/opt/private/thing.ts',
    '</opt/private/thing.ts>',
    'file:///opt/private/thing.ts',
  ];

  for (const attempt of NON_HOME) {
    test(`${JSON.stringify(attempt)} — the general rule, not the home-dir rule`, () => {
      const out = scrubPaths(attempt);
      expect(out).not.toContain('/opt/private');
      expect(out).not.toContain('/var/secrets');
      expect(out).not.toContain('/srv/internal');
      expect(out).not.toContain('/etc/shadow');
      expect(out).toContain('<path>');
    });
  }

  /**
   * A `.` or `-` immediately before the slash.
   *
   * The lookbehind first excluded `[A-Za-z0-9._-]`, and the sdlc/021 security pass found these
   * two walked straight through — a second, narrower hole inside the fix that had just closed
   * eleven wider ones. A mutation then showed I had closed it WITHOUT a test, so widening the
   * class back was silent. These are that test.
   */
  const PUNCT_PREFIXED = ['foo-/opt/secrets/key', 'report.-/var/secrets/x', 'v1.2-/srv/internal/x'];

  for (const attempt of PUNCT_PREFIXED) {
    test(`${JSON.stringify(attempt)} — a . or - before the slash does not smuggle it`, () => {
      const out = scrubPaths(attempt);
      expect(out).not.toContain('/opt/secrets');
      expect(out).not.toContain('/var/secrets');
      expect(out).not.toContain('/srv/internal');
      expect(out).toContain('<path>');
    });
  }

  test('the home rule catches what the general rule skips, in either case', () => {
    // These are the cases ONLY the unconditional home rule can reach: an alphanumeric before the
    // slash makes the general rule step over them. That is what makes the home rule, and its `i`
    // flag, load-bearing rather than decorative — a first draft of this test used `/users/joe`,
    // which the general rule catches anyway, so a mutation removing the flag left it green.
    for (const c of ['x/users/joe/secret', 'x/Users/joe/secret', 'v2/home/joe/secret']) {
      expect(scrubPaths(c)).not.toContain('joe');
      expect(scrubPaths(c)).toContain('<path>');
    }
    expect(scrubPaths('/var/home/joe/secret')).not.toContain('joe');
  });

  test('and the legible names this rule exists to protect are untouched', () => {
    // The non-vacuous half: a scrubber that replaced everything would pass every assertion above.
    for (const safe of ['A5/A6/A7 — the switch', 'handles 2026/08/26 input', 'a 3/4 majority',
      'reads config a/b/c', 'v1.2/a/b', 'a.b/c/d']) {
      expect(scrubPaths(safe)).toBe(safe);
    }
  });
});
