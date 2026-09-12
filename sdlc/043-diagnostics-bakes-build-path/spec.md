# Spec: take the path from the host, and gate the artifact that actually ships

- **ID:** 043-diagnostics-bakes-build-path
- **Stage:** 2 — Design
- **Status:** **revision 1**, pending re-review. The first draft was **REJECTED** on three blocking
  findings, all three confirmed by re-running them here rather than taken on the reviewer's word.
- **Derived from:** [`intent.md`](./intent.md)

## Summary

`showDiagnostics` stops reading `__filename` and takes the path as a parameter, which `activate`
supplies from `context.extensionPath`. The modal's label and `SPEC.md` §10.5 are corrected. A new
`bundleScan` gate reads the **built bundle** — and runs in **both** places a bundle is built: the
`verify` gate, and the release workflow's `package-vscode` job, which is the one that produces the
published `.vsix`.

## What the first draft got wrong

Recorded in full, because two of the three are failures of the same kind this project keeps
producing — a claim that sounded right and was never run.

**B1 — the gate did not run where the artifact ships.** The draft's A7 said *"CI runs the same
command, so the check lands in CI with no workflow edit."* True of `ci.yml`. **False of
`release.yml`**, whose `package-vscode` job is the only thing that builds the published artifact:

```
.github/workflows/release.yml  (package-vscode)
  bun install
  bun run --filter @claudewatch/core build          # :95
  bun run --filter claudewatch-vscode build         # :98   <- builds its own dist/
  npx @vscode/vsce package --no-dependencies        # :102  <- packages it, unscanned
  upload-artifact                                   # :106
```

`verify` is never invoked there. The intent's problem statement is *"every published `.vsix` carries
the build machine's absolute source path"*, and the draft's gate inspected a bundle built by a
different job, on a different runner, from a different checkout. **"No workflow edit" was exactly the
wrong conclusion**, and it defeated the loop's purpose while reading like diligence.

**B2 — the "exhaustive" file list omitted a file the change turns red.** `scripts/env.test.ts:130-140`
builds a sandbox `package.json` listing every gate step by script name, and `runGate` asserts exit 0.
A new `STEPS` entry with no matching fixture script makes the fixture's `bun run bundleScan` fail.
This is not a prediction: `scripts/vscode-stub-cover.test.ts:503` already asserts
`expect(…env.test.ts…).toContain('vscodeStubCover: noop')`, with the comment *"and the env sandbox
stubs it, or its four cases go red."* The draft claimed the list was exhaustive **in the same
sentence that cited `sdlc/042` for this exact mistake.**

**B3 — the mutation justifying the gate was killed by a unit test.** The draft wrote mutation (1) as
*"revert to `const path = __filename` → A1 (the verify step, not a unit test)"*. That parenthetical
was the only evidence in the document that the new gate is load-bearing, and it is false. Measured:

```
$ bun test <a scratch file that logs __filename>
__filename = /tmp/.../fn.test.ts          # it resolves under bun test
$ cd packages/vscode && bun test src/commands.test.ts
 5 pass  0 fail  12 expect() calls        # at HEAD, with commands.ts:11 reading __filename
```

So under that mutation the modal renders the real source path and **A3 fails** — a unit test kills
it, and it demonstrates nothing about the gate. Revision 1 replaces it with a mutant no unit test can
observe, and keeps the original as a separate row with a corrected prediction.

## What the measurements decided

Every row was run, in a `mktemp -d` copy where the candidate fix was involved, discarded afterwards.
Rows marked † were re-measured in revision 1.

| Measured | Result | Consequence |
|---|---|---|
| Does the fix remove the literal? | **0** matches, and `__filename` appears **0** times in the built output | The parameter approach works. Bun injects the shadowing `var` only because the source reads it |
| Bundle still CommonJS? | **14** `require(`/`module.exports` markers | The `CLAUDE.md` requirement survives |
| What breaks under `tsc`? | **exactly 4** `TS2554` at `commands.test.ts:89,103,110,139` | Four call sites in one test file; `extension.ts` is the only product caller |
| Does `context.extensionPath` typecheck? | **yes** | Measured, not assumed |
| Would a repo-root scan catch **today's** bundle? | **1** occurrence | A real positive control on the pre-fix artifact |
| † Does the **stronger** rule (any absolute-path-shaped literal, not a fixed prefix list) over-match? | `grep -oE '"/[A-Za-z_][^"]{0,60}"'` on today's bundle returns **exactly one line — the leak itself** | **R2 is strengthened.** The draft's four-prefix list and the general rule both measure zero on a correct bundle, so the weaker one bought nothing and cost coverage of `/root/`, `/builds/`, `/workspace/`, `/opt/`, `/srv/ci/` |
| † Bundle size | **51,613** bytes | The size floor gets a number and a derivation, rather than the phrase "a size floor" |
| † Is `extensionPath` optional in the API? | `readonly extensionPath: string` at `@types/vscode@1.110.0:8354` — **non-optional** | The unavailable branch is defensive against non-conforming hosts and is **unreachable through `activate`**. Said out loud rather than left for a reader to wonder about |
| † Is there a `browser` manifest entry? | **absent** | The extension cannot load in a web host, which is why `extensionPath`'s "independent of the uri scheme" caveat cannot bite here. This is the reason the choice is safe, so it is written down |
| Does the stub expose `vscode.extensions`? | **no** | `getExtension()` rejected — it needs a new stub leaf, and it keys on `publisher.name` (`claudewatch`), which the pending `joezuchora` rename would break. `context.extensionPath` depends on neither |

## Behavior

### `commands.ts`

```ts
export async function showDiagnostics(extensionPath: string | undefined): Promise<void>
```

`string | undefined`, **not** `string` with a cast at the call site. The draft specified `string` and
then had its own test pass `undefined as unknown as string`; widening the parameter is how this repo
narrows rather than asserts, and it removes the cast.

- `const path = __filename` becomes the parameter.
- **The fallback predicate, stated exactly:** `typeof extensionPath !== 'string' || extensionPath.trim() === ''` renders the literal `(unavailable)`. Whitespace-only counts as absent — "  " is not an
  answer, and leaving the predicate to an implementer's taste is how two readings ship.
- **The label is corrected.** `context.extensionPath` is the install **directory**, so
  `**Extension bundle path:**` becomes `**Extension path:**`. Joining `dist/extension.js` onto it was
  rejected: it duplicates the manifest's `main` somewhere that can silently disagree with it.
- The unreachable `&& cache.snapshot` guard at `:19` stays **verbatim**, per `sdlc/028`.

### `extension.ts`

```ts
vscode.commands.registerCommand('claudewatch.diagnostics', () => showDiagnostics(context.extensionPath)),
```

A closure, because `registerCommand` passes its own arguments to the callback and a bare reference
hands `showDiagnostics` whatever VS Code invokes the command with — which, since the parameter is now
first, means the path would be replaced by a VS Code argument. That failure mode is **total and
user-visible**: every user would see `(unavailable)` forever. It therefore gets a test (A9), not a
note.

### `SPEC.md` §10.5

Line 581's *"shows the extension bundle path"* becomes the extension's **install path**, **and names
the unavailable case**. The loop exists because §10.5 described a value the command never produced;
shipping `(unavailable)` undocumented would be the same shape at smaller scale.

## The gate

A source-level test cannot see this defect: the source says `__filename`, and only the bundler turns
it into a literal. So the check reads the built artifact.

Structured as a pure function plus a thin runner, matching `fence-check` and `vscode-stub-cover`:

- `scripts/bundle-scan.ts` — `scanBundle(text: string, repoRoot: string): string[]` returning the
  offending literals, plus a runner reading `packages/vscode/dist/extension.js`.
- `scripts/bundle-scan.test.ts` — fixtures and controls.

**`repoRoot = resolve(import.meta.dir, '..')`**, following `scripts/perf.ts:70`. Specified, because
`process.cwd()`, `import.meta.dir` and `git rev-parse --show-toplevel` all differ, and an implementer
who passed `import.meta.dir` would get `<repo>/scripts` — under which R1 silently never fires and no
criterion notices.

Two rules, with their patterns written out rather than described:

- **R1 — the repo root.** The bundle must not contain `repoRoot` as a substring. Named "repo root",
  not "build root": the runner can only know its own location at scan time.
- **R2 — absolute-path shapes.** No string literal matching `/^(\/[A-Za-z_.]|[A-Za-z]:[\\/])/`. Note
  the scan reads raw file text, so a Windows path appears as `C:\\Users\\…` with doubled backslashes;
  the pattern must match the escaped form.

**The limitation, narrowed to what actually remains.** The draft excused `/srv/ci/…` in prose; R2 as
strengthened catches it, and prose that excuses a fixable gap converts it into an accepted one. What
genuinely remains: paths assembled by concatenation at runtime, encoded forms, and non-literal leaks.
Also, for any `dist/` not built by the same invocation, R1 compares against the **scan** root rather
than the build root — which is why B1's release-job wiring matters rather than being optional.

**Where it runs — both places, because there are two.**

1. `scripts/verify.ts` `STEPS`, between `build` and `perf`.
2. `.github/workflows/release.yml`'s `package-vscode` job, between *Build VS Code extension* (`:98`)
   and *Package VSIX* (`:102`). This is the one that gates the published artifact.

**The positive precondition.** A grep-for-absent-string is green on an empty set. Before reporting
success the runner asserts the file exists, is **at least 20,000 bytes** (derived: the measured
bundle is 51,613, and a stub or truncated write is orders of magnitude smaller; the floor sits well
below the real value so ordinary growth or shrinkage never trips it), and contains the marker
`claudewatch.diagnostics`. Missing, truncated or stub is a **failure**, not a pass.

**Staleness**, which the intent asked for and the draft silently dropped: inside `verify` and inside
`package-vscode`, `build` immediately precedes the scan, so a stale `dist/` is unreachable by
ordering. The standalone `bun run bundleScan` has no such guarantee and is therefore **advisory**;
this is stated rather than fixed with an mtime check, because an mtime comparison against one source
file would be a partial answer wearing a complete one's clothes.

## Data and types

Exhaustive — and this time the claim is checked rather than asserted. B2 was found by reading
`env.test.ts`; every other entry below was confirmed by grep against the real files.

| File | Change |
|---|---|
| `packages/vscode/src/commands.ts` | signature, `const path`, the label, the `(unavailable)` branch |
| `packages/vscode/src/extension.ts` | the registration closure — one line |
| `packages/vscode/src/commands.test.ts` | four call sites gain an argument; new cases for A3/A4 |
| `packages/vscode/src/extension.test.ts` | **added in revision 1** — A9 drives the command through `activate` |
| `scripts/bundle-scan.ts` | **new** — `scanBundle` plus the runner |
| `scripts/bundle-scan.test.ts` | **new** — fixtures, controls, and the step-declaration test |
| `scripts/verify.ts` | one `STEPS` entry, after `build` |
| `scripts/env.test.ts` | **added in revision 1 (B2)** — `bundleScan: noop` in the fixture's scripts |
| `package.json` | the `bundleScan` script |
| `.github/workflows/release.yml` | **added in revision 1 (B1)** — the scan step in `package-vscode` |
| `SPEC.md` | §10.5's description, including the unavailable case |
| `scripts/vscode-stub-cover.test.ts` | `FLOORS['commands.test.ts']` and `FLOORS['extension.test.ts']` |

`verify:plain` (`package.json:20`) is **deliberately not** extended, consistent with `lintBudget` and
`fenceCheck`, which it also omits. Stated so the omission is a decision rather than an oversight.

No new `packages/core` export, no stub change, no new `mock.module` call — `mock-topology.test.ts`'s
inventory does not move.

## Edge cases

| Case | Expected |
|---|---|
| `extensionPath` is `undefined` / `''` / `'   '` | `(unavailable)`, never the text `undefined` |
| The command is invoked by VS Code with its own arguments | the closure ignores them; `showDiagnostics` receives exactly the path |
| `dist/extension.js` absent when the gate runs | **failure**, named "bundle missing" |
| present but truncated or a stub | **failure**, via the 20,000-byte floor and the marker |
| A repo root legitimately containing `/tmp/` | R1 and R2 both fire — correct; a `/tmp` root in a shipped bundle is still a leak |
| A non-`file:` uri scheme | unreachable: no `browser` manifest entry, so the extension never loads in a web host |
| The `&& cache.snapshot` guard | untouched, verbatim, per `sdlc/028` |

## Backward compatibility

- `showDiagnostics` is referenced only from `extension.ts` and `commands.test.ts` — verified by grep,
  not assumed. The signature change is internal to `packages/vscode`.
- Command ID, manifest and the modal's other half unchanged. Bundle stays CommonJS (14 markers).
- `.oxlint-budget.json` must not move. If it does, **fix the construct**, as `sdlc/042` did.
- **Floors are `>=`.** Leaving them untouched passes forever, so "update the floors" is a
  **convention, not a criterion** — the draft presented it as one. A7 instead requires `review.md` to
  record the measured counts and the recorded floor to equal them.

## Acceptance criteria

- [ ] **A1 — the bundle carries no build-host path.** After `build`, `scanBundle` reports **zero**
      findings under R1 and R2. Falsifiable by construction: A2's fixture pins the pre-fix line.
- [ ] **A2 — the gate is not vacuous.** Six parts, because the draft's three established only that
      the *input* was a plausible bundle and nothing about the *scan*:
      (a) the runner fails on a missing file, on one below the floor, and on one lacking the marker,
      each with a positive control in the same test;
      (b) **against the real artifact**: `scanBundle(realText + injected, repoRoot)` reports both a
      `repoRoot`-prefixed literal and a `/Users/nobody/x.ts` literal, while `scanBundle(realText,
      repoRoot)` reports none;
      (c) the runner **exits non-zero** when `scanBundle` returns a non-empty array;
      (d) one fixture per rule branch: a `repoRoot`-prefixed path under a root R2's pattern does not
      match (**R1-only**), plus `/home/`, `/Users/`, `/tmp/`, `/opt/`, and a doubled-backslash drive
      prefix (**R2**);
      (e) the pre-fix leak is pinned as a literal fixture —
      `var vscode3, __filename = "<abs>/packages/vscode/src/commands.ts"` — so the positive control
      is a test rather than this document's memory, `dist/` being untracked and overwritten by the fix;
      (f) the three-part step declaration, per `vscode-stub-cover.test.ts:495-504`: `verify.ts`
      contains the `STEPS` entry, `package.json` declares the script, `env.test.ts` stubs it.
- [ ] **A3 — the command reports what it is given.** `showDiagnostics('/some/install/dir')` puts that
      exact string in the modal, asserted on the captured message, not a mock call count.
- [ ] **A4 — a missing path is legible.** `undefined`, `''` and `'   '` each render `(unavailable)`
      and none renders the text `undefined`. Both halves asserted.
- [ ] **A5 — it discriminates.** Six mutations, each **predicted before running**, re-run at Stage 4
      rather than inherited:
      (1) **module-scope `const buildStamp = __filename;` in `commands.ts`, never rendered** → **A1
      only**. This is the mutant that isolates the gate: measured in the sandbox, the parameter fix
      keeps `typecheck` and `lintBudget` green, and no unit test observes an unrendered constant;
      (2) revert `const path = __filename` → **A1 and A3** (corrected from the draft's "A1 only",
      which was false — `__filename` resolves under `bun test`);
      (3) drop the `(unavailable)` fallback → A4;
      (4) registration back to a bare `showDiagnostics` reference → **A9** — predicted to **DIE**,
      where the draft predicted SURVIVE and proposed recording it as a known gap;
      (5) delete the marker check from the runner → A2(a);
      (6) **delete R1 entirely** → A2(d)'s R1-only fixture. Added because with only real-artifact
      checks, R1 can be deleted with everything still green.
      Failing test named per mutation in `review.md`.
- [ ] **A6 — the documents agree with the code.** `SPEC.md` §10.5 and the modal's label both describe
      an install path, neither says "bundle path", and §10.5 names the unavailable case.
- [ ] **A7 — the gate holds.** `bun run verify` exits 0 with the new step. `.oxlint-budget.json`
      unchanged. `review.md` records the measured pass/expect counts for both changed test files, and
      the recorded floors equal them.
- [ ] **A8 — the release path is gated.** `release.yml`'s `package-vscode` job runs `bundleScan`
      between building the extension and `vsce package`, asserted by a test that greps the workflow.
      Without this the loop's stated purpose is unmet, whatever `verify` reports.
- [ ] **A9 — the wiring is covered.** Driven through `activate`, the diagnostics command receives
      `context.extensionPath`: `extension.test.ts` sets it on `makeCtx()`, invokes
      `registered.get('claudewatch.diagnostics')`, and asserts the modal contains it. Closes the
      loop's only otherwise-uncovered product line.

## Deliberately not done

- **The CJS bundle-format check stays manual**, though `bundle-scan.ts` is now its obvious home.
  Filed as a follow-up; a gate that grows a second unrelated assertion in its first commit is how
  gates become grab-bags.
- **The statusline binary is not scanned.** Same artifact class, different loop.
