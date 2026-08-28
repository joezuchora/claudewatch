import { existsSync, readFileSync, readdirSync } from 'fs';

/**
 * Compare each loop's `spec.md` against its `plan.md` scope fence.
 *
 * The plan-to-diff auditor compares PLAN to DIFF. Nothing compared SPEC to PLAN, and loop 030 shows
 * what that costs: its `spec.md` asked for `extractLastError`'s gate to be "KEPT, and relabelled";
 * its `plan.md` then listed `snapshot.ts` on the explicitly-not-touched fence. The two artifacts
 * contradict each other, the auditor found the diff inside the fence — because it was — and the
 * loop shipped with the criterion recorded as met. The missing half was implemented a loop later,
 * by hand. See sdlc/033-harness-gates/.
 *
 * The check must resolve SYMBOLS, not just paths. Loop 030's spec never writes the string
 * `snapshot.ts`; it names `extractLastError`, and the file is merely where that symbol lives. A
 * path-only version of this script was built first and measured: it misses loop 030 entirely. That
 * is why `buildIndex` exists.
 */

export interface Finding {
  loop: string;
  specToken: string;
  file: string;
  fenceEntry: string;
}

export type SymbolIndex = ReadonlyMap<string, readonly string[]>;

/**
 * Three phrasings across loops 020-022, settling on the first from 024 on. `Not touched` is a
 * prefix of `Not touched, deliberately`, so two entries cover all three.
 *
 * The first draft of the spec matched only the long forms, called loops 021 and 022 UNCHECKABLE,
 * and then justified the resulting count with "the convention starts at loop 020" — a parser bug
 * one commit away from being baselined as a constant.
 */
const MARKERS = ['Explicitly not touched', 'Not touched'] as const;

/** Asides name files that are NOT fenced — loop 025's names `core-bridge.ts`. Flat, not nesting-aware. */
const PARENTHETICAL = /\([^()]*\)/g;
/** Loop 020's fence is one path followed by prose, one sentence of which says `verify.ts` DOES move. */
const SENTENCE_END = /\.(\s|$)/;
/** Line-bounded: a fence token cannot span a newline. */
const TOKEN = /`([^`\n]+)`/g;
/** Only requirement headings. Body prose yields 89 findings across 9 loops; headings yield 1. */
const HEADING = /^#{2,4}\s/;
const PATH_RE = /^(?:[\w./@-]+\/)?[\w.@-]+\.(?:ts|md|json|ya?ml|sh|ps1|js)$/;
const EXPORTED =
  /^export\s+(?:async\s+)?(?:abstract\s+class|function|const|let|class|interface|type|enum)\s+(\w+)/gm;

/**
 * Deliberately broken files whose exports are noise, not API — and two symbols there are genuinely
 * double-defined (`COLOURS`, `leaky`), inside a directory loop 031's plan fences verbatim.
 */
const INDEX_EXCLUDE = 'packages/core/src/typefixtures/';

const ticks = (md: string): string[] => [...md.matchAll(TOKEN)].map((m) => m[1]!.trim());

/** Windows separators, so a `readdir` corpus does not make every finding silently vanish. */
const toPosix = (p: string): string => p.split('\\').join('/');

/**
 * `null` means the plan has no machine-readable fence: reported UNCHECKABLE, never reported as
 * passing.
 *
 * Order matters and three mutations target it: EARLIEST marker (a plan carrying two forms must be
 * read from the first), slice to the first blank line, strip parentheticals ON THE JOINED STRING
 * (loop 030's aside spans a newline, so per-line stripping leaves its contents in), truncate at the
 * first sentence end, then collect tokens.
 */
export function extractFence(planMd: string): string[] | null {
  const found = MARKERS.map((m) => planMd.indexOf(m)).filter((i) => i >= 0);
  if (found.length === 0) return null;
  let s = planMd.slice(Math.min(...found));
  const para = s.indexOf('\n\n');
  if (para >= 0) s = s.slice(0, para);
  s = s.replace(PARENTHETICAL, ' ');
  const dot = s.search(SENTENCE_END);
  if (dot >= 0) s = s.slice(0, dot);
  return ticks(s);
}

export function headingTokens(specMd: string): string[] {
  return ticks(
    specMd
      .split('\n')
      .filter((l) => HEADING.test(l))
      .join('\n'),
  );
}

/**
 * Loops 020-022 write headings as `name(arg: T): R` exclusively. Without this strip none of them
 * resolves to anything, ever.
 */
const bareSymbol = (t: string): string => t.replace(/\(.*$/, '').replace(/:.*$/, '').trim();

export function buildIndex(corpus: readonly string[], read = readFileSync): SymbolIndex {
  const index = new Map<string, string[]>();
  for (const f of corpus) {
    if (!f.endsWith('.ts')) continue;
    if (!f.startsWith('packages/') && !f.startsWith('scripts/')) continue;
    if (f.startsWith(INDEX_EXCLUDE)) continue;
    for (const m of String(read(f, 'utf8')).matchAll(EXPORTED)) {
      const k = m[1]!;
      const at = index.get(k);
      if (at) at.push(f);
      else index.set(k, [f]);
    }
  }
  return index;
}

/**
 * Core wins over other `packages/*` files — those are surfaces re-exporting core, per CLAUDE.md's
 * architecture rule, and without this `renderEvent` resolves to a vscode bridge shim and fires
 * against loop 032's fence.
 *
 * A `scripts/` definition is KEPT as an independent candidate. `scripts/` is not a surface over
 * core, and two real counterexamples exist: `scripts/verify.ts` documents at length that
 * `MAX_LINE_BYTES` is deliberately duplicated in `junit.ts` rather than imported, and
 * `scripts/perf.ts` has an unrelated `evaluate`. Under unqualified core-wins, a harness loop naming
 * `MAX_LINE_BYTES` whose plan fences `scripts/` — as loops 029-032 all do — would resolve to
 * `telemetry.ts` and miss. That is exactly the class of loop this gate exists for.
 */
function resolveSymbol(token: string, index: SymbolIndex): readonly string[] {
  const all = index.get(token) ?? index.get(bareSymbol(token)) ?? [];
  if (all.length <= 1) return all;
  const core = all.filter((f) => f.startsWith('packages/core/src/'));
  if (core.length === 0) return all;
  return [...core, ...all.filter((f) => f.startsWith('scripts/'))];
}

/** Equal to, a basename tail (`snapshot.ts`), or a directory prefix (`packages/metrics`). */
function inFence(file: string, entry: string): boolean {
  const e = entry.replace(/\/\*+$/, '').replace(/\/$/, '');
  if (e === '') return false;
  return file === e || file.endsWith(`/${e}`) || file.startsWith(`${e}/`);
}

/**
 * `unresolved` is returned, not swallowed. Zero false positives across twelve loops is easy to
 * achieve by understanding almost nothing, so the check publishes what it could not read: only 26
 * of 50 heading tokens resolve. Type members (`MetricEvent.payload` — the very token loop 020's
 * fence protects as the telemetry security boundary), non-exported symbols, and flags all fall
 * through. Baselining the count turns that silence into a ratcheted number.
 */
export function checkLoop(
  loop: string,
  specMd: string,
  planMd: string,
  index: SymbolIndex,
  corpus: readonly string[],
): { findings: Finding[]; unresolved: string[] } | null {
  const fence = extractFence(planMd);
  if (fence === null) return null;

  const findings: Finding[] = [];
  const unresolved: string[] = [];
  for (const token of new Set(headingTokens(specMd))) {
    const targets = PATH_RE.test(token)
      ? corpus.filter((f) => f === token || f.endsWith(`/${token}`))
      : resolveSymbol(token, index);
    if (targets.length === 0) {
      unresolved.push(token);
      continue;
    }
    for (const file of targets) {
      const entry = fence.find((x) => inFence(file, x));
      if (entry !== undefined) findings.push({ loop, specToken: token, file, fenceEntry: entry });
    }
  }
  return { findings, unresolved };
}

export interface Baseline {
  uncheckable: number;
  unresolvedTokens: number;
  findings: Array<Finding & { note: string }>;
}

export const BASELINE_PATH = 'sdlc/fence-baseline.json';

/** Validated, not `as`-asserted, and never healed — see `lint-budget.ts` for the same reasoning. */
export function parseBaseline(text: string): Baseline {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('fence-check: baseline is not an object');
  const { uncheckable, unresolvedTokens, findings } = parsed as Record<string, unknown>;
  if (!Number.isInteger(uncheckable) || !Number.isInteger(unresolvedTokens) || !Array.isArray(findings)) {
    throw new Error('fence-check: baseline is malformed');
  }
  return {
    uncheckable: uncheckable as number,
    unresolvedTokens: unresolvedTokens as number,
    findings: findings.map((f, i) => {
      if (typeof f !== 'object' || f === null) throw new Error(`fence-check: baseline finding ${i} is not an object`);
      const { loop, specToken, file, fenceEntry, note } = f as Record<string, unknown>;
      if (
        typeof loop !== 'string' ||
        typeof specToken !== 'string' ||
        typeof file !== 'string' ||
        typeof fenceEntry !== 'string' ||
        typeof note !== 'string'
      ) {
        throw new Error(`fence-check: baseline finding ${i} is malformed`);
      }
      return { loop, specToken, file, fenceEntry, note };
    }),
  };
}

const keyOf = (f: Finding): string => `${f.loop}|${f.specToken}|${f.file}|${f.fenceEntry}`;

export async function gitFiles(): Promise<string[]> {
  const proc = Bun.spawn(['git', 'ls-files'], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.split('\n').filter(Boolean).map(toPosix);
}

async function main(): Promise<number> {
  const corpus = await gitFiles();
  const index = buildIndex(corpus);

  const findings: Finding[] = [];
  const unresolved: string[] = [];
  let uncheckable = 0;
  let checkable = 0;
  let skipped = 0;

  for (const loop of readdirSync('sdlc').filter((d) => /^\d{3}-/.test(d)).toSorted()) {
    const spec = `sdlc/${loop}/spec.md`;
    const plan = `sdlc/${loop}/plan.md`;
    if (!existsSync(spec) || !existsSync(plan)) {
      skipped += 1;
      continue;
    }
    const res = checkLoop(loop, readFileSync(spec, 'utf8'), readFileSync(plan, 'utf8'), index, corpus);
    if (res === null) {
      uncheckable += 1;
      continue;
    }
    checkable += 1;
    findings.push(...res.findings);
    unresolved.push(...res.unresolved.map((t) => `${loop}: ${t}`));
  }

  // Printed whether or not the run fails: the next loop that writes a heading this check cannot
  // read should show up as a delta, not as silence.
  console.log(`fence-check: ${checkable} checkable, ${uncheckable} uncheckable, ${skipped} skipped`);
  console.log(`fence-check: ${unresolved.length} unresolved heading tokens`);
  for (const u of unresolved) console.log(`  unresolved  ${u}`);
  for (const f of findings) console.log(`  FINDING  ${f.loop}: ${f.specToken} -> ${f.file} (fence: ${f.fenceEntry})`);

  if (!existsSync(BASELINE_PATH)) {
    console.error(`\nfence-check: ${BASELINE_PATH} is missing.`);
    return 1;
  }

  let baseline: Baseline;
  try {
    baseline = parseBaseline(readFileSync(BASELINE_PATH, 'utf8'));
  } catch (e) {
    console.error(`\nfence-check: ${BASELINE_PATH} is unreadable — ${String(e)}`);
    return 1;
  }

  const problems: string[] = [];
  const known = new Set(baseline.findings.map(keyOf));
  const seen = new Set(findings.map(keyOf));
  for (const f of findings) {
    if (!known.has(keyOf(f))) {
      problems.push(
        `fence-check: NEW CONTRADICTION  ${f.loop}: spec.md requires \`${f.specToken}\` (${f.file}) ` +
          `but plan.md fences \`${f.fenceEntry}\``,
      );
    }
  }
  for (const f of baseline.findings) {
    if (!seen.has(keyOf(f))) {
      problems.push(`fence-check: baselined contradiction no longer found — ${f.loop}: ${f.specToken}. Remove it from ${BASELINE_PATH}.`);
    }
  }
  // Skipped is reported, never asserted: a loop mid-flight has spec.md and no plan.md, so asserting
  // it would make verify red for the first two commits of every future loop.
  if (uncheckable !== baseline.uncheckable) {
    problems.push(`fence-check: uncheckable is ${uncheckable}, baseline says ${baseline.uncheckable}`);
  }
  if (unresolved.length !== baseline.unresolvedTokens) {
    problems.push(
      `fence-check: unresolved heading tokens is ${unresolved.length}, baseline says ${baseline.unresolvedTokens}`,
    );
  }

  if (problems.length === 0) return 0;
  console.error('');
  for (const p of problems) console.error(p);
  return 1;
}

if (import.meta.main) process.exit(await main());
