#!/usr/bin/env bun
/**
 * The gap distribution of a metrics store, on BOTH clocks.
 *
 * ```
 * bun run scripts/arrival-dist.ts /root/.local/share/claudewatch-metrics/metrics.db
 * ```
 *
 * This script exists because sdlc/037's first spec draft published a distribution measured on `ts`
 * under the heading "the arrival distribution", and decided the loop's central question — whether to
 * ship a staleness bound — on it. Every window in `anomaly.ts` filters on `receivedAt`, so the one
 * clock that mattered was the one not measured. Against arrivals the claimed 6x headroom is 2.08x.
 *
 * A pasted table cannot be re-run. The intent asked for "a form the next loop can re-run rather than
 * re-derive"; this is that form, and it reports both clocks side by side precisely so the substitution
 * cannot happen again silently.
 *
 * Read-only, path from argv with no default, so it cannot be pointed at the live store by accident.
 * Prints numbers and kind names only — no paths, per SPEC.md §12.
 */
import { Database } from 'bun:sqlite';
/**
 * The percentile rule is IMPORTED, not re-derived.
 *
 * `anomaly.ts`'s own docstring says it is "exported so `scripts/perf.ts` shares this exact
 * definition rather than writing a third copy — linear interpolation would differ by one order
 * statistic". The first version of this file wrote a fourth copy two hundred lines from that
 * sentence. sdlc/037's Stage 5 audit caught it, and noted the irony precisely: this loop draws the
 * reuse-versus-formatting-preference distinction correctly for `formatAgeMs` (which is NOT shared
 * with `agent.ts`'s `formatAge`, because a unit ladder is a preference) and then got it backwards
 * one file over, for a rule.
 */
import { percentile } from '../packages/metrics/src/anomaly.js';

export interface Distribution {
  n: number;
  p50: number; p75: number; p90: number; p95: number; p99: number; max: number;
  overOneHour: number;
  overTwoHours: number;
}

const HOUR_MS = 3_600_000;

/**
 * Gaps between DISTINCT timestamps, sorted.
 *
 * Distinct, because a shipped batch gives many events one `receivedAt` and counting the zero-gaps
 * between them would report a p50 of 0 and hide the real cadence entirely.
 */
export function gapDistribution(timestamps: readonly string[]): Distribution | null {
  const t = [...new Set(timestamps)].map((x) => Date.parse(x)).filter(Number.isFinite).toSorted((a, b) => a - b);
  if (t.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < t.length; i++) gaps.push(t[i]! - t[i - 1]!);
  const s = gaps.toSorted((a, b) => a - b);
  const q = (p: number): number => percentile(s, p)!;
  return {
    n: s.length,
    p50: q(0.5), p75: q(0.75), p90: q(0.9), p95: q(0.95), p99: q(0.99), max: s[s.length - 1]!,
    overOneHour: s.filter((g) => g > HOUR_MS).length,
    overTwoHours: s.filter((g) => g > 2 * HOUR_MS).length,
  };
}

export interface EventRow { ts: string; receivedAt: string }

/**
 * BOTH clocks, from one function, so the pairing of column to label is testable.
 *
 * The first version left this inline in `main`, and the M9 mutation — report `ts` for both clocks,
 * which is sdlc/037's first spec draft's actual defect — produced ZERO test failures. The test named
 * `both clocks are reported` called `renderDistribution` directly with a hand-built distribution, so
 * it asserted that the RENDERER preserves a label and never that the CALLER passes the right column.
 * A test whose name claims one thing and whose body checks another is the shape this repo keeps
 * finding; here it was guarding the very mistake the script exists to prevent.
 */
export function distributionsFor(rows: readonly EventRow[]): {
  ts: Distribution | null;
  receivedAt: Distribution | null;
} {
  return {
    ts: gapDistribution(rows.map((r) => r.ts)),
    receivedAt: gapDistribution(rows.map((r) => r.receivedAt)),
  };
}

const m = (ms: number): string => `${(ms / 60_000).toFixed(1)}m`;

export function renderDistribution(label: string, d: Distribution | null): string {
  if (d === null) return `${label}  (fewer than two distinct timestamps)`;
  return (
    `${label}  n=${String(d.n).padStart(4)}  p50=${m(d.p50)} p75=${m(d.p75)} p90=${m(d.p90)} ` +
    `p95=${m(d.p95)} p99=${m(d.p99)} max=${m(d.max)}  >1h=${d.overOneHour} >2h=${d.overTwoHours}`
  );
}

function main(): number {
  const path = process.argv[2];
  if (path === undefined) {
    console.error('usage: bun run scripts/arrival-dist.ts <path-to-metrics.db> [kind]');
    console.error('  no default path, deliberately — this must not run against a store by accident.');
    return 1;
  }
  const kind = process.argv[3] ?? 'verify_run';

  const db = new Database(path, { readonly: true });
  try {
    const census = db.query('SELECT kind, COUNT(*) AS c FROM events GROUP BY kind ORDER BY kind').all() as
      Array<{ kind: string; c: number }>;
    console.log(`kinds: ${census.map((r) => `${r.kind}=${r.c}`).join(' ') || '(empty store)'}`);

    const rows = db.query('SELECT ts, received_at AS receivedAt FROM events WHERE kind = ?').all(kind) as EventRow[];
    console.log(`\n${kind}: ${rows.length} events`);
    // BOTH clocks, always, side by side. See this file's header.
    const d = distributionsFor(rows);
    console.log(renderDistribution('ts-gaps        ', d.ts));
    console.log(renderDistribution('receivedAt-gaps', d.receivedAt));
    return 0;
  } finally {
    db.close();
  }
}

if (import.meta.main) process.exit(main());
