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
 * A path that ESCAPES the root via `..` is also nulled, whether it arrived relative or was
 * relativized into one. Found by probing this function adversarially rather than by reading it:
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

  // Case-insensitive on Windows, where the same path may differ only in case.
  const isWindows = /^[A-Za-z]:/.test(normFile) || normFile.startsWith('//');
  const a = isWindows ? normFile.toLowerCase() : normFile;
  const b = isWindows ? normRoot.toLowerCase() : normRoot;

  if (a === b || a.startsWith(`${b}/`)) {
    const rel = normFile.slice(normRoot.length + 1);
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
      const type = attr(failureMatch[1] ?? '', 'type');

      const rawLine = attr(attrs, 'line');
      const parsedLine = rawLine === null ? NaN : Number.parseInt(rawLine, 10);
      const rawName = attr(attrs, 'name');
      const rawSuite = attr(attrs, 'classname');

      out.push({
        file: relativizeFile(attr(attrs, 'file'), repoRoot),
        name: decodeEntities(rawName ?? '', 1),
        suite: rawSuite === null || rawSuite === '' ? null : decodeEntities(rawSuite, 2),
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
 * repo's longest real test names serialize to 5078 bytes, so the case is reachable, not
 * theoretical.
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
