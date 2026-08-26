# Plan: the statusline must not hang on any stdin state

- **ID:** 005-statusline-tty-stdin
- **Stage:** 3 — Build
- **Status:** accepted
- **Derived from:** [`spec.md`](./spec.md)

## Approach

Replace `readStdin`'s state-guessing guard with a descriptor-type gate plus a deadline, then
add the smoke test that would have caught this — and loops 001 and 003 — by running the
compiled binary the way a user does.

The smoke test is the more important half. The fix is ten lines; the absence of any test that
executes the shipped artifact is what let three defects through.

## Scope fence

```
packages/statusline/src/main.ts
packages/statusline/src/main.test.ts
packages/statusline/src/smoke.test.ts
deploy/systemd/claudewatch-metrics.service
deploy/systemd/claudewatch-ship.service
deploy/systemd/claudewatch-sdlc-loop.service
SPEC.md
sdlc/005-statusline-tty-stdin/plan.md
sdlc/005-statusline-tty-stdin/review.md
```

## Changes

### `main.ts` — `readStdin()`
- Gate on `fstatSync(0)`: read only `isFIFO()` or `isFile()`. Everything else returns null
  after one syscall.
- Bound the read at `CLAUDEWATCH_STDIN_TIMEOUT_MS` (default 250 ms), checked between chunks.
- Keep the existing `isTTY` early return — redundant under the new gate, but free and it
  documents intent.
- `fstat` failure returns null rather than propagating.

### `smoke.test.ts` (new)
Spawns the **compiled binary** with a sandbox `HOME` — fake credentials and a fresh v2 cache,
so no network is touched — across every stdin state in the spec's table. Builds the binary
first if absent, and skips with a clear message on Windows, where the socket case cannot be
constructed the same way.

### systemd units
`StandardInput=null` explicitly on all three.

### `SPEC.md §2.4`
One sentence: session JSON is read only from a descriptor that can reach EOF, and any other
state degrades to plain output.

## Tests

| Spec criterion | Test |
|---|---|
| Socket stdin exits with output | `smoke.test.ts` — the reported failure |
| Terminal / closed / empty-pipe stdin | `smoke.test.ts` |
| Piped session JSON gives rich output | `smoke.test.ts` — the compatibility guarantee |
| Malformed JSON degrades to plain output | `smoke.test.ts` |
| Unwritten pipe exits after the deadline | `smoke.test.ts`, asserting both bounds |
| Exit codes unchanged | asserted in every smoke case |
| Cache-hit p95 < 50 ms | measured, recorded in `review.md` |

## Risks

- **The smoke test is slow or flaky.** It spawns a real process per case. Mitigated by a
  shared sandbox, no network, and generous-but-bounded timeouts. If it proves flaky it must be
  fixed, never skipped — a skipped smoke test returns the repo to the state that produced
  three defects.
- **Constructing a socket stdin portably.** Node's `net` can supply one on POSIX; Windows is
  skipped explicitly rather than silently.
- **The deadline masks a real regression** by degrading to plain output where rich was
  expected. Mitigated by asserting the piped-JSON case produces rich output.

---

**Next stage:** Build/Test — run `/sdlc-implement 005-statusline-tty-stdin`.
