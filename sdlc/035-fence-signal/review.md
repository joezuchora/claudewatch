# Review: stop counting what can never be counted

- **ID:** 035-fence-signal
- **Stage:** 5 — Deploy
- **Reads:** the diff `efe02eb..5761fb8`, `plan.md`, `REVIEW.md`
- **Date:** 2026-08-29

## Summary

Shipped, after two reviewer findings that each required a code change rather than a note.

`fenceCheck`'s `unresolvedTokens` counted two populations in one integer. It is now split by shape,
only the identifier-shaped class is baselined, and two narrow resolution rules — script names and
dotted prefixes — resolve three tokens that previously could not resolve at all. **25 → 14.**

The loop's honest headline is not that number. It is that **the loop's own first attempt at the
number was made by editing a committed artifact to remove two tokens**, and the plan-to-diff audit
caught it. A loop whose thesis is "hand-lowering this number is the disease" caught itself doing
exactly that, one commit in.

## Commits

| Commit | What |
|---|---|
| `efe02eb` | spec revision after the Stage 2 review — B-3 and M-1 changed the design |
| `446dba6` | plan; **contains the fence violation** |
| `71cc86e` | implementation: the three fenced files |
| `64d8a0a` | Stage 5 remediation of the plan-to-diff audit |
| `5761fb8` | Stage 5 remediation of the security pass |

## Pass 1 — Bugs and logical errors

Run as the `plan-to-diff-auditor` subagent over `efe02eb..71cc86e`, plus my own mutation testing.

### B-1 (BLOCKING, fixed) — the fence was violated to make the number smaller

The `plan.md` commit rewrote five backticked headings out of the already-committed `spec.md`. The
stated reason was a fence trap around `package.json`. Three things were wrong with it:

1. **The reason accounts for none of the effect.** `package.json` produced zero findings either way,
   because the fence never named it — the trap existed only in a counterfactual where it had been
   listed on the negative fence, which it was not. The rewrite's real effect was on `name:` and
   `UNRESOLVED`, which have nothing to do with manifests.
2. **It lowered the baselined number from 15 to 13.**
3. **It edited a committed `spec.md`** — which that spec's own *Backward compatibility* section
   promises not to do — from outside the plan's scope fence.

Resolved by applying the spec's own test: *does removing this token hide a fact the number exists to
report?* `name:`, `.ts`, `interface X {` and `type X = {` name a **measurement**, not a requirement;
they stay prose. `UNRESOLVED` is a requirement heading naming an identifier-shaped thing the index
does not know, which is the definition of the counted class. **Restored; the number is 14**, and
`fenceCheck` now reports loop 035 in its own output. The fence was amended to name `spec.md` rather
than leaving the edit unfenced — the correction loop 034's plan made for the same reason.

The audit also confirmed the rewrite destroyed no information (every removed token still appears in
the body prose under its heading) and that the `package.json` reasoning itself holds: it is genuinely
unchanged, all four script names Rule 3 needs are pre-existing, and `inFence`'s basename-tail match
really would have covered all five committed manifests.

### B-2 (MAJOR, fixed) — a test named the opposite of what it asserted

`an unknown prefix stays unresolved rather than guessing` asserted `notASymbol`. The behaviour was
correct; the name was not. In a loop whose entire subject is that those two words name different
populations, that is the wrong kind of mistake to leave in the file. Renamed.

### B-3 (MAJOR, recorded) — A3's sum clause is tautological

A3 asks that `notASymbol.length + unresolved.length` equal the number of tokens that failed
resolution. `checkLoop` pushes each failed token into exactly one array, so the identity holds by
construction, and `checkLoop` exposes no independent count to compare against. Inventing one in the
test would be a second reading of the same rule. What the test *does* assert — disjointness, no
duplicates, and a classification round-trip — is real. Recorded in the test and in the spec rather
than left implying a check that is not happening.

### B-4 (MINOR, fixed) — A7 asserted its criterion only by implication

`a script name resolves to the file it runs` checked `unresolved === []` but not `notASymbol === []`.
Implied by the finding it asserts, so not vacuous — but cheap to assert literally, so now it is.

### B-5 (MINOR, fixed) — `./scripts/upgrade-all.ps1` never resolved

Found by my own test rather than by a reviewer, and the first version of that test **encoded the gap
as an expectation**. `git ls-files` does not emit a `./` prefix, so two of this repo's own script
entries silently failed `tracked.has()`. Both fixed.

## Pass 2 — Security and vulnerabilities

Run as the `security-reviewer` subagent over `efe02eb..64d8a0a`. Nothing blocking, nothing major.
Four minor findings, all fixed in `5761fb8`.

### S-1 (MINOR, fixed) — the split made an escape sequence *quieter*

The finding that justified the pass. This is a regression **this loop introduced**, not a
pre-existing hole:

- **Before:** an ESC-bearing heading token landed in `unresolved`, whose count is baselined.
  Committing one forced a count mismatch and a **red gate**.
- **After the split:** it classifies as `not-a-symbol` — printed, never asserted — so the same bytes
  print on a **green** run. A `\x1b[8m` (conceal) in a spec heading hides every `FINDING` line
  printed after it, and the ESC byte is invisible in a diff viewer.

The exit code is unaffected; what is hidden is the *explanation* of a failure. Fixed at the boundary
rather than the printer — `scrubControls` now runs inside `ticks()`, the single point where every
backticked token enters the module, covering `headingTokens` and `extractFence` alike. That is the
rule this file already stated for `parseBaseline` and loop 032 established for `disabledReason`.

**No committed artifact contains a control character today**, so this closes a latent hole rather
than a live one.

### S-2 (MINOR, fixed) — the manifest read bypassed the module's own bound

The diff's only new file read, and it went through neither `lstat` nor the 1 MiB cap that
`readableSource` applies to everything else. A `package.json` symlinked to `/dev/zero` reproduces the
unbounded read that OOM'd the gate in loop 033.

Fixed with `statSync`, **not** the `lstatSync` in `readableSource`, and the asymmetry is deliberate:
there the path comes from `git ls-files`, so a file's *name* decides what is read and a symlink is a
redirection attack; here nothing chooses the path, and a monorepo that symlinks its manifest is a
legitimate setup that should not turn the gate red with a baffling count mismatch. What is still
refused is a non-regular **target** — `/dev/zero` is a character device, so `isFile()` is false.

### S-3 (MINOR, fixed) — `SCRIPT_TARGET` was quadratic

`.` sat inside the character class *and* in the literal immediately after it, unanchored.
Independently reproduced at **8548ms on 64 KB** of dots; 1 MB would hang to the 300s step timeout.

Not an escalation, and the review said so plainly: anyone who can edit a `scripts` entry already has
arbitrary code execution in CI, since `verify` literally runs `bun run scripts/verify.ts`. Fixed
anyway — a gate should not be a CPU sink on input it does not trust. Now whitespace-anchored.

`DOTTED`, `ENV_VAR`, `IDENTIFIER` and the pre-existing `PATH_RE` were all measured linear.

### S-4 (MINOR, fixed) — an array passed the `scripts` shape check

`typeof scripts === 'object'` admits an array, which would be walked with numeric string keys.
Harmless today (`"0"` cannot match an identifier-shaped token) but unvalidated shape, against this
module's own house rule. `Array.isArray` added.

### S-5 (INFORMATIONAL, recorded) — the fallback's failure direction is not universal

`indexScripts`' docstring claimed a malformed manifest raises the count and fails the gate. True for
`verify`, which is identifier-shaped. **False for a hyphenated script name** — `upgrade-all` fails
`IDENTIFIER` and lands in `notASymbol`, which is never asserted, so losing it would be silent. Same
for a dotted token whose owner stops being a top-level export, *including* `MetricEvent.payload`.

What actually pins those is the live-tree test naming them, not the fallback's direction. The
docstring now says so. A general fix — routing would-have-resolved tokens into `unresolved` — is a
loop of its own.

### Cleared, and stated as cleared rather than silent

No token, absolute path, home directory, hostname or username reaches any output. Credentials
untouched — the diff's entire filesystem surface is four reads and a `readdir`. **Zero new writes**,
so the atomic-write/`0700`/`0600` rules have no new call site. No `fetch`, no TLS constant, no
`spawn`, no `execSync`. Traced explicitly: `verify.ts` spawns steps with `stdio: 'inherit'`, so no
string derived from `package.json`, `spec.md`, `plan.md` or the corpus can reach the telemetry spool.
`buildIndex`'s lstat + cap were verified unweakened by mechanical diff.

## Pass 3 — Compliance

| Rule | Verdict |
|---|---|
| Domain logic in `packages/core` | **N/A** — no product code touched. This is harness-only. |
| Surfaces stay thin | N/A |
| No `any` | Clean. `JSON.parse` results narrowed through validation, never `as`-asserted. |
| ESM, strict TS | Clean; `typecheck` passes. |
| UTC ISO internally | N/A |
| VS Code bundle stays CJS | N/A — `packages/vscode` not in the diff. |
| `docs/audit-report.md` standing items | `indexScripts`' new `JSON.parse` validates rather than asserts, so it does not extend the standing finding. `install.ts` untouched. |

## Acceptance criteria

| # | Verdict |
|---|---|
| A1 `verify` exits 0, CI green | **MET** — 16.0s; CI green on every pushed commit |
| A2 classifier, one test per rule | **PARTIAL, recorded** — 7 tests over 3 rules, because the flag branch turned out to be dead and was deleted (M1). Each surviving rule has a test that fails when it is mutated. |
| A3 invariant, not constants | **MET, with B-3's caveat recorded** |
| A4 finding set unchanged | **MET** — exactly one, loop 030's |
| A5 flags/env-vars do not move the count | **MET** |
| A6 unknown identifier does move it | **MET** |
| A7 script name resolves; untracked target does not | **MET** |
| A8 dotted prefix resolves; unknown prefix does not | **MET** |
| A9 baseline records neither `notASymbol` nor the old key, via raw `JSON.parse` | **MET** |
| A10 mutation predictions, named before the run | **PARTIAL — see below. Three of the first six were materially wrong.** |
| A11 `.oxlint-budget.json` at 8 rows / 10 warnings | **MET** — and enforced: the gate rejected the first version of the security tests for shadowing `read`. Fixed the shadow, not the record. |
| A12 no file outside the fence; zero findings for this loop | **MET AFTER REMEDIATION.** Initially **FAILED** — see B-1. |

## The mutation record, in full

Eleven mutations. The first six were predicted in `plan.md` before the run; the last five were
predicted in-session before the run, after M4's failure changed how I predict.

| # | Mutation | Predicted | Actual | Verdict |
|---|---|---|---|---|
| M1 | delete the flag branch | 3 failures | **0** | **WRONG.** The branch was dead: a token starting with `-` already fails `IDENTIFIER`. Deleted; `a flag is not a symbol` now exercises the rule that decides it, and fails under M4 where before it could not fail at all. |
| M2 | `ENV_VAR` `+` → `*` | 1, live tree unaffected | 1, live tree unaffected | right |
| M3 | empty `RESERVED` | 2 | 3 | under-named, safe direction |
| M4 | `IDENTIFIER` → `/./` | 5 named | 5 failures, **only 1 of them named** | **WRONG, and recorded as correct.** See below. |
| M5 | delete script fallback | 2 + live tree | 4, superset | right |
| M6 | delete dotted fallback | A3's sum catches it | A3 does **not** | **WRONG.** The token falls into `notASymbol`: disjoint, duplicate-free, self-consistent. A live-tree test naming the three resolved tokens catches it. |
| M7 | drop `scrubControls` in `ticks` | 2, named | 2, exactly those | right |
| M8 | unanchor `SCRIPT_TARGET` | 1 | 1 (8548ms) | right |
| M9 | drop `Array.isArray` | 1 | 1 | right |
| M10 | drop the `./` strip | 1 | 1 | right |
| M11 | drop `readManifest`'s stat guard | **0, and that is the wrong answer** | 3, after making it testable | right, by fixing the code |

### M4 is the finding worth carrying forward

The plan predicted `a plain identifier is unresolved`, `a reserved word…`, `a TypeScript type
keyword…`, `the live tree`, and A6. Five failures actually occurred — but **only `the live tree` was
among the five named**. The commit message reported "M4 5" and "all as predicted or better", which is
a **count** match concealing a **set** mismatch of four in five. The audit caught it.

The cause is precise and reusable: `ENV_VAR`, `RESERVED` and `TYPE_KEYWORDS` are checked **before**
`IDENTIFIER` and return early, so mutating `IDENTIFIER` cannot reach any test whose input is caught
upstream. **I named rules without tracing the early returns.**

Loops 033 and 034 both under-predicted by missing cross-cutting suites, and A10 was written for that.
This is a different failure one level down: getting the *per-rule* tests wrong because the rules are
not independent. M7–M11 were predicted with the guard ordering traced, and all five came back correct
on the set.

### M11 is the near-miss

`readManifest`'s first version read a fixed path through the ambient `fs`, and the mutation deleting
its guard produced **zero** failures — a guard whose absence no test can detect, which is exactly
loop 034's A7. Caught before shipping rather than after, and fixed the same way `scripts/spool-path.ts`
fixes it: exported, taking `stat`/`read` as parameters, so the matrix is a plain unit test.

## Recorded, not fixed

- **S-5's general case.** Routing would-have-resolved tokens into `unresolved` rather than
  `notASymbol` is its own loop.
- **`PATH_RE` and its kind still classify as environment variables.** No shape rule separates
  `PATH_RE` from `TMPDIR`.
- **14 is a floor.** The fourteen are enumerated in `spec.md` with the reason each is unreachable.
  A future reader must not read a rising number as "the check got worse" — rising is the signal
  working.
- **`package.json` is now a runtime input to the gate with no fence protection**, on either side.
  Deliberate (naming it would trap on the basename-tail match) but worth stating.
- **`HEADING` cannot tell a requirement heading from a measurement heading.** This loop was caught by
  that ambiguity from *both* directions in one afternoon: loop 032's `primaryUtilizationPct` false
  positive, and this loop's own heading rewrite. Narrowing needs a heading convention no committed
  loop follows.
- **`cli-ship.ts` still has no test file** (loop 034 A9, PARTIAL). Product code, outside this fence.
- **`ship()` collapses every failure reason into "retained"** — found live during this stage, not by
  reading code. A 404, a 500, a TLS failure and a DNS failure print identically, and on the NUC the
  retained count walks toward the 20-file drop with no way to tell why. Filed as a loop 036
  candidate; any fix must carry the status code and at most the endpoint path, never the token.

---

**Next stage:** Maintain — the retrospective lands in `sdlc/README.md`. No incident.
