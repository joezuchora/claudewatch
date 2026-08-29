/**
 * Tests for `deploy/lib/env-file.sh` — the writer for the metrics environment file, which
 * under `--lan` holds a bearer token. (sdlc/038)
 *
 * The thing worth understanding before editing this file: **asserting the env file's final
 * mode does not test anything.** The pre-change code ended at `0600` too, because it ran
 * `chmod 600` immediately after creating a world-readable file. The defect was the interval,
 * not the destination. So the mode is observed at creation, by putting a stub `chmod` earlier
 * on `PATH` that records what the file looked like before delegating to the real one.
 *
 * `the recorder catches the pre-change form` is what keeps that honest: it runs the four
 * original lines, verbatim, through the same recorder and requires them to be caught. If
 * interposition ever silently stops working — a stub no longer found, a `chmod` call that
 * moved — that test fails instead of leaving the others asserting against an empty log.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO = resolve(import.meta.dir, '..');
const LIB = join(REPO, 'deploy', 'lib', 'env-file.sh');
const INSTALLER = join(REPO, 'deploy', 'install-nuc.sh');

/** Mode of a path as the three-digit string `stat -c %a` would print. */
function mode(path: string): string {
  return (statSync(path).mode & 0o7777).toString(8).padStart(3, '0');
}

interface RunOpts {
  /** Ambient umask for the child. Pinned on every run: a developer's own umask must not
   *  decide whether a test passes. Under `umask 077` an unfixed `mkdir` already yields 0700
   *  and an unfixed write already yields 0600, so an unpinned umask silently disarms the
   *  suite on exactly the machines most likely to run it. */
  umask?: string;
  /** Interpose a recording `chmod` on PATH. */
  observe?: boolean;
  /** Run the child under `bash -x`. */
  xtrace?: boolean;
  /** Run without `set -euo pipefail`, to prove the library does not rely on the caller's
   *  shell options for its own error handling. */
  bareShell?: boolean;
  /** Extra shell sourced before the snippet — used to shadow a command with a failing stub. */
  preamble?: string;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  /** `<mode> <path>` pairs seen by the stub `chmod`, in call order. Empty unless `observe`. */
  observed: string[];
}

/**
 * Run a bash snippet with the library sourced, in a sandbox, with the real environment
 * stripped.
 *
 * `env -i` is not tidiness: it makes `$HOME` *unreachable* rather than merely unreferenced,
 * so a library that grew a `~/.config` fallback could not quietly write to the real one and
 * still pass. The sandbox is passed as an explicit absolute argument every time.
 */
function run(sb: string, snippet: string, opts: RunOpts = {}): RunResult {
  const bin = join(sb, 'bin');
  const observedFile = join(sb, 'observed.log');

  if (opts.observe) {
    mkdirSync(bin, { recursive: true });
    // Records the mode the target has *before* the real chmod changes it. Records the path
    // too: the directory's chmod goes through this same stub, and position alone would not
    // say which line belongs to the file.
    writeFileSync(
      join(bin, 'chmod'),
      ['#!/bin/bash', 'for f in "$@"; do', '  [ -e "$f" ] && /usr/bin/stat -c "%a %n" "$f" >> "$OBSERVED"', 'done', 'exec /bin/chmod "$@"', ''].join('\n'),
      { mode: 0o755 },
    );
  }

  const script = [
    `umask ${opts.umask ?? '022'}`,
    opts.bareShell ? '' : 'set -euo pipefail',
    opts.preamble ?? '',
    `. ${JSON.stringify(LIB)}`,
    snippet,
  ].join('\n');

  const proc = spawnSync(
    'env',
    [
      '-i',
      `HOME=${join(sb, 'unused-home')}`,
      `PATH=${opts.observe ? `${bin}:` : ''}/usr/bin:/bin`,
      `OBSERVED=${observedFile}`,
      'bash',
      ...(opts.xtrace ? ['-x'] : []),
      '-c',
      script,
    ],
    { encoding: 'utf-8' },
  );

  return {
    status: proc.status ?? -1,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
    observed: existsSync(observedFile)
      ? readFileSync(observedFile, 'utf-8').split('\n').filter((l) => l.length > 0)
      : [],
  };
}

function sandbox(): { sb: string; envFile: string; configDir: string; parent: string } {
  const sb = mkdtempSync(join(tmpdir(), 'cw-envfile-'));
  const parent = join(sb, '.config');
  const configDir = join(parent, 'claudewatch');
  return { sb, envFile: join(configDir, 'metrics.env'), configDir, parent };
}

const call = (envFile: string, lan: string) =>
  `claudewatch_write_env_file ${JSON.stringify(envFile)} ${JSON.stringify(lan)}`;

/** The four lines this loop replaced, verbatim, frozen as a fixture. Not live code — it
 *  exists so the recorder can be shown catching the defect it was built to catch. */
const PRE_CHANGE_FORM = `
ENV_FILE="$1"
LAN=1
mkdir -p "$(dirname "$ENV_FILE")"
{
  echo "# ClaudeWatch metrics configuration."
  echo "CLAUDEWATCH_METRICS_ENDPOINT=http://127.0.0.1:8787"
  TOKEN="$(head -c 48 /dev/urandom | base64 | tr -d '/+=' | head -c 48)"
  echo "CLAUDEWATCH_METRICS_HOST=0.0.0.0"
  echo "CLAUDEWATCH_METRICS_TOKEN=$TOKEN"
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
`;

describe('creation mode', () => {
  test('creates the env file at 0600 even under umask 000', () => {
    const { sb, envFile, configDir } = sandbox();
    const r = run(sb, call(envFile, '1'), { umask: '000', observe: true });

    expect(r.status).toBe(0);
    // The directory also passes through the stub, and under `umask 000` it is legitimately
    // 777 when its own chmod reaches it — that window closes before the env file exists, so
    // it is not part of the claim. Everything that is not the directory is a file holding the
    // secret, and every one of those must already be 0600.
    const fileLines = r.observed.filter((line) => !line.endsWith(` ${configDir}`));
    expect(fileLines.length).toBeGreaterThan(0);
    expect(fileLines.filter((line) => !line.startsWith('600 '))).toEqual([]);
    // The 0600 belongs to the env file or the temp file it is renamed from, not to something
    // incidental that happened to be chmodded.
    expect(fileLines.some((line) => line.includes('.metrics.env.') || line.endsWith(` ${envFile}`))).toBe(true);
    expect(mode(envFile)).toBe('600');
  });

  test('the recorder catches the pre-change form', () => {
    // Two assertions, one test, on purpose: deleting either half is visible in the diff.
    // If this ever passes trivially, the test above is asserting against nothing.
    const a = sandbox();
    const broken = run(a.sb, PRE_CHANGE_FORM, { umask: '000', observe: true, preamble: `set -- ${JSON.stringify(a.envFile)}` });
    const brokenModes = broken.observed.map((l) => l.split(' ')[0]);
    expect(brokenModes).toContain('666');
    // The pre-change form ends at 0600 all the same — which is exactly why the final mode is
    // not the thing to assert.
    expect(mode(a.envFile)).toBe('600');

    const b = sandbox();
    const fixed = run(b.sb, call(b.envFile, '1'), { umask: '000', observe: true });
    const fixedModes = fixed.observed.map((l) => l.split(' ')[0]);
    expect(fixedModes).not.toContain('666');
  });

  test('the config directory ends up 0700', () => {
    const { sb, envFile, configDir } = sandbox();
    expect(run(sb, call(envFile, '0'), { umask: '022' }).status).toBe(0);
    expect(mode(configDir)).toBe('700');
  });

  test('the parent directory is not tightened as collateral', () => {
    const { sb, envFile, parent } = sandbox();
    // The parent must NOT exist beforehand: `umask 077; mkdir -p` only locks a directory it
    // creates, so pre-creating it would let the shortcut implementation pass this test.
    expect(existsSync(parent)).toBe(false);
    expect(run(sb, call(envFile, '0'), { umask: '022' }).status).toBe(0);
    expect(mode(parent)).not.toBe('700');
  });

  test('a pre-existing parent keeps its own mode', () => {
    const { sb, envFile, parent, configDir } = sandbox();
    mkdirSync(parent, { recursive: true });
    chmodSync(parent, 0o755);
    expect(run(sb, call(envFile, '0'), { umask: '022' }).status).toBe(0);
    expect(mode(parent)).toBe('755');
    expect(mode(configDir)).toBe('700');
  });
});

describe('the token', () => {
  test('the generated token appears in no output stream', () => {
    const { sb, envFile } = sandbox();
    const r = run(sb, call(envFile, '1'), { umask: '022' });
    expect(r.status).toBe(0);

    const token = /^CLAUDEWATCH_METRICS_TOKEN=(.+)$/m.exec(readFileSync(envFile, 'utf-8'))?.[1] ?? '';
    // Assert the token was really found before asserting its absence. `not.toContain('')` is
    // trivially true, so a read-back that quietly missed would turn this into a green test
    // over a leak.
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(r.stdout).not.toContain(token);
    expect(r.stderr).not.toContain(token);
  });

  test('the token does not leak under bash -x', () => {
    const { sb, envFile } = sandbox();
    const r = run(sb, call(envFile, '1'), { umask: '022', xtrace: true });
    expect(r.status).toBe(0);

    const token = /^CLAUDEWATCH_METRICS_TOKEN=(.+)$/m.exec(readFileSync(envFile, 'utf-8'))?.[1] ?? '';
    expect(token.length).toBeGreaterThanOrEqual(32);
    // xtrace prints the argv of every command it runs, so this covers the "never a process
    // argument" half of the claim as well as the "never in debug output" half.
    expect(r.stderr).not.toContain(token);
    // The trace really did run — otherwise the assertion above proves nothing.
    expect(r.stderr).toContain('+');
  });

  test('loopback writes neither host nor token', () => {
    const { sb, envFile } = sandbox();
    expect(run(sb, call(envFile, '0'), { umask: '022' }).status).toBe(0);
    const text = readFileSync(envFile, 'utf-8');
    expect(text).not.toContain('CLAUDEWATCH_METRICS_TOKEN');
    expect(text).not.toContain('CLAUDEWATCH_METRICS_HOST');
    expect(text).toContain('CLAUDEWATCH_METRICS_ENDPOINT=http://127.0.0.1:8787');
  });

  test('an unrecognised lan value is treated as loopback', () => {
    const { sb, envFile } = sandbox();
    expect(run(sb, call(envFile, 'yes'), { umask: '022' }).status).toBe(0);
    expect(readFileSync(envFile, 'utf-8')).not.toContain('CLAUDEWATCH_METRICS_TOKEN');
  });

  test('an absent lan argument is treated as loopback', () => {
    const { sb, envFile } = sandbox();
    const r = run(sb, `claudewatch_write_env_file ${JSON.stringify(envFile)}`, { umask: '022' });
    // Under `set -u` a bare `$2` would abort here rather than defaulting, so this covers the
    // `${2:-0}` requirement as well as the value rule.
    expect(r.status).toBe(0);
    expect(readFileSync(envFile, 'utf-8')).not.toContain('CLAUDEWATCH_METRICS_TOKEN');
  });

  test('a token too short for the service is rejected at install time', () => {
    // Added because mutation M9 -- deleting the length check -- failed nothing at all. A guard
    // no test can reach is not a guard, and predicting the zero does not excuse leaving it.
    const { sb, envFile } = sandbox();
    const bin = join(sb, 'stub');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'tr'), '#!/bin/bash\necho short\n', { mode: 0o755 });
    const r = run(sb, call(envFile, '1'), { umask: '022', preamble: `PATH=${JSON.stringify(bin)}:$PATH` });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('shorter than the 32 characters');
    expect(existsSync(envFile)).toBe(false);
  });

  test('a failing token generator fails the call and leaves no file', () => {
    const { sb, envFile } = sandbox();
    const bin = join(sb, 'stub');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'base64'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
    const r = run(sb, call(envFile, '1'), { umask: '022', preamble: `PATH=${JSON.stringify(bin)}:$PATH` });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('could not generate a token');
    // The point of the separate `local token; token=$(...)` lines. A one-line
    // `local token="$(...)"` takes its status from `local` and would sail past this.
    expect(existsSync(envFile)).toBe(false);
  });
});

describe('an existing file', () => {
  test('an existing 0644 file is tightened, and the output says so', () => {
    const { sb, envFile, configDir } = sandbox();
    mkdirSync(configDir, { recursive: true });
    writeFileSync(envFile, 'CLAUDEWATCH_METRICS_TOKEN=preexisting-token-value-kept-intact\n');
    chmodSync(envFile, 0o644);

    const r = run(sb, call(envFile, '1'), { umask: '022' });
    expect(r.status).toBe(0);
    expect(mode(envFile)).toBe('600');
    expect(r.stdout).toContain('tightened permissions');
    expect(r.stdout).toContain('(was 644)');
    // Repairing the mode must not rewrite the file or rotate the token.
    expect(readFileSync(envFile, 'utf-8')).toBe('CLAUDEWATCH_METRICS_TOKEN=preexisting-token-value-kept-intact\n');
  });

  test('an existing 0600 file is left alone, contents intact', () => {
    const { sb, envFile, configDir } = sandbox();
    mkdirSync(configDir, { recursive: true });
    writeFileSync(envFile, 'ORIGINAL=1\n');
    chmodSync(envFile, 0o600);

    const r = run(sb, call(envFile, '1'), { umask: '022' });
    expect(r.status).toBe(0);
    expect(mode(envFile)).toBe('600');
    expect(r.stdout).toContain('kept existing');
    expect(r.stdout).not.toContain('tightened');
    expect(readFileSync(envFile, 'utf-8')).toBe('ORIGINAL=1\n');
  });

  test('an existing 0400 file is not loosened under a message claiming otherwise', () => {
    const { sb, envFile, configDir } = sandbox();
    mkdirSync(configDir, { recursive: true });
    writeFileSync(envFile, 'ORIGINAL=1\n');
    chmodSync(envFile, 0o400);

    const r = run(sb, call(envFile, '1'), { umask: '022' });
    expect(r.status).toBe(0);
    // An owner-only file is already at least as strict as this script would make it. Changing
    // 0400 to 0600 and printing "tightened" would describe a loosening as its opposite.
    expect(mode(envFile)).toBe('400');
    expect(r.stdout).not.toContain('tightened');
  });
});

describe('paths a secret must not be written to', () => {
  test('a symlinked env path is refused and the target keeps its mode', () => {
    const { sb, envFile, configDir } = sandbox();
    mkdirSync(configDir, { recursive: true });
    const victim = join(sb, 'victim');
    writeFileSync(victim, 'not ours\n');
    chmodSync(victim, 0o644);
    symlinkSync(victim, envFile);

    const r = run(sb, call(envFile, '1'), { umask: '022' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('is a symlink');
    // `[ -f ]` is true for a link to a regular file, so a repair branch without the `[ -L ]`
    // guard would chmod straight through to here.
    expect(mode(victim)).toBe('644');
    expect(readFileSync(victim, 'utf-8')).toBe('not ours\n');
  });

  test('a dangling symlink is refused and its target is not created', () => {
    const { sb, envFile, configDir } = sandbox();
    mkdirSync(configDir, { recursive: true });
    const target = join(sb, 'never-created');
    symlinkSync(target, envFile);

    const r = run(sb, call(envFile, '1'), { umask: '022' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('is a symlink');
    // `[ -f ]` is FALSE for a dangling link, so the pre-change create branch wrote the token
    // straight through it. This one fails against the old code too.
    expect(existsSync(target)).toBe(false);
  });

  test('a directory in place of the env file is refused', () => {
    const { sb, envFile } = sandbox();
    mkdirSync(envFile, { recursive: true });
    const r = run(sb, call(envFile, '1'), { umask: '022' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('not a regular file');
  });

  test('a relative path is refused rather than chmodding the working directory', () => {
    const { sb } = sandbox();
    const cwdGuard = join(sb, 'cwd');
    mkdirSync(cwdGuard, { recursive: true });
    chmodSync(cwdGuard, 0o755);
    const r = run(sb, `cd ${JSON.stringify(cwdGuard)}\nclaudewatch_write_env_file "metrics.env" "1"`, { umask: '022' });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('must be absolute');
    // `dirname "metrics.env"` is `.`, so an unguarded `chmod 700 "$dir"` would land here and
    // report success.
    expect(mode(cwdGuard)).toBe('755');
  });

  test('a missing path argument fails and creates nothing', () => {
    const { sb } = sandbox();
    // Deliberately without `set -u`: under it, a bare `$1` would abort with
    // "unbound variable" on stderr and a non-zero status, which is to say a library
    // containing no validation at all would satisfy a looser version of this test.
    const r = run(sb, 'claudewatch_write_env_file', { bareShell: true });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('env-file: no path given');
    expect(r.stderr).not.toContain('unbound variable');
  });
});

describe('the library and its caller', () => {
  test('sourcing the library prints nothing and creates nothing', () => {
    const { sb } = sandbox();
    const r = run(sb, 'true');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
    expect(existsSync(join(sb, '.config'))).toBe(false);
    expect(existsSync(join(sb, 'unused-home'))).toBe(false);
  });

  test('both shell files parse, and the installer calls the library', () => {
    for (const file of [LIB, INSTALLER]) {
      const r = spawnSync('bash', ['-n', file], { encoding: 'utf-8' });
      expect(`${file}: ${r.status} ${r.stderr}`).toBe(`${file}: 0 `);
    }
    const installer = readFileSync(INSTALLER, 'utf-8');
    expect(installer).toContain('deploy/lib/env-file.sh');
    expect(installer).toContain('claudewatch_write_env_file');
    // A source line can coexist with the block it was supposed to replace. The defect is only
    // gone once the inline redirect is.
    expect(installer).not.toContain('> "$ENV_FILE"');
  });

  test('the documented invariants still say what the code now does', () => {
    // Same convention as scripts/env.test.ts: pin the sentence, so code and prose cannot drift
    // apart silently.
    expect(readFileSync(join(REPO, 'deploy', 'README.md'), 'utf-8')).toContain('created `0600`, not chmodded to `0600` afterwards');
    expect(readFileSync(join(REPO, 'SPEC.md'), 'utf-8')).toContain('created with its final mode');
  });
});
