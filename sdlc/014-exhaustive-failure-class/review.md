# Review: make the compiler enforce the FailureClass decisions

- **ID:** 014-exhaustive-failure-class
- **Stage:** 5 — Deploy
- **Derived from:** [`plan.md`](./plan.md)
- **Branch:** `claude/ai-sdlc-setup-plan-nqyqbk`

## What shipped

`failurePolicy` in `packages/core/src/cooldown.ts` is one exhaustive `switch` returning all four
decisions the product makes from a `FailureClass`: whether it enters the 5-minute cooldown,
whether a retry is worth attempting, which `makeErrorSnapshot` presentation it renders as, and
which statusline exit code it produces. Seven consumers read it instead of comparing strings.

Two compile-time guards keep it honest — the `never` fallback in the switch, and a `never`
assignment over `Exclude<FailureClass, typeof FAILURE_CLASSES[number]>` — and a fixture harness
proves both actually fail a build, which is the part this loop nearly got wrong twice.

```
 11 files changed, 428 insertions(+), 37 deletions(-)
 + packages/core/src/exhaustive-guard.test.ts        (122 lines)
 + packages/core/src/typefixtures/                   (4 fixtures, a tsconfig, a README)
```

`bun run verify` passes in 12.1s — typecheck 2.0s, lint 0.1s, test 7.5s, build 0.5s, perf 2.0s.
599 tests across 30 files. The fixture harness costs one `tsc` run and 806ms, against the 8s
the plan flagged as the outcome if it ran `tsc` once per fixture.

The VS Code bundle was checked by hand, per CLAUDE.md: `module.exports` at `extension.js:1291`,
zero top-level `import`/`export` statements. Still CommonJS.

## Mutation testing

Every guard was broken, the failing check recorded, and the guard restored. Sixteen mutations,
sixteen caught. This table is the evidence that no check here is green on an empty set.

| # | Mutation | Check that failed |
|---|---|---|
| M1 | `case 'timeout':` deleted from `failurePolicy` | `tsc` — TS2322 at `cooldown.ts:129` naming `"timeout"` |
| M2 | `'timeout'` deleted from `FAILURE_CLASSES` | `tsc` — TS2322 at `cooldown.ts:66` naming `"timeout"` |
| M3 | `authInvalid.statuslineExitCode` 2 → 1 | `every member has exactly the documented policy` |
| M4 | `isFailureClass` → `value !== null` | `an unknown lastErrorClass is nulled, not rejected` |
| M5 | the `lastErrorClass` validation deleted from `readCacheResult` | same, plus `a non-string lastErrorClass is nulled too` |
| M6 | stale-cache path exits `policy.statuslineExitCode` instead of 0 | `REGRESSION GUARD: a renderable stale cache exits 0 for EVERY failure class`, and the pre-existing `with stale cache data, marks stale and exits 0` |
| M7 | `errorLineFor(...)` → literal `'⊙ error'` | `the rendered line matches the policy presentation`, and the pre-existing `authInvalid with no stale data exits 2` |
| M8 | `case 'missing':` deleted from `errorLineFor` | `tsc` — TS2322 at `main.ts:356` |
| M9 | retry drops `\|\| result.status === 429` | `does not retry 429 (preserves rate limit budget)` |
| M10 | retry drops `!failurePolicy(...).retryable` | `does not retry 401` |
| M11 | `case 'serviceUnavailable':` deleted from `statusLessClassOf` | `tsc` — TS2322 at `client.ts:132` |
| M12 | the missing `case 'blue'` restored in `switch-missing-case.expect-error.ts` | `a member missing from an exhaustive switch fails typecheck` |
| M13 | `"scripts"` added back to `tsconfig.json`'s `exclude` | `typecheck skips exactly three paths and no more` |
| M14 | negative control rewritten into the working guard form | `the inert empty-array form compiles clean, as it did when it shipped` |
| M15 | fixture project's `include` changed to match nothing | `tsc actually ran and reported failures` (via the TS18003 assertion) |
| M16 | `extension.ts` reverted to `result.failureClass === 'authInvalid'` | `no surface branches on a FailureClass literal` |

Two of these are worth reading twice.

**M9 and M10 together** prove the retry condition's two halves are independently load-bearing.
Dropping `|| result.status === 429` starts retrying rate limits; dropping
`!failurePolicy(...).retryable` starts retrying 401s. This is the one decision in the change
that is *not* a pure function of the `FailureClass` — 429 and 5xx are both `serviceUnavailable`
and want opposite answers — and the plan called it out as the place a mechanical
comparison-replacement would silently change behaviour. It would have.

**M6** is the other. `authInvalid`'s policy says exit 2, and the stale-cache path in `main.ts`
exits 0 regardless of class, because a rendered number is a success from the caller's point of
view. Consulting the policy there — the obvious "finish the job" edit — turns a working stale
statusline into a failure exit for every user whose token has expired. The mutation trips both
the new regression guard and a pre-existing test, which is the outcome you want: the old test
suite already knew.

## Deviations from the plan

Four, all declared rather than discovered.

1. **`packages/vscode/src/core-bridge.ts` is not in the fence.** The plan named statusline's
   `core-deps.ts` and overlooked the VS Code package's identical re-binding module. `extension.ts`
   imports through it, so `failurePolicy` had to be re-bound there too — one line, same shape as
   the line above it. The plan was incomplete, not the diff.

2. **The harness test is `packages/core/src/exhaustive-guard.test.ts`, not
   `typefixtures/exhaustive.test.ts`.** The plan put it inside the excluded directory. That is
   `sdlc/018`'s bug exactly: a test in a directory `tsconfig.json` excludes is a test nobody
   typechecks. Moving it out costs nothing and closes the hole before it opens.

3. **`typefixtures/tsconfig.json` and `typefixtures/README.md` are new files the fence did not
   list.** The fence listed `typefixtures/*.expect-error.ts`. The fixtures need a project of
   their own to be compiled at all.

4. **`packages/statusline/src/main.test.ts` is not in the fence**, though the plan's own test
   table names a test in it. An omission in the fence, not a scope excursion.

## Fixture count: three, not four

The plan's test table lists four `.expect-error.ts` fixtures. Three shipped, plus a fixture of a
different kind, and the count is not the interesting part — the plan's rows 1, 3 and 4 ("missing
case", "deleted case", "`statusClassOf` exhaustive") are all the *same form*: an exhaustive
switch with a `never` fallback. Writing that fixture three times with different names would have
produced a table that looks more thorough and tests nothing more. One fixture covers the form;
M1, M8 and M11 cover the three real switches directly, in the real files.

The fourth fixture is a **negative control**, `inert-empty-array.expect-clean.ts`, and it is the
most valuable file in the change. It is the guard this loop's own spec proposed —
`const _x: Exclude<A, B>[] = []` — frozen at the moment it compiles clean with a member missing.
An empty array literal is assignable to `never[]`, so it reports nothing, ever. The harness
asserts tsc emits **no diagnostic** for that file. If it ever starts failing, TypeScript has
changed and the form has become a real guard; three files' worth of reasoning point here to
explain why it is not used.

That asymmetry — three files that must fail, one that must not — is why the harness asserts
per-file diagnostics rather than a single exit code.

## What the work found

**The fixture project silently matched zero files.** `typefixtures/tsconfig.json` extends the
root config, and `extends` inherits `exclude` with its paths rebased — so the fixture project
inherited the exclusion of *its own directory*. `tsc` exited 2 with `TS18003: No inputs were
found`, and the harness's own self-check ("tsc ran and reported failures") passed on it, because
a non-zero exit and the substring `error TS` were both present. Three assertions downstream went
green against an empty string.

The fix is `"exclude": []` in the fixture config. The finding is the assertion that let it
through: `exitCode !== 0` is not "the compiler checked something". The harness now asserts
`TS18003` is absent, and M15 confirms that assertion fires.

This is the sixth instance of the pattern already recorded in `sdlc/README.md` — *a green check
on an empty set is indistinguishable from a green check on a covered one unless you plant a
failure* — and the first time it was caught by a guard written for that exact purpose in the
same sitting.

**Two fixtures were global scripts, not modules.** Without a top-level `import`/`export`,
TypeScript treats a file as a global script; the three fixtures then collided on `Colour` and
`COLOURS`, burying the TS2322 under six TS2300/TS2451 duplicate-identifier errors. The
`expect-error` fixtures would still have passed — they only assert TS2322 is *present* — but the
negative control would have reported errors and failed, correctly, for entirely the wrong reason.

## What this change does not cover

- **`packages/vscode/src/extension.ts` has no tests, still.** The only checks on its edit are
  `tsc` and the cross-package source scan in `cooldown.test.ts` (M16). The scan is real — it
  catches a revert to `=== 'authInvalid'` — but it cannot tell you the *replacement* behaves
  correctly. `policy.presentation !== 'unknown'` is argued from the diff, not demonstrated by a
  running extension. This is the pre-existing gap noted in `sdlc/README.md`, unchanged by this
  loop and now load-bearing for one more decision.

- **`notConfigured` and `malformedResponse` are never constructed anywhere in the product.**
  Their policy rows are choices made in advance, exercised only by the policy table test. If
  either ever starts being produced, its row is a hypothesis that has not met a real caller.
  `notConfigured` in particular is a deliberate behaviour change from the old implicit default:
  exit 2 rather than 1, per SPEC.md §11.5's definition of a configuration error.

- **The `never` guards cannot see a duplicate.** `satisfies` rejects a non-member,
  the `never` assignment rejects an omission, and neither notices `FAILURE_CLASSES` listing
  `'timeout'` twice — which would make every `for (const fc of FAILURE_CLASSES)` loop in the test
  suite cover five classes while reporting six. A `Set` size assertion covers it, in code rather
  than in types.

### Second mutation pass, on the review fixes

| # | Mutation | Check that failed |
|---|---|---|
| M17 | the non-object guard deleted from `readCacheResult` | `a cache file containing null is deleted, not thrown on` (and five siblings) |
| M18 | `sanitizeCooldownUntil` call deleted | `REGRESSION: an unparseable cooldownUntil is nulled before isInCooldown sees it` |
| M19 | the far-future clamp dropped, nulling kept | `a value beyond one full cooldown is clamped to the ceiling` |
| M20 | `_allCovered` renamed in `cooldown.ts` | `cooldown.ts still guards that FAILURE_CLASSES covers every member of the union` |
| M21 | `.expect-clean.ts` dropped from the fixture project's `include` | `tsc compiled every fixture on disk, not just the ones that fail` |
| M22 | a `throw` planted after the narrowed `try` in `client.ts` | `fetchUsage returns authInvalid` — it propagates instead of being relabelled |

M21 matters most: before this round, the negative control's assertion (*"tsc reported nothing
for this file"*) was **vacuous** for a file tsc never opened. It passes identically whether the
fixture compiles clean or is not in the project at all. That is the same defect as the TS18003
one, in the check written to catch the TS18003 one.

## Findings

Two reviewers, both read the change at commit `9573222`. Ten findings between them, of which
eight were real and are fixed here. Both reviewers were briefed to read an *uncommitted* diff
and I committed it out from under them mid-run; I sent both the commit range. That was my
error, and it would have produced two "no changes found" reports.

### Security pass

| # | Severity | Finding | Resolution |
|---|---|---|---|
| S1 | minor | **`cooldownUntil` is unvalidated, and the 5-minute backoff is the only throttle on token-bearing requests.** `isInCooldown` computes `Date.now() < new Date(v).getTime()`; an unparseable string gives `NaN`, every comparison against `NaN` is false, and the cooldown is **silently released** — one corrupt byte turns into a fresh authenticated request on every prompt render. `8.64e15` wedges it the other way, pinning the tool on stale data indefinitely. | **Fixed.** `sanitizeCooldownUntil` nulls garbage (fail open — one fetch, then a real cooldown is written) and clamps magnitude to one full backoff (fail closed). M18, M19. |
| S2 | minor | **`JSON.parse(raw) as CacheEnvelope` then `parsed.version` — a cache file containing the literal `null` throws `TypeError` and the file is never deleted.** Exit 3 on every invocation, forever, until someone removes it by hand. That is exactly the stuck failure loop SPEC.md §9 exists to prevent. | **Fixed.** An object check before the first member access, routed to the existing `corruptJson` path (delete + refetch). M17. |
| S3 | minor | **`failurePolicy`'s deliberate `throw` was being laundered.** It ran inside the `try` wrapping the network call, so a throw was caught, relabelled as a synthetic `serviceUnavailable`, retried, and persisted into the cache as `lastErrorMessage`. A guard whose failure is indistinguishable from a flaky network is not a guard. | **Fixed.** The `try` now covers `singleFetch` and nothing else. M22. |
| S4 | informational | **`bunx tsc` in the new harness can execute a registry package.** On a pruned or half-installed tree `bunx` falls back to fetching a package named `tsc` — which is not TypeScript — and running it during `bun test`. | **Fixed.** Invokes `node_modules/.bin/tsc` by explicit path, so a missing devDependency is a red test rather than a download. |
| S5 | informational | `Bun.spawnSync(['cat', …])` with `new URL(...).pathname` — percent-encoded, so a checkout path containing a space resolves wrong, and `/C:/…` on Windows. | **Fixed.** `readFileSync(fileURLToPath(...))`; the subprocess is gone. |

Cleared and worth recording, because they were checked rather than assumed: the token reaches
only the `Authorization` header — both new template literals interpolate an enum value only;
no new file write of any kind, so the `0700`/`0600` atomic-write path is byte-identical;
credentials still read-only; `https://` still hardcoded with no TLS escape hatch anywhere in
the tree; and the request-count question the reviewer was asked directly — the non-retryable
set grows from `{authInvalid}` to `{authInvalid, notConfigured}`, so the change makes strictly
**fewer or equal** token-bearing requests, with the `maxRetries + 1` ceiling untouched.
Prototype pollution was specifically probed on the new spread and is not reachable.

### Plan-to-diff audit

Verdict: **excursions recorded**. The four deviations were the ones already declared above; the
fence caught them, which is the fence working. Substantive findings beyond that, all about
comments claiming more than the code does:

| # | Finding | Resolution |
|---|---|---|
| A1 | **`cooldown.ts` claimed `unexpectedFailure` is "never constructed as a FailureClass".** It is — `client.ts` returns it for any status that is not 200/401/429/5xx. The policy values are still behaviour-preserving; the comment was simply false about a class that reaches production. | **Fixed.** The comment now says which of the pair is actually unreachable (`malformedResponse`) and which is not. |
| A2 | **The `isFailureClass` and `cache.ts` comments claimed the check closes a live path into `failurePolicy`'s `throw`.** It does not. Nothing passes `lastErrorClass` to `failurePolicy` — it is copied into new envelopes and printed by `--debug`, nothing more. I verified this independently before accepting it. The validation is defensible hardening; the comments sold it as closing an open hole. | **Fixed.** Both now say plainly that it is defence in depth and that the path described does not exist. |
| A3 | `main.ts` claimed its error strings "match the credential-resolution paths above". Only `'missing'` does; `'invalid'` prints `⊙ auth invalid` where that path prints `⊙ auth expired`. | **Fixed.** The comment now explains why they differ. |
| A4 | **The harness header claimed to prove the shipped guards fail a build. It proves the *form* does.** Every fixture uses a local stand-in union — delete `_allCovered` from `cooldown.ts` and all five assertions stayed green. *The same overstatement this loop was opened to fix, one level up.* | **Fixed twice over.** The header now separates the two claims explicitly, and four new tests search the shipped files for the guards themselves (M20). Those also close the plan's `statusClassOf` row, which had shipped with no test. |
| A5 | A test named `…in the union order` never asserted order. | **Fixed** — renamed to what it checks. |
| A6 | `the fixture project matches every fixture on disk` read the directory but never consulted what tsc resolved, leaving the negative control vacuous. | **Fixed.** `--listFiles` on the existing run, matched against the directory. M21. |
| A7 | `client.ts` said a status-only retry rule "would lose `notConfigured`". It would lose `authInvalid`; `notConfigured` is never constructed by `fetchUsage`. | **Fixed.** |
| A8 | `extension.ts`'s widened condition has no test, and is inert today only because `notConfigured` is never constructed. | **Not fixed** — recorded below. |
| A9 | A pre-existing comment named `./deps.js` where the mock targets `./core-deps.js`. | **Fixed** in passing. |

## What this change still does not cover

- **`packages/vscode/src/extension.ts` has no tests.** Its edit is covered by `tsc` and by the
  source scan that catches a revert to `=== 'authInvalid'` (M16) — but nothing demonstrates the
  *replacement* is right. `policy.presentation !== 'unknown'` is argued from the diff. It is
  also inert today, because the only class it newly catches is `notConfigured`, which nothing
  constructs. Pre-existing gap, now load-bearing for one more decision.

- **`malformedResponse` is never constructed.** Its policy row is a choice made in advance,
  exercised only by the table test.

- **The `never` guards cannot see a duplicate** in `FAILURE_CLASSES`; a `Set` assertion covers
  that in code rather than in types.

- **`readCacheResult` still `as`-asserts the parsed envelope.** Three fields are now checked
  (`version`, `snapshot`'s shape, `lastErrorClass`) plus the object check and `cooldownUntil`,
  but this is validation by accretion, not a schema. The standing item in
  `docs/audit-report.md` remains open, narrowed.

## Verdict

**Accepted.** `bun run verify` green in 13.0s; 22 mutations run across two passes, 22 caught.

The loop's own summary, honestly: it opened to stop decisions defaulting silently, and produced
three separate instances of *its own* failure mode along the way — an inert guard in the spec, a
type-checker checking nothing in the build, and a header claiming the harness watched guards it
never looked at. Each was found by a different mechanism: an adversarial spec review, running
the thing, and an adversarial diff review. None was found by reading.
