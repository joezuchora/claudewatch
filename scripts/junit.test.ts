import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { parseJunitFailures, relativizeFile, boundBySize, MAX_LINE_BYTES, type FailedTest } from './junit.js';
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
