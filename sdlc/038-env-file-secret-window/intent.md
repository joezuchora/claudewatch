# Intent: the install script exposes the metrics bearer token before it protects it

- **ID:** 038-env-file-secret-window
- **Stage:** 1 — Plan
- **Status:** accepted
- **Author:** the SDLC loop, from the standing queue (raised during loop 034's review, carried unfixed since)
- **Date:** 2026-08-29

## Problem

`deploy/install-nuc.sh` writes the metrics environment file — which under `--lan` contains a
generated bearer token — with a plain redirect, and only afterwards restricts it:

```sh
  { ...; echo "CLAUDEWATCH_METRICS_TOKEN=$TOKEN"; } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
```

The redirect creates the file with the caller's umask. The `chmod` closes the door after the
secret is already inside. Three facts, each measured in a sandbox rather than inferred:

| What was measured | Result |
|---|---|
| Mode of the token file at the moment `chmod` is invoked, `umask 000` | `666` |
| Same, under the default `umask 022` | `644` |
| Mode of the containing config directory | `755` |
| Mode after a re-run over a file left at `644` | `644` — unchanged |

The first two say the secret is world-readable for the duration of the window. The third says
the window is *reachable*: the directory is traversable by any local user, so there is nothing
above the file making it moot. The fourth is a separate hole on the other branch — the script
never repairs the mode of an env file that already exists, and prints `kept existing
<path>` while leaving a world-readable secret exactly as it found it.

Method: lines 40–57 of the script were extracted verbatim and sourced in a temporary `HOME`
with a stub `chmod` earlier on `PATH` that records the file's mode before delegating to the
real one. The window is not a race that has to be won — it is the file's steady state until
`chmod` runs, and any local user reading at that instant gets the token.

`SPEC.md §12` forbids an access token in logs, cache files, debug output, or process
arguments. A world-readable file on disk is the same trust boundary stated for a different
medium; the enumeration is examples, not an exhaustive list of the places a token may not be.

## Who is affected

Anyone who runs `./deploy/install-nuc.sh --lan` on a machine with more than one local account.
Today that is one person on one NUC, so the realistic exposure is nil. Saying otherwise would
be inventing urgency: this is a latent defect in shipped deployment tooling, found by reading,
not a reported compromise.

What makes it worth more than its current blast radius is that the script is the documented,
recommended way to install this, `--lan` is the mode whose whole purpose is to expose the
service to other machines, and the file is the only thing standing between a LAN-reachable
endpoint and anyone with a shell on the box.

## Why now

The queue's other open items are correctness or hygiene; this is the only one on it that
hands a credential to the wrong reader. It is also small, fully measurable, and sits in a file
no other loop is touching.

There is a second reason, specific to this repo's failure history. The defect class recorded in
loops 033–037 is *a test named for a guard that does not exercise it*, and this change is an
unusually sharp instance of the trap: the obvious test — assert the env file ends up `0600` —
**passes against the unfixed script**, because the trailing `chmod` really does set `0600`. A
loop that writes that test ships a green check over an untouched vulnerability. Getting this
one right requires the discipline the last five loops built, on a change small enough that the
discipline is the hard part rather than the code.

## What "done" means

- [ ] The token file is never observable at a mode other than `0600`, including at the instant
      the script's own `chmod` runs — demonstrated by a check that **fails against the current
      script** and passes after the change
- [ ] The directory holding the env file is `0700`, not `0755`
- [ ] Re-running the installer over an env file that is already too permissive tightens it,
      rather than reporting `kept existing` and leaving it
- [ ] The token itself appears in no output stream — not stdout, not stderr, not a process
      argument — under both `--lan` and the default
- [ ] The behaviour above is covered by tests that run in `bun test`, on a host with no
      systemd, without installing anything or touching the real `$HOME`
- [ ] `bun run verify` exits 0

## Explicitly out of scope

- **The rest of the installer.** Unit installation, `daemon-reload`, `enable --now`, and
  lingering are untouched. Only the env-file section and what it needs is in scope.
- **The token's strength or format.** `head -c 48 /dev/urandom | base64 | tr -d '/+=' | head -c 48`
  stays as it is. Its entropy is not the defect; where the result is written is.
- **Rotating or re-issuing an existing token.** If an env file already has a token, this change
  fixes its *permissions* and nothing else. Replacing a possibly-exposed secret is a decision
  for whoever ran the script, not for the script.
- **The server's own auth model.** Whether a bearer token is the right mechanism for
  `--lan` at all is a real question and not this one.
- **`suppressions.json` and the metrics data directory.** Already `0600`/`0700` by their own
  writers; this loop does not revisit them.
- **Windows and macOS installers.** POSIX modes do not transfer, and neither script generates
  a token.

## Open questions

None blocking. One decision recorded rather than deferred: the trailing `chmod 600` **stays**
even once the file is created at `0600`, because it is what repairs an existing file, and
because a second, independent statement of the invariant costs one line. That means the test
cannot observe the fix through the final mode, and must observe creation directly — which is
the point made under "Why now" and is a design constraint on Stage 2, not an open question.

---

**Next stage:** Design — run `/sdlc-spec 038-env-file-secret-window` to turn this into `spec.md`.
