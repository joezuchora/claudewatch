# Review findings: the statusline must not hang on any stdin state

- **ID:** 005-statusline-tty-stdin
- **Stage:** 5 — Deploy
- **Reviewed against:** [`plan.md`](./plan.md) and [`/REVIEW.md`](../../REVIEW.md)

## Plan-to-diff audit

**Verdict: CLEAN.** Every changed file is inside the fence.

## Pass 1 — Bugs and logical errors

This change went through **three wrong diagnoses** before the right one. All three are
recorded because the sequence is the finding.

| # | Wrong theory | How it died |
|---|---|---|
| 1 | "It hangs because stdin is a TTY and never reaches EOF." | `main.ts:75` already guarded `isTTY`. I wrote the cause without opening the function — the exact trap this repo's own `incident.md` template warns about two lines from the top. Corrected in `004`. |
| 2 | "Gate on descriptor type: read only a FIFO, which provably reaches EOF." | **libuv creates child stdio pipes as UNIX domain sockets.** So Claude Code's session channel *is* a socket — the same descriptor type as the hang. The gate silently rejected the only path with users, and the smoke test caught it as lost rich output. |
| 3 | "Bound it with an `O_NONBLOCK` reopen of `/dev/fd/0`." | Never actually exercised: theory 2's gate rejected the socket before the read ran. I diagnosed its failure twice from theory (`Atomics.wait` throwing, chunk discarding) and was wrong both times. |

**The actual fix**: descriptor type cannot distinguish "will deliver" from "will never
deliver", because they are the same type. What distinguishes them is *time*. `readStdin` is
now an async bounded read — `Promise.race([Bun.stdin.text(), timeout(250ms)])` — and a
timeout degrades to plain output, which was already a supported state.

**What made the difference**: every one of those three theories was killed by running the
compiled binary, not by reading code. Theory 1 died to a `readlink /proc/self/fd/0`; theory 2
died to the smoke test's rich-output assertion.

## Pass 2 — Security and vulnerabilities

No findings. No new I/O, no network, no credential path. The read is now bounded where it was
previously unbounded, which is a small availability improvement.

`StandardInput=null` set explicitly on all three systemd units. Not the root cause — systemd
already defaults to `null` — but those units are exactly the launcher class this bites, and
relying on a default for the property that caused the incident is how the next one happens.

## Pass 3 — Compliance

- No `any`; ESM; no domain logic added to a surface.
- `SPEC.md §2.4` amended to state the bounded-read contract and why descriptor type is not
  used. `§11.4`'s contractual flag list is untouched — no flag was added, deliberately: a flag
  would require the caller to know about a defect in the callee, and every invocation that
  hung did so because nobody passed anything.

## Verification evidence

All seven cases run the **compiled binary**:

```
$ bun test packages/statusline/src/smoke.test.ts
 7 pass  0 fail
```

| Case | Result |
|---|---|
| Socket stdin — **the reported failure** | exits 0 with output |
| Terminal stdin | exits 0 with output |
| Closed stdin | exits 0 with output |
| Empty closed pipe | exits 0 with output |
| **Pipe with session JSON → rich output** | `myproject`, `Claude 4 Opus` — unchanged |
| Pipe with malformed JSON | plain output, exit 0 |
| Unwritten, unclosed pipe | exits on the deadline, under 4 s |
| `--version` with stdin never closed | exits 0 immediately |

```
$ bun run verify
verify: pass in 29.7s  [typecheck 2.0s  lint 0.1s  test 27.4s  build 0.2s]
VERIFY EXIT=0
```

**Performance, measured over 100 runs of the compiled binary:**

| Scenario | p50 | p95 | max |
|---|---|---|---|
| Cache hit, closed stdin | 44 ms | **48 ms** | 77 ms |
| Cache hit, telemetry on, 4 MB spool | 44 ms | **51 ms** | 70 ms |
| Socket stdin (deadline path) | — | — | 310 ms |

## Acceptance criteria not met

- **`Cache-hit p95 < 50 ms with telemetry enabled and a 4 MB spool present` — NOT MET at
  51 ms.** One millisecond over, and the p50 is identical to the telemetry-off case (44 ms),
  so the delta sits inside run-to-run noise — but the criterion says 50 and the number says
  51, and rounding that down would make every future measurement meaningless. The dominant
  cost is process startup at ~44 ms, not telemetry. Recorded open; the honest fix is either a
  startup optimisation or a re-baselined budget in `SPEC.md §11.7`, and that is its own change.

## Findings deliberately not fixed

1. **Socket stdin now costs 310 ms** instead of hanging. Correct behaviour, but any launcher
   that hands the binary a silent socket pays the full deadline on every invocation. If that
   turns out to be a real deployment shape, the deadline wants tuning — currently unknown.
2. **`getCacheDir()` ignores `$XDG_CACHE_HOME`** while `SPEC.md:488` claims otherwise. Still
   open from loop 003.
3. All loop 001–003 follow-ups remain open, including the ~26 s of real `setTimeout` sleeps
   that dominate every gate run.

## Note on process

The lesson from loop 003's review — *every change that touches a shipped artifact must have at
least one check that executes that artifact* — was written down one loop ago and is now paid
for. The smoke test added here caught a regression I had **explicitly predicted in this
change's own spec** (`O_NONBLOCK` racing Claude Code and losing session data) and then walked
into anyway.

Writing a risk down does not prevent it. A test that executes the artifact does.

---

**Next stage:** Maintain.
