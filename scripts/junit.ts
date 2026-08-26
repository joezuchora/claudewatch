import { chmodSync, existsSync } from 'fs';

/**
 * Parse the failing tests out of `bun test --reporter=junit` output.
 *
 * This exists so that an intermittent gate failure names the test that broke, rather than
 * recording only that the `test` step failed. See sdlc/020-which-test-failed/.
 *
 * The sanitization is the point of the module, not an afterthought: the parsed values land in
 * `~/.cache/claudewatch/metrics-spool.jsonl`, the SAME file product telemetry appends to, which
 * a user-run agent ships to a user-hosted service. SPEC.md §17 governs what may appear there.
 */

/**
 * Kept in sync with `packages/core/src/telemetry.ts` by a test, not by an import.
 *
 * `verify.ts` must not import `packages/core`. A syntax error in core would then stop the gate
 * from starting at all — no step ever runs, no `verify_run` event is recorded, and the failure
 * arrives as a raw Bun stack trace instead of `verify: fail [typecheck]`. Losing the record in
 * exactly the situation the record exists for is worse than the duplication.
 *
 * Both cases were run before this was decided: a TYPE error in core is harmless (Bun strips
 * types), a SYNTAX error is fatal to the importer.
 *
 * `junit.test.ts` asserts this equals core's value, so the number cannot drift the way
 * sdlc/015's threshold did.
 */
export const MAX_LINE_BYTES = 4096;

/**
 * Narrow the junit report to 0600.
 *
 * Bun creates it 0644 — verified with `stat`, not assumed. The file lists every test name in the
 * suite and can outlive the run if `verify.ts` is killed before its cleanup. The 0700 parent
 * directory already blocks other users, so this is defence in depth; but SPEC.md's E9 and the
 * surrounding comments say 0600, and code should do what the documents claim rather than the
 * documents describing what the code wishes it did. (sdlc/020 audit)
 *
 * Lives here rather than in `verify.ts` so a test can import it without executing the gate.
 */
export function tightenMode(path: string): void {
  try {
    if (existsSync(path)) chmodSync(path, 0o600);
  } catch {
    // Recording a metric, and protecting its scratch file, must never fail the gate.
  }
}

export interface FailedTest {
  /** Repo-relative, POSIX separators. `null` when the path could not be vouched for (S3). */
  file: string | null;
  /** Decoded once (S5a). */
  name: string;
  /** Decoded twice, opaque (S5b). */
  suite: string | null;
  line: number | null;
  type: string | null;
}

/**
 * Decode XML entities `n` times.
 *
 * `name` needs one pass and `classname` needs two, because Bun double-encodes the latter. A
 * single uniform rule cannot be right for both: double-decoding `name` would corrupt a test
 * whose source name legitimately contains `&lt;`.
 */
function decodeEntities(value: string, passes: number): string {
  let out = value;
  for (let i = 0; i < passes; i++) {
    out = out
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      // `&amp;` LAST, so `&amp;lt;` becomes `&lt;` on this pass rather than `<`.
      .replace(/&amp;/g, '&');
  }
  return out;
}

/**
 * Remove anything path-shaped from a free-text field.
 *
 * `name`, `suite` and `type` come from the repository's own source, so in practice they hold
 * test names. But they are free text, and SPEC.md §17 — plus SECURITY.md and deploy/README.md —
 * promise that NO event of any source carries an absolute path, a home directory, or a username.
 * Before this, only `file` was sanitized, so a test literally named after `homedir()` would have
 * been recorded verbatim and the documents would have been asserting an invariant the code did
 * not enforce. Found by the sdlc/020 plan-to-diff audit.
 *
 * Deliberately conservative: a single-segment reference like `returns /health` is kept, because
 * it discloses nothing and scrubbing it would make failures harder to read. Two or more
 * segments, or a Windows drive path, is replaced.
 */
export function scrubPaths(value: string): string {
  return value
    // UNC first: `\\server\share\x` embeds a HOSTNAME, which §17 names explicitly. It matched
    // neither of the other two branches — found by the sdlc/020 security pass.
    .replace(/\\\\[^\s"']+/g, '<path>')
    .replace(/[A-Za-z]:[\\/][^\s"']*/g, '<path>')
    .replace(/\/[^\s"'/]+(?:\/[^\s"'/]*)+/g, '<path>');
}

/**
 * Constrain `<failure type>` to an identifier, or report `'other'`.
 *
 * Bun 1.3.11 emits only `AssertionError`, including for a thrown custom Error — the security
 * pass probed this by naming an Error after a credentials path and the attribute did not change.
 * But it is free text from an external tool, so the same "defence against a future Bun change"
 * argument that justifies `relativizeFile` applies here, and had not been made. Constraining it
 * also lets SPEC.md §17's amendment describe the payload honestly rather than omitting a field.
 */
export function normalizeFailureType(raw: string | null): string | null {
  if (raw === null) return null;
  return /^[A-Za-z][A-Za-z0-9_.]{0,63}$/.test(raw) ? raw : 'other';
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? m[1]! : null;
}

function isAbsolutePath(p: string): boolean {
  // POSIX, plus Windows drive-letter and UNC forms. `path.isAbsolute` would do, but this module
  // deliberately parses text rather than touching the filesystem.
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

function normalizeSeparators(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * S2/S3 — make a path safe to record, or drop it.
 *
 * Bun 1.3.11 already emits repo-relative paths for tests under the working directory; verified
 * across all 623 testcases in this repo. So the common case returns unchanged and this function
 * is defence against a future Bun change, not a fix for an observed leak. (An earlier draft of
 * the spec claimed otherwise, generalizing from a probe fixture placed outside the repo.)
 *
 * An absolute path outside the repo is nulled rather than recorded: it cannot be relativized,
 * and an absolute path carries a home directory and a username, which SPEC.md §17 forbids.
 *
 */

/**
 * Whether a repo-relative path climbs out of the repository.
 *
 * Found by probing `relativizeFile` adversarially rather than by reading it:
 * `/home/user/claudewatch/../../../etc/passwd` starts with the root, so a prefix check alone
 * relativizes it to `../../../etc/passwd` and records it. The realistic form of that leak is
 * `../sibling-project/x.test.ts`, which discloses a PROJECT NAME — explicitly forbidden by §17.
 * Bun does not emit such paths; the parser still must not be defeatable by one.
 */
function escapesRoot(relative: string): boolean {
  let depth = 0;
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      depth--;
      if (depth < 0) return true;
    } else {
      depth++;
    }
  }
  return false;
}

export function relativizeFile(file: string | null, repoRoot: string): string | null {
  if (file === null || file === '') return null;
  if (!isAbsolutePath(file)) {
    const rel = normalizeSeparators(file);
    return escapesRoot(rel) ? null : rel;
  }

  const normFile = normalizeSeparators(file);
  const normRoot = normalizeSeparators(repoRoot).replace(/\/$/, '');

  // With a root of '/' or '', normRoot is empty, `startsWith('')` is true for everything, and the
  // absolute branch below would simply strip the leading slash — turning
  // `/home/joe/x.test.ts` into `home/joe/x.test.ts` and recording a username. Not reachable via
  // `bun run verify`, whose cwd is the repo, but this function is exported and independently
  // callable. (sdlc/020 security pass, S4.)
  if (normRoot === '') return null;

  // Case-insensitive on Windows, where the same path may differ only in case.
  const isWindows = /^[A-Za-z]:/.test(normFile) || normFile.startsWith('//');
  const a = isWindows ? normFile.toLowerCase() : normFile;
  const b = isWindows ? normRoot.toLowerCase() : normRoot;

  if (a === b || a.startsWith(`${b}/`)) {
    const rel = normFile.slice(normRoot.length + 1);
    // `file === root` leaves nothing. A directory is not a test file, and `''` would contradict
    // FailedTest.file's contract of "a repo-relative path, or null".
    if (rel === '') return null;
    return escapesRoot(rel) ? null : rel;
  }
  return null;
}

/**
 * Every `<testcase>` that contains a `<failure>`, in document order.
 *
 * Never throws. Malformed input yields `[]` — the caller distinguishes that from "parsed, no
 * failures" via `junitOutfile`, because those are different facts.
 *
 * `hostname` is never read. It is an attribute on every nested `<testsuite>`, and "never read"
 * is a property of this function rather than a filter applied to its output (S1).
 */
export function parseJunitFailures(xml: string, repoRoot: string): FailedTest[] {
  const out: FailedTest[] = [];
  if (typeof xml !== 'string' || xml.length === 0) return out;

  try {
    // Openings first, then the body, rather than one combined pattern.
    //
    // The combined form `<testcase\b([^>]*)>([\s\S]*?)</testcase>` is WRONG and its own test
    // caught it: a self-closing `<testcase ... />` (a PASS) matches the opening, and the lazy
    // body then runs to the NEXT `</testcase>` — swallowing the following failure and
    // attributing it to the test that passed. Reporting the wrong test name is worse than
    // reporting none, since it sends the reader to innocent code.
    const testcaseRe = /<testcase\b([^>]*)>/g;
    let m: RegExpExecArray | null;

    while ((m = testcaseRe.exec(xml)) !== null) {
      const attrs = m[1] ?? '';

      // Self-closing: the test passed, there is no <failure> child (E7).
      if (attrs.trimEnd().endsWith('/')) continue;

      const bodyStart = m.index + m[0].length;
      const bodyEnd = xml.indexOf('</testcase>', bodyStart);
      if (bodyEnd === -1) continue;
      const body = xml.slice(bodyStart, bodyEnd);

      const failureMatch = /<failure\b([^>]*?)\/?>/.exec(body);
      if (!failureMatch) continue;

      // S4: the `type` attribute and nothing else. Not text content, not `message`, not CDATA.
      // Bun does not currently emit those — this is what keeps that true if it starts.
      const type = normalizeFailureType(attr(failureMatch[1] ?? '', 'type'));

      const rawLine = attr(attrs, 'line');
      const parsedLine = rawLine === null ? NaN : Number.parseInt(rawLine, 10);
      const rawName = attr(attrs, 'name');
      const rawSuite = attr(attrs, 'classname');

      out.push({
        file: relativizeFile(attr(attrs, 'file'), repoRoot),
        name: scrubPaths(decodeEntities(rawName ?? '', 1)),
        suite: rawSuite === null || rawSuite === '' ? null : scrubPaths(decodeEntities(rawSuite, 2)),
        line: Number.isFinite(parsedLine) ? parsedLine : null,
        type,
      });
    }
  } catch {
    // A parse must never be the reason the gate reports something untrue.
    return [];
  }

  return out;
}

/**
 * Drop entries from the end until the serialized event fits one atomic append.
 *
 * The binding constraint is `MAX_LINE_BYTES`, NOT the 5 MB spool cap — an earlier draft had this
 * backwards. `verify.ts` appends to the same spool product telemetry uses, so a line over
 * PIPE_BUF breaks single-write atomicity and can interleave into corrupt JSONL. Twenty of this
 * repo's realistic test names serialize to well over the cap (4699 bytes bare, 4920 in the full
 * event wrapper — recomputed here rather than inherited; an earlier draft cited 5078, a figure
 * taken from a review and repeated without checking, which is sdlc/015's failure mode).
 *
 * `buildEvent` is a callback rather than a pre-built object because the size depends on the
 * entries, so the two cannot be computed independently.
 */
export function boundBySize<T>(
  entries: T[],
  buildEvent: (kept: T[]) => unknown,
  maxBytes: number = MAX_LINE_BYTES,
): T[] {
  let kept = entries;
  while (kept.length > 0) {
    const size = Buffer.byteLength(`${JSON.stringify(buildEvent(kept))}\n`, 'utf-8');
    if (size <= maxBytes) return kept;
    // Halve while far over, then step, so a 600-failure suite does not cost 600 serializations.
    kept = kept.slice(0, kept.length > 8 ? Math.floor(kept.length / 2) : kept.length - 1);
  }
  return kept;
}

/**
 * `boundBySize`, then add back what the halving overshot.
 *
 * Halving is cheap but coarse: with 400 short entries it keeps 12 where roughly 24 fit. Fidelity
 * rather than safety — `failedTestCount` always carries the true total — but the whole point is
 * to name the failing tests, so keeping twice as many for a handful of extra serializations is
 * worth it. (sdlc/020 security pass, S7.)
 */
export function boundBySizeTight<T>(
  entries: T[],
  buildEvent: (kept: T[]) => unknown,
  maxBytes: number = MAX_LINE_BYTES,
): T[] {
  let kept = boundBySize(entries, buildEvent, maxBytes);
  while (kept.length < entries.length) {
    const next = entries.slice(0, kept.length + 1);
    if (Buffer.byteLength(`${JSON.stringify(buildEvent(next))}\n`, 'utf-8') > maxBytes) break;
    kept = next;
  }
  return kept;
}

/** What the junit report yielded for a failing `test` step. */
export interface TestFailureRecord {
  failures: FailedTest[];
  total: number;
  outfile: 'present' | 'absent' | 'unparseable';
}

/**
 * Read and classify the junit report, if there is one.
 *
 * A SIGKILLed step leaves NO file: bun writes the report once, at end of run. So a timeout gives
 * `'absent'` and an empty list — this change cannot name the test in a hanging suite, and says so
 * rather than implying otherwise. See sdlc/020's "What this cannot do".
 */
export function readJunitReport(
  path: string,
  repoRoot: string,
  read: (p: string) => string,
  exists: (p: string) => boolean,
): TestFailureRecord {
  if (!exists(path)) return { failures: [], total: 0, outfile: 'absent' };
  let xml: string;
  try {
    xml = read(path);
  } catch {
    return { failures: [], total: 0, outfile: 'absent' };
  }
  // A report bun finished writing always closes its root element. Checking the CLOSING tag rather
  // than the opening one is what separates a truncated file from a complete one: the audit noted
  // that `<testsuites><testcase name="t"` contains `<testsuites`, so an opening-tag check would
  // have called a truncated file a clean parse with zero failures.
  if (!xml.includes('</testsuites>')) return { failures: [], total: 0, outfile: 'unparseable' };
  const failures = parseJunitFailures(xml, repoRoot);
  return { failures, total: failures.length, outfile: 'present' };
}

/**
 * Add the failure fields to a payload, or leave it exactly as it was.
 *
 * Pure, and exported, so the "a passing run's payload is unchanged" and "junitOutfile reflects
 * reality" criteria can be tested against the shipped code. The sdlc/020 audit found both had no
 * test touching the code they named — and the obvious fix, driving the whole gate from a test,
 * makes `bun test` spawn `bun run verify` which runs `bun test`: infinite recursion, discovered
 * by running it. Extracting the logic is the right answer anyway; a script that only orchestrates
 * is easier to trust than one that also decides.
 */
export function attachFailures(
  base: Record<string, unknown>,
  record: TestFailureRecord | null,
  wrap: (payload: Record<string, unknown>) => unknown,
  maxBytes: number = MAX_LINE_BYTES,
): Record<string, unknown> {
  if (record === null) return base;
  const kept = boundBySizeTight(
    record.failures,
    (k) => wrap({ ...base, failedTests: k, failedTestCount: record.total, junitOutfile: record.outfile }),
    maxBytes,
  );
  return { ...base, failedTests: kept, failedTestCount: record.total, junitOutfile: record.outfile };
}
