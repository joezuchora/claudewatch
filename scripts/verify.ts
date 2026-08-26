#!/usr/bin/env bun
/**
 * The verification gate, instrumented.
 *
 * This IS `bun run verify`. An earlier design put instrumentation behind an opt-in
 * `verify:metrics`, which would have meant the runs that hang were exactly the runs nobody
 * remembered to instrument — defeating the reason for building it. `verify:plain` remains
 * available for anyone who wants the bare chain.
 *
 * Exit-code passthrough is exact: this must not change what the gate means.
 *
 * Each step carries a timeout so that a hang is RECORDED rather than hanging the terminal
 * forever. That recording is the entire point — the hang is intermittent, environment
 * specific, and invisible to CI, so it can only be characterised by capturing every run.
 */
import { spawn } from 'child_process';
import { appendFileSync, mkdirSync, statSync, mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { parseJunitFailures, boundBySize, MAX_LINE_BYTES, type FailedTest } from './junit.js';

/**
 * Deliberately NOT imported from `packages/core`, even though the constant lives there too.
 *
 * A syntax error in core would make this import fail, and then the gate never starts: no step
 * runs, no `verify_run` event is written, and the failure surfaces as a raw Bun stack trace
 * instead of `verify: fail [typecheck]`. Losing the record in exactly the case the record exists
 * for is worse than duplicating a number. `junit.test.ts` asserts the two agree. (sdlc/020)
 */

interface StepResult {
  name: string;
  durationMs: number;
  exitCode: number | null;
  outcome: 'pass' | 'fail' | 'timeout';
}

const STEPS: Array<{ name: string; cmd: string[]; junit?: boolean }> = [
  { name: 'typecheck', cmd: ['bun', 'run', 'typecheck'] },
  { name: 'lint', cmd: ['bun', 'run', 'lint'] },
  // `junit: true` makes runStep append --reporter=junit --reporter-outfile=<temp>. The report
  // names WHICH test failed; before sdlc/020 the spool recorded only that this step did.
  { name: 'test', cmd: ['bun', 'test'], junit: true },
  { name: 'build', cmd: ['bun', 'run', 'build'] },
  // MUST stay after `build` — it measures the binary that step produces. A future reordering
  // breaks this in a way typecheck cannot see.
  //
  // n=40 supports a median comfortably and a tail not at all, so `evaluate` declines the p95
  // verdict on its own and prints that it declined. No suppression flag: a gate that says
  // "p95: not evaluated (n<200)" is more honest than one that silently omits the line, and it
  // exercises the full verdict path rather than a special case. See sdlc/013.
  // REPORT-ONLY since sdlc/015. The step measures and prints on every run — that visibility is
  // what makes a drift noticeable — but it does not fail the gate. The machine's startup floor
  // moved 41ms -> 57ms between two sessions with no code change and a load average of 0.5,
  // which is larger than the p50 budget's 1.22x margin. A gate that goes red because the host
  // got slower teaches everyone to ignore it. The enforcing verdict is `bun run perf`.
  { name: 'perf', cmd: ['bun', 'run', 'perf', '--samples', '40', '--report-only'] },
];

/** Per-step ceiling. Generous versus a ~35s healthy run, tight enough to bound a hang. */
const STEP_TIMEOUT_MS = Number(process.env.CLAUDEWATCH_VERIFY_TIMEOUT_MS ?? 300_000);

function runStep(name: string, cmd: string[], junitOutfile?: string): Promise<StepResult> {
  return new Promise((resolve) => {
    const started = Bun.nanoseconds();
    // Console output is unchanged by these flags — verified by diffing full-suite output with
    // and without them. The reporter writes the XML in addition to, not instead of, stdout.
    const argv = junitOutfile
      ? [...cmd.slice(1), '--reporter=junit', `--reporter-outfile=${junitOutfile}`]
      : cmd.slice(1);
    const child = spawn(cmd[0]!, argv, { stdio: 'inherit' });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, STEP_TIMEOUT_MS);

    child.on('exit', (code) => {
      clearTimeout(timer);
      const durationMs = Math.round((Bun.nanoseconds() - started) / 1e6);
      resolve({
        name,
        durationMs,
        exitCode: code,
        outcome: timedOut ? 'timeout' : code === 0 ? 'pass' : 'fail',
      });
    });

    child.on('error', () => {
      clearTimeout(timer);
      const durationMs = Math.round((Bun.nanoseconds() - started) / 1e6);
      resolve({ name, durationMs, exitCode: 127, outcome: 'fail' });
    });
  });
}

/**
 * Read and parse the junit report, if there is one.
 *
 * A SIGKILLed step leaves NO file: bun writes the report once, at end of run. So a timeout
 * yields `'absent'` and an empty list — this change cannot name the test in a hanging suite, and
 * says so rather than implying otherwise. See sdlc/020's "What this cannot do".
 */
function readJunit(path: string): TestFailureRecord {
  if (!existsSync(path)) return { failures: [], total: 0, outfile: 'absent' };
  let xml: string;
  try {
    xml = readFileSync(path, 'utf-8');
  } catch {
    return { failures: [], total: 0, outfile: 'absent' };
  }
  const failures = parseJunitFailures(xml, process.cwd());
  if (failures.length === 0 && !xml.includes('<testsuites')) {
    return { failures: [], total: 0, outfile: 'unparseable' };
  }
  return { failures, total: failures.length, outfile: 'present' };
}

function spoolPath(): string {
  return join(homedir(), '.cache', 'claudewatch', 'metrics-spool.jsonl');
}

/**
 * SDLC process metrics are always recorded. They contain no user data, never run in a
 * shipped artifact, and are written to a local file — so they need no consent gate. Product
 * telemetry, which does concern a user, remains opt-in and off by default.
 */
function record(
  steps: StepResult[],
  totalMs: number,
  outcome: string,
  failedStep: string | null,
  testFailures: TestFailureRecord | null,
): void {
  try {
    // Widened from `string | number | boolean | null` to admit `failedTests`. Only THIS local
    // annotation moves: `packages/core`'s MetricEvent.payload stays as it was, because
    // telemetry.ts calls it the security boundary for product telemetry and this is a dev-loop
    // process metric. SPEC.md §17 carries the amendment that permits repo-relative paths and
    // test identifiers on `source: 'sdlc'` events only.
    const payload: Record<string, string | number | boolean | null | FailedTest[]> = {
      outcome,
      failedStep,
      stepCount: steps.length,
    };
    for (const s of steps) payload[`${s.name}Ms`] = s.durationMs;

    const build = (kept: FailedTest[]) => {
      const p = { ...payload };
      if (testFailures) {
        p.failedTests = kept;
        p.failedTestCount = testFailures.total;
        p.junitOutfile = testFailures.outfile;
      }
      return {
        eventId: EVENT_ID,
        ts: TS,
        source: 'sdlc',
        kind: 'verify_run',
        ok: outcome === 'pass',
        durationMs: totalMs,
        schemaVersion: 1,
        payload: p,
      };
    };

    // Bounded by BYTES, not entry count. This spool is the same file product telemetry appends
    // to, so a line over MAX_LINE_BYTES breaks single-write append atomicity and can interleave
    // into corrupt JSONL. 20 realistic entries measure 5078 bytes, so the case is reachable.
    const kept = testFailures ? boundBySize(testFailures.failures, build, MAX_LINE_BYTES) : [];
    const event = build(kept);

    const dir = join(homedir(), '.cache', 'claudewatch');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      if (statSync(spoolPath()).size >= 5 * 1024 * 1024) return;
    } catch { /* first append */ }
    appendFileSync(spoolPath(), `${JSON.stringify(event)}\n`, { mode: 0o600 });
  } catch {
    // Recording a metric must never be the reason the gate fails.
  }
}

const EVENT_ID = crypto.randomUUID();
const TS = new Date().toISOString();

/** What the junit report yielded for a failing `test` step. Absent when the step passed. */
interface TestFailureRecord {
  failures: FailedTest[];
  total: number;
  outfile: 'present' | 'absent' | 'unparseable';
}

const startedAll = Bun.nanoseconds();
const results: StepResult[] = [];
let exitCode = 0;
let failedStep: string | null = null;
let outcome: 'pass' | 'fail' | 'timeout' = 'pass';

// Outside the repo, so a stray file can never be picked up as a test or committed. 0600 so a
// survivor after a kill is not world-readable — it lists every test name in the suite.
const junitDir = mkdtempSync(join(tmpdir(), 'claudewatch-verify-'));
const junitPath = join(junitDir, 'report.xml');
let testFailures: TestFailureRecord | null = null;

try {
  for (const step of STEPS) {
    const result = await runStep(step.name, step.cmd, step.junit ? junitPath : undefined);
    results.push(result);

    if (result.outcome !== 'pass') {
      failedStep = result.name;
      outcome = result.outcome;
      // Passthrough. A timeout has no exit code of its own, so use 124 as `timeout(1)` does.
      exitCode = result.outcome === 'timeout' ? 124 : (result.exitCode ?? 1);

      if (step.junit) testFailures = readJunit(junitPath);

      break; // short-circuit, so the first failure is the one reported
    }
  }
} finally {
  rmSync(junitDir, { recursive: true, force: true });
}

const totalMs = Math.round((Bun.nanoseconds() - startedAll) / 1e6);
record(results, totalMs, outcome, failedStep, testFailures);

const summary = results.map((r) => `${r.name} ${(r.durationMs / 1000).toFixed(1)}s`).join('  ');
console.log(`\nverify: ${outcome} in ${(totalMs / 1000).toFixed(1)}s  [${summary}]`);
if (outcome === 'timeout') {
  console.log(`verify: step '${failedStep}' exceeded ${STEP_TIMEOUT_MS}ms and was killed.`);
}

process.exit(exitCode);
