import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';

/**
 * `cli-ship.ts`'s first test file.
 *
 * It has had none since it was written, recorded as PARTIAL against sdlc/034's A9 and carried
 * forward through 035 and 036. It is closed here not out of diligence but out of necessity: A4 and
 * A12 both need the entry point run as a SUBPROCESS, because the defect they guard is that the
 * process used to die before printing anything, and an in-process call cannot observe that.
 *
 * Every subprocess gets HOME and XDG_CACHE_HOME pointed at a mktemp sandbox. NEVER the real cache —
 * that is a standing rule, and `getSpoolPath()` reads both.
 */

const CLI = new URL('./cli-ship.ts', import.meta.url).pathname;
const SPAWN_TIMEOUT_MS = 30_000;

const EVENT = `${JSON.stringify({
  eventId: 'e1', ts: '2026-08-29T05:00:00.000Z', source: 'sdlc', kind: 'verify_run',
  ok: true, durationMs: 1, schemaVersion: 1, payload: {},
})}\n`;

let dir: string;
let cache: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-cli-ship-'));
  cache = join(dir, '.cache');
  mkdirSync(join(cache, 'claudewatch'), { recursive: true });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const spool = (): string => join(cache, 'claudewatch', 'metrics-spool.jsonl');

async function run(env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(['bun', 'run', CLI], {
    // A CLOSED port by default. Never api.anthropic.com, never a real endpoint.
    env: { PATH: process.env.PATH ?? '', HOME: dir, XDG_CACHE_HOME: cache, ...env },
    stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill(), SPAWN_TIMEOUT_MS);
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, out, err };
}

describe('cli-ship prints why, not just how many (sdlc/036 A4)', () => {
  test('an unreachable service produces a reason line, a backlog line, and a non-zero exit', async () => {
    writeFileSync(spool(), EVENT);
    const { code, out } = await run({ CLAUDEWATCH_METRICS_ENDPOINT: 'http://127.0.0.1:9187' });
    expect(out).toContain('retained 1');
    expect(out).toContain('retained: Network error');
    expect(out).toContain('backlog: 1 file(s)');
    expect(code).toBe(1);
  });

  test('an unconfigured endpoint is not an error and prints no reason line', async () => {
    // The overwhelmingly common case. A gate that treats "telemetry is off" as a failure is worse
    // than one that says nothing.
    writeFileSync(spool(), EVENT);
    const { code, out } = await run({});
    expect(out).toContain('not set');
    expect(out).not.toContain('retained:');
    expect(code).toBe(0);
  });

  test('a clean run prints no reason line and no backlog line', async () => {
    // Positive precondition for the two above: the lines are absent because nothing failed, not
    // because they are never printed.
    const { code, out } = await run({ CLAUDEWATCH_METRICS_ENDPOINT: 'http://127.0.0.1:9187' });
    expect(out).toContain('shipped 0 events');
    expect(out).not.toContain('retained:');
    expect(out).not.toContain('backlog:');
    expect(code).toBe(0);
  });

  test('a backlog at the cap reports the data-loss line on stderr', async () => {
    for (let i = 1; i <= 25; i++) writeFileSync(`${spool()}.${i}.shipping`, EVENT);
    const { code, err, out } = await run({ CLAUDEWATCH_METRICS_ENDPOINT: 'http://127.0.0.1:9187' });
    expect(err).toContain('DATA LOST');
    expect(err).toContain('exist nowhere else');
    expect(out).toContain('backlog: 20 file(s)');
    expect(code).toBe(1);
  });
});

/**
 * A12 — SPEC.md §12, as a test rather than as a review step.
 *
 * The first spec draft made this "a security pass confirms…", which `REVIEW.md` mandates anyway and
 * which is satisfied by a person saying so. Its assertion was also defeatable: it checked for the
 * absence of `u` and `p`, single characters that both appear in "unparseable line(s)".
 *
 * Sentinels are high-entropy for exactly that reason, and `.invalid` cannot resolve.
 */
describe('no configured secret reaches any output (sdlc/036 A12)', () => {
  const USER = 'USER7f3a9c';
  const PASS = 'PASS2b81de';
  const TOKEN = 'TOK4d19ae';
  const PATHSENT = 'sentinelpath5c7d2e';
  /**
   * A CLOSED LOOPBACK PORT, not a `.invalid` hostname.
   *
   * The first version used `https://…@sentinel-host.invalid/x` on the reasoning that `.invalid`
   * cannot resolve. Run, it returned **HTTP 403** — this environment's outbound proxy answers for
   * unresolvable hosts, so the test was making a real outbound request on every one of its five
   * cases. The claim was made by reading and was wrong; the plan's risk section stated it as fact.
   *
   * Loopback on a closed port cannot leave the machine, and the sentinels still ride in the userinfo
   * and the path, which is what the assertion is actually about.
   */
  const ENDPOINT = `https://${USER}:${PASS}@127.0.0.1:9187/${PATHSENT}`;

  const cases: Array<[label: string, seed: () => void]> = [
    ['a clean run', () => {}],
    ['a transport failure', () => writeFileSync(spool(), EVENT)],
    ['a retained backlog', () => {
      writeFileSync(spool(), EVENT);
      for (let i = 1; i <= 3; i++) writeFileSync(`${spool()}.${i}.shipping`, EVENT);
    }],
    ['a drop at the cap', () => {
      for (let i = 1; i <= 25; i++) writeFileSync(`${spool()}.${i}.shipping`, EVENT);
    }],
    ['an unparseable spool', () => writeFileSync(spool(), 'not json at all\n')],
  ];

  for (const [label, seed] of cases) {
    test(`${label} leaks neither credential, host, nor an absolute path`, async () => {
      seed();
      const { out, err } = await run({
        CLAUDEWATCH_METRICS_ENDPOINT: ENDPOINT,
        CLAUDEWATCH_METRICS_TOKEN: TOKEN,
      });
      const all = `${out}${err}`;
      // Positive precondition: the child ran with the configured endpoint and got far enough to
      // report on it. Without this, an empty output or an early exit would pass every assertion
      // below — the vacuous shape sdlc/033 and sdlc/035 both caught.
      expect(all).toContain('shipped ');
      expect(all).not.toContain('not set');

      for (const secret of [USER, PASS, TOKEN, PATHSENT]) {
        expect(all).not.toContain(secret);
      }
      // No URL echoed at all, in any form, and no absolute path from this machine.
      expect(all).not.toContain('://');
      expect(all).not.toContain('@');
      expect(all).not.toContain(dir);
      expect(all).not.toContain(homedir());
    });
  }
});
