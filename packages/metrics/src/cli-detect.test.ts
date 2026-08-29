import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MetricsStore } from './store.js';

/**
 * A6's CLI half — the freshness line must print ABOVE `cli-detect.ts`'s `insufficient-data` exit.
 *
 * The result-side assertion lives in `anomaly.test.ts` and cannot catch this: the branch returns and
 * calls `process.exit(0)` before `formatBaseline` and the suppression lines, so a line rendered after
 * it would be missing from exactly the case a broken pipeline lands in first. Only running the
 * process observes the ordering.
 *
 * `CLAUDEWATCH_METRICS_DB` points at a scratch file. Never `~/.cache/claudewatch/`, and never the
 * real metrics store, which `cli-detect.ts:171` would otherwise open.
 */

const CLI = new URL('./cli-detect.ts', import.meta.url).pathname;
const SPAWN_TIMEOUT_MS = 30_000;

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-detect-'));
  dbPath = join(dir, 'metrics.db');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function seed(count: number, ageHours: number): void {
  const store = new MetricsStore(dbPath);
  const ts = new Date(Date.now() - ageHours * 3_600_000).toISOString();
  store.ingest(Array.from({ length: count }, (_, i) => ({
    eventId: `seed-${i}`, ts, source: 'sdlc', kind: 'verify_run',
    ok: true, durationMs: 30_000, schemaVersion: 1, payload: { outcome: 'pass' },
  })));
  store.close();
}

async function run(): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bun', 'run', CLI], {
    // CLAUDEWATCH_REPO is the one that gates WRITES. cli-detect.ts:16 resolves
    // `process.env.CLAUDEWATCH_REPO ?? process.cwd()` and `draft()` writes incident.md + intent.md
    // under it, so without this the subprocess inherits the real working tree. Today's fixtures only
    // reach the insufficient-data and healthy exits so nothing is written — but the sandbox was
    // incomplete in exactly the dimension where the CLI writes files. sdlc/037's Stage 5 audit.
    env: {
      PATH: process.env.PATH ?? '', HOME: dir, XDG_CACHE_HOME: join(dir, '.cache'),
      CLAUDEWATCH_METRICS_DB: dbPath, CLAUDEWATCH_REPO: dir,
    },
    stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill(), SPAWN_TIMEOUT_MS);
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, out };
}

describe('cli-detect prints freshness on every verdict (sdlc/037 A6)', () => {
  test('the line appears BEFORE the insufficient-data exit', async () => {
    seed(3, 4);   // below minVerifyRuns
    const { code, out } = await run();
    expect(out).toContain('insufficient data');
    expect(out).toContain('input: newest arrived');
    // Ordering is the assertion. A line printed after the early exit would not appear at all, but
    // asserting the index makes the intent explicit and survives someone moving the exit.
    expect(out.indexOf('input: newest arrived')).toBeLessThan(out.indexOf('insufficient data'));
    expect(code).toBe(0);
  });

  test('and on a healthy verdict, reporting the seeded age', async () => {
    seed(25, 4);   // above minVerifyRuns
    const { code, out } = await run();
    expect(out).toContain('healthy:');
    expect(out).toContain('input: newest arrived');
    // The runs were emitted four hours ago; they arrived just now, because this test ingested them.
    expect(out).toContain('emitted 4h 0m ago');
    expect(out.indexOf('input: newest arrived')).toBeLessThan(out.indexOf('healthy:'));
    expect(code).toBe(0);
  });

  test('an empty store still prints the line, with never', async () => {
    // Positive precondition for the two above: the line is unconditional, not a side effect of
    // there being events. This is also the post-prune shape — RETENTION_DAYS is 90, so a 90-day
    // outage empties the store and the number degrades from "91d 0h" to "never". Accepted, recorded.
    new MetricsStore(dbPath).close();
    const { out } = await run();
    expect(out).toContain('input: newest arrived never ago');
  });
});
