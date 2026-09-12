# Spec: take the path from the host, and let the gate read the bundle

- **ID:** 043-diagnostics-bakes-build-path
- **Stage:** 2 — Design
- **Status:** draft, pending `spec-reviewer`
- **Derived from:** [`intent.md`](./intent.md)

## Summary

`showDiagnostics` stops reading `__filename` and takes the path as a parameter, which `activate`
supplies from `context.extensionPath` — the host's own answer, not the bundler's. The modal's label
and `SPEC.md` §10.5 are corrected to describe what is actually shown. A new `verify` step reads the
**built bundle** and fails if a build-host path survives in it, because this is a build-output
property that no source-level test can see.

## What the measurements decided

Run before writing this, in a `mktemp -d` copy of the tree with the candidate fix applied, and
discarded afterwards. Every row is a command that was run, not a reading of the source.

| Measured | Result | Consequence for the design |
|---|---|---|
| Does the fix remove the literal? `grep -o '/tmp/…\|/home/user/…' dist/extension.js` after building the patched copy | **no matches** | The parameter approach works. `__filename` appears **0** times in the built output once the source stops referencing it — bun injects the shadowing `var` only because the source reads it |
| Is the bundle still CommonJS? | **14** `require(`/`module.exports` occurrences | The CJS requirement (`CLAUDE.md`) survives the change |
| What breaks under `tsc`? | **exactly 4 errors**, all `TS2554: Expected 1 arguments, but got 0` at `commands.test.ts:89,103,110,139` | The blast radius is four call sites in one test file. `extension.ts` is the only product caller |
| Does `context.extensionPath` typecheck? | **yes** — the sandbox `typecheck` reported only the four call-site errors | The property exists on this `@types/vscode`. Measured rather than assumed |
| Would a build-root scan catch **today's** bundle? | **1 occurrence**: `/home/user/claudewatch/packages/vscode/src/commands.ts` | The gate has a real positive control on the pre-fix artifact, and goes to 0 on the post-fix one |
| Does a correct bundle contain **any** absolute-path-shaped literal (`/home/`, `/Users/`, `/tmp/`, `X:\`)? | **zero** | The stronger rule R2 below is viable with **no allowlist**. Had there been legitimate matches, R2 would have needed one, and an allowlist that starts non-empty is an allowlist nobody ever empties |
| Does the stub expose a `vscode.extensions` namespace? | **no** — `grep extensions packages/vscode/src/vscode-stub.ts` is empty | **`vscode.extensions.getExtension()` is rejected.** It would need a new stub leaf (and so a `sdlc/040` pristine-inventory change), and it identifies the extension by `publisher.name` — today `claudewatch.claudewatch-vscode`. The publisher rename to `joezuchora` is explicitly the user's pending call, so an ID-keyed lookup would break on a decision this loop must not pre-empt. `context.extensionPath` depends on neither |

## Behavior

### `commands.ts`

```ts
export async function showDiagnostics(extensionPath: string): Promise<void>
```

The body's `const path = __filename` becomes the parameter. Two further changes follow from it:

- **The label is corrected.** `context.extensionPath` is the extension's **install directory**, not
  a bundle file, so the modal's `**Extension bundle path:**` becomes `**Extension path:**`. Keeping
  the old label and joining `dist/extension.js` onto the directory was considered and rejected: it
  duplicates the manifest's `main` in a second place that can silently disagree with it.
- **A missing path says so.** If the argument is empty or not a string, the modal shows the fixed
  literal `(unavailable)` rather than rendering `undefined`. The intent's "done" requires the
  command to say plainly that it could not determine a path; `undefined` printed inside a code fence
  looks like a value.

Nothing else in the function changes. In particular the unreachable `&& cache.snapshot` guard at
`:19` stays **verbatim**, as `sdlc/028` decided.

### `extension.ts`

```ts
vscode.commands.registerCommand('claudewatch.diagnostics', () => showDiagnostics(context.extensionPath)),
```

A closure, because `registerCommand` passes its own arguments to the callback and a bare reference
would hand `showDiagnostics` whatever VS Code invokes the command with.

**This is the loop's only product-source change outside `commands.ts`, and it is one line.** Note
what it means for the existing tests: `extension.test.ts` builds `ctx` as `{ subscriptions: [] }`,
so `context.extensionPath` is `undefined` there. That is harmless — the closure body runs only when
the command is invoked, and no test in that file invokes it — but it is stated here rather than
discovered, because "a test that passes for an unrelated reason" is this repo's standing hazard.

### `SPEC.md` §10.5

Line 581 reads *"shows the extension bundle path"*. It becomes the extension's **install path**, with
a one-line note that the previous wording described a value the command never produced.

## The gate

A source-level test cannot see this defect: the source says `__filename`, and only the **bundler**
turns that into a literal. So the check reads the built artifact, which means it must run **after**
`build` in `scripts/verify.ts`'s `STEPS` array (currently `… test → build → perf`; the new step goes
between `build` and `perf`).

Structured like the repo's other gates — `fence-check.ts`/`fence-check.test.ts`,
`vscode-stub-cover.ts`/`.test.ts` — as a pure function plus a thin runner, so the **logic** is tested
by `bun test` while the **artifact** is scanned by `verify`:

- `scripts/bundle-scan.ts` exports `scanBundle(text: string, buildRoot: string): string[]`, returning
  the offending literals, and a runner that reads `packages/vscode/dist/extension.js`.
- `scripts/bundle-scan.test.ts` exercises `scanBundle` against fixtures.

Two rules, because neither subsumes the other:

- **R1 — the build root.** The bundle must not contain the absolute path of the directory the build
  ran in. Catches leakage even where the build root matches no known prefix (a CI runner at `/__w/…`,
  a container at `/opt/build/…`).
- **R2 — absolute-path shapes.** No string literal containing `/home/`, `/Users/`, `/tmp/`, or a
  Windows drive prefix. Catches leakage from elsewhere on the build host, which R1 cannot see.
  Measured to have **no** legitimate matches today, so it ships with no allowlist.

**Stated limitation, rather than overclaimed:** together these catch the class of leak this loop
found. A build-host absolute path under some other root — `/srv/ci/…`, say — is caught by R1 only if
it is the build root. The gate is a net with a known mesh size, not a proof.

**The positive precondition, in the runner itself.** A grep-for-absent-string is green on an empty
set, so before reporting success the runner asserts the file exists, exceeds a size floor, and
contains the marker `claudewatch.diagnostics`. A missing, truncated, or stub bundle is a **failure**,
not a pass. This is the criterion `sdlc/026` and `sdlc/042` both had to learn by being caught.

## Data and types

Files this spec requires changing, named exhaustively so the plan's fence cannot omit one — the
omission `sdlc/042`'s first draft made, which `fenceCheck` structurally cannot catch:

| File | Change |
|---|---|
| `packages/vscode/src/commands.ts` | signature, `const path`, the label, the `(unavailable)` case |
| `packages/vscode/src/extension.ts` | the registration closure — one line |
| `packages/vscode/src/commands.test.ts` | four call sites gain an argument; new cases for the two behaviors above |
| `scripts/bundle-scan.ts` | **new** — `scanBundle` plus the runner |
| `scripts/bundle-scan.test.ts` | **new** — the fixtures and controls |
| `scripts/verify.ts` | one entry in `STEPS`, after `build` |
| `package.json` | the `bundleScan` script the step invokes |
| `SPEC.md` | §10.5's description |
| `scripts/vscode-stub-cover.test.ts` | `FLOORS['commands.test.ts']` — today `{ pass: 5, expects: 12 }` |

No new export from `packages/core`, no stub change, no new `mock.module` call, so
`mock-topology.test.ts`'s pinned inventory does not move.

## Edge cases

| Case | Expected |
|---|---|
| `extensionPath` is `undefined` (a host that omits it; the test `ctx`) | the modal shows `(unavailable)`, not `undefined` |
| `extensionPath` is `''` | same — empty is not an answer |
| The command is invoked by VS Code with its own arguments | the closure ignores them; `showDiagnostics` receives exactly the path |
| `dist/extension.js` absent when the gate runs | **failure**, named as "bundle missing", never a silent pass |
| `dist/extension.js` present but truncated or a stub | **failure** via the marker and size floor |
| A build root that legitimately contains `/tmp/` (this spec's own sandbox did) | R1 and R2 both fire. Correct: a `/tmp` build root in a shipped bundle is still a leak |
| The `&& cache.snapshot` guard | untouched, verbatim, per `sdlc/028` |

## Backward compatibility

- **`showDiagnostics`'s signature changes.** It is not exported from any package entry point —
  `grep -rn showDiagnostics` finds `extension.ts` and `commands.test.ts` and nothing else — so the
  change is internal to `packages/vscode`.
- The command ID, the manifest, and the modal's other half are unchanged.
- The VS Code bundle stays CommonJS (measured: 14 markers after the fix).
- `.oxlint-budget.json` must not move. If it does, a construct was used that the budget rejects —
  **fix the construct**, as `sdlc/042` did when `consistent-function-scoping` fired.
- `FLOORS['commands.test.ts']` moves. The new value is **derived at Stage 4 and measured**, not
  guessed here; floors are `>=`, so an under-prediction is invisible forever and a mismatch between
  the derivation and the measurement is a finding to investigate, not a number to overwrite.

## Acceptance criteria

- [ ] **A1 — the bundle carries no build-host path.** After `bun run build`, `scanBundle` reports
      **zero** findings for `packages/vscode/dist/extension.js` under both R1 and R2. The pre-fix
      artifact is on record as reporting exactly one, so this criterion is known to be falsifiable.
- [ ] **A2 — the gate is not vacuous.** `bundle-scan.test.ts` asserts the runner **fails** on a
      missing file, on a file below the size floor, and on a file lacking the
      `claudewatch.diagnostics` marker — each with a positive control in the same test showing the
      same scan passing on a well-formed fixture.
- [ ] **A3 — the command reports what it is given.** `showDiagnostics('/some/install/dir')` puts that
      exact string in the modal, asserted on the captured message rather than on a mock call count.
- [ ] **A4 — a missing path is legible.** `showDiagnostics(undefined as unknown as string)` and
      `showDiagnostics('')` both render `(unavailable)` and neither renders the text `undefined`.
      Both halves asserted: rendering `(unavailable)` somewhere while also printing `undefined`
      elsewhere would satisfy a one-sided check.
- [ ] **A5 — it discriminates.** Five mutations, each **predicted before running**, re-run at Stage 4
      rather than inherited from this document:
      (1) revert `commands.ts` to `const path = __filename` → A1 (the verify step, not a unit test);
      (2) drop the `(unavailable)` fallback → A4;
      (3) change the registration back to a bare `showDiagnostics` reference → the modal receives
      VS Code's own argument rather than the path; predicted to fail A3's sibling in
      `extension.test.ts` only if such a test exists — **it does not**, so this mutation is predicted
      to SURVIVE, and that prediction is recorded here as a known gap rather than discovered at
      Stage 4 and quietly rounded off;
      (4) delete the marker check from the runner → A2's marker case;
      (5) weaken R2 to match only `/home/` → A2's fixture for `/Users/`.
      Failing test named per mutation in `review.md`.
- [ ] **A6 — the documents agree with the code.** `SPEC.md` §10.5 and the modal's label both describe
      an install path; neither says "bundle path".
- [ ] **A7 — the gate holds.** `bun run verify` exits 0 with the new step in place; CI runs the same
      command, so the check lands in CI with no workflow edit. `.oxlint-budget.json` unchanged.
      `FLOORS['commands.test.ts']` updated to the measured value.

## Deliberately not done

- **The CJS bundle-format check stays manual.** `CLAUDE.md` records it as the one thing `verify` does
  not do for you, and this loop adds a step that reads the same file — folding it in would be two
  lines. It is still out: the intent scoped this loop to the path leak, and a gate that grows a
  second unrelated assertion in its first commit is how gates become grab-bags. **Filed as a
  follow-up**, with the note that `bundle-scan.ts` is now the obvious home for it.
- **The statusline binary is not scanned.** Same artifact class, different loop.
