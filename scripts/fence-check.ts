import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'fs';

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

/** Root `package.json` script name -> the tracked file that script runs. See `indexScripts`. */
export type ScriptIndex = ReadonlyMap<string, string>;

/** Which of the two populations an unresolved heading token belongs to. See `classifyToken`. */
export type TokenClass = 'unresolved' | 'not-a-symbol';

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
/**
 * Headings only. Body prose yields 89 findings across 9 loops; headings yield 1.
 *
 * NOT "requirement headings" — this matches every `##` through `####`, measurement and prose
 * headings included, and the distinction is load-bearing: loop 032's `primaryUtilizationPct` false
 * positive comes from a heading that *measures* rendering behaviour, not one that requires a change
 * to the file where the field is declared. Narrowing to requirement headings would need a heading
 * convention no committed loop follows, so the docstring is honest instead. See sdlc/035's m-2.
 */
const HEADING = /^#{2,4}\s/;
const PATH_RE = /^(?:[\w./@-]+\/)?[\w.@-]+\.(?:ts|md|json|ya?ml|sh|ps1|js)$/;
const EXPORTED =
  /^export\s+(?:async\s+)?(?:abstract\s+class|function|const|let|class|interface|type|enum)\s+(\w+)/gm;

/**
 * Deliberately broken files whose exports are noise, not API — and two symbols there are genuinely
 * double-defined (`COLOURS`, `leaky`), inside a directory loop 031's plan fences verbatim.
 */
const INDEX_EXCLUDE = 'packages/core/src/typefixtures/';

/**
 * The single point where every backticked token enters this module — heading tokens and fence
 * entries alike — and therefore the right place to bound control characters.
 *
 * `scrubControls` already guards `parseBaseline` for exactly this reason: a record field carrying a
 * raw CSI sequence is invisible in a diff viewer and reaches a terminal intact. sdlc/035's security
 * pass found the same hole one door down, and found that THIS DIFF made it quieter rather than
 * louder. Before the split, an ESC-bearing heading token landed in `unresolved`, whose count is
 * baselined, so committing one forced a count mismatch and a red gate. After the split it classifies
 * as `not-a-symbol` — printed, never asserted — so the same bytes print on a GREEN run, and a
 * `\x1b[8m` conceals every `FINDING` line after it.
 *
 * Scrubbing here rather than at each print site is the same choice loop 032 made for
 * `disabledReason`: a positive bound at the boundary, not a blacklist at the printer. No committed
 * artifact contains a control character today, so this changes no current output.
 */
const ticks = (md: string): string[] =>
  [...md.matchAll(TOKEN)].map((m) => scrubControls(m[1]!).trim());

/**
 * Windows separators, so a `readdir` corpus does not make every finding silently vanish.
 *
 * Applied at the ENTRY of `buildIndex` and `checkLoop`, not only in `gitFiles`. The first version
 * normalised in `gitFiles` alone, which made the portability test unable to fail: it built a
 * backslash corpus and then converted it back to POSIX before calling anything, so the assertion
 * held with `toPosix` replaced by the identity function. sdlc/033's audit proved that by mutation.
 */
export const toPosix = (p: string): string => p.split('\\').join('/');

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

/**
 * A tracked path is only read when `lstat` says it is a regular file under the cap.
 *
 * `lstat`, not `stat`, so a SYMLINK is rejected rather than followed. sdlc/033's security pass
 * demonstrated both halves in a scratch repo: a tracked `packages/core/src/evil.ts` symlinked
 * outside the repo had its exports indexed, and one pointing at `/dev/zero` grew until ENOMEM and
 * killed the gate — an unbounded OOM on any CI runner without a ulimit. A repository file's NAME
 * must not decide what gets read.
 *
 * 1 MiB is ~4x the largest source file here and cannot plausibly be exceeded by hand-written TS.
 */
const MAX_INDEXED_BYTES = 1024 * 1024;

/** Passed by tests whose corpus is string literals with no files behind it. */
export const NO_STAT = null as unknown as typeof lstatSync;

function readableSource(path: string, statFn = lstatSync): boolean {
  try {
    const st = statFn(path);
    return st.isFile() && st.size <= MAX_INDEXED_BYTES;
  } catch {
    // A tracked path that is not present in the working tree (mid-rebase, a deleted-but-unstaged
    // file) defines no symbol in the checked-out tree. Skipping it is correct; dying on it is not.
    return false;
  }
}

export function buildIndex(corpus: readonly string[], read = readFileSync, stat = lstatSync): SymbolIndex {
  const index = new Map<string, string[]>();
  for (const raw of corpus) {
    const f = toPosix(raw);
    if (!f.endsWith('.ts')) continue;
    if (!f.startsWith('packages/') && !f.startsWith('scripts/')) continue;
    if (f.startsWith(INDEX_EXCLUDE)) continue;
    if (stat !== NO_STAT && !readableSource(raw, stat)) continue;
    let source: string;
    try {
      source = String(read(raw, 'utf8'));
    } catch {
      continue;
    }
    for (const m of source.matchAll(EXPORTED)) {
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
function prefer(all: readonly string[]): readonly string[] {
  if (all.length <= 1) return all;
  const core = all.filter((f) => f.startsWith('packages/core/src/'));
  if (core.length === 0) return all;
  return [...core, ...all.filter((f) => f.startsWith('scripts/'))];
}

/**
 * A clean dotted chain, anchored on both ends and identifier-segmented.
 *
 * `SPEC.md §12` (space) and `⊙ error` never reach it. `response.json()` reaches it only after
 * `bareSymbol` strips the signature, and then fails to resolve because `response` is not an export
 * — which is the correct outcome, not a near miss.
 */
const DOTTED = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;

/**
 * The exported index first; then two fallbacks, in this order, neither of which can change a
 * finding that already exists.
 *
 * **Rule 3 — script names.** `verify` in loops 033 and 034 means the gate command, and
 * `"verify": "bun run scripts/verify.ts"` is a *declared* mapping from that name to a file, written
 * by hand in a committed manifest exactly as `export function verify` would be. Before this, both
 * loops left the token unresolved; loop 034 therefore moved the baselined count by 1 for a reason
 * carrying no information, which is the defect sdlc/035 exists to fix. The RAW token is tried
 * before `bareSymbol`, the opposite of the symbol lookup above, because `bareSymbol` truncates at
 * `:` and would destroy `verify:plain` and `metrics:ship`.
 *
 * **Rule 4 — dotted prefixes.** `MetricEvent.payload` is the token loop 020's fence protects as
 * the product-telemetry security boundary, and it was invisible here: a spec asking to widen the
 * payload while a plan fenced `telemetry.ts` produced silence. Its OWNER is an ordinary top-level
 * export, so resolving `Owner.member` to wherever `Owner` is declared needs no member index at all.
 *
 * Both are fallbacks, deliberately. sdlc/035 measured the alternative — indexing type members — at
 * four new findings across two loops, ALL FOUR false positives, because a bare field name in a
 * heading names the field's behaviour, not the file that declares it. These two rules resolve three
 * tokens across every committed loop and produce zero findings.
 */
function resolveSymbol(token: string, index: SymbolIndex, scripts: ScriptIndex): readonly string[] {
  const direct = index.get(token) ?? index.get(bareSymbol(token)) ?? [];
  if (direct.length > 0) return prefer(direct);

  const bare = bareSymbol(token);
  const script = scripts.get(token) ?? scripts.get(bare);
  if (script !== undefined) return [script];

  if (DOTTED.test(bare)) {
    const owner = index.get(bare.slice(0, bare.indexOf('.')));
    if (owner !== undefined) return prefer(owner);
  }
  return [];
}

/**
 * First path-shaped WORD in a script command. `bun run scripts/verify.ts` -> `scripts/verify.ts`.
 *
 * Whitespace-anchored on both ends, deliberately. The unanchored first version was quadratic: `.` is
 * inside the character class AND the following literal, so a long run of dots with no valid suffix
 * backtracks at every start position — sdlc/035's security pass measured 8.2s on 64 KB and a hang to
 * the 300s step timeout on 1 MB. Not an escalation, since anyone who can edit a `scripts` entry
 * already has code execution in CI, but a gate should not be a CPU sink on input it does not trust.
 */
const SCRIPT_TARGET = /(?:^|\s)([\w./@-]+\.(?:ts|sh|ps1|js))(?=\s|$)/;

/**
 * Root `package.json` script names, mapped to the file each one runs.
 *
 * Only entries whose target is actually TRACKED survive, so a script naming a file that is not in
 * the corpus resolves to nothing rather than inventing a path. `"lint": "oxlint"` and
 * `"build": "bun run --filter …"` name no file and contribute nothing.
 *
 * A missing or malformed manifest yields an EMPTY MAP rather than throwing. A gate that dies on a
 * missing optional input is worse than one that resolves less.
 *
 * The failure direction is safe for the tokens that exist TODAY but is NOT universal, and saying so
 * is the point. `verify` is identifier-shaped, so losing it raises the baselined count and the gate
 * goes red. A HYPHENATED script name would not: `upgrade-all` fails `IDENTIFIER` and lands in
 * `notASymbol`, which is printed and never asserted, so losing it is silent. The same is true of a
 * dotted token if its owner ever stops being a top-level export — including `MetricEvent.payload`,
 * the one this module's own comments call the telemetry security boundary. What actually pins those
 * is the live-tree test that names them (`fence-check.test.ts`, "the two resolution rules still
 * resolve the three tokens they were added for"), not this fallback's direction. Recorded by
 * sdlc/035's security pass, finding 4; a general fix means routing would-have-resolved tokens into
 * `unresolved`, which is a loop of its own.
 */
export function indexScripts(packageJsonText: string, corpus: readonly string[]): ScriptIndex {
  const out = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch {
    return out;
  }
  if (typeof parsed !== 'object' || parsed === null) return out;
  const { scripts } = parsed as Record<string, unknown>;
  // `Array.isArray` matters: an array passes `typeof === 'object'` and would be walked with numeric
  // string keys. Harmless today — `"0"` cannot match an identifier-shaped heading token — but it is
  // unvalidated shape, and this module's house rule is to validate rather than rely on that.
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return out;
  const tracked = new Set(corpus.map(toPosix));
  for (const [name, command] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof command !== 'string') continue;
    const m = SCRIPT_TARGET.exec(command);
    if (m === null) continue;
    // Leading `./` stripped. Two of this repo's own scripts write `./scripts/upgrade-all.ps1`, and
    // `git ls-files` never emits the prefix, so without this they silently never resolve — a gap the
    // first version of the sdlc/035 test encoded as an expectation before the test was run.
    const target = toPosix(m[1]!).replace(/^\.\//, '');
    if (tracked.has(target)) out.set(name, target);
  }
  return out;
}

/**
 * ECMAScript's reserved words. Kept SEPARATE from the type keywords below, rather than merged into
 * one constant, because the claim being made is that the two come from different languages and a
 * merged set makes that unauditable. sdlc/035's spec called this "TypeScript's reserved set" and
 * `any` is not in it — `any` is a contextual type keyword and is a legal identifier.
 */
const RESERVED: ReadonlySet<string> = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if',
  'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'package',
  'private', 'protected', 'public', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true',
  'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]);

/** TypeScript's built-in type keywords. Legal identifiers in ECMAScript; never declarations here. */
const TYPE_KEYWORDS: ReadonlySet<string> = new Set([
  'any', 'bigint', 'boolean', 'never', 'number', 'object', 'string', 'symbol', 'undefined',
  'unknown',
]);

/**
 * The underscore is REQUIRED, and that is a deliberate narrowing.
 *
 * `^[A-Z][A-Z0-9_]*$` — the obvious form — swallows module-private ALLCAPS constants, and four of
 * them live in this very file: `MARKERS`, `HEADING`, `TOKEN`, `EXPORTED`. A heading naming one would
 * be classified "not a symbol" when it is precisely a symbol the index cannot see, which is the
 * silent false negative sdlc/035 exists to remove. The cost is a permanent `+1` for any future
 * heading naming `HOME` or `PATH`; that is the safe direction, because it is visible.
 *
 * Still missed: `PATH_RE` has an underscore and is still called an environment variable. No shape
 * rule separates it from `TMPDIR`. Recorded, not fixed.
 */
const ENV_VAR = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * Which population an unresolved token belongs to, decided by SHAPE and never by a list of specific
 * tokens — a list would need editing every loop, which is the maintenance reflex being removed.
 *
 * Applied to `bareSymbol(token)` throughout: the same string resolution failed on. Otherwise a
 * heading written `XDG_CACHE_HOME: string` would classify differently from one written
 * `XDG_CACHE_HOME`, a distinction its author never meant to draw.
 *
 * Runs only AFTER resolution fails, which is what makes the env-var rule safe at all: an exported
 * `MAX_LINE_BYTES` resolves and never reaches this function.
 */
export function classifyToken(token: string): TokenClass {
  const bare = bareSymbol(token);
  if (ENV_VAR.test(bare)) return 'not-a-symbol';
  if (RESERVED.has(bare) || TYPE_KEYWORDS.has(bare)) return 'not-a-symbol';
  // No separate flag branch. sdlc/035's spec listed one, the plan predicted three test failures for
  // deleting it, and the A10 mutation returned ZERO: a token starting with `-` already fails
  // IDENTIFIER, so `--json` and `--debug` were classified by this line all along. A branch no test
  // can distinguish from its absence is the shape sdlc/032 and sdlc/033 both ruled against, so it is
  // deleted rather than kept as documentation. `classifyToken > a flag is not a symbol` still holds
  // and now exercises this rule, which is what makes it a test instead of a restatement.
  if (!IDENTIFIER.test(bare)) return 'not-a-symbol';
  return 'unresolved';
}

/** Equal to, a basename tail (`snapshot.ts`), or a directory prefix (`packages/metrics`). */
function inFence(file: string, entry: string): boolean {
  const e = entry.replace(/\/\*+$/, '').replace(/\/$/, '');
  if (e === '') return false;
  return file === e || file.endsWith(`/${e}`) || file.startsWith(`${e}/`);
}

/**
 * `scripts` is a REQUIRED parameter, not an optional one with an empty default. There are four call
 * sites in the whole repository, so the churn is trivial, and a required parameter turns "`main`
 * forgot to wire the script map" into a typecheck failure rather than a silently smaller count —
 * the exact failure class sdlc/035 exists to remove.
 *
 * `unresolved` is returned, not swallowed. Zero false positives across twelve loops is easy to
 * achieve by understanding almost nothing, so the check publishes what it could not read: only 28
 * of 50 heading tokens resolve (measured at sdlc/033 Stage 5; the 26-of-47 in that loop's spec.md
 * was the Stage-2 figure, before loop 033's own artifacts became checkable). Type members (`MetricEvent.payload` — the very token loop 020's
 * fence protects as the telemetry security boundary), non-exported symbols, and flags all fall
 * through. Baselining the count turns that silence into a ratcheted number.
 */
export function checkLoop(
  loop: string,
  specMd: string,
  planMd: string,
  index: SymbolIndex,
  rawCorpus: readonly string[],
  scripts: ScriptIndex,
): { findings: Finding[]; unresolved: string[]; notASymbol: string[] } | null {
  const fence = extractFence(planMd);
  if (fence === null) return null;
  const corpus = rawCorpus.map(toPosix);

  const findings: Finding[] = [];
  const unresolved: string[] = [];
  const notASymbol: string[] = [];
  for (const token of new Set(headingTokens(specMd))) {
    const targets = PATH_RE.test(token)
      ? corpus.filter((f) => f === token || f.endsWith(`/${token}`))
      : resolveSymbol(token, index, scripts);
    if (targets.length === 0) {
      (classifyToken(token) === 'unresolved' ? unresolved : notASymbol).push(token);
      continue;
    }
    for (const file of targets) {
      const entry = fence.find((x) => inFence(file, x));
      if (entry !== undefined) findings.push({ loop, specToken: token, file, fenceEntry: entry });
    }
  }
  return { findings, unresolved, notASymbol };
}

export interface Baseline {
  uncheckable: number;
  /**
   * Identifier-shaped heading tokens the index does not know — the `unresolved` class only.
   *
   * RENAMED from `unresolvedTokens` in sdlc/035, and the rename is not cosmetic. The definition
   * changed underneath it: the old number counted flags, environment variables, keywords and
   * expressions alongside real symbols, so it could never go down and had to go up every loop.
   * Keeping the name across that redefinition would make `git log -p` on this file unreadable — a
   * reader would see 25 -> 13 under an unchanged key and be unable to tell whether the check
   * improved or the definition moved. `parseBaseline` rejects a baseline still carrying the old
   * key, so no half-migrated record can pass.
   */
  unresolvedSymbols: number;
  findings: Array<Finding & { note: string }>;
}

export const BASELINE_PATH = 'sdlc/fence-baseline.json';

/** Validated, not `as`-asserted, and never healed — see `lint-budget.ts` for the same reasoning. */
export function parseBaseline(text: string): Baseline {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('fence-check: baseline is not an object');
  const { uncheckable, unresolvedSymbols, findings } = parsed as Record<string, unknown>;
  if (!Number.isInteger(uncheckable) || !Number.isInteger(unresolvedSymbols) || !Array.isArray(findings)) {
    throw new Error('fence-check: baseline is malformed');
  }
  return {
    uncheckable: uncheckable as number,
    unresolvedSymbols: unresolvedSymbols as number,
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
      return {
        loop: scrubControls(loop),
        specToken: scrubControls(specToken),
        file: scrubControls(file),
        fenceEntry: scrubControls(fenceEntry),
        note: scrubControls(note),
      };
    }),
  };
}

/**
 * Record files are skimmed in diff viewers, where a terminal escape is invisible; `compareToBaseline`
 * then echoes these fields straight to stderr. The validators check TYPE, not character class, so a
 * `fenceEntry` containing a raw CSI sequence survived them — sdlc/033's security pass demonstrated
 * it. Scrubbed on parse, which is the same shape as loop 032's control-character rule for
 * `disabledReason`: a positive bound at the boundary, not a blacklist at the printer.
 */
export function scrubControls(v: string): string {
  let out = '';
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    out += c < 0x20 || (c >= 0x7f && c <= 0x9f) ? ' ' : v[i];
  }
  return out;
}

const keyOf = (f: Finding): string => `${f.loop}|${f.specToken}|${f.file}|${f.fenceEntry}`;

/**
 * The four ways this gate fails, extracted from `main` so each one has a test.
 *
 * The first version lived inline in `main`, unexported, and sdlc/033's audit caught that every
 * branch here had ZERO coverage — including the NEW CONTRADICTION message, which is the intent's
 * first done-criterion ("naming both the file and the two artifacts"). A gate whose failure paths
 * have never been executed is loop 032's lesson wearing a new hat.
 *
 * `skipped` is deliberately not a parameter: a loop mid-flight has `spec.md` and no `plan.md`, so
 * asserting it would make `verify` red for the first two commits of every future loop.
 */
export function compareToBaseline(
  actual: { findings: readonly Finding[]; uncheckable: number; unresolved: number },
  baseline: Baseline,
): string[] {
  const problems: string[] = [];
  const known = new Set(baseline.findings.map(keyOf));
  const seen = new Set(actual.findings.map(keyOf));
  for (const f of actual.findings) {
    if (!known.has(keyOf(f))) {
      problems.push(
        `fence-check: NEW CONTRADICTION  ${f.loop}: spec.md requires \`${f.specToken}\` (${f.file}) ` +
          `but plan.md fences \`${f.fenceEntry}\``,
      );
    }
  }
  for (const f of baseline.findings) {
    if (!seen.has(keyOf(f))) {
      problems.push(
        `fence-check: baselined contradiction no longer found — ${f.loop}: ${f.specToken}. ` +
          `Remove it from ${BASELINE_PATH}.`,
      );
    }
  }
  if (actual.uncheckable !== baseline.uncheckable) {
    problems.push(`fence-check: uncheckable is ${actual.uncheckable}, baseline says ${baseline.uncheckable}`);
  }
  if (actual.unresolved !== baseline.unresolvedSymbols) {
    problems.push(
      `fence-check: unresolved symbol-shaped heading tokens is ${actual.unresolved}, ` +
        `baseline says ${baseline.unresolvedSymbols}`,
    );
  }
  return problems;
}

/**
 * The manifest read, bounded — the diff's only new file read, and sdlc/035's security pass flagged
 * that it bypassed the guard the rest of this module goes through.
 *
 * `statSync`, NOT the `lstatSync` in `readableSource`, and the difference is deliberate. There the
 * path comes from `git ls-files`, so a repository file's NAME decides what is read and a symlink is
 * a redirection attack — refused. Here the path is a fixed constant, nothing chooses it, and a
 * monorepo that symlinks its manifest is a legitimate setup that should not turn the gate red with a
 * baffling count mismatch. What is still refused is a non-regular TARGET: `/dev/zero` is a character
 * device, so `isFile()` is false and the unbounded read that killed the gate in sdlc/033 cannot
 * happen. The size cap is the same 1 MiB.
 *
 * Returns `''` on anything unreadable, including the TOCTOU window between the check and the read.
 * `indexScripts` turns that into an empty map, whose consequences its own docstring states.
 *
 * Exported, and taking `stat`/`read` as parameters, for the reason `scripts/spool-path.ts` states at
 * length: a guard whose absence no test can detect is not a guard. The first version read a fixed
 * path through the ambient `fs`, and the A10 mutation deleting the guard produced ZERO failures —
 * the same shape as sdlc/034's A7, caught here before it shipped rather than after.
 */
export function readManifest(
  path = 'package.json',
  stat: (p: string) => { isFile: () => boolean; size: number } = statSync,
  read: (p: string, enc: 'utf8') => string = readFileSync,
): string {
  try {
    const st = stat(path);
    if (!st.isFile() || st.size > MAX_INDEXED_BYTES) return '';
    return read(path, 'utf8');
  } catch {
    return '';
  }
}

export async function gitFiles(): Promise<string[]> {
  const proc = Bun.spawn(['git', 'ls-files'], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.split('\n').filter(Boolean).map(toPosix);
}

async function main(): Promise<number> {
  const corpus = await gitFiles();
  const index = buildIndex(corpus);
  const scripts = indexScripts(readManifest(), corpus);

  const findings: Finding[] = [];
  const unresolved: string[] = [];
  const notASymbol: string[] = [];
  let uncheckable = 0;
  let checkable = 0;
  let skipped = 0;

  if (!existsSync('sdlc')) {
    console.error('fence-check: no `sdlc/` directory here — run me from the repository root.');
    return 1;
  }

  for (const loop of readdirSync('sdlc').filter((d) => /^\d{3}-/.test(d)).toSorted()) {
    const spec = `sdlc/${loop}/spec.md`;
    const plan = `sdlc/${loop}/plan.md`;
    if (!existsSync(spec) || !existsSync(plan)) {
      skipped += 1;
      continue;
    }
    const res = checkLoop(loop, readFileSync(spec, 'utf8'), readFileSync(plan, 'utf8'), index, corpus, scripts);
    if (res === null) {
      uncheckable += 1;
      continue;
    }
    checkable += 1;
    findings.push(...res.findings);
    unresolved.push(...res.unresolved.map((t) => `${loop}: ${t}`));
    notASymbol.push(...res.notASymbol.map((t) => `${loop}: ${t}`));
  }

  // Printed whether or not the run fails: the next loop that writes a heading this check cannot
  // read should show up as a delta, not as silence.
  console.log(`fence-check: ${checkable} checkable, ${uncheckable} uncheckable, ${skipped} skipped`);
  console.log(
    `fence-check: ${unresolved.length} unresolved symbol-shaped heading tokens, ` +
      `${notASymbol.length} not symbols at all`,
  );
  for (const u of unresolved) console.log(`  unresolved   ${u}`);
  // Printed, never asserted. This number is EXPECTED to rise with every loop that writes a heading
  // naming a flag or an environment variable, which is precisely why it must not be a gate.
  for (const n of notASymbol) console.log(`  not-a-symbol ${n}`);
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

  const problems = compareToBaseline({ findings, uncheckable, unresolved: unresolved.length }, baseline);
  if (problems.length === 0) return 0;
  console.error('');
  for (const p of problems) console.error(p);
  return 1;
}

if (import.meta.main) process.exit(await main());
