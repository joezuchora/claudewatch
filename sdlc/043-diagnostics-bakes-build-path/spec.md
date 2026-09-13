# Spec: take the path from the host, and gate the artifact that actually ships

- **ID:** 043-diagnostics-bakes-build-path
- **Stage:** 2 — Design
- **Status:** **revision 3**, pending re-review. Rejected three times: three blocking findings, then
  four, then two. Every blocking finding in all three rounds was confirmed by re-running it here, and
  in all three rounds the re-run found the reviewer right. Nine blocking defects in one spec, none of
  which would have been cheap to find in a published `.vsix`.
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

### What revision 1 then got wrong

Revision 1 fixed B1's mechanism and was rejected again. Two of the four findings are the **same two
classes**, which is the point worth recording rather than the individual slips.

**BL-1 and BL-2 — B3 was resolved in wording only.** Revision 1's replacement mutant was
`const buildStamp = __filename;`, justified as "measured in the sandbox, the parameter fix keeps
`typecheck` and `lintBudget` green". That list omits **`lint`**, which is `STEPS[1]` in
`scripts/verify.ts` — five steps before `build`. Measured here:

```
$ bun run lint     # with `const buildStamp = __filename;`
packages/vscode/src/commands.ts:5:7: error eslint(no-unused-vars):
  Variable 'buildStamp' is declared but never used.
lint exit=1

$ bun run lint     # revision 1's mutation (2): parameter kept, body reverted
packages/vscode/src/commands.ts:10:39: error eslint(no-unused-vars):
  Parameter 'extensionPath' is declared but never used.
lint exit=1
```

`no-unused-vars` is `correctness`, and `.oxlintrc.json:4` sets `correctness: error`. So **both**
mutants die at `lint`, and neither one reaches the gate it was written to justify. B3 said the
mutant was killed by a unit test; revision 1 replaced the killer instead of removing it. The fix is
one character — `_buildStamp` — measured: `lint` 0, `lintBudget` 0, and the repo root still appears
once in the built bundle.

**BL-3 — B2 recurred in a different file**, under a heading that read *"Exhaustive — and this time
the claim is checked rather than asserted"*. `scripts/fence-check.test.ts:696` asserts **exact set
equality** over the root manifest's resolvable script names. A tracked `scripts/bundle-scan.ts` plus
a `bundleScan` entry joins that set and reddens it. Same class as B2, same loop, one file over.

**The lesson, stated once.** Three rounds, three instances of the same shape: a claim about what
*would* happen, written in the register of a measurement, never run. The countermeasure that works is
not vigilance — it is refusing to write a consequence I have not executed. Revision 2's every
blocking fix below was run before it was written down.

### What revision 2 then got wrong

**B-1 — the rule I strengthened was inert on the only artifact that ships.** Revision 2 specified
R2's extractor as `/"(?:[^"\\]|\\.)*"/g`. Measured against the **leaking** bundle at HEAD:

```
spec extractor: literals=380  R2 hits=0        <- finds NOTHING on a bundle that leaks
line-scoped   : literals=380  R2 hits=1        <- ["/home/user/claudewatch/packages/vscode/src/commands.ts"]
mis-paired spans (contain a raw newline): 239 of 380
```

The bundle contains a regex literal with a `"` inside a character class. From that point the
escape-aware left-to-right pairing is off by one, and **two thirds of the file falls inside
mis-paired spans** — including the leak, which is swallowed mid-span and never enters the extracted
set at all.

How it got in is the part worth recording. The measured row that justified strengthening R2 used
`grep -oE '"/[A-Za-z_][^"]{0,60}"'` — **line-scoped and escape-unaware**. The spec then wrote down a
*different*, escape-aware regex. Both return 0 on a clean bundle, so the substitution was invisible
to every check the spec proposed. That is the fourth instance in this one document of the same class:
**a consequence written in the register of a measurement, against something other than what was
actually run.**

**Fix, measured:** `/"[^"\n]*"/g`. Line-scoped pairing bounds mis-pairing to one line and cannot
swallow the leak — 1 hit pre-fix, 0 post-fix. The trade is explicit: this cannot see a path inside a
literal containing an escaped quote. **Seeing the real leak beats handling `\"`,** and revision 2's
choice bought the second at the cost of the first.

**B-2 — the terminal check was false on every correct bundle.** Revision 2 wrote
*"`text.trimEnd().endsWith(';')` or the known trailing `module.exports` line"*. Measured:

```
trimEnd().endsWith(";") = false   | last 40 chars: "…writeCache2(envelope);\n}"
last "module.exports" at byte 38364 of 51595   (74% through the file, not trailing)
```

The bundle ends with a function declaration's `}`, so the first reading reds the gate on every
correct build; the second has no referent, and a 40 KB truncation still contains `module.exports` and
passes. One sentence, two readings, both wrong.

**Fix, measured:** parse the text — `new Bun.Transpiler({ loader: 'js' }).transformSync(text)`. Full
bundle parses; `text.slice(0, 30000)` throws `Expected identifier but found end of file`. Parse-only,
no execution, and it does not pin a byte pattern the bundler is free to change.

**One correction to the fix itself, measured rather than inherited:** the parse check does **not**
subsume "stub" — `// stub` parses cleanly. So the size floor and the marker stay load-bearing, and
the three checks divide as: **parse** catches truncation, **floor + marker** catch a stub. Revision 3
says so instead of repeating the reviewer's "subsumes truncated, stub and half a file".

## What the measurements decided

Every row was run, in a `mktemp -d` copy where the candidate fix was involved, discarded afterwards.
Rows marked † were re-measured in revision 1; rows marked ‡ were measured for revision 2; rows marked § for revision 3.

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
| ‡ Does `lint` kill an unrendered `const buildStamp = __filename;`? | **yes** — `no-unused-vars`, `correctness: error` (`.oxlintrc.json:4`), `lint exit=1` | Revision 1's isolating mutant died at `STEPS[1]`, five steps before `build`. **`_buildStamp` instead**: `lint` 0, `lintBudget` 0, repo root still present once in the bundle |
| ‡ Does `lint` kill revision 1's mutation (2) (parameter kept, body reverted)? | **yes** — `Parameter 'extensionPath' is declared but never used`, `lint exit=1` | A5 is therefore evaluated **per-criterion**, not by running `verify` |
| ‡ Is `Bun.YAML` available on the pinned runtime? | **yes** — `["parse","stringify"]`, Bun **1.3.11** | A8 becomes a structural assertion over the parsed workflow rather than a grep |
| ‡ Does `fence-check.test.ts` pin the resolvable script-name set? | **yes** — `:696-705`, exact `toEqual` over seven names | A new `bundleScan` script joins that set and reddens it |
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
- The unreachable `&& cache.snapshot` guard at `:20` stays **verbatim**, per `sdlc/028`. (`:19` is the `readCache()` call; the off-by-one is inherited from `intent.md` and corrected here.)

### `extension.ts`

```ts
vscode.commands.registerCommand('claudewatch.diagnostics', () => showDiagnostics(context.extensionPath)),
```

A closure, because a bare reference would hand `showDiagnostics` whatever VS Code invokes the command
with. **The mechanism, corrected in revision 2:** invoked from the Command Palette VS Code passes *no*
arguments, so `extensionPath` is `undefined` — not "replaced by a VS Code argument", as revision 1
wrote. The user-visible outcome is the same and it is total: **every** user would see `(unavailable)`
forever. So A9 stands and mutation (4) still dies; only the stated reason was wrong.

### `SPEC.md` §10.5 and §15.4

Line 581's *"shows the extension bundle path"* becomes the extension's **install path**, **and names
the unavailable case**. The loop exists because §10.5 described a value the command never produced;
shipping `(unavailable)` undocumented would be the same shape at smaller scale.

**§15.4 Non-Functional Checks** (line 928) gains one bullet: *"No build-host absolute path in the
published bundle"*. That section is where this repo's artifact-level invariants live — "No token
written to logs", "`--debug` output contains no token values" — and this is the same class. Revision 1
amended §10.5 and was silent on §15.4; silence there would have left the new gate enforcing an
invariant the spec never states.

## The gate

A source-level test cannot see this defect: the source says `__filename`, and only the bundler turns
it into a literal. So the check reads the built artifact.

Structured as a pure function plus a thin runner, matching `fence-check` and `vscode-stub-cover`:

- `scripts/bundle-scan.ts` — `scanBundle(text: string, repoRoot: string): string[]` returning the
  offending literals, plus a runner reading `packages/vscode/dist/extension.js`.
- `scripts/bundle-scan.test.ts` — fixtures and controls.

**`repoRoot = resolve(import.meta.dir, '..')`**, the idiom at `scripts/perf.ts:70` (which uses `join`; same normalisation, named accurately here). Specified, because
`process.cwd()`, `import.meta.dir` and `git rev-parse --show-toplevel` all differ, and an implementer
who passed `import.meta.dir` would get `<repo>/scripts` — under which R1 silently never fires and no
criterion notices.

Two rules, with their patterns written out rather than described:

- **R1 — the repo root.** The predicate, written out because "matched at a `/` boundary" has two
  readings and one of them ships the leak: `text.includes(root + '/') || text.includes(root + '"') ||
  text.endsWith(root)`. The middle term is what catches a **bare root with no trailing segment**,
  which a follow-must-be-`/` reading would miss. Measured: sibling `/tmp/checkout-2/x.ts` → no match,
  `/tmp/checkout/x.ts` → match, bare `/tmp/checkout` → match.
  The `repoRoot.length >= 8` floor stays, but when it disables R1 the runner **fails loudly** rather
  than passing — revision 2 reintroduced as a bounds check exactly the silent no-op it invokes
  `repoRoot`'s pinning to prevent. Unbounded substring matching would false-positive
  for a checkout at `/api` or `/opt` against the bundle's own
  `"https://api.anthropic.com/api/oauth/usage"` — measured present. Named "repo root", not "build
  root": the runner can only know its own location at scan time.
- **R2 — absolute-path shapes.** No string literal matching `/^(\/[A-Za-z_.]|[A-Za-z]:[\\/])/`.
  **The extractor is part of the rule, and revision 2's was wrong:** literals are pulled
  **line-scoped** with `/"[^"\n]*"/g`. An escape-aware pairing regex mis-pairs on the bundle's own
  regex literals and finds **zero** hits on a leaking artifact (measured; see B-1). Single-quoted and
  template literals are out of scope because bun normalises to double quotes — measured: **380**
  double-quoted on the pre-fix bundle (382 post-fix), 0 single-quoted, 44 backtick spans.
  **The trade, stated:** line-scoping cannot see a path inside a literal containing an escaped quote.
  That is accepted deliberately — seeing the real leak beats handling `\"` — and so revision 2's
  escaped-form fixture in A2(d) is **dropped** rather than left as a criterion the extractor fails.
  On Windows paths: `[\\/]` is a character class holding one backslash, so the pattern matches the
  raw-text escaped form `C:\\Users\\bob` **and** the decoded `C:\Users\bob` **and** `C:/Users/bob`. The
  pattern needs no change; revision 1's note that it "must match the escaped form" was muddled enough
  to push an implementer toward `[A-Za-z]:\\\\`, which would then miss the decoded form.

**The limitation, narrowed to what actually remains.** The draft excused `/srv/ci/…` in prose; R2 as
strengthened catches it, and prose that excuses a fixable gap converts it into an accepted one. What
genuinely remains: paths assembled by concatenation at runtime, encoded forms, and non-literal leaks.
Also, for any `dist/` not built by the same invocation, R1 compares against the **scan** root rather
than the build root — which is why B1's release-job wiring matters rather than being optional.

**Where it runs — both places, because there are two.**

1. `scripts/verify.ts` `STEPS`, between `build` and `perf`.
2. `.github/workflows/release.yml`'s `package-vscode` job, between *Build VS Code extension* (`:98`)
   and *Package VSIX* (`:102`). This is the one that gates the published artifact.

**The runner's seam.** `bun run scripts/bundle-scan.ts [--bundle <path>] [--root <path>]`, defaulting
to the resolved bundle and `repoRoot`. Without it, A2(a) and A2(c) could only be satisfied by moving
or corrupting the shared `dist/`, which a test in this repo must not do — and two implementers would
resolve that differently.

**The positive precondition.** A grep-for-absent-string is green on an empty set. Before reporting
success the runner asserts the file exists, is **at least 20,000 bytes** (derived: the measured
bundle is 51,613, and a stub or truncated write is orders of magnitude smaller; the floor sits well
below the real value so ordinary growth or shrinkage never trips it; note the byte count varies a
little with checkout path length — a sandbox at `/tmp/tmp.XXXXXXXXXX` measured 51,610), and contains
the marker `claudewatch.diagnostics`. **Plus a parse check** — `new Bun.Transpiler({ loader: 'js' }).transformSync(text)`, which is
parse-only and executes nothing — because a 30 KB partial write containing the marker would otherwise
pass the precondition and then scan half a file, reporting zero vacuously. Measured: the full bundle
parses, `slice(0, 30000)` throws. Revision 2's `endsWith(';')` was **false on every correct bundle**
(it ends with `}`) and its `module.exports` alternative sits at 74% of the file, so a truncation
retains it. The three checks divide the work: **parse** catches truncation, **floor + marker** catch a
stub — measured, because `// stub` parses cleanly and the parse check alone would wave it through. Missing,
truncated or stub is a **failure**, not a pass.

**Staleness**, which the intent asked for and the draft silently dropped: inside `verify` and inside
`package-vscode`, `build` immediately precedes the scan, so a stale `dist/` is unreachable by
ordering. The standalone `bun run bundleScan` has no such guarantee and is therefore **advisory**;
this is stated rather than fixed with an mtime check, because an mtime comparison against one source
file would be a partial answer wearing a complete one's clothes.

## Data and types

Revision 1 headed this table *"Exhaustive — and this time the claim is checked"* and still missed
`scripts/fence-check.test.ts`. So: **this list is the set of files I have confirmed the change
touches, and the two misses so far were both test files that pin a global inventory.** The class is
now named — *anything asserting an exact set over the repo's scripts, steps or leaves* — and its
**four** known members are all present: `env.test.ts`, `fence-check.test.ts`,
`vscode-stub-cover.test.ts`, and `mock-topology.test.ts`, the fourth found in round three after the
class had already been named. Naming a class is not the same as enumerating it.

**`sdlc/fence-baseline.json` is measured, not left unexamined.** `compareToBaseline`
(`scripts/fence-check.ts:528-535`) fails on any inequality of `uncheckable` and `unresolvedSymbols`.
Measured: `headingTokens` over this `spec.md` yields exactly `["commands.ts", "extension.ts",
"SPEC.md"]`, and `checkLoop` against a synthetic plan returns no findings — **so the baseline does not
move, provided the Stage 3 `plan.md` carries a fence marker paragraph.** Without one this loop counts
as `uncheckable`, 13 → 14, and `verify` goes red.

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
| `scripts/fence-check.test.ts` | **added in revision 2 (BL-3)** — `bundleScan` joins the resolvable script-name set equality (test opens `:696`, the list runs `:699-707`) |
| `scripts/mock-topology.test.ts` | **added in revision 3** — a fourth member of the class. Its `realTree()` walks `scripts/` too, and A1(a) pins the exact tree-wide set of `(test file, specifier)` mock pairs. **Binding, not predicted:** `bundle-scan.test.ts` calls **no** `mock.module` — it uses the `--bundle`/`--root` seam — so the row records a constraint rather than a hope |
| `package.json` | the `bundleScan` script |
| `.github/workflows/release.yml` | **added in revision 1 (B1)** — the scan step in `package-vscode` |
| `SPEC.md` | §10.5's description including the unavailable case, **and §15.4's new bullet (revision 2)** |
| `scripts/vscode-stub-cover.test.ts` | `FLOORS['commands.test.ts']` and `FLOORS['extension.test.ts']` |

`verify:plain` (`package.json:20`) is **deliberately not** extended, consistent with `lintBudget` and
`fenceCheck`, which it also omits. `CLAUDE.md`'s pipeline prose is **deliberately not** updated
either: line 76 already describes `verify` as "typecheck -> lint -> test -> build" and is stale by
four steps, and `vscodeStubCover` set the precedent of leaving it. Both stated so the omissions are
decisions rather than oversights — and both recorded as a follow-up, because a gate list that has
drifted by five steps is a document nobody can use.

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

**How A5 is evaluated, stated once.** Per-criterion — each mutation is judged by running the named
check directly, **not** by running `bun run verify`. Revision 1 left this unsaid, and because `lint`
is `STEPS[1]` and `build` is `STEPS[6]`, a mutant that trips `lint` short-circuits the gate and never
reaches the step it was written to exercise. Two of revision 1's six mutations did exactly that.

- [ ] **A1 — the bundle carries no build-host path.** After `build`, `scanBundle` reports **zero**
      findings under R1 and R2. Falsifiable by construction: A2(e) pins the pre-fix line.
- [ ] **A2 — the gate is not vacuous.** Eight parts:
      (a) the runner fails on a missing file, on one below the floor, on one lacking the marker, and
      on one failing the terminal check — each with a positive control in the same test, driven
      through `--bundle` against a `mkdtemp` fixture;
      (b) **against the real artifact — and this one is measured, not predicted** (revision 2 asserted
      it and it was false under revision 2's extractor): `scanBundle(realText + injected, repoRoot)`
      reports the injected `repoRoot`-prefixed literal **and** `/Users/nobody/x.ts`, and after the
      product fix `scanBundle(realText, repoRoot)` reports none. Run against the pre-fix bundle it
      reports the real leak plus `[R1]`, which is the criterion's positive control;
      (c) the runner **exits non-zero** when `scanBundle` returns a non-empty array;
      (d) one fixture per rule branch. The **R1-only** fixture root is pinned literally as
      **`/9build/checkout`** — measured not to match R2, because every natural root (`/home/…`,
      `/tmp/…`, `/Users/…`, `/opt/…`) matches R2 too, so a fixture built from one is not R1-only and
      mutation (6) would survive it. Plus `/home/`, `/Users/`, `/tmp/`, `/opt/`, a doubled-backslash
      drive prefix and a decoded drive prefix (**R2**). The escaped-form fixture is **dropped**: the
      line-scoped extractor cannot satisfy it, and a criterion the implementation is known to fail is
      not a criterion;
      (e) the pre-fix leak pinned as a literal fixture —
      `var vscode3, __filename = "<abs>/packages/vscode/src/commands.ts"` — so the positive control is
      a test rather than this document's memory, `dist/` being untracked and overwritten by the fix;
      (f) the **four**-part step declaration (revision 1 said three, and missed one): `verify.ts`
      contains the `STEPS` entry, `package.json` declares the script, `env.test.ts` stubs it as
      `bundleScan: noop`, and `fence-check.test.ts`'s resolvable-script set includes `bundleScan`.
      Ordering hazard worth one sentence at Stage 4: that set is over *resolvable* names and
      resolution goes through `git ls-files`, so `scripts/bundle-scan.ts` must be `git add`ed before
      the expected array is updated, or the failure arrives with a misleading diff;
      (g) R1's boundary condition, with a root **above** the length floor so the rule is actually
      running: root `/tmp/checkout`, bundle text containing `/tmp/checkout-2/x.ts` asserted **not** to
      match, and `/tmp/checkout/x.ts` asserted to match **in the same test**. Revision 2's fixture used
      `/repo` — five characters, below the `>= 8` floor — so it passed because R1 was switched off,
      and could not have failed;
      (h) the runner **fails loudly** when the length floor disables R1, rather than reporting success.
- [ ] **A3 — the command reports what it is given.** `showDiagnostics('/some/install/dir')` puts that
      exact string in the modal, asserted on the captured message, not a mock call count.
- [ ] **A4 — a missing path is legible.** `undefined`, `''` and `'   '` each render `(unavailable)`
      and none renders the text `undefined`. Both halves asserted.
- [ ] **A5 — it discriminates.** Seven mutations, each **predicted before running**, re-run at Stage 4
      rather than inherited, and each judged by the named check directly:
      (1) **module-scope `const _buildStamp = __filename;` in `commands.ts`, never rendered** → **A1
      only**. The underscore is load-bearing: without it `no-unused-vars` (`correctness: error`)
      fails `lint` and the mutant never reaches the gate. Measured for revision 2: with `_`,
      `typecheck`, `lint` **and** `lintBudget` are all green and the repo root still appears once in
      the built bundle. This is the only mutant that isolates the new gate;
      (2) revert `const path = __filename` → **`lint` first** (`Parameter 'extensionPath' is declared
      but never used`), and then **A1 and A3** when those checks are run directly. Revision 0 said
      "A1 only"; revision 1 said "A1 and A3"; both were incomplete, and the third answer is the one
      that was run;
      (3) drop the `(unavailable)` fallback → A4;
      (4) registration back to a bare `showDiagnostics` reference → **A9**, predicted to **DIE**;
      (5) delete the marker check from the runner → A2(a);
      (6) **delete R1 entirely** → A2(d)'s R1-only fixture, which is why that fixture's root is
      pinned to one R2 does not match;
      (7) **revert the modal's label to `Extension bundle path:`** → A6, added in revision 3 when A6
      acquired a mechanical check.
      Failing check named per mutation in `review.md`.
- [ ] **A6 — the documents agree with the code, mechanically.** A test asserts: `SPEC.md` contains
      §10.5's new sentence and §15.4's new bullet, and does **not** contain `extension bundle path`;
      `packages/vscode/src/commands.ts` does not contain `Extension bundle path`. Revisions 0-2 stated
      A6 as prose to be read — which is the shape `scripts/lint-budget.ts`'s own docstring rejects
      ("a criterion the gate cannot run is a note, not a check"), and it was the *one* criterion
      without a check in the loop that exists **because** §10.5 described a value the command never
      produced. A5 gains mutation (7): revert the modal's label → A6.
- [ ] **A7 — the gate holds.** `bun run verify` exits 0 with the new step. `.oxlint-budget.json`
      unchanged. `review.md` records the measured pass/expect counts for both changed test files, and
      the recorded floors equal them.
- [ ] **A8 — the release path is gated, structurally.** A test parses `.github/workflows/release.yml`
      with `Bun.YAML.parse` (available on the pinned runtime — measured: Bun 1.3.11, `["parse",
      "stringify"]`) and asserts, over `jobs['package-vscode'].steps`:
      (i) a step whose `run` contains `bundleScan` exists;
      (ii) its index is **strictly greater** than that of the step running
      `--filter claudewatch-vscode build` and **strictly less** than that of the `vsce package` step;
      (iii) that step has no `continue-on-error` and **no `if` key**, its `run` contains neither `||`
      nor `; true`, and `jobs['package-vscode']` itself has no `continue-on-error` — either of the
      last two neuters the gate while passing (i) and (ii).
      **Four** negative controls, because revision 2 supplied two and both exercised (i) and (ii)
      only, leaving (iii) deletable with the test still green — the same unfalsifiable-assertion
      defect that got A8 rejected, one clause down: fixtures with the step **removed**, **after
      `vsce package`**, carrying **`continue-on-error: true`**, and carrying **`|| true`**, each
      failing the predicate.
      Implementation notes, measured: `Bun.YAML.parse` yields `jobs['package-vscode'].steps` as an
      array where `run` is a string on the six `run` steps and **`undefined` on the three `uses`
      steps**, so the predicate must be `typeof s.run === 'string' && s.run.includes(...)` or it
      throws. And nothing pins Bun — `ci.yml` and `release.yml` both use `bun-version: latest`, and
      `bun-types` is a types package — so the test must fail with a **named message** when `Bun.YAML`
      is absent rather than with a bare `TypeError`.
      Revision 1 said "asserted by a test that greps the workflow", which
      `expect(yml).toContain('bundleScan')` satisfies — and which stays green for
      `bundleScan || true`, for `continue-on-error: true`, for the step in the wrong position, and for
      the step in the wrong job. A criterion carrying the fix for B1 cannot itself be satisfiable
      without the property holding.
- [ ] **A9 — the wiring is covered.** Driven through `activate`, the diagnostics command receives
      `context.extensionPath`: `extension.test.ts` sets it on `makeCtx()`, installs a
      `showInformationMessage` **sink on the stub** (the file has none today — named here because the
      criterion pins the other two mechanisms), invokes `registered.get('claudewatch.diagnostics')`,
      and asserts the modal contains the path.
      **One thing this drags in, stated rather than discovered:** `activate`'s dynamic
      `await import('./commands.js')` pulls the **real** `./commands-bridge.js` and so the real
      `readCache`, which reads `$XDG_CACHE_HOME`/`~/.cache/claudewatch`. `extension.test.ts` mocks
      `./extension-bridge.js` only. The case therefore pins `XDG_CACHE_HOME` to a `mkdtemp` dir for
      its duration — the assertion is about the path and would not flake either way, but an unmocked
      real-filesystem read landing in a file that had none is exactly what `CLAUDE.md`'s isolation
      rule forbids, and under a whole-suite run which module wins depends on bun load order, the
      hazard `scripts/mock-topology.ts` documents as its KNOWN LIMIT.
      **Why `XDG_CACHE_HOME` and not `setCacheBaseDir`**, so a later reader does not "upgrade" it:
      `getCacheDir()` (`packages/core/src/cache.ts:70`) consults the module-level `cacheBaseDir`
      **first**, then `process.env.XDG_CACHE_HOME` at call time — so the env pin does work, and
      `setCacheBaseDir` would win over it. The env pin is nonetheless correct here, because reaching
      `setCacheBaseDir` from `extension.test.ts` would create a new direct core consumer outside the
      bridge arrangement.
- [ ] **A10 — the bundle is still CommonJS.** `review.md` records the measured marker count **and**
      the check asserts `module.exports` specifically. "`require(` or `module.exports`, > 0" is
      weaker than the property: an ESM bundle can emit `require(` via `createRequire`, whereas bun's
      ESM output never emits `module.exports`. The intent lists
      this outcome and revision 1 recorded it under Backward compatibility while declining to check
      it — leaving an intent outcome with no check at all. This uses A7's mechanism (a recorded
      measurement) rather than adding a second assertion to the new gate, which is what
      "Deliberately not done" refuses.

## Deliberately not done

- **The CJS bundle-format check stays manual**, though `bundle-scan.ts` is now its obvious home.
  Filed as a follow-up; a gate that grows a second unrelated assertion in its first commit is how
  gates become grab-bags.
- **The statusline binary is not scanned.** Same artifact class, different loop.
