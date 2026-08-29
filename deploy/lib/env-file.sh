# shellcheck shell=bash
#
# Create or repair the ClaudeWatch metrics environment file.
#
# Sourced, not executed. Sourcing must have no side effects: no directories, no output. That
# is what lets the tests exercise this on a host with no systemd, which is the whole reason it
# lives here instead of inline in install-nuc.sh. (sdlc/038)
#
# GNU coreutils assumed — `stat -c` is not BSD-portable. The installer already requires systemd
# and already uses GNU-only `grep -oP`, so this adds no new constraint.
#
# Every step checks its own status instead of leaning on the caller's `set -e`. Two reasons.
# The library is sourced by callers with different shell options, so its contract must not
# depend on theirs. And the wrapper below calls the implementation as the left operand of `||`
# to capture its status, which — measured — disables `set -e` for the whole call, so an
# unchecked failure inside would not abort anything at all.

_cw_say() { printf '  %s\n' "$*"; }
_cw_err() { printf 'env-file: %s\n' "$*" >&2; }

# claudewatch_write_env_file <absolute_env_file_path> <lan>
#
# <lan> enables a LAN bind and generates a bearer token. Only the exact string "1" counts:
# loopback is the safe default, so an unrecognised or absent value must not fall through to
# exposing the service.
#
# Returns 0 on success, 1 on an operation that failed, 2 on a bad argument, 3 on a path that
# is not something a secret may be written to.
claudewatch_write_env_file() {
  # `bash -x` prints every expansion, so an operator debugging a failed install with
  # `bash -x ./deploy/install-nuc.sh --lan` would splash the token across their terminal and
  # any log they piped it to. Measured: an assignment from a command substitution produces two
  # trace lines carrying the value. SPEC.md §12 forbids a token in debug output, so xtrace is
  # off for the duration and restored exactly as it was found.
  local _cw_xtrace=0
  case "$-" in *x*) _cw_xtrace=1; set +x ;; esac

  local _cw_rc=0
  _cw_write_env_file_impl "$@" || _cw_rc=$?

  [ "$_cw_xtrace" = 1 ] && set -x
  return "$_cw_rc"
}

_cw_write_env_file_impl() {
  local env_file="${1:-}"
  local lan="${2:-0}"

  if [ -z "$env_file" ]; then
    _cw_err "no path given"
    return 2
  fi
  # A relative path is not merely untidy. `dirname` of a bare filename is `.`, so the
  # `chmod 700 "$dir"` below would set the CALLER'S WORKING DIRECTORY to 0700 and report
  # success — the repo root, if a test ran from there. Refuse instead of guessing a root.
  case "$env_file" in
    /*) ;;
    *) _cw_err "path must be absolute: $env_file"; return 2 ;;
  esac

  # lstat, not stat — and before the existence branch, because the two symlink cases fall on
  # opposite sides of it. `[ -f ]` is TRUE for a link to a regular file, which would send the
  # repair branch's `chmod 600` at the link's TARGET; `[ -f ]` is FALSE for a dangling link,
  # which sends the create branch's write through it to create the target, token and all. Both
  # measured. REVIEW.md Pass 2 and SECURITY.md have required lstat-before-write all along.
  #
  # Refusing rather than resolving is deliberate: the reason we check is that the target is not
  # necessarily something this script should write a secret into or chmod. Following it
  # helpfully is the vulnerability.
  if [ -L "$env_file" ]; then
    _cw_err "$env_file is a symlink; refusing to write a secret through it"
    return 3
  fi
  if [ -e "$env_file" ] && [ ! -f "$env_file" ]; then
    _cw_err "$env_file exists and is not a regular file"
    return 3
  fi

  local dir
  dir="$(dirname "$env_file")" || return 1
  mkdir -p "$dir" || { _cw_err "could not create $dir"; return 1; }
  # The umask is NOT raised around the mkdir. `umask 077` in effect for `mkdir -p` sets every
  # directory it CREATES to 0700 — including ~/.config, on an account where that does not yet
  # exist. Measured both ways: a pre-existing 0755 parent is left alone, a freshly created one
  # is not. Locking down a directory this tool does not own is a worse outcome than the defect
  # it would prevent, so the leaf is chmodded on its own and the parents keep the user's umask.
  #
  # The leaf is therefore 0755 for an instant before it is 0700. That window exposes nothing:
  # it closes before the env file exists, and the env file is 0600 from its own first instant.
  chmod 700 "$dir" || { _cw_err "could not restrict $dir"; return 1; }

  if [ -f "$env_file" ]; then
    _cw_repair_mode "$env_file"
    return $?
  fi

  local token=''
  if [ "$lan" = "1" ]; then
    # Declared and assigned on separate lines on purpose. `local token="$(...)"` takes its exit
    # status from `local`, not from the command substitution, so a failing generator would be
    # silently ignored — a protection the inline version had and the extraction would otherwise
    # have quietly removed. Measured both ways.
    #
    # 48 is load-bearing beyond entropy: the trailing `head -c` closes the pipe, and under
    # `pipefail` a SIGPIPE in `tr` fails the whole pipeline. Measured 0 failures in 300 runs at
    # 48 bytes, and 20 of 20 once the input is raised to 100000. Raising it for "more entropy"
    # would make the installer fail intermittently.
    token="$(head -c 48 /dev/urandom | base64 | tr -d '/+=' | head -c 48)" || {
      _cw_err "could not generate a token"
      return 1
    }
    # The service refuses a non-loopback bind under 32 characters. Catching a short token here
    # turns an undiagnosable "the service will not start" into a message at install time.
    if [ "${#token}" -lt 32 ]; then
      _cw_err "generated token is shorter than the 32 characters the service requires"
      return 1
    fi
  fi

  # Temp file in the destination directory, then rename — the same atomic write CLAUDE.md and
  # SECURITY.md require of every other private file this project writes, and the reason this
  # one now matches. `mktemp` creates at 0600 even under an ambient `umask 000` (measured), so
  # the mode is a property of the creation rather than a correction applied afterwards.
  #
  # Atomicity is not decoration here. A plain `> "$env_file"` truncates at open time, before a
  # single line is written: a generator or disk failure would leave a header-only file that the
  # repair branch above then blesses as "kept existing" on every future run, with no token in
  # it and no way out but manual deletion. Measured. The rename means the destination either
  # does not exist or is complete.
  local tmp
  tmp="$(mktemp "$dir/.metrics.env.XXXXXX")" || { _cw_err "could not create a temp file in $dir"; return 1; }

  # Composed first, written once. The obvious `{ echo; echo; if ...; fi; } > "$tmp"` takes its
  # status from the LAST command in the group — which, on the loopback path, is an `if` whose
  # condition was false and whose status is therefore 0. A failing `echo` above it would be
  # masked and the function would report success over a truncated file. Found reading the diff
  # in the Stage 5 bugs pass, not by a test; see review.md for why it has none.
  local content
  content="# ClaudeWatch metrics configuration. This file holds a secret — keep it 0600.
CLAUDEWATCH_METRICS_ENDPOINT=http://127.0.0.1:8787"
  if [ "$lan" = "1" ]; then
    content="$content
CLAUDEWATCH_METRICS_HOST=0.0.0.0
CLAUDEWATCH_METRICS_TOKEN=$token"
  fi
  if ! printf '%s\n' "$content" > "$tmp"; then
    rm -f "$tmp"
    _cw_err "could not write $tmp"
    return 1
  fi

  # Redundant after mktemp, and kept: it is the mechanism the repair branch depends on, one
  # more independent statement of the invariant, and the point at which the tests observe the
  # mode. See deploy/env-file.test.ts — asserting the FINAL mode would pass against the very
  # defect this change fixes.
  chmod 600 "$tmp" || { rm -f "$tmp"; _cw_err "could not restrict $tmp"; return 1; }
  mv "$tmp" "$env_file" || { rm -f "$tmp"; _cw_err "could not move $tmp into place"; return 1; }
  _cw_say "wrote $env_file"
}

# Repair an existing file's mode without reading a byte of it. An existing token stays where it
# is: never loaded into a variable, never regenerated, never printed.
_cw_repair_mode() {
  local env_file="$1" mode
  mode="$(stat -c '%a' "$env_file")" || { _cw_err "could not stat $env_file"; return 1; }
  # Pad so the group and other digits are always the last two, whatever the leading bits are.
  mode="$(printf '%03d' "$mode")"
  case "$mode" in
    # No group or other bits. 0600 and 0400 both land here: an owner-only file is already at
    # least as strict as this script would make it, and chmod-ing 0400 up to 0600 under a
    # message reading "tightened" would be a loosening described as its opposite.
    *00)
      _cw_say "kept existing $env_file"
      ;;
    *)
      chmod 600 "$env_file" || { _cw_err "could not restrict $env_file"; return 1; }
      _cw_say "tightened permissions on $env_file (was $mode)"
      ;;
  esac
}
