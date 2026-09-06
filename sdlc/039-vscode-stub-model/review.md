# Review: 039-vscode-stub-model

- **ID:** 039-vscode-stub-model
- **Stage:** 5 — Deploy
- **Derived from:** [`plan.md`](./plan.md)
- **Range reviewed:** `b00bd4e..ced2914`, `sdlc(039)` commits only

Both reviewers ran and both are folded in. Neither returned clean.

## Commits

| Commit | What |
|---|---|
| `dd438e8` | intent — three files document a mock model I cannot reproduce |
| `8766e6c` | intent correction — the composite is real and I framed it wrong |
| `bcbba8d` | spec, first draft |
| `310eb6f` | intent correction — my correction of the docstring's number was itself wrong |
| `461bbba` | spec revision 1 — the union model was false, so consolidate instead |
| `a7715f4` | plan |
| `e7fcbc2` | Stage 4 correction — six vscode test files, not five |
| `9666821` | plan — what each stub actually needs from the shared module |
| `856f295` | implementation half 1 — one shared stub |
| `13ee4ca` | implementation half 2 — the `vscodeStubCover` gate step **(pushed red)** |
| `d4c1f9d` | fix — green the gate `13ee4ca` left red |
| `fc45b6b` | plan-to-diff remediation |
| `ced2914` | security remediation |

## The loop in one line

The queue item was "make the vscode stubs an actual superset, or share one". Measurement
dissolved the first half (they already were a top-level superset), refuted the model the spec was
built on, and ended with one shared stub plus a gate that keeps it one. **Four of this loop's
findings are corrections to claims I made earlier in the same loop**, which is the honest summary
of what it cost.

## Pass 1 — Bugs and logical errors

Reviewed by me against `spec.md` and `SPEC.md`.

### P1-1 · **blocking** · I pushed a commit with a red gate · **fixed** (`d4c1f9d`)

`bun run verify` printed `exit=1` on `lintBudget` directly above the commit I then made. I had
chained the commit after a `;` instead of gating on the status, and did not read output that was
on screen. `13ee4ca` reached CI red.

Every subsequent commit gated on the exit code and refused while red — which is how the two
follow-on failures (`fence-check.test.ts`'s pinned script list, `mock-topology.test.ts`'s pinned
inventory) were caught before pushing rather than after. The mechanism was available the whole
time; I just did not use it until it had already cost something.

### P1-2 · **minor** · no test drives `onDidChangeTelemetryEnabled`'s subscription · **recorded, not fixed**

The stub now provides it (see S-1), so the branch at `extension.ts:75-79` is *reachable*. Nothing
exercises it. Adding that test means asserting a disposable is registered and a config recompute
fires, which is a behaviour test for `extension.ts` rather than for this loop's subject. Queued.

## Plan-to-diff audit

Run by the `plan-to-diff-auditor` over `b00bd4e..d4c1f9d`. Verdict: **excursions recorded**. No
file outside the fence; the fence is fourteen literal paths with no globs.

### D-1 · **blocking** · A13 shipped as nothing, and I skipped the mutation that would have caught it · **fixed** (`fc45b6b`)

Reproduced before fixing: making the CLI unconditionally `process.exit(0)` left **all 22 tests
green**. A13 exists in the spec precisely so that A1 and A11 cannot be satisfied by a script that
never fails, and it had no test at all.

The plan listed that mutation as **M7** and predicted it would kill A13. I ran six mutations and
M7 was not one of them. This is the repo's recorded "an acceptance criterion shipped as nothing"
defect, produced by skipping the one check written down to prevent it.

### D-2 · **blocking** · the gate claimed "exactly one factory" and enforced "zero inline" · **fixed** (`fc45b6b`)

Demonstrated by the audit: strip the factory from every test file and the CLI still exits 0 while
the package would be entirely red. `inlineFactories` became `vscodeInstallers`, returning both
lists; the CLI now fails on zero shared installers as well as on any inline one.

**What it still cannot do, established by measurement rather than assumed:** removing *one* file's
installer while others keep theirs exits 0, because a static scan cannot know which files need
`vscode`. `every vscode test file passes run alone` catches it — verified, `tooltip` alone then
fails with `Cannot find package 'vscode'`. That division of labour is now stated in the code.

### D-3 · **major** · A2's stated method was absent · **fixed** (`fc45b6b`)

The spec required a test reading the checked-in stub with `Uri` removed in memory. No test read
the real stub at all; the mapped test used synthetic `compare()` input. The property held — the
audit confirmed by hand — but the check the criterion named did not exist.

### D-4 · **major** · a side-effecting reset at module scope · **fixed** (`fc45b6b`)

`extension.test.ts` called `resetVscodeStub()` at import time as well as in `beforeEach`. A
load-time mutation of a process-wide shared singleton is the exact hazard class this loop exists
to close, sitting in the loop's own diff.

### D-5 · **minor** · A15 promised "naming both files" and asserted one · **fixed** (`fc45b6b`)

### D-6 · **minor** · four residue items · **fixed** (`fc45b6b`)

A dead `Uri` member in `VscodeSinks`; a flat `readdirSync` in a test where the CLI walks
recursively; an undocumented `--list` flag; `spec.md` still saying "five" in one place after the
six-file correction.

### D-7 · **minor** · the fence-amendment record overstated its own discipline · **accepted**

`plan.md` says the amendment landed "before the edits". Git shows it in the *same* commit as the
edit, after `13ee4ca` had already broken the pin while the gate was red. True of the final edit,
not of the change that necessitated it. Left as written with this note rather than retrofitted —
the plan's claim and the git history disagreeing is itself the record.

### D-8 · **not a defect** · `tooltip.test.ts` does not call the reset

Consistent with the plan's own table ("safe either way"). See S-5.

## Pass 2 — Security and vulnerabilities

Run by the `security-reviewer` over `b00bd4e..fc45b6b`. **Nothing blocking.**

### S-1 · **major** · the gate was blind to cast-wrapped reads, and I had claimed the opposite · **fixed** (`ced2914`)

`extension.ts:45` reads `(vscode.env as { isTelemetryEnabled?: unknown }).isTelemetryEnabled`. My
walker climbed to `node.parent` without unwrapping the `AsExpression`, recorded bare `env`, and
lost the sub-key — so the gate reported `env.isTelemetryEnabled` as **surplus**, telling a
maintainer the member gating telemetry was dead weight in the stub.

**This corrects a claim of mine.** `fc45b6b`'s predecessor commit says the checker "settles a
disagreement in the reviewer's favour" about that member not being required. It is required. The
Stage 2 reviewer's *observation* — that no `vscode.env.X` token appears in the text — was correct;
the conclusion I drew from my own tool was an artifact of the tool, presented as the compiler
settling the matter. Measured blind spots: `(x as T).y`, `x!.y`, `(x).y` all lost the sub-key;
`x["y"].z` and `import * as vs` were invisible entirely.

Fixed by unwrapping `AsExpression`/`Parenthesized`/`NonNull` and resolving the namespace-import
binding. The fixed walker immediately found `env.onDidChangeTelemetryEnabled` used by
`extension.ts` and absent from the stub — a true coverage gap. It is guarded by
`typeof === 'function'` so it fails closed; added to the stub, with P1-2 recording that no test
drives it.

### S-2 · **minor** · `mockClear` preserves an overridden implementation · **fixed** (`ced2914`)

Measured on bun 1.3.11: `mockClear()` keeps a `mockImplementation`, `mockReset()` drops it.
Nothing overrides those two mocks today, so this was latent — but one file's override would have
survived into every later file, feeding `extension.ts`'s config read.

### S-3 · **minor** · a FIFO named `x.ts` hangs the gate · **fixed** (`ced2914`)

`readSources` read anything ending in `.ts`. `readFileSync` on a FIFO blocks forever — bounded by
`verify`'s 300s step timeout, unbounded when the step runs alone. Now `entry.isFile()`.

### S-4 · **minor** · the fixture trees leaked temp directories · **fixed** (`ced2914`)

Three per run; 18 had accumulated. `0700` with synthetic contents, so hygiene rather than
exposure.

### S-5 · **minor** · the reset is opt-in per file · **recorded, not fixed**

`tooltip.test.ts` imports the stub and never resets, and `commands.test.ts` leaves recording sinks
on two leaves relying on the *next* file's `beforeEach`. The reviewer traced every `vscode.*` value
use in the source and none of the un-reset leaves gates network or filesystem, so this is not
exploitable now. The clean fix — have the gate assert every importer also resets — is a real
change to what the gate checks and belongs in its own loop.

### S-6 · **minor** · a negative assertion with no positive control · **fixed** (`ced2914`)

A regex asserted *not* to match, with nothing proving the regex could match anything. A typo in
the pattern would have made it green forever.

### S-7 · **informational** · argv path and absolute paths in stderr · **cleared**

The CLI accepts a directory from argv and prints an absolute path on one error path. The reviewer
confirmed by seeding a fake token behind a symlink that only identifier names and basenames are
ever printed, and that the step is not `junit: true`, so nothing reaches the telemetry spool.
§17 is not engaged.

## Pass 3 — Compliance

- No product source file changed. The diff is test files, one test-only stub module, one dev
  script, and a `verify` step registration.
- The built extension bundle is byte-identical to before, still CommonJS, with **0** occurrences
  of `bun:test`, `vscodeStub` or `resetVscodeStub`. `.vscodeignore` excludes `src/`, so the stub
  does not ship in the `.vsix` either.
- No `SPEC.md` amendment. Nothing in the change touches §7, §9, §12 or §17's substance.
- Fence amended twice, both recorded in `plan.md`: `fence-check.test.ts` added; a
  `mock-topology.test.ts` amendment added and then **reverted**, because padding that inventory
  would have recorded a falsehood — the new test file mocks nothing, its fixture *strings* merely
  look like it. The fixtures are assembled from parts instead.

## Mutation testing

Predictions were written before each run.

| # | Mutation | Predicted | Observed | Verdict |
|---|---|---|---|---|
| M1 | remove `Uri` from the one stub | 1 fail alone, 1 together, identical | exactly that | ✓ — and the asymmetry it replaces was 5 failures together, 0 alone |
| M2 | second inline factory | the one-factory check fails | 3 fail incl. that one | ✓ |
| M3 | `Uri: undefined` | CLI fails | 2 fail incl. the CLI | ✓ |
| M4 | per-member classification | A5b fails | **zero** | **prediction wrong** — see below |
| M6 | remove the step from `STEPS` | the wiring test fails, `verify` still exits 0 | exactly that | ✓ |
| M7 | CLI always exits 0 | *(never run in Stage 4)* | 22 pass — A13 absent | **the skipped one, D-1** |
| M8 | empty `resetVscodeStub()` | only the run-alone test fails | exactly that | ✓ — the criterion that matters |
| M9 | bare parent satisfies a sub-key | that criterion fails | exactly that | ✓ |
| M7′ | re-run after the fix | 3 fail | **2** fail | prediction wrong — a test asserting exit 0 cannot be killed by always exiting 0 |
| N1 | plain `node.parent` | the cast test fails | exactly that | ✓ |
| N2 | hardcode the `vscode` binding | 2 fail | exactly that | ✓ |
| N3 | `mockClear` for `mockReset` | **zero** | zero | ✓ prediction — recorded as latent, not claimed as a kill |

### M4 · the criterion is structurally satisfied, not mutation-verified

The mutation was meant to express per-member rather than per-occurrence classification. It could
not: under the compiler-API design, type and value uses are different AST node kinds, so the
walker never sees a type occurrence and there is no per-member alternative to mutate into. The
defect class the criterion guards against cannot exist in this implementation — a good outcome,
recorded as such rather than as a kill.

## Acceptance criteria

All met. 30 tests in `scripts/vscode-stub-cover.test.ts`; `bun run verify` exits 0.

| Criterion | Test |
|---|---|
| A1, A11 | `bun run verify` exits 0, lint budget unchanged |
| A1b | `every vscode test file passes run alone` — six files, count asserted |
| A2 | `the real stub, with Uri removed in memory, no longer covers commands.ts` |
| A3 | `a missing member makes the CLI exit non-zero` (names member and file) |
| A4 | `a type-only reference is not required` |
| A5 | `a constructed reference is required` |
| A5b | `the same member in both positions is required` |
| A6 | `comments and string literals contribute nothing` (has a positive precondition) |
| A7 | `a surplus member is reported, not failed` |
| A8 | `an empty provided set fails loudly rather than passing vacuously` |
| A9 | `a bare parent does not satisfy a sub-key requirement` |
| A10 | see below — **met differently from how the spec worded it** |
| A12 | `verify runs the step, and package.json declares it` |
| A13 | `a missing member makes the CLI exit non-zero` + `a covered fixture tree exits 0` |
| A14 | `scripts/env.test.ts`'s four sandbox cases |
| A15 | `two files building their own factories are BOTH named` |
| A16 | `a key defined as undefined is not provided` |
| A17 | `commands.ts requires showInformationMessage and not showErrorMessage` |

**A10 is met differently from its wording, and that is a finding, not a pass.** The spec said both
files would "assert `showInformationMessage` is reached from `commands.ts`". They assert nothing of
the kind: the paragraphs making the stale claim were **deleted along with the inline factories that
carried them**, not rewritten. `plan.md` says the claims "are corrected", which overstates it. A17
is the real check and computes over the actual `commands.ts`.

## Findings recorded and not fixed

| # | What | Why not here |
|---|---|---|
| P1-2 | No test drives `onDidChangeTelemetryEnabled`'s subscription branch | A behaviour test for `extension.ts`, not for this loop's subject |
| S-5 | The reset is opt-in per file | The fix changes what the gate checks; own loop, own fence |
| D-7 | The fence-amendment record overstates its timing by one commit | Left as written — the disagreement between claim and history is the record |
| — | `requiredMembers` cannot see destructuring (`const { env } = vscode`) | Measured. Not present in this package; a real limit of a syntactic walk, and the compiler's type checker would be needed to close it |
| — | `mock-topology.ts` cannot tell a `mock.module` call from the same text in a string literal | Re-discovered here; `mock-topology.test.ts:227` already records it |

## Queue additions

1. A test for the `onDidChangeTelemetryEnabled` subscription branch.
2. Make `resetVscodeStub()` non-optional — have `vscodeStubCover` assert every file importing the
   stub also calls the reset.
