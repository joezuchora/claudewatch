# Stage 2 review: spec-reviewer findings

**Verdict: revise before implementation.** Accepted in full. The default changed as a result.

## The finding that changed the design

The spec's load-bearing premise — *"`scripts/verify.ts` runs only when someone types
`bun run verify` in a clone of this repo"* — is **false**.
`deploy/systemd/claudewatch-sdlc-loop.service:20` runs `bun run verify` hourly and unattended,
and it is the invocation path that produces most of the recorded data. I wrote that unit myself,
in this project, and then wrote a spec whose central argument it contradicts.

The counterfactual built on it was a strawman: *"off-by-default would have produced nothing"*
holds only if the person who owns the machine and wrote the unit would never add one line to it.
The unit already reads `EnvironmentFile=-%h/.config/claudewatch/metrics.env`, and
`deploy/install-nuc.sh` already writes `CLAUDEWATCH_*` lines into that file.

**Off by default plus one `Environment=` line preserves the entire hourly series.** The intent had
asked the right question — *who is the person choosing?* — noted that owner and contributor have
different answers, and then the spec gave the owner's answer to both, on the strength of a
counterfactual that assumed the owner helpless. The review was explicitly asked whether this was
self-serving reasoning. It was.

The default is now **off**, with the unit setting it on explicitly. That also closes a hazard the
review found: the unit runs `bash -lc`, a login shell, so an ambient `export ...=0` in a profile
would otherwise have killed the unattended series silently. `Environment=` in the unit beats the
inherited value.

## Other findings

| # | Finding | Resolution |
|---|---|---|
| B2 | The CLI-flag rejection cited two false claims — that `bun run` swallows arguments and that a hook invokes `verify`. **I had already found and corrected both** before the review returned; the reviewer confirmed independently and added that the systemd timer was missing from the call-site list. | Rewritten with the true reasons and the true three call sites. |
| B3 | **A8 was untestable.** `config.ts`'s `fromEnv` is not exported, and `verify.ts` must not import core — so "matches `config.ts`" could only compare a hand-copied table against itself: green by construction, still green after `config.ts` changed. | `parseBooleanEnvValue` gets exported from core; the *test* imports it, the *gate* does not. The `MAX_LINE_BYTES` precedent at `junit.test.ts:7`. |
| M1 | **The junit trade was stated dishonestly.** +0.82% is of the *test step*, not the gate. The parse branch is *already* conditional. And a disabled run still writes a report naming failing tests to `$TMPDIR`. | All three corrected, and the residual cost stated plainly rather than omitted. |
| M2 | **A7 passes with an implementation that does nothing.** | Paired with a spool assertion in the same test. |
| M3 | **The A5–A7 fixture contradicted itself** — "spawn a subprocess" and "never run the gate from inside `bun test`" — and left the fixture shape unspecified, so two implementers would build very different things. | Fixture specified: five no-op scripts, `cwd`, `HOME`+`USERPROFILE`, platform scope stated. |
| M4 | The unrecognised-value fallback landed on "record" without examining the symmetric harm: someone typing `=disabled` is recorded despite refusing. | With the default now off, the fallback is fail-closed for consent. A stderr line covers the *other* direction — someone typing `=enabled` who gets silence. |
| M5 | Three intent outcomes had **no criterion**: the false comment in `verify.ts`, the three spool documents, and `CONTRIBUTING.md` — the one document a contributor actually reads. | A9 added, mechanically checkable by grep. |
| M6 | `deploy/README.md:25` **and the unit-file comment** both claim every firing records an event. The unit file was on nobody's list. | Both in A9. |
| m1 | `"   "` (whitespace-only) was uncovered; an implementer writing `if (!v) return DEFAULT` would disagree with `config.ts` and pass every criterion. | Added to A2. |
| m2 | E4's rationale was confused — CI runs never reach the store at all, rather than being indistinguishable in it. | Corrected. |
| m3 | The helper had no cohesion with `junit.ts`, a junit XML parser. | New `scripts/env.ts`. |

## Verified and correct

Worth recording, since the point of checking is that some claims survive:

- The `config.ts` vocabulary claim was **accurate token-for-token in both directions**, including
  the empty-string case at line 38 — the detail most likely to have been asserted from memory.
- The `mkdirSync`-before-size-check claim was accurate, and correctly flagged as the criterion
  most likely to be got wrong.
- The `CLAUDEWATCH_TELEMETRY` reuse rejection and the config-file rejection both hold.
- A2, A4 and A6's construction was called out as the correct general fix for the `sdlc/020`
  vacuity class.

## The meta-finding

`sdlc/020` ended with *"a number from a trusted source is still a number nobody checked."* This
loop extends it: **a premise about your own system is still a premise nobody checked.** The false
claim was not inherited from a document or a reviewer — it was about infrastructure I had built,
and one `grep` of my own `deploy/` directory would have caught it before the spec was written.
