# Spec: the statusline must not hang on any stdin state

- **ID:** 005-statusline-tty-stdin
- **Stage:** 2 — Design
- **Status:** accepted
- **Derived from:** [`intent.md`](./intent.md) and
  [`004`'s corrected root cause](../004-statusline-stdin-hang/incident.md)

## Summary

`readStdin()` stops guessing which descriptor states are safe and instead reads only from a
descriptor that can deliver EOF, under a bounded deadline. Any other stdin state is treated as
"no session data", which is already a supported condition producing the plain status line.

## Design decisions

### Gate on the descriptor type, not on `isTTY`

`isTTY` answers "is this a terminal", which is not the question. The question is "can this
descriptor reach EOF". Claude Code spawns the binary with a **pipe**, so:

```ts
if (!fstatSync(0).isFIFO()) return null;
```

A FIFO is read. A socket, a character device, a regular file redirect, or a TTY is not —
except that a regular-file redirect *can* reach EOF and is genuinely useful for testing, so it
is admitted too (`isFile()`). Everything else is skipped with zero latency.

This inverts the existing logic correctly: instead of enumerating states that hang, which is
open-ended and was got wrong, it enumerates the two states that provably terminate.

### A deadline as defence in depth

A FIFO whose writer never writes and never closes would still block. That is not the observed
failure and it is not what Claude Code does, but the whole lesson of `004` is that the guard
was written against imagined cases rather than the actual condition.

So the read is additionally bounded: **250 ms**, overridable via `CLAUDEWATCH_STDIN_TIMEOUT_MS`.
On expiry the binary proceeds with no session data.

**On the 50 ms budget** (`SPEC.md §11.7`): the deadline is a ceiling, not a cost. It applies
only when stdin is a FIFO — the Claude Code invocation, where data is already buffered and the
read returns immediately. Every other path skips the read entirely after a single `fstat`.
The cache-hit budget is measured with telemetry enabled and a FIFO present, not assumed.

### No new CLI flag

`SPEC.md §11.4`'s flag list is contractual and a flag would be the wrong shape: it would
require the *caller* to know about a defect in the callee. Every invocation that hangs today
does so precisely because nobody thought to pass anything. The fix must work for a caller who
does nothing, which a flag cannot.

`--json` and `--version` already short-circuit before the read and are unaffected.

### `StandardInput=null` in the systemd units

Not the root cause — systemd already defaults to `null` — but the units shipped in `deploy/`
are exactly the launcher class this bites, and relying on a default for a property this
load-bearing is how the next instance happens. Made explicit.

## Behavior

| stdin state | Before | After |
|---|---|---|
| Pipe with session JSON (Claude Code) | reads, rich output | **unchanged** |
| Pipe, empty, closed | reads 0, plain output | **unchanged** |
| Terminal | skipped by `isTTY`, plain output | **unchanged** |
| Closed / `/dev/null` | reads 0, plain output | **unchanged** |
| **Socket, never written** | **hangs forever** | skipped, plain output |
| **Pipe, writer never writes or closes** | **hangs forever** | plain output after 250 ms |
| Regular file redirect | reads, rich output if valid | **unchanged** |

Exit codes are untouched in every case.

## Edge cases

| Case | Expected |
|---|---|
| `fstat(0)` throws (fd closed entirely) | Treated as no session data. Never propagates. |
| FIFO delivers JSON in several chunks | Read to EOF as today, within the deadline. |
| FIFO delivers malformed JSON | `parseSessionInfo` returns null as today — plain output. |
| Deadline expires mid-read | Partial data discarded, plain output. Never a partial parse. |
| `CLAUDEWATCH_STDIN_TIMEOUT_MS` is 0, negative, or unparseable | Falls back to the 250 ms default rather than disabling the bound. |
| Session JSON larger than one 4096-byte chunk | Unchanged — the existing loop already handles this. |

## Backward compatibility

**The Claude Code invocation path is unchanged**, which is the only path with users today.
Every row marked "unchanged" above is asserted directly against the compiled binary.

No change to exit codes, flags, output formats, the cache, or the API contract. `SPEC.md §2.4`
gains a sentence naming the descriptor requirement; §11.4's flag list is untouched.

## Acceptance criteria

Every one of these runs the **compiled binary**, because this defect and the two before it
were all invisible to module-level tests:

- [ ] Socket stdin → exits with output, within a 5 s bound — **the reported failure**
- [ ] Terminal stdin → exits with output
- [ ] Closed stdin (`< /dev/null`) → exits with output
- [ ] Empty closed pipe → exits with output
- [ ] Pipe carrying valid session JSON → **rich session output**, byte-identical to today
- [ ] Pipe carrying malformed JSON → plain output, exit 0
- [ ] Unwritten, unclosed pipe → exits after the deadline, not before 200 ms
- [ ] Exit codes identical to today across all of the above
- [ ] Cache-hit p95 < 50 ms over 100 runs with a FIFO present
- [ ] `bun run verify` exits 0

## Rejected alternatives

- **Broaden the `isTTY` check** to also test for sockets. Enumerating hanging states is what
  produced the defect; the set is open-ended.
- **A `--no-session` flag.** Requires the caller to know about the callee's defect.
- **Non-blocking read with `O_NONBLOCK` and no FIFO gate.** Races Claude Code: a pipe not yet
  written returns `EAGAIN` and the session data is silently lost — trading a visible hang for
  an invisible regression.
- **Deadline only, no descriptor check.** Would fix the hang but spend up to 250 ms on every
  interactive invocation for nothing.

---

**Next stage:** Build — run `/sdlc-plan 005-statusline-tty-stdin`.
