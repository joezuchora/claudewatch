# Review: loop 041 — the telemetry listener, tested through the effect it exists to cause

- **ID:** 041-telemetry-listener-untested
- **Stage:** 5 — Deploy
- **Commits:** `fe92ea4..HEAD` on `claude/ai-sdlc-setup-plan-nqyqbk` (PR #16)
- **Reviewers:** spec-reviewer (Stage 2, **three rounds**), plan-to-diff-auditor and security-reviewer
  (Stage 5, sequentially). All five invocations returned; none is reported here as clean that did not.

## What shipped

Four tests in `extension.test.ts` covering `extension.ts:75-81` — the live half of `SPEC.md` §10.6
(line 595). A stale comment and its `test.todo` are gone; the header docstring's gap count is now
machine-checked. **No product source change**: `extension.ts`'s blob hash is identical at both ends of
the loop, which the security pass verified with `git rev-parse` rather than by reading the diff.

## Acceptance criteria

| # | Status | Evidence |
|---|---|---|
| A1 | met | disposable **identity** (`toContain(sentinel)`), not length — measured, a length check survives deleting the push |
| A2 | met | three-row truth table over both ANDed inputs, each row asserting `setTelemetryConfig` **and** `telemetryOverride()` |
| A3 | met | seven mutations, all predicted before running, all matched — table below |
| A4 | met **after two Stage 5 fixes** | see "A4 needed fixing twice" |
| A5 | met | seven files pass run alone; floors `pass 24 / expects 56` **as derived**; `verify` exit 0; `.oxlint-budget.json` unchanged |

## Mutations — predicted first, then run

| # | Mutation of `extension.ts` | Predicted | Measured |
|---|---|---|---|
| M1 | delete the `subscriptions.push` wrapper | A1 + test 3 | 22 pass, 2 fail ✓ |
| M2 | push a decoy disposable instead | A1 + test 3 | 22 pass, 2 fail ✓ |
| M3 | replace the callback with `() => {}` | A2 | 23 pass, 1 fail ✓ |
| M4 | force the `typeof` guard false | A1 + A2 + test 3 | 21 pass, 3 fail ✓ |
| M5 | drop `settingEnabled` from the AND | A2 **row 3** | 23 pass, 1 fail ✓ |
| M6 | push a local value, `telemetryAllowed` stale | A2's `telemetryOverride()` half | 23 pass, 1 fail ✓ |
| M7 | delete the `typeof` guard entirely | test 3 | 23 pass, 1 fail ✓ |

The auditor checked past the counts to *which assertion fired*: M5 at row 3's `expect`, M6 at row 1's
`telemetryOverride()`. M6 is the one that justifies asserting both observables — `setTelemetryConfig`
received the correct value and only the override assertion caught it. M7 is the one test 3 uniquely
kills, which is why test 3 exists.

Four A4 probes all fail as required, **including the indented-todo one** that revision 2's bare-anchor
pattern would have missed while bun printed one more todo than the docstring claimed.

## A4 needed fixing twice, and the second fix is the loop in miniature

The plan-to-diff audit found three defects, all in A4:

- **Its control did not control anything.** Control 2 applied its own *duplicate* regex literal to the
  fixture instead of the `TODO` const it exists to control. Weakening `TODO` to a bare `^` left the
  file green — a control decoupled from the thing it controls, inside the criterion added to prevent
  exactly that. Now `FIXTURE.match(TODO)`; verified 24/0 before the fix, 23/1 after.
- **My code comment was the FOURTH wrong explanation of that regex**, written in the commit that
  deleted the third. It said "removing the anchor entirely still yields the right count"; over the
  real file the unanchored pattern counts **4**, because it also hits control 2's own fixture strings.
  I measured that against the fixture and promoted it to a claim about the file — the same shape as
  the constant-`false` measurement the first draft was rejected for.
- **A silent coupling to source formatting.** Reformatting the fixture broke A4 with a confusing
  count. The fixture lines are now assembled by interpolation, so the coupling does not exist rather
  than being documented.

And the fix needed a fix: hoisting the builder tripped `unicorn(consistent-function-scoping)` and
reddened `lintBudget`. The plan's rule was explicit — fix the construct, not the budget — so
`todoLine` is module-scoped.

## Security pass: PASS

No blocking or major findings. Verified by measurement, not inspection: a socket-level guard
(`net.Socket.prototype.connect` and `tls.TLSSocket.prototype.connect` replaced with throwers) showed
**zero** connection attempts; an `fs` guard showed **no** `.claude/` or `.credentials.json` access and
no write outside `/tmp`; the real spool's md5 was identical before and after every run; and the built
bundle contains zero matches for `bun:test`, `vscodeStub`, `GAPS:` or `import.meta.path`, with
`.vscodeignore` excluding `src/`. The sdlc/024 and sdlc/027 repeats are both absent.

Its minor finding is recorded below rather than fixed, because the fix is outside this loop's fence.

## Recorded, not fixed

1. **A user turning the SETTING off mid-session keeps emitting until reload, and nothing notices.**
   Gutting `extension.ts:126`'s `recomputeTelemetryGate()` in the `onDidChangeConfiguration` branch
   leaves **428 pass / 0 fail** across the whole package. Reproduced independently. This is the
   *unsafe* direction of `SPEC.md:595`'s "narrow, never widen" — the setting's own observable is
   never fired by any test. The intent explicitly scoped `onDidChangeConfiguration` out, so covering
   it here would be creep; it is the strongest candidate for the next loop. Test 2's name was
   corrected so it no longer reads as covering both event sources, and a comment names the gap.
2. **`commands.ts:11` bakes the build machine's absolute path into every `.vsix`** via
   `const path = __filename`, which resolves to `/home/user/claudewatch/packages/vscode/src/commands.ts`
   in the shipped bundle. Not telemetry, so not a §17 violation, but a build-host disclosure in a
   published artifact — and `ClaudeWatch: Diagnostics` is specified (§10.5) to show the *extension
   bundle* path, so it is also a correctness bug. Untouched by this loop; found during the bundle
   check. Deserves its own loop before Marketplace publication.
3. **`telemetryOverride()` had zero callers in the product** before this loop; its docstring and
   `sdlc/007`'s spec both describe a call site that does not exist. This loop's test file is its
   first caller. Pinned rather than wired or deleted, because either is a product change the intent
   forbids.
4. **The two remaining `test.todo`s** (`onDidChangeConfiguration` handlers, `startPolling`'s 30s
   floor) stay, with reasons that are still true — unlike the one this loop removed.

## Process record

Three Stage 2 rejections plus one self-inflicted round. The reviewer's summary of the pattern was
exact: *every claim in this spec that was run has held; every claim that was not run has been wrong.*
The self-inflicted round is worth naming — `97ef382`'s message claimed a D1 fix that a failed edit
never wrote to disk, because a Python block raised partway and its write never executed while the
next block printed `ok`. Verifying edits by reading the artifact back, rather than by trusting a
tool's success message, is the habit that came out of it, and it caught a self-contradicting spec
paragraph at Stage 4.
