#!/usr/bin/env bun
/**
 * Evaluate the control bounds and, on a breach, draft an incident and its follow-up intent.
 *
 * Writes files and STOPS. It does not git add, commit, push, or open anything. An autonomous
 * loop that files its own tickets unattended is a loop that generates work for itself with
 * nobody ever seeing why. The drafts are picked up by the next iteration and reviewed like
 * any other artifact.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { MetricsStore, defaultDbPath } from './store.js';
import { detect, BOUNDS, formatBaseline, type Anomaly, type Suppression, formatFreshness } from './anomaly.js';
import { collectDetectorInput } from './detector-input.js';

const repoRoot = process.env.CLAUDEWATCH_REPO ?? process.cwd();
const sdlcDir = join(repoRoot, 'sdlc');
const suppressionPath =
  process.env.CLAUDEWATCH_SUPPRESSIONS ?? join(dirname(defaultDbPath()), 'suppressions.json');

function readSuppressions(): Suppression[] {
  // Machine state, not project state — deliberately not in the repo, or two machines would
  // disagree about what has been raised. Corrupt or missing is empty, never a hard failure:
  // suppression state must not be able to block detection.
  try {
    const parsed: unknown = JSON.parse(readFileSync(suppressionPath, 'utf-8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is Suppression =>
        s !== null && typeof s === 'object' &&
        typeof (s as Suppression).fingerprint === 'string' &&
        typeof (s as Suppression).raisedAt === 'string',
    );
  } catch {
    return [];
  }
}

function writeSuppressions(list: Suppression[]): void {
  try {
    mkdirSync(dirname(suppressionPath), { recursive: true, mode: 0o700 });
    const tmp = `${suppressionPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
    renameSync(tmp, suppressionPath);
  } catch {
    // Failing to persist suppression means a duplicate next hour, which is noise — not a
    // reason to fail the run that already produced a useful draft.
  }
}

function nextId(): string {
  let max = 0;
  try {
    for (const name of readdirSync(sdlcDir)) {
      const m = /^(\d{3})-/.exec(name);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch { /* no sdlc dir yet */ }
  return String(max + 1).padStart(3, '0');
}

const slugs: Record<string, string> = {
  verify_duration_outlier: 'verify-duration-outlier',
  verify_pass_rate: 'verify-pass-rate',
  schema_drift_spike: 'schema-drift-spike',
  fetch_failure_rate: 'fetch-failure-rate',
};

function evidenceTable(a: Anomaly): string {
  return Object.entries(a.evidence)
    .map(([k, v]) => `| \`${k}\` | ${String(v)} |`)
    .join('\n');
}

function draft(a: Anomaly, id: string, now: Date): { dir: string; files: string[] } {
  const slug = `${id}-${slugs[a.kind] ?? a.kind}`;
  const dir = join(sdlcDir, slug);
  mkdirSync(dir, { recursive: true });

  const stamp = now.toISOString().replace('T', ' ').slice(0, 16);

  writeFileSync(join(dir, 'incident.md'), `# Incident: ${a.summary}

- **ID:** ${slug}
- **Stage:** 6 — Maintain
- **Status:** open — **drafted automatically, not yet reviewed**
- **Detected:** ${stamp} UTC — by the control bounds in \`packages/metrics/src/anomaly.ts\`
- **Severity:** ${a.severity}
- **Fingerprint:** \`${a.fingerprint}\`

> Drafted by \`bun run metrics:detect\`. Nothing here has been verified by a human or by a
> later run. **Treat every line below as a claim to check, not a finding.** The detector knows
> only what the metrics store contains; it has not read the code, the diff, or the logs.

## What triggered it

${a.summary}

| Evidence | Value |
|---|---|
${evidenceTable(a)}

## What happened

*To be filled in by whoever picks this up.* The detector observed the numbers above and
nothing else. What the user saw, whether anyone saw anything, and whether this reflects a real
defect are all open.

## Impact

*Unknown at drafting time.*

## Root cause

*Not diagnosed.* Resist writing the cause you suspect before opening the code — this
repository has recorded three separate occasions where the first theory was wrong
(\`sdlc/004\`, \`sdlc/005\`, and the 2026-08-26 test-bound corrections in \`sdlc/README.md\`).

## Follow-up

| Follow-up | New intent ID | Status |
|---|---|---|
| Confirm or dismiss this anomaly, then act | [\`${id}\`](./intent.md) | drafted |

## If this is a false positive

Say so here and tune the bound in \`BOUNDS\` (\`packages/metrics/src/anomaly.ts\`) with a test
covering **both sides** of the new threshold. Do not silence the detector without changing the
bound — an unexplained suppression is how monitoring dies quietly.
`);

  writeFileSync(join(dir, 'intent.md'), `# Intent: investigate ${a.summary}

- **ID:** ${slug}
- **Stage:** 1 — Plan
- **Status:** draft — **derived automatically from an incident**
- **Source:** [\`incident.md\`](./incident.md)

> This is the Maintain → Plan edge, traversed without a human present. It is a **starting
> point**, not an accepted intent. The first job of whoever picks it up is to decide whether
> there is a real problem here at all.

## Problem

The control bounds observed: ${a.summary}

That is a statement about metrics, not about the product. Whether it reflects a defect worth
fixing is the open question.

## What "done" means

- [ ] The anomaly is confirmed as a real defect, or dismissed with a reason
- [ ] If real: root cause established by reading code and reproducing, not by inference
- [ ] If a false positive: the bound is tuned, with a test covering both sides of it

## Explicitly out of scope

Anything the evidence does not actually support. The detector saw numbers; it did not see a
cause.

---

**Next stage:** Design — but only after the problem above is confirmed to exist.
`);

  return { dir, files: ['incident.md', 'intent.md'] };
}

// --- run ---

const store = new MetricsStore(process.env.CLAUDEWATCH_METRICS_DB ?? defaultDbPath());
const now = Date.now();
const events = collectDetectorInput(store, now);
const result = detect(events, now, readSuppressions());

// ABOVE the insufficient-data exit, deliberately. `cli-detect` returns and exits at the branch
// below, before `formatBaseline` and the suppression lines, so a line printed after it would be
// missing from exactly the case a broken pipeline lands in first.
//
// Printed on every verdict and asserted on none of them. sdlc/037's B4: a staleness THRESHOLD would
// have to encode a claim about whether someone's machine ought to be on, which is not a fact the
// detector has. The age is; a human can apply the judgement they actually possess.
console.log(formatFreshness(result.freshness));

if (result.status === 'insufficient-data') {
  console.log(`insufficient data: ${result.have} verify runs, need ${result.need}. No verdict.`);
  store.close();
  process.exit(0);
}

if (result.durationBaseline) {
  // Print the instrument's own sensitivity, not just its verdict. The defect this loop fixed
  // was invisible precisely because `healthy` printed while the baseline quietly narrowed.
  console.log(formatBaseline(result.durationBaseline));
}

for (const s of result.suppressed) {
  console.log(`suppressed (raised within ${BOUNDS.suppressionHours}h): ${s.fingerprint}`);
}

if (result.status === 'healthy') {
  console.log(`healthy: ${result.evaluated} verify runs evaluated, no bounds breached.`);
  store.close();
  process.exit(0);
}

console.log(`${result.anomalies.length} anomaly(ies) over ${result.evaluated} verify runs:\n`);
const suppressions = readSuppressions();
let id = Number(nextId());

for (const a of result.anomalies) {
  const { dir, files } = draft(a, String(id).padStart(3, '0'), new Date(now));
  id++;
  suppressions.push({ fingerprint: a.fingerprint, raisedAt: new Date(now).toISOString() });
  console.log(`  [${a.severity}] ${a.summary}`);
  console.log(`    drafted ${files.join(', ')} in ${dir}`);
}

writeSuppressions(suppressions);
console.log(`\nDrafts written. Nothing committed — review them before acting.`);
store.close();
process.exit(0);
