# Review: drive the extension's refresh through what ships

Range reviewed: `0549346..HEAD` — `141c324` (implementation), `170addb` (security fixes), and
the Stage 5 remediation commit this file ships in.

Reviewers: `security-reviewer` (returned before `170addb`, folded in there),
`plan-to-diff-auditor` (returned **after** the security fixes, against `0549346..170addb`).

## Verdict

**Accept, after remediation.** The plan-to-diff audit returned **FENCE VIOLATED** with three
blocking findings. All three reproduced under my own hands and all three are fixed in this
commit. The audit was right on every blocking item; where I checked its collateral claims I
found one count off by three (16 failures, not 13, because I had added tests) and nothing
material wrong.

This loop was accepted only after a reviewer said no. That is the first time in the twenty-seven
loops that a Stage 5 gate changed the outcome rather than annotating it.

## Pass 1 — bugs and logical errors

### BLOCKING 1 — `settle()` tested for a lull, not for completion. Fixed.

The drain helper polled until the call log stopped growing, 5 ms apart. `doRefresh` *contains* a
lull: it suspends at `await fetchUsage(...)`. Any suspension outlasting one poll returned
mid-refresh, left `refreshInFlight` true, and the **next** test's refresh was silently swallowed
by the in-flight dedupe — surfacing as that test's own missing calls, i.e. blamed on the wrong
case.

Measured by varying only the mock's fetch delay, which changes no behaviour under test:

| delay | failures |
|---|---|
| 1 ms (shipped) | 0 |
| 6 ms | 2 |
| 20 ms | 6 |

A 5 ms margin. One loaded CI box from red, and red in a way that accuses the wrong test.

Fixed by removing the cause rather than widening the timeout: the mock's `fetchUsage` no longer
starts a timer, so `doRefresh` contains no macrotask wait at all, and a single
`await new Promise(r => setTimeout(r, 0))` is a *guarantee* — the microtask queue drains
completely before the next macrotask callback runs. No margin to tune. The premise that makes it
a guarantee is load-bearing, so it is now a test (`the bridge mock adds no macrotask wait`) that
races the mock against `setTimeout(…, 0)`; reintroducing a timer reddens it by name.

### BLOCKING 2 — the one permitted production change was not needed by any test. Fixed.

`plan.md` wrote its own falsification condition: *"revert `:90` to the discarding form → predicted:
the fetch cases hang or time out. If they pass, `settle()` is not actually waiting and A6 is
theatre."* I ran it. **68 pass, 3 todo, 0 fail.** The condition was met and the loop shipped anyway.

This is the finding I am least comfortable with, because the plan anticipated it exactly and the
implementation stepped over it. A2 existed to make this one production change impossible to slip
in unnoticed, and it was slipped in unnoticed by the check designed to notice.

The change is defensible on its own merits — `registerCommand` accepts a Thenable, and returning
the promise means `executeCommand('claudewatch.refresh')` resolves when the refresh is actually
done — but that is not the justification the spec gave, and an undeserved justification is what
this loop keeps shipping. It now has a test that pins the contract directly
(`the refresh command returns a promise that settles AFTER the refresh`). Reverting `:93` to the
discarding form now fails **exactly that test and nothing else**.

### BLOCKING 3 — A3's headline arm, the catch-all, was neither tested nor listed. Fixed.

The `:254` catch-all is the arm the Stage 2 spec review added to A3 *by name*, because a prototype
had already fooled itself by miscounting it. Revision 1 shipped with zero cases reaching it and no
`test.todo` either. Now covered by exact equality on the call log — the second `readCache` is the
catch's signature and no non-throwing path produces one.

### The fourth `shouldCooldown` cell was missing, and the third was too weak to notice. Fixed.

`plan.md`'s Tests table promised `{cached, none} × {cooldown y, n}`. Three of four shipped. The
miss was invisible because the with-cache case asserted only `toContain('enterCooldown')`, which
`:249` on the no-cache arm satisfies just as well. Both are fixed: the with-cache case now pins
its arm via `markStale`, and the no-cache cell has its own test.

## Pass 1b — the plan-to-diff audit

**Fence.** `scripts/mock-topology.ts` was changed while `plan.md` listed it under "explicitly not
touched" — and `plan.md` shipped *in the same commit* as the change that contradicted it. The
commit body declared the excursion, so it was not smuggled, but two committed artifacts were left
in direct contradiction and neither was reconciled. `plan.md` now carries the excursion with its
reason. A fence that is quietly wrong is worse than one that is wide: the next audit trusts it.

**The excursion had its own defect.** The comment-stripper shipped in `170addb` traded a false
negative for a false positive: anchoring `//` to line-leading meant
`foo(); // mock.module('./phantom.js')` was discovered as a **real mock**. That is the same defect
the fix existed to prevent, relocated from column 0 to a trailing position, and it had no test.
Both regex forms are wrong in one direction; it is now a quote-aware scan that has neither, with
both shapes pinned.

## Pass 2 — security (SPEC.md §12, §17)

The security pass returned before `170addb` and its findings are fixed there. Restated because the
first one is the most valuable thing this loop produced:

1. **The documented network-safety layer did not exist.** The file set `process.env.HOME` to a temp
   dir and claimed the network was unreachable "by construction". On bun `os.homedir()` is fixed at
   process start, so `getCredentialPath()` still resolved to the real `~/.claude/.credentials.json`.
   The pattern was lifted from sdlc/024's `seedSandboxHome`, where it works only because it goes
   into a **child process's** spawn env. Worse than a missing guard: the docstring asserted the
   guarantee, so the next reader would have built on it. Replaced with a `globalThis.fetch` thrower
   (the single egress chokepoint — `client.ts:75` calls the global, and no `node:http`/`undici`
   import exists anywhere in `packages/core/src`).
2. **Real telemetry reached the real spool.** The reviewer's own run wrote 14+ render lines into
   `~/.cache/claudewatch/metrics-spool.jsonl`. Fixed with `setCacheBaseDir`, which unlike `HOME`
   does take effect in-process (measured). Asserted against the mechanism — `getCacheDir()` vs the
   real path — not against the env var.

No token, path, hostname or account identifier is introduced into any payload by this diff. No
credential file is written by it.

**A note the shipped code contradicts:** `170addb`'s commit body records that this file "is now a
second hand-rolled writer of a file named `.credentials.json`". It is not — the HOME layer was
removed entirely and no credential file is written. The commit body is pushed and I have not
rewritten it; recording the correction here so a future `seedSandboxHome` consolidation is not
misled by it.

## Pass 3 — compliance

No domain logic added to `packages/vscode`. `extension-bridge.ts` is re-exports only (SPEC.md
§8.2). No `any`. Bundle verified CJS after build (17 `require`/`module.exports` occurrences, no
top-level ESM markers) — the check `verify` does not do for you.

## Mutation log

Every result **predicted before running**. One prediction was wrong, and that is recorded as such.

| # | Mutation | Predicted | Actual |
|---|---|---|---|
| M1 | revert `:93` to the discarding form | 1 fail (command-contract) | **1** ✓ |
| M2 | put a 20 ms timer back in the mock | ≥2, premise test among them | **9**, premise included ✓ |
| M3 | delete `doRefresh`'s `catch` block | 1 fail (catch-all) | **2** ✗ — see below |
| M4 | delete `enterCooldown` at `:249` | 1 fail (no-cache cooldown) | **1** ✓ |
| M5 | revert to the line-leading `//` regex | 2 fails (both new stripper tests) | **2** ✓ |
| M6 | drop the escaped-char branch | 1 fail (escaped-quote test) | **1** ✓ |

**M3's wrong prediction was worth more than the five right ones.** The extra failure was an
unrelated test receiving another test's calls. Cause: the fixture set `writeCacheThrows` *before*
`start()`, so `activate`'s own initial refresh threw too — the test was leaning on the catch-all
to survive its own setup, and with the catch removed that second escape became an unhandled
rejection that bled into the next case. Fixed by setting the flag after `start()`, so exactly one
throw is under test. M3 then gave exactly 1, with no unhandled error.

M3 re-run after the fix: **1 fail** ✓.

## What is NOT done

- **`BRIDGE_KEYS` is a hand-written literal.** Because the module is mocked, the key-set assertion
  compares the *mock's* keys to that literal and never the bridge's real exports. A symbol added to
  `extension-bridge.ts` but not imported by `extension.ts` drifts past both. Annotated in place;
  not fixed.
- **The `vscode` stubs are still not a superset.** `Uri`, `window.showInformationMessage`,
  `window.showErrorMessage` and `env.openExternal` are reached from `commands.ts` and are in none
  of them. Latent only because `openDashboard`/`showDiagnostics` are registered and never invoked.
  The word "superset" was wrong in the shipped comments and in `plan.md`; both now say what is
  measured (`env` → 16 failures, `onDidChangeConfiguration` → 0) instead.
- **`onDidChangeTelemetryEnabled` (`:76-80`) is dead in this file** because the stub omits the key,
  so the `typeof === 'function'` guard is false. Now a named `test.todo` rather than a silent gap.
- **`spec.md` A9 states a falsehood** — that an omitted symbol yields a swallowed `TypeError` and a
  green test. Measured: it is a hard `SyntaxError` at link time, 0 pass / 1 fail. A9 earns its
  place on *surplus* keys only. `spec.md` is a committed Stage 2 record and I have not rewritten
  it; the correction is here and in `extension-bridge.ts`'s docstring.
- **`commands.ts` still bypasses the bridge** with `await import('@claudewatch/core')`. Out of
  fence; carried forward.
- **Plan step sequencing was not followed** — steps 1 and 2 were to "each leave the gate green
  before the next" and everything landed in one commit. Process only, no defect.

## Retrospective

The recurring finding of the last four loops is **the claim made by reading**, and this loop
produced two fresh species of it:

1. **A check that cannot fail is worse than no check**, because it is counted. `settle()`,
   `onDidChangeConfiguration`'s justification, and A3's missing arm were all *present* in the
   artifact chain and all three were inert. The plan even wrote the experiment that would have
   exposed the second one, and the experiment was skipped rather than run.
2. **A restore mechanism is a claim too.** Mid-review I reverted a mutation with
   `git checkout <file>` on a file whose fix was still *uncommitted*, silently discarding the fix,
   and then measured the old code and nearly wrote up the result. Caught only because the number
   disagreed with the prediction. Backups now go to the scratchpad; `git checkout` reverts to HEAD,
   which is not the same thing as "undo".

The counter-discipline that keeps working is unchanged and was, again, the only thing that caught
any of this: **predict the mutation result before running it, and when the number disagrees,
believe the number.** Five of six predictions were right and taught nothing. The sixth was wrong
and found a real fixture defect.

New rule for `sdlc/README.md`: **when a plan writes its own falsification condition, running it is
not optional and its result goes in `review.md` whichever way it comes out.** This loop wrote one,
skipped it, and shipped — and the auditor ran it in thirty seconds.
