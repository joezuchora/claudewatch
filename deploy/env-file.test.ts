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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { realpathSync } from 'fs';

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
  /** Interpose wrappers that record the argv of every external command the secret path runs. */
  recordArgv?: boolean;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  /** `<mode> <path>` pairs seen by the stub `chmod`, in call order. Empty unless `observe`. */
  observed: string[];
  /** Full argv of each wrapped external command. Empty unless `recordArgv`. */
  argv: string[];
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

  const argvFile = join(sb, 'argv.log');
  if (opts.recordArgv) {
    mkdirSync(bin, { recursive: true });
    // Every external command the secret-handling path can reach. A token that ever became a
    // process argument would show up here as an execve argv.
    for (const cmd of ['head', 'base64', 'tr', 'mktemp', 'mv', 'cat', 'env', 'printf', 'stat']) {
      writeFileSync(
        join(bin, cmd),
        ['#!/bin/bash', `printf '%s\\n' "$*" >> "$ARGV_LOG"`, `exec /usr/bin/${cmd} "$@"`, ''].join('\n'),
        { mode: 0o755 },
      );
    }
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
      `PATH=${opts.observe || opts.recordArgv ? `${bin}:` : ''}/usr/bin:/bin`,
      `OBSERVED=${observedFile}`,
      `ARGV_LOG=${argvFile}`,
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
    argv: existsSync(argvFile)
      ? readFileSync(argvFile, 'utf-8').split('\n').filter((l) => l.length > 0)
      : [],
  };
}

function sandbox(): { sb: string; envFile: string; configDir: string; parent: string } {
  // realpath, because the library now refuses a config directory that resolves elsewhere and
  // some platforms hand out a $TMPDIR that is itself a symlink.
  const sb = realpathSync(mkdtempSync(join(tmpdir(), 'cw-envfile-')));
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
    // The 0600 belongs to the temp file the destination is renamed from. `|| endsWith(envFile)`
    // used to be permitted here, and that disjunction is exactly what let the whole atomic-write
    // design go untested -- the first draft's `umask 077` subshell chmods the destination and
    // satisfied the other half.
    expect(fileLines.some((line) => line.includes('.metrics.env.'))).toBe(true);
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

describe('the atomic write', () => {
  // Added in Stage 5. The plan-to-diff audit found that swapping the shipped `mktemp` + `mv`
  // back to the first draft's `( umask 077; … > "$env_file" )` left all 23 tests passing:
  // the entire reason for spec revision 2 shipped unarmed. Reproduced before fixing.

  test('the destination is written through a temp file, never opened directly', () => {
    const { sb, envFile, configDir } = sandbox();
    const r = run(sb, call(envFile, '1'), { umask: '000', observe: true });
    expect(r.status).toBe(0);

    const fileLines = r.observed.filter((line) => !line.endsWith(` ${configDir}`));
    // Every file chmodded on the create path is a temp sibling. A design that opens the
    // destination directly chmods the destination, and fails here.
    expect(fileLines.length).toBeGreaterThan(0);
    expect(fileLines.filter((line) => !line.includes('.metrics.env.'))).toEqual([]);
    expect(fileLines.some((line) => line.endsWith(` ${envFile}`))).toBe(false);
    // ...and nothing is left lying around afterwards.
    expect(readdirSync(configDir).toSorted()).toEqual(['metrics.env']);
  });

  test('a temp file that cannot be opened leaves no destination file', () => {
    const { sb, envFile, configDir } = sandbox();
    mkdirSync(configDir, { recursive: true });
    // The stubbed `mktemp` names a path inside a directory that does not exist, so the redirect
    // fails with ENOENT. A read-only directory was tried first and does not work: this suite
    // runs as root in CI and in the container, and root bypasses directory permissions, so the
    // write succeeded and the test passed for the wrong reason. ENOENT is uid-independent.
    //
    // This is the partial-write hole that motivated the revision: a design that redirects
    // straight at the destination truncates it at open time and leaves a header-only file
    // behind, which the repair branch would then bless as `kept existing` forever.
    const bin = join(sb, 'stub');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'mktemp'), `#!/bin/bash\necho ${join(sb, 'no-such-dir', 'doomed')}\n`, { mode: 0o755 });

    const r = run(sb, call(envFile, '1'), { umask: '022', preamble: `PATH=${JSON.stringify(bin)}:$PATH` });
    expect(r.status).not.toBe(0);
    expect(existsSync(envFile)).toBe(false);
  });

  test('a failing rename leaves no temp file holding the token', () => {
    // All three `rm -f "$tmp"` cleanups were untested: deleting each individually left the
    // suite green, and the mv- and chmod-failure temps hold the COMPLETE token. Not an
    // exposure — 0600 inside a 0700 directory — but the design comment claims nothing is left
    // lying around, and only the happy path checked that.
    const { sb, envFile, configDir } = sandbox();
    const r = run(sb, call(envFile, '1'), { umask: '022', preamble: 'mv() { return 1; }' });

    expect(r.status).not.toBe(0);
    expect(existsSync(envFile)).toBe(false);
    expect(readdirSync(configDir)).toEqual([]);
  });

  test('the file contents are exactly what the service parses', () => {
    // Nothing asserted the bytes: mutating `printf '%s\\n'` to `printf '%s'` -- an env file
    // with no trailing newline -- failed no test at all.
    const loopback = sandbox();
    expect(run(loopback.sb, call(loopback.envFile, '0'), { umask: '022' }).status).toBe(0);
    expect(readFileSync(loopback.envFile, 'utf-8')).toBe(
      '# ClaudeWatch metrics configuration. This file holds a secret \u2014 keep it 0600.\n' +
        'CLAUDEWATCH_METRICS_ENDPOINT=http://127.0.0.1:8787\n',
    );

    const lan = sandbox();
    expect(run(lan.sb, call(lan.envFile, '1'), { umask: '022' }).status).toBe(0);
    const text = readFileSync(lan.envFile, 'utf-8');
    const token = /^CLAUDEWATCH_METRICS_TOKEN=(.+)$/m.exec(text)?.[1] ?? '';
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(text).toBe(
      '# ClaudeWatch metrics configuration. This file holds a secret \u2014 keep it 0600.\n' +
        'CLAUDEWATCH_METRICS_ENDPOINT=http://127.0.0.1:8787\n' +
        'CLAUDEWATCH_METRICS_HOST=0.0.0.0\n' +
        `CLAUDEWATCH_METRICS_TOKEN=${token}\n`,
    );
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
    const r = run(sb, `${call(envFile, '1')}\n: cw-xtrace-restored-marker`, { umask: '022', xtrace: true });
    expect(r.status).toBe(0);

    const token = /^CLAUDEWATCH_METRICS_TOKEN=(.+)$/m.exec(readFileSync(envFile, 'utf-8'))?.[1] ?? '';
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(r.stderr).not.toContain(token);
    // `toContain('+')` used to stand here and was satisfied by the harness's own pre-call
    // trace lines, so it would have held against a library that switched xtrace off and never
    // switched it back. The marker runs AFTER the call: seeing it traced is what proves the
    // setting was restored rather than merely disabled.
    expect(r.stderr).toContain('cw-xtrace-restored-marker');
  });

  test('the token never becomes a process argument', () => {
    // This used to be claimed by a comment on the `bash -x` test, on the reasoning that xtrace
    // prints the argv of every command. It cannot: the library disables xtrace for exactly the
    // secret-handling section, so argv is precisely what that trace cannot show. The Stage 5
    // security pass proved the gap by routing the content through `/usr/bin/env printf` — a
    // real execve argv — and the whole suite stayed green.
    //
    // The code is safe today only because `printf` and `[` are bash builtins. Nothing held it
    // there, so this records the argv of every external command the secret path can reach.
    const { sb, envFile } = sandbox();
    const r = run(sb, call(envFile, '1'), { umask: '022', recordArgv: true });
    expect(r.status).toBe(0);

    const token = /^CLAUDEWATCH_METRICS_TOKEN=(.+)$/m.exec(readFileSync(envFile, 'utf-8'))?.[1] ?? '';
    expect(token.length).toBeGreaterThanOrEqual(32);
    // The recorder really recorded — otherwise the assertion below proves nothing.
    expect(r.argv.length).toBeGreaterThan(0);
    expect(r.argv.filter((line) => line.includes(token))).toEqual([]);
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
    // `cat > /dev/null` first: a stub that never reads stdin leaves `base64` writing into a
    // closed pipe, and under `pipefail` that SIGPIPE fails the pipeline — so the call errors
    // with "could not generate a token" instead of the length message this test asserts.
    // Measured at 1 failure in 400 without the drain, 0 in 400 with it. It flaked on its
    // second run here; at that rate it would have reddened CI eventually and looked like an
    // infrastructure problem.
    writeFileSync(join(bin, 'tr'), '#!/bin/bash\ncat > /dev/null\necho short\n', { mode: 0o755 });
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
    // ...nor PRINT it. SPEC.md §12's Deployment secrets clause, added by this very loop, says
    // the repair branch "never reads, rotates, or prints the token". Only the first two halves
    // were armed: the Stage 5 security pass made `_cw_repair_mode` cat the file into its own
    // success message and the whole suite stayed green.
    expect(r.stdout).not.toContain('preexisting-token-value-kept-intact');
    expect(r.stderr).not.toContain('preexisting-token-value-kept-intact');
  });

  test('an existing 0600 file is left alone, contents intact', () => {
    const { sb, envFile, configDir } = sandbox();
    mkdirSync(configDir, { recursive: true });
    writeFileSync(envFile, 'ORIGINAL=1\n');
    chmodSync(envFile, 0o600);

    const r = run(sb, call(envFile, '1'), { umask: '022' });
    // (the sentinel below never appears in the file; it guards against a future edit that
    // starts echoing contents on the untouched branch too)
    expect(r.status).toBe(0);
    expect(mode(envFile)).toBe('600');
    expect(r.stdout).toContain('kept existing');
    expect(r.stdout).not.toContain('tightened');
    expect(readFileSync(envFile, 'utf-8')).toBe('ORIGINAL=1\n');
    expect(`${r.stdout}${r.stderr}`).not.toContain('SECRET-SENTINEL');
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
  test('a mode-000 file is not loosened either', () => {
    // The `printf '%03d'` padding is what puts a bare `0` from `stat` into the `*00` case.
    // Deleting the padding left every test green while a 0000 file was loosened to 0600 under
    // a message reading "tightened" — the same inversion the 0400 test exists to prevent.
    const { sb, envFile, configDir } = sandbox();
    mkdirSync(configDir, { recursive: true });
    writeFileSync(envFile, 'ORIGINAL=1\n');
    chmodSync(envFile, 0o000);

    const r = run(sb, call(envFile, '1'), { umask: '022' });
    expect(r.status).toBe(0);
    expect(mode(envFile)).toBe('000');
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

  test('a symlinked config directory is refused and the token is not written into it', () => {
    // Worse than a symlinked file: mkdir, chmod, mktemp and mv all follow a symlinked
    // DIRECTORY, so the token is not merely mis-moded, it lands somewhere else — a dotfiles
    // repo, a Syncthing share. Raised by the Stage 5 security pass, which measured it.
    const { sb, envFile, parent } = sandbox();
    const elsewhere = join(sb, 'elsewhere');
    mkdirSync(join(elsewhere, 'claudewatch'), { recursive: true });
    mkdirSync(parent, { recursive: true });
    symlinkSync(join(elsewhere, 'claudewatch'), join(parent, 'claudewatch'));

    const r = run(sb, call(envFile, '1'), { umask: '022' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('resolves to');
    expect(readdirSync(join(elsewhere, 'claudewatch'))).toEqual([]);
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
    const spec = readFileSync(join(REPO, 'SPEC.md'), 'utf-8');
    expect(spec).toContain('created with its final mode');
    // The clause makes two claims; pinning only the first left the atomic-write half as
    // unenforced prose, which is how the design went untested in the first place.
    expect(spec).toContain('written to a temporary file in the destination directory and renamed');
  });
});
