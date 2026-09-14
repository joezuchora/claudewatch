# Review: honour `$XDG_CACHE_HOME`, or stop claiming to

- **ID:** 034-xdg-cache-home
- **Stage:** 5 — Deploy
- **Range reviewed:** `2724d63..b6ae580` (seven commits)
- **Verdict:** **Accept.** Both reviewers returned, both found real defects, both remediated.
- **Date:** 2026-08-29

## What shipped

`getCacheDir()` resolves `$XDG_CACHE_HOME` — absolute wins, unset/empty/relative fall back — on
every platform. That is four lines. The other seventeen files are the consequence.

```
verify: pass  [typecheck lint lintBudget fenceCheck test build perf]   967 pass, 0 fail
fence-check: 14 checkable, 13 uncheckable, 6 skipped; 1 baselined finding (loop 030's)
```

`SPEC.md:491` had claimed this since loop 003. Loops 003 and 005 both recorded the divergence in
their reviews and neither fixed it. Thirty loops of "recorded, not fixed" is why it was worth doing:
the item had become proof that recorded items never get done.

## The finding that mattered most: a token left the machine

The security pass returned one **blocking** finding and demonstrated it end to end against a local
sink with a fake token.

Before this loop the spool directory was always `~/.cache/claudewatch`, created `0700` by this tool,
so only its owner could put a file there. **Honouring an environment variable made it an arbitrary
absolute path** — possibly one another local user owns or can create in. `pendingShippingFiles()`
selects by basename pattern and `ship()` does `readFileSync` with no `lstat`, so a planted
`metrics-spool.jsonl.<n>.shipping` symlinked to `~/.claude/.credentials.json` was read and POSTed to
the configured endpoint. The reviewer watched the OAuth access token arrive at the sink.

**The shipper never touches token-handling code.** Every token-handling invariant in the checklist
was clean — no token in logs, in argv, in the cache, in `--debug`; credentials read-only; TLS
untouched. The token arrived as *file contents*, through a path built out of two individually
reasonable decisions: "honour the user's cache variable" and "ship whatever is in the spool
directory". Neither is wrong. Their composition was.

> **A capability review has to follow the data, not the code.** Grepping the diff for token handling
> would have cleared this change, because the diff contains none. What changed was *who can write to
> a directory this process reads*.

The guard is `lstat`, not `stat`, on file **selection** — matching what `credentials.ts:15` already
does to the credential file — so every consumer of the pending list inherits it. `rotate()` carries
its own copy, so a symlinked live spool cannot be renamed into the pending set.

The same shape appeared in the write direction (**F2**): `appendFileSync` follows a symlink, so a
spool linked at an attacker-writable path wrote telemetry into whatever it pointed at. Guarded, and
the event is dropped rather than redirected — recording a metric must never be the reason something
else gets written.

Two minors, both verified by running: `cli-ship` printed an absolute path containing the username to
stdout, and its no-double-ship guard was a **string** compare that shipped the same event twice when
`XDG_CACHE_HOME` was a symlink resolving to `$HOME/.cache`. Now `realpath`.

## The other four defects

### The fifth definition (Stage 2)

The spec's first draft named four places that decide where this tool's files live. The reviewer
found **eight**, and the one I missed was the one that loses data. `scripts/verify.ts:169` built the
spool *directory* independently of `spoolPath()`. Patch only the resolver and `record()` creates the
legacy directory, appends to an XDG path whose parent does not exist, throws `ENOENT`, and the
catch — *"Recording a metric must never be the reason the gate fails"* — swallows it. Gate exits 0,
**every `verify_run` event silently lost**, on the machine running the hourly loop.

### The change would have turned `verify` red on the users it serves (Stage 2)

`SandboxSeed.env` is an allowlist merged over `process.env`, and it had no `XDG_CACHE_HOME`. An
ambient value would defeat the `HOME` sandbox, the seeded fixture would be missed, and `perf.ts`'s
sentinel would throw. **After this change, sandboxing `HOME` no longer sandboxes the cache** — which
is why A13 was restated rather than extended.

### A6 was unsatisfiable, and A7 could not fail (Stages 2 and 5)

A6's first form asserted `verify.ts` and core agree. `verify.ts` exports nothing and ends in
`process.exit()`, so no test can import it — and the `MAX_LINE_BYTES` precedent does not transfer,
because `junit.ts` has no top-level statements. Replaced with `scripts/spool-path.ts`, whose
resolvers take `home` and `env` as parameters; that also avoids a subprocess matrix, since
`homedir()` does not re-read a mutated `HOME`.

A7 was worse, and it is the loop's sharpest lesson. I wrote a source grep for
`join(homedir(), '.cache'` and paired it with a property test. The audit defeated it **five ways** —
double quotes, a template literal, a destructured `homedir()`, an extracted constant — and with the
mutant that matters: leave the `mkdir` derived and construct the **append** path independently. That
produces no event anywhere, gate at exit 0, A7 green.

> **A source grep tests spelling. A behavioural test tests the invariant.** A7 now spawns the real
> gate against the `env.test.ts` fixture with `XDG_CACHE_HOME` pointing at a third directory and
> asserts the event lands there *and nowhere else*. It kills the append mutant.

### I made an existing test worse (Stage 5)

`extension.test.ts`'s block is named *"the safety layers themselves"*. After this loop, both its
assertions — not-the-legacy-path, and `startsWith(tmpdir())` — pass with the safety layer
**deleted**, because an ambient `XDG_CACHE_HOME` usually lives under `TMPDIR`. A mutant-killing test
became a mutant-surviving one. Now a positive identity against the directory the override installed.

## Mutation testing (A10)

Nine mutations across the loop, **zero survivors**.

| # | Mutation | Predicted | Actual | |
|---|---|---|---|---|
| M1 | `isAbsolute` check removed | 2 named + "the matrix" | **6** | under |
| M2 | `claudewatch` suffix removed | 2 named | **6** | under |
| M3 | `setCacheBaseDir` loses precedence | 3 named | **2** | over |
| M4 | script resolver drifts | 3 named | **4** | under |
| M5 | drain trigger loses `pendingShippingFiles` | 1 named | 1, named | ✓ |
| M6 | A7 source grep (pre-audit) | 1 named | 1, named | ✓ |
| M7 | A7 append constructed independently | 1 named | 1, named | ✓ |
| M8 | `pendingShippingFiles` symlink filter removed | 3 named | **2** | over |
| M9 | spool append guard removed | 1 named | 1, named | ✓ |

**Four exact, five mis-predicted — and the misses have two causes, not five.**

Four of the five under-predictions are the same mistake: **I predict the tests written *for* a rule
and forget the suites written *across* rules.** A6's agreement matrix compares script against core
over six XDG shapes, so any resolver mutation lights up several cells at once. This is the identical
cause as loop 033's misses, where the cross-cutting test was the live-tree baseline. Two loops, one
lesson, still not learned in advance.

The two over-predictions are different and more interesting: in both, a test I expected to fail
**bound to a different rule than I thought**. M3's "wins with the variable UNSET" survives because
the mutant still falls through to `cacheBaseDir` when there is no XDG value. M8's rotate test
survives because `rotate()` carries its own guard, which I had not mutated. Both are *correct*
per-rule coverage; my model of which test binds which rule was wrong.

> **Predicting a mutation's blast radius requires naming the cross-cutting suites, not just the
> per-rule tests.** And when a prediction over-shoots, the usual cause is not a weak test — it is
> two rules where I thought there was one.

## Acceptance criteria

| # | Verdict | Evidence |
|---|---|---|
| A1 | **MET** | `verify` exit 0 locally and CI green on every commit. The auditor ran 709 tests under an ambient absolute `XDG_CACHE_HOME`: 0 fail. |
| A2 | **MET** | `cache.test.ts` — unset resolves to `getLegacyCacheDir()`. |
| A3 | **MET** | All six paths asserted under an absolute value; `getCachePath()` added at Stage 5 after the audit found it was the one of six left to derivation. |
| A4 | **MET** | Empty, relative, trailing-slash and `~/cache`, four named tests. |
| A5 | **MET** | Both directions plus the `setCacheBaseDir(null)` restore. |
| A6 | **MET** | Six-cell matrix, no subprocess; M4 confirms it kills drift. |
| A7 | **MET, after being rewritten** | Behavioural; M7 confirms. The source-grep version is recorded above as a failure. |
| A8 | **MET** | Predicate tested including the retained-`.shipping` case; M5 confirms. |
| A9 | **PARTIAL** | `combineResults` and the `realpath` guard are tested. **`cli-ship`'s composition is not** — it has no test file, so neither the guard's use nor the exit code is exercised. Inherited from the Stage 3 mapping, not introduced at Stage 4. |
| A10 | **MET, with the miss recorded** | Nine mutations, zero survivors, 4/9 exact. |
| A11 | **MET** | Budget now 8 rows / 10 warnings — see below. |
| A12 | **MET, one excursion recorded** | `sdlc/fence-baseline.json` was disclosed in Risks but not tabulated; added to the fence at Stage 5. `fenceCheck` reports zero findings for this loop. |
| A13 | **MET** | Seed pin present and load-bearing; `extension.test.ts` strengthened after the audit. |
| A14 | **MET** | `win32.isAbsolute` asserted directly. |
| A15 | **MET** | Uses a third directory — the seed pins XDG to `<home>/.cache`, so both branches produce the same string and a seed-based assertion would have been vacuous. |
| A16 | **MET** | No test writes to the real cache. |

**The lint budget failed one of my own commits**, which is worth recording as the gate working
rather than as an inconvenience. Switching to `toSorted()` while adding the symlink filter *removed*
a warning; the removal direction caught it with the asymmetric wording loop 033 designed for exactly
this. 9 rows / 11 warnings → 8 / 10.

## What is NOT done

1. **`cli-ship.ts` has no test file.** A9's guard and exit code are unexercised. The plan's test
   mapping mapped A9 only to `combineResults`, so this is a Stage 3 gap that Stage 4 inherited and
   Stage 5 found — the order matters, because it means the mapping was wrong before the code was.
2. **A pre-existing loose `$XDG_CACHE_HOME` is neither tightened nor detected.** A `0777` root stays
   `0777`; only the files are `0600`. Recorded by the security pass; not fixed.
3. **An unwritable or non-directory `XDG_CACHE_HOME` is a new hard-failure mode** — `ENOTDIR` at
   exit 3, reachable by a typo. Arguably belongs in `SPEC.md` §7's HardFailure list. Not added.
4. **`config.ts:29` still hardcodes `.config`** while `deploy/install-nuc.sh:14-15` honours
   `${XDG_CONFIG_HOME:-…}` — the same defect, opposite direction, already shipped. Deliberately out
   of scope; confirmed not made worse.
5. **The systemd unit is documented, not fixed.** `ReadWritePaths=` does no environment expansion,
   so a non-default `XDG_CACHE_HOME` needs a manual line. Install-time substitution is the only
   unattended answer and is recorded as out of scope.
6. **`unresolvedTokens` is now 25 and rises every loop.** Loop 033 justified baselining it as "a
   ratcheted number so the silence cannot grow quietly"; two consecutive loops have now advanced it
   as a matter of course, which makes updating it routine — the reflex loop 033's own guardrails
   exist to prevent. Queued for loop 035.
7. **Windows is asserted, not verified.** Only `win32.isAbsolute`'s classification is pinned.

## Retrospective

The four-line resolver was never the work. Seventeen files moved with it, and the two worst defects
were both **compositions of individually correct decisions**: honouring a user's variable is right,
and shipping what is in the spool directory is right, but together they put an OAuth token on the
wire. Nothing in the diff handled a token.

The loop also demonstrated, twice, that a fix is not exempt from review. My A7 shipped as a source
grep that five respellings defeat; my sandbox change turned a mutant-killing assertion into a
mutant-surviving one. Both were introduced *by the work that was supposed to make this safe*.

And the harness built in loop 033 paid for itself here in a way I did not predict: `lintBudget`
rejected one of my own commits for a warning I had accidentally *fixed*, and `fenceCheck` forced the
baseline update into the same commit as the artifact that caused it. Neither was a judgement call.

---

**Next stage:** Maintain — no incident. The retrospective goes to `sdlc/README.md`.
