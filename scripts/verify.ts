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
// MAX_LINE_BYTES comes from junit.ts, NOT from packages/core, even though the constant lives
// there too. A syntax error in core would make that import fail and the gate would never start:
// no step runs, no `verify_run` event is written, and the failure surfaces as a raw Bun stack
// trace instead of `verify: fail [typecheck]`. Losing the record in exactly the case the record
// exists for is worse than duplicating a number, and `junit.test.ts` asserts the two agree.
// (sdlc/020)
import { readJunitReport, attachFailures, tightenMode, MAX_LINE_BYTES, type TestFailureRecord } from './junit.js';
import { shouldRecordVerifyMetrics } from './env.js';

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

function spoolPath(): string {
  return join(homedir(), '.cache', 'claudewatch', 'metrics-spool.jsonl');
}

/**
 * Records a `verify_run` event, if the machine has opted in.
 *
 * The comment this replaces claimed these metrics needed no consent gate, justified by a payload
 * holding nothing but step durations. `sdlc/020` made that false:
 * the payload now carries repo-relative source paths, test names and describe chains — a
 * description of someone's repository at the moment their tests were failing. Still not user
 * data, but no longer nothing.
 *
 * So it is off unless `CLAUDEWATCH_VERIFY_METRICS` says otherwise. The systemd unit driving the
 * hourly loop sets it explicitly, so the continuous series is unaffected. See sdlc/021.
 *
 * Product telemetry, which does concern a user, remains separately opt-in and off by default.
 */
function record(
  steps: StepResult[],
  totalMs: number,
  outcome: string,
  failedStep: string | null,
  testFailures: TestFailureRecord | null,
): void {
  // FIRST statement, before the mkdirSync below. A guard next to appendFileSync would still
  // create ~/.cache/claudewatch on a machine that opted out — the directory is an observable
  // side effect, not just the file.
  if (!shouldRecordVerifyMetrics(process.env)) return;

  try {
    // Widened from `string | number | boolean | null` to admit `failedTests`. Only THIS local
    // annotation moves: `packages/core`'s MetricEvent.payload stays as it was, because
    // telemetry.ts calls it the security boundary for product telemetry and this is a dev-loop
    // process metric. SPEC.md §17 carries the amendment that permits repo-relative paths and
    // test identifiers on `source: 'sdlc'` events only.
    const payload: Record<string, unknown> = {
      outcome,
      failedStep,
      stepCount: steps.length,
    };
    for (const s of steps) payload[`${s.name}Ms`] = s.durationMs;

    const wrap = (p: Record<string, unknown>) => ({
      eventId: EVENT_ID,
      ts: TS,
      source: 'sdlc',
      kind: 'verify_run',
      ok: outcome === 'pass',
      durationMs: totalMs,
      schemaVersion: 1,
      payload: p,
    });

    // Bounded by BYTES, not entry count. This spool is the same file product telemetry appends
    // to, so a line over MAX_LINE_BYTES breaks single-write append atomicity and can interleave
    // into corrupt JSONL. Twenty realistic entries exceed the cap, so the case is reachable.
    const event = wrap(attachFailures(payload, testFailures, wrap, MAX_LINE_BYTES));

    const dir = join(homedir(), '.cache', 'claudewatch');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      if (statSync(spoolPath()).size >= 5 * 1024 * 1024) return;
    } catch { /* first append */ }
    const line = `${JSON.stringify(event)}\n`;

    // The last guard, mirroring `emit` in packages/core/src/telemetry.ts:179. `boundBySizeTight`
    // gives up and returns [] once even one entry overflows, and it does NOT re-measure the
    // zero-entry event — so an oversized base payload would otherwise be appended unbounded.
    // The base is program-controlled (~250 bytes) so this is unreachable today, which is exactly
    // why it needs a check rather than an argument: the invariant should hold by construction,
    // not by arithmetic that a future field could silently invalidate. This spool is shared with
    // product telemetry, and a line over PIPE_BUF breaks single-write append atomicity.
    // (sdlc/020 security pass, S6.)
    if (Buffer.byteLength(line, 'utf-8') > MAX_LINE_BYTES) return;

    appendFileSync(spoolPath(), line, { mode: 0o600 });
  } catch {
    // Recording a metric must never be the reason the gate fails.
  }
}

const EVENT_ID = crypto.randomUUID();
const TS = new Date().toISOString();

const startedAll = Bun.nanoseconds();
const results: StepResult[] = [];
let exitCode = 0;
let failedStep: string | null = null;
let outcome: 'pass' | 'fail' | 'timeout' = 'pass';

// Outside the repo, so a stray file can never be picked up as a test or committed.
//
// The 0700 directory is what actually protects the report: BUN creates the file, and creates it
// 0644 (verified with `stat`). An earlier version of this comment claimed 0600, and a test
// "confirmed" it by chmodding a file of its own — a green check on something the code never did.
// `tightenMode` below makes the claim true instead of asserting it. (sdlc/020 audit)
const junitDir = mkdtempSync(join(tmpdir(), 'claudewatch-verify-'));
const junitPath = join(junitDir, 'report.xml');
let testFailures: TestFailureRecord | null = null;

try {
  for (const step of STEPS) {
    const result = await runStep(step.name, step.cmd, step.junit ? junitPath : undefined);
    // Unconditionally, not only when the step failed. Bun writes the report 0644 and it lists
    // every test name in the suite, so a PASSING run — including one that opted out of recording
    // entirely — was leaving a world-readable file until the `finally` removed it. Contained by
    // the 0700 parent, but the narrower mode costs nothing. (sdlc/021 security pass, S8.)
    if (step.junit) tightenMode(junitPath);
    results.push(result);

    if (result.outcome !== 'pass') {
      failedStep = result.name;
      outcome = result.outcome;
      // Passthrough. A timeout has no exit code of its own, so use 124 as `timeout(1)` does.
      exitCode = result.outcome === 'timeout' ? 124 : (result.exitCode ?? 1);

      if (step.junit) {
        testFailures = readJunitReport(junitPath, process.cwd(), p => readFileSync(p, 'utf-8'), existsSync);
      }

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
