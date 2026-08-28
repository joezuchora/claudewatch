import { existsSync, readFileSync } from 'fs';

/**
 * A warning budget for `oxlint`, enforced by `bun run verify`.
 *
 * Every loop since 029 carried an acceptance criterion of the form "oxlint warnings unchanged,
 * sorted diff empty". It lived as prose in a `spec.md`, was evaluated by hand at Stage 5, and was
 * broken five times — 11→12 and 11→19 in loop 031, then 11→13, 11→12 and 11→12 again in loop 032 —
 * every one of them found by a human re-running a command rather than by the gate. Loop 030's own
 * review had already concluded that a criterion the gate cannot run is a note, not a check, and the
 * two loops after it carried it as a note anyway. See sdlc/033-harness-gates/.
 *
 * `oxlint` already fails the gate on any ERROR. This governs WARNINGS, which it does not.
 */

/**
 * One budgeted warning, identified by everything about it that does not move on an unrelated edit.
 *
 * Line and column are deliberately absent: an edit ten lines above shifts every warning below it,
 * and a budget that fires on that is a budget nobody keeps.
 *
 * `message` is present, and its absence was a real hole in the first draft of the spec. With a
 * `code` + `filename` key, swapping one warning for a DIFFERENT warning of the same rule in the
 * same file leaves the count unchanged and is invisible — the same defeat as the count-only budget
 * the spec rejects, one level down. The hand procedure this replaces
 * (sdlc/031-cache-read-completeness/plan.md:162) diffed whole oxlint lines, messages included, so a
 * message-free key would have been strictly weaker than the prose it automates.
 *
 * `count` is still needed on top of `message`, because messages genuinely do collide: both
 * `unicorn(no-array-sort)` warnings in `packages/metrics/src/anomaly.ts` carry identical text, as do
 * both `unicorn(prefer-array-find)` in `packages/core/src/call-sites.test.ts`.
 */
export interface Row {
  code: string;
  /** Repo-relative, POSIX separators. Windows backslashes are normalised on read. */
  filename: string;
  message: string;
  count: number;
}

/** The subset of an `oxlint --format=json` diagnostic this module reads. */
export interface Diagnostic {
  code?: unknown;
  filename?: unknown;
  message?: unknown;
  severity?: unknown;
  /**
   * Present in the real payload, carrying `span.line` / `span.column`, and read by NOTHING here.
   * Declared so the type describes what oxlint emits rather than what this module wants, and so a
   * test can vary the line to prove the key ignores it.
   */
  labels?: unknown;
}

export const BUDGET_PATH = '.oxlint-budget.json';

/** Field separator for the composite key. Tab cannot appear in a rule code or a POSIX path. */
const KEY_SEP = '\t';

const keyOf = (r: { code: string; filename: string; message: string }): string =>
  [r.code, r.filename, r.message].join(KEY_SEP);

/**
 * SPEC.md §2.1 ships v1 on Windows 11 as well as Linux, where oxlint reports
 * `packages\core\src\x.ts`. Without this the nine committed rows mismatch nine actual rows on every
 * Windows checkout — nine "removed" plus nine "added" — and the gate fails on first run with no
 * code change.
 */
const toPosix = (p: string): string => p.split('\\').join('/');

/**
 * Sorted so the comparison is stable: oxlint's emission order is not guaranteed across runs on an
 * identical tree, which is why the hand procedure this replaces piped through `sort`.
 *
 * `toSorted()`, not `sort()`. `unicorn(no-array-sort)` is one of the two rules responsible for all
 * five historic regressions this module exists to catch, and a gate that trips the rule it enforces
 * is not shippable.
 */
export function rowsFrom(diagnostics: readonly Diagnostic[]): Row[] {
  const counts = new Map<string, Row>();
  for (const d of diagnostics) {
    if (d.severity !== 'warning') continue;
    if (typeof d.code !== 'string' || typeof d.filename !== 'string' || typeof d.message !== 'string') {
      throw new Error(
        `lint-budget: a diagnostic is missing code/filename/message — got ${JSON.stringify(d)}`,
      );
    }
    const row: Row = { code: d.code, filename: toPosix(d.filename), message: d.message, count: 1 };
    const k = keyOf(row);
    const seen = counts.get(k);
    if (seen) seen.count += 1;
    else counts.set(k, row);
  }
  return [...counts.values()].toSorted((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
}

/**
 * Both directions, and the removal direction is not decoration.
 *
 * Without it the per-file count key is trivially defeated: remove one `unicorn(no-array-sort)` from
 * `anomaly.ts` and introduce a different one in the same file, and an upward-only budget sees the
 * same count before and after. The cost is that a cleanup commit which FIXES a warning also fails,
 * and the only way to green is to edit the budget file — which is why there is no `--write` flag and
 * why the two directions are worded differently (see `report`).
 *
 * A changed count surfaces as one `added` and one `removed`, so the wording falls out of one path.
 */
export function diffBudget(
  actual: readonly Row[],
  budget: readonly Row[],
): { added: Row[]; removed: Row[] } {
  const b = new Map(budget.map((r) => [keyOf(r), r]));
  const a = new Map(actual.map((r) => [keyOf(r), r]));
  const added: Row[] = [];
  const removed: Row[] = [];
  for (const [k, r] of a) {
    const prev = b.get(k);
    if (!prev) added.push(r);
    else if (prev.count < r.count) added.push({ ...r, count: r.count - prev.count });
  }
  for (const [k, r] of b) {
    const now = a.get(k);
    if (!now) removed.push(r);
    else if (now.count < r.count) removed.push({ ...r, count: r.count - now.count });
  }
  return { added, removed };
}

/**
 * Asymmetric on purpose. A reviewer scanning a `.oxlint-budget.json` diff must be able to tell a
 * regression from a fix, because the edit that resolves them is identical.
 */
export function report(diff: { added: readonly Row[]; removed: readonly Row[] }): string[] {
  const lines: string[] = [];
  for (const r of diff.added) {
    lines.push(`lint-budget: NEW WARNING  ${r.code}  ${r.filename}  ${r.message}`);
  }
  for (const r of diff.removed) {
    lines.push(
      `lint-budget: ${r.count} fewer ${r.code} in ${r.filename} — ` +
        `if you fixed it, update ${BUDGET_PATH} in this commit`,
    );
  }
  return lines;
}

/**
 * Validated, not `as`-asserted. `docs/audit-report.md` already carries `JSON.parse … as` as a
 * standing informational finding and this module must not add two more.
 */
export function parseBudget(text: string): Row[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error(`lint-budget: ${BUDGET_PATH} is not an array`);
  return parsed.map((r, i) => {
    if (typeof r !== 'object' || r === null) throw new Error(`lint-budget: row ${i} is not an object`);
    const { code, filename, message, count } = r as Record<string, unknown>;
    if (
      typeof code !== 'string' ||
      typeof filename !== 'string' ||
      typeof message !== 'string' ||
      typeof count !== 'number' ||
      !Number.isInteger(count) ||
      count < 1
    ) {
      throw new Error(`lint-budget: row ${i} is malformed`);
    }
    return { code, filename, message, count };
  });
}

/** The failure output IS the new budget file — there is no `--write`, so it must be pasteable. */
export function renderBudget(rows: readonly Row[]): string {
  return `${JSON.stringify(rows, null, 2)}\n`;
}

async function main(): Promise<number> {
  const proc = Bun.spawn(['bunx', 'oxlint', '--format=json'], { stdout: 'pipe', stderr: 'pipe' });
  const raw = await new Response(proc.stdout).text();
  await proc.exited;

  let diagnostics: readonly Diagnostic[];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { diagnostics?: unknown }).diagnostics)) {
      throw new Error('no diagnostics array');
    }
    diagnostics = (parsed as { diagnostics: Diagnostic[] }).diagnostics;
  } catch (e) {
    // NOT treated as a clean tree. An empty warning set would silently "improve" the budget to
    // zero, which is the one failure mode a budget must never have.
    console.error(`lint-budget: could not read oxlint output (${String(e)}). This is a failure, not a clean tree.`);
    return 1;
  }

  const actual = rowsFrom(diagnostics);

  if (!existsSync(BUDGET_PATH)) {
    console.error(`lint-budget: ${BUDGET_PATH} is missing. Create it with this content:\n`);
    console.error(renderBudget(actual));
    return 1;
  }

  let budget: Row[];
  try {
    budget = parseBudget(readFileSync(BUDGET_PATH, 'utf8'));
  } catch (e) {
    // Deliberately the opposite of the product cache idiom (SPEC.md §9.6: corruption → delete and
    // refetch). A gate that heals its own record is not a gate.
    console.error(`lint-budget: ${BUDGET_PATH} is unreadable — ${String(e)}`);
    return 1;
  }

  const diff = diffBudget(actual, budget);
  if (diff.added.length === 0 && diff.removed.length === 0) return 0;

  for (const line of report(diff)) console.error(line);
  console.error(`\nlint-budget: ${BUDGET_PATH} should be:\n`);
  console.error(renderBudget(actual));
  return 1;
}

if (import.meta.main) process.exit(await main());
