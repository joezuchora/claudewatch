#!/usr/bin/env bun
/**
 * Measure the compiled statusline against SPEC.md §11.7's cache-hit budget.
 *
 * The hard part is not timing — it is not measuring the wrong thing. Three of this loop's
 * blocking review findings were about the measurement silently degrading into something else,
 * so each has a mechanical guard rather than a comment:
 *
 *   1. If the seeded cache is ever rejected, `main()` falls through to `resolveCredentials()`
 *      and every sample becomes an authenticated API call — against the user's REAL token, at
 *      ~200 requests a run. Sample 1 then writes a valid envelope, samples 2..N look like
 *      normal cache hits, and the script reports a pass. Guarded by an isolated HOME holding a
 *      fixture credential, plus a cache-hit assertion.
 *   2. The spool lives under the cache dir, so isolating HOME guarantees an empty spool.
 *      Telemetry state is therefore pinned in the child env and named in the budget, rather
 *      than inherited from whatever the operator happens to have configured.
 *   3. A p95 over 40 samples is the 38th order statistic wearing a percentile's name. Below
 *      200 samples the p95 verdict is declined, not estimated.
 *
 * Exit codes: 0 every evaluated budget holds; 1 a budget was breached; 2 could not measure.
 * A missing binary must never read as a pass.
 *
 * `--report-only` prints the distribution and verdicts but always exits 0 (2 still applies —
 * a run that could not measure is not a run that passed). `bun run verify` uses it, because
 * sdlc/015 found the machine's startup floor moving ~40% between sessions with no code change,
 * which is more than the p50 budget's margin. Enforcing a PRODUCT target as a REGRESSION gate
 * on whatever machine happens to be running conflates two instruments; the enforcing verdict
 * lives in a deliberate `bun run perf`, which REVIEW.md already requires for startup-path
 * changes.
 */
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
// A relative reach into the workspace package's src/, not `@claudewatch/metrics`. The root
// package declares no dependency on the workspace packages and `scripts/verify.ts` sets no
// precedent for one, so the package specifier does not resolve here. Adding a root dependency
// purely to satisfy the plan's prose would be the tail wagging the dog; the prose was corrected
// instead. (plan-to-diff audit, sdlc/013)
import { percentile } from '../packages/metrics/src/anomaly.js';

/** SPEC.md §11.7. p50 is the live tripwire; p95 is a regression ceiling. See sdlc/013. */
export const BUDGET_P50_MS = 50;
export const BUDGET_P95_MS = 100;
/** Below this the p95 verdict is declined. The budget is defined over >= 200 samples. */
export const P95_MIN_SAMPLES = 200;
/** Below this nothing is evaluated at all. */
export const MIN_SAMPLES = 30;
export const WARMUP = 5;
/**
 * A utilization the seeded envelope renders and nothing else plausibly would. Warm-up 0's
 * stdout must contain it, which is how the run PROVES it read the sandbox rather than merely
 * failing to disturb it.
 */
export const SENTINEL_PCT = 37;
/**
 * Per-sample ceiling. Overridable so the timeout guard can be TESTED rather than reasoned
 * about — the same affordance `scripts/verify.ts` gives its own step timeout. The audit found
 * that removing this guard entirely left every test green.
 *
 * 30s, not the 5s this started at. Five was picked as "a generous multiple of the budget" and
 * was not: a real cold exec of this 99MB binary exceeded it on the first run after the host
 * had been idle, turning the gate red for no code reason (sdlc/015). Thirty still does the job
 * the guard exists for — bounding a hang so it is RECORDED rather than hanging the terminal —
 * and would have caught the 550s event by a factor of 18.
 */
const SAMPLE_TIMEOUT_MS = Number(process.env.CLAUDEWATCH_PERF_SAMPLE_TIMEOUT_MS ?? 30_000);

const DEFAULT_BIN = join(import.meta.dir, '..', 'packages', 'statusline', 'dist', 'claudewatch');

export interface Verdict {
  label: string;
  observedMs: number | null;
  budgetMs: number;
  ok: boolean;
  evaluated: boolean;
  reason?: string;
}

/**
 * Pure, so every pass/fail case is testable without spawning anything. The spawning half is
 * what makes this script slow; the deciding half is what makes it wrong or right.
 */
export function evaluate(
  sorted: number[],
  budgets: { p50: number; p95: number },
): Verdict[] {
  const n = sorted.length;
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  const p95Evaluated = n >= P95_MIN_SAMPLES;
  return [
    { label: 'p50', observedMs: p50, budgetMs: budgets.p50, evaluated: true,
      ok: p50 !== null && p50 < budgets.p50 },
    { label: 'p95', observedMs: p95, budgetMs: budgets.p95, evaluated: p95Evaluated,
      ok: !p95Evaluated || (p95 !== null && p95 < budgets.p95),
      ...(p95Evaluated ? {} : { reason: `not evaluated (n<${P95_MIN_SAMPLES})` }) },
  ];
}

/**
 * An isolated HOME holding a fixture credential and a fresh v2 cache envelope.
 * Same shape as packages/statusline/src/smoke.test.ts's helper, deliberately: an earlier draft
 * of this script invented an env var that did not exist.
 */
export function makeSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-perf-'));
  // Modes at creation, not after: writeFileSync-then-chmod leaves a 0644 window, and this
  // helper is a template someone will copy to a path where that matters.
  mkdirSync(join(dir, '.claude'), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, '.cache', 'claudewatch'), { recursive: true, mode: 0o700 });

  const creds = join(dir, '.claude', '.credentials.json');
  writeFileSync(creds, JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-PERF-FIXTURE-NOT-REAL',
      refreshToken: 'r',
      expiresAt: 4102444800000,
    },
  }), { mode: 0o600 });
  chmodSync(creds, 0o600);   // belt and braces: mode is advisory against a permissive umask

  writeFileSync(join(dir, '.cache', 'claudewatch', 'usage.json'), JSON.stringify({
    version: 2, cooldownUntil: null, lastErrorClass: null,
    snapshot: {
      fetchedAt: new Date().toISOString(),
      source: { usageEndpoint: 'success' }, authState: 'valid', tier: 'standard',
      fiveHour: { utilizationPct: SENTINEL_PCT, resetsAt: '2099-01-01T00:00:00.000Z' },
      sevenDay: { utilizationPct: 18, resetsAt: '2099-01-01T00:00:00.000Z' },
      sevenDayOpus: { utilizationPct: null, resetsAt: null }, enterprise: null,
      display: { primaryWindow: 'fiveHour', primaryUtilizationPct: SENTINEL_PCT },
      freshness: { isStale: false, staleReason: null, ageSeconds: 0 },
      rawMetadata: { normalizationWarnings: [] },
    },
  }), { mode: 0o600 });
  return dir;
}

class MeasureError extends Error {}

export function measure(bin: string, samples: number): number[] {
  if (!existsSync(bin)) {
    throw new MeasureError(
      `binary not found: ${bin}\nBuild it first: bun run --filter @claudewatch/statusline build`,
    );
  }
  let home: string | null = null;
  // Registered before the sandbox exists so Ctrl-C during a ~90s n=200 run cannot leak it.
  const cleanup = () => { if (home) rmSync(home, { recursive: true, force: true }); home = null; };
  const onSignal = () => { cleanup(); process.exit(130); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    home = makeSandbox();
    const cachePath = join(home, '.cache', 'claudewatch', 'usage.json');
    const seededMtime = statSync(cachePath).mtimeMs;

    // HOME is not enough. `os.homedir()` follows HOME on POSIX and USERPROFILE on Windows —
    // a supported build target — so pinning only HOME would run the binary against the
    // developer's REAL credentials and REAL cache on Windows, and the mtime guard below would
    // check an untouched sandbox file and report a pass. (security pass, sdlc/013)
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      HOMEDRIVE: '',
      HOMEPATH: home,
      CLAUDEWATCH_TELEMETRY: '0',
    } as Record<string, string>;

    const one = (index: number, capture = false): { ms: number; out: string } => {
      const t0 = Bun.nanoseconds();
      const r = Bun.spawnSync([bin], {
        stdin: 'ignore', stdout: capture ? 'pipe' : 'ignore', stderr: 'ignore',
        env, timeout: SAMPLE_TIMEOUT_MS,
      });
      const ms = (Bun.nanoseconds() - t0) / 1e6;
      if (r.exitCode === null) throw new MeasureError(`sample ${index} timed out after ${SAMPLE_TIMEOUT_MS}ms`);
      if (r.exitCode !== 0) {
        throw new MeasureError(
          `sample ${index} exited ${r.exitCode}. A binary that fails is not a binary that is fast.`,
        );
      }
      return { ms, out: capture ? new TextDecoder().decode(r.stdout) : '' };
    };

    // POSITIVE, and BEFORE the timed loop. The mtime check alone is negative and post-hoc: it
    // proves the sandbox was not disturbed, which is also true when the child ignored the
    // sandbox entirely — and it fires only after every sample has already run. Requiring the
    // seeded sentinel in warm-up 0's output proves the child READ this cache, on every
    // platform, before a single measurement is taken. It is also what makes fixture drift loud:
    // a future CACHE_VERSION bump breaks here instead of silently becoming N live fetches.
    const probe = one(-1, true);
    if (!probe.out.includes(String(SENTINEL_PCT))) {
      throw new MeasureError(
        `the binary did not render the seeded cache (expected ${SENTINEL_PCT}% in its output, got ` +
        `${JSON.stringify(probe.out.trim().slice(0, 120))}). These would not be cache hits.`,
      );
    }

    for (let i = 1; i < WARMUP; i++) one(-1);
    const times: number[] = [];
    for (let i = 0; i < samples; i++) times.push(one(i).ms);

    // Every cache-miss path calls writeCache. Kept as a second, independent check: the sentinel
    // proves the first run was a hit, this proves none of the later ones stopped being one.
    if (statSync(cachePath).mtimeMs !== seededMtime) {
      throw new MeasureError(
        'the seeded cache was rewritten, so these samples are not cache hits. Refusing to report them.',
      );
    }
    return times.toSorted((a, b) => a - b);
  } finally {
    cleanup();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

// --- CLI ---

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

if (import.meta.main) {
  const samples = Number(flag('samples') ?? 200);
  const bin = flag('bin') ?? DEFAULT_BIN;
  const budgets = {
    p50: Number(flag('budget-p50') ?? BUDGET_P50_MS),
    p95: Number(flag('budget-p95') ?? BUDGET_P95_MS),
  };

  if (!Number.isFinite(samples) || samples < MIN_SAMPLES) {
    console.error(`--samples must be at least ${MIN_SAMPLES}; a percentile over fewer is the maximum wearing a percentile's name.`);
    process.exit(2);
  }

  let sorted: number[];
  try {
    sorted = measure(bin, samples);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }

  const at = (q: number) => percentile(sorted, q)!.toFixed(1);
  const dist = {
    samples: sorted.length,
    p50: Number(at(0.5)), p90: Number(at(0.9)), p95: Number(at(0.95)),
    p99: Number(at(0.99)), max: Number(sorted[sorted.length - 1]!.toFixed(1)),
  };

  const verdicts = evaluate(sorted, budgets);

  if (has('json')) {
    console.log(JSON.stringify({ ...dist, verdicts }, null, 2));
  } else {
    console.log(
      `n=${dist.samples}  p50=${dist.p50}  p90=${dist.p90}  p95=${dist.p95}  p99=${dist.p99}  max=${dist.max}`,
    );
    for (const v of verdicts) {
      if (!v.evaluated) { console.log(`  ${v.label}: ${v.reason}`); continue; }
      console.log(`  ${v.label}: ${v.observedMs!.toFixed(1)}ms against ${v.budgetMs}ms — ${v.ok ? 'ok' : 'BREACH'}`);
    }
  }

  const breached = verdicts.some((v) => v.evaluated && !v.ok);
  if (breached && has('report-only')) {
    console.log('  (report-only: not failing the gate — see sdlc/015-perf-gate-incident)');
  }
  process.exit(breached && !has('report-only') ? 1 : 0);
}
