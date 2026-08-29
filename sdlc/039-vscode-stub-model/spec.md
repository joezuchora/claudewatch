# Spec: check that the merged `vscode` stub covers what the source actually needs

- **ID:** 039-vscode-stub-model
- **Stage:** 2 — Design
- **Status:** revised after Stage 2 review — first draft REJECTED, invariant replaced
- **Derived from:** [`intent.md`](./intent.md)

## Why this spec was rewritten

The first draft's central model — *provided = the union of the four stub factories* — is
**false**, and the Stage 2 review rejected the spec on it. I reproduced the refutation before
accepting it.

Remove `Uri` from the `statusbar`, `commands` and `tooltip` stubs, leaving it defined in
`extension.test.ts`, and run the package:

```
72 pass, 5 fail
TypeError: undefined is not an object (evaluating 'v.Uri.parse')
```

`Uri` is in the union — one stub declares it — so the union check would have exited **0 while
`bun test` was red**. Worse, that configuration is approximately the one `sdlc/028` was opened to
fix, so the guard would have been green on the defect that produced the loop that produced this
one.

The mechanism the review established, and my `Uri` run confirms: each top-level key's value comes
**wholesale from one factory**, and which factory wins is decided by bun's load order — measured
as `statusbar, telemetry-gate, manifest, extension, commands, tooltip`, neither alphabetical nor
documented. There is no instant at which a union holds for any consumer. The first draft cited
`sdlc/028`'s probe as evidence *for* the union; that probe records `PROBE has Uri: false` while
`extension.test.ts` defines `Uri`, which is a refutation of a union, and I read it as support.

**The invariant is therefore per-file, and once it is per-file the four stubs must each be
complete — which is to say identical.** Four identical objects maintained by hand is not a design;
it is the thing a shared module exists for. So the rewrite also reverses the first draft's scope
call: **consolidate now**, and let the check enforce that the consolidation stays consolidated.
The deferral rested on a risk that does not apply — sharing the `vscode` stub touches neither
`./core-bridge.js` nor `./extension-bridge.js` nor the `globalThis.fetch` thrower, so the standing
live-credential hazard is not in this path.

## Summary

The four hand-maintained `vscode` stubs are replaced by **one** shared stub module that all four
test files install. A new harness check, wired into `bun run verify`, asserts that exactly one
`mock.module('vscode', …)` factory exists in the package and that it provides every `vscode`
member the **source** files use in a **value** position. Load order stops mattering by
construction, and the check stops it silently coming back. Two stale docstring claims are
corrected. No source file under `packages/vscode/src` changes behaviour.

## Behavior

### What the check does

A new `scripts/vscode-stub-cover.ts`, wired into `verify` after `fenceCheck`:

1. **Required set.** Walk `packages/vscode/src/**/*.ts`, excluding `*.test.ts`, with the
   **TypeScript compiler API** (`ts.forEachChild` + `ts.isTypeNode`), and collect `vscode.<a>` and
   `vscode.<a>.<b>` references in a **value** position, classified **per occurrence** and unioned.

   *Revised from a syntactic rule after review.* The proposed rule — "a type position is after
   `:`, in `implements`/`extends`, or in a type-only import" — is unsound on four shapes that are
   in this tree today: a cast-mediated read (`extension.ts:45`), a member chain split across lines
   (`extension.ts:50-52`, which yields bare `workspace` and loses `workspace.getConfiguration`), the
   same member in both positions two lines apart (`tooltip.ts:39-40`), and a return type after `=>`
   rather than `:` (`extension.ts:78`). It also has a false-positive direction: a future
   `x as vscode.StatusBarItem` has no preceding colon and would make the gate demand a runtime stub
   for an interface. The first draft rejected the compiler API as "much heavier"; the package is
   four files and ~580 lines, and enumerating the type-position keywords correctly is the
   compiler's job by definition. A member is a value
   position when it is called, constructed, or read as data; it is a **type** position when it
   appears after `:` in a type annotation, in `implements`/`extends`, or inside a type-only
   import. Measured on the tree today: `ExtensionContext`, `StatusBarItem` and `Disposable` are
   type-only and must **not** be required; `MarkdownString` and `ThemeColor` appear under `new`
   and must be.
2. **Uniqueness.** Assert that exactly **one** `mock.module('vscode', …)` call site in
   `packages/vscode/src/**` supplies a factory body of its own. The four test files install the
   shared stub; a fifth file writing its own inline factory is a failure, because that is how the
   per-file divergence comes back.
3. **Provided set.** Read the shared stub module's exported object — top-level keys and their
   first-level sub-keys. Not a union across files: the union model is refuted above.
4. **Compare.** Every required member must appear in the provided set. A missing member is a
   failure naming the member **and the source file that needs it** — the message a developer gets
   today is 21 failures in two files that do not contain the cause.
4. **Report the other direction as information, not failure.** A member provided by some stub and
   required by no source file is printed as a surplus line. It does not fail: a stub may legitimately
   carry a key for a consumer that is not `vscode.*`-shaped, and turning surplus into an error would
   make the check hostile to ordinary test scaffolding.

### What the check deliberately does not do

- **It does not verify which file wins a key.** After consolidation there is one factory, so the
  question the first draft called "not well-formed" stops existing rather than being answered.
- **It does not verify behaviour of a stub member**, only presence. A stub whose
  `createStatusBarItem` returns nonsense passes; the tests that use it are what catch that.
- **It does not run the tests.** It is static, so it stays fast and cannot itself perturb the
  process-wide mock state it is reasoning about.

### The two docstring corrections

`statusbar.test.ts:82` and `tooltip.test.ts:33` both assert that
`window.showInformationMessage` and `window.showErrorMessage` are "both reached from
`commands.ts`". Measured: `commands.ts` reaches `window.showInformationMessage`,
`env.openExternal` and `Uri.parse`. **`showErrorMessage` appears in no source file at all** — only
in two stubs that define it and the two docstrings that claim it is needed. The sentence is
corrected in both places to say what the code does.

The two stubs keep their `showErrorMessage` definitions. Removing them is a separate judgement
about test scaffolding, and the new check reports them as surplus rather than requiring a
decision now.

## Data and types

```ts
export interface Member { object: string; property?: string }   // `window`, `window.createStatusBarItem`
export interface CoverageResult {
  required: Member[];      // value positions in source, sorted
  provided: Member[];      // union across stub factories, sorted
  missing: Member[];       // required minus provided — the failure set
  surplus: Member[];       // provided minus required — informational
}
export function requiredMembers(files: readonly SourceFile[]): Member[]
export function providedMembers(files: readonly SourceFile[]): Member[]
export function compare(required: readonly Member[], provided: readonly Member[]): CoverageResult
```

`SourceFile` is `{ path, text }`, matching `scripts/mock-topology.ts` so the two harness scripts
read the tree the same way. A member with no `property` is a bare top-level requirement.

## Edge cases

| Case | Expected |
|---|---|
| `vscode.ExtensionContext` in a type annotation only | **Not** required |
| `vscode.MarkdownString` under `new` | Required |
| `vscode.StatusBarAlignment.Right` | Required as `StatusBarAlignment.Right`, not bare `StatusBarAlignment` |
| A member required by source and provided by no stub | Failure, naming member and source file |
| A member provided by a stub and required by nothing | Surplus line, exit 0 |
| A source file with no `vscode.` reference at all | Contributes nothing; not an error |
| A test file with no `mock.module('vscode', …)` | Contributes nothing; not an error |
| The string `vscode.` inside a comment or docstring | **Not** required — the two docstrings this loop corrects both contain `window.showErrorMessage`, so a check that scanned comments would require the very member it is meant to report as absent |
| The string `vscode.` inside a string literal | Not required, same reason |
| No test file mocks `vscode` at all | Every required member is missing; the failure is loud rather than a silent empty-set pass |

The comment and string-literal rows are the ones most likely to make this check vacuous or
self-contradictory, so both get tests.

## What the review found that this rewrite absorbs rather than answers

- **The provided-set scanner could not have read `statusbar.test.ts`.** It declares
  `const vscodeMock = {…}` and passes `() => vscodeMock`, so a scanner collecting keys from a
  factory body gets an identifier and zero keys — then A8 ("an empty provided set fails loudly")
  would have made `verify` red on today's tree, contradicting A1. Consolidation removes the shape:
  the check reads one named module, not a factory body. If a future stub reintroduces an inline
  factory, A15 fails it.
- **Non-recursive glob.** `packages/vscode/src/*.ts` misses subdirectories. There are none today,
  which is exactly the argument `mock-topology.ts:29` makes about its own equivalent hole. Behavior
  1 now uses `**`.
- **`normalizeForScan` reuse** (`mock-topology.ts:138`) is moot for the required set now the
  compiler API parses it, and remains relevant to nothing else here.

## Backward compatibility

- No behaviour of `packages/vscode` changes; no file under `packages/vscode/src` that is not a
  test is edited.
- **The four stubs ARE restructured** — this is the change. Every test must still assert exactly
  what it asserts today, and the whole package must stay green, alone and together. Any test whose
  behaviour changes is a finding, not an adjustment.
- Each of `packages/vscode/src/*.test.ts` must pass **run alone** as well as in the package run.
  That is `intent.md`'s fifth outcome, dropped by the first draft without a note, and it is the
  guard that would have caught `sdlc/025`. It becomes a criterion below.
- `verify` gains a step. It is static text analysis over ~10 files, so its cost is comparable to
  `fenceCheck`'s.
- The check must pass on the tree **as it stands today**. If it does not, that is a finding about
  the tree, and it gets recorded in `review.md` and fixed — not accommodated by weakening the rule.

## Acceptance criteria

- [ ] **A1 — the check passes on the tree as this loop leaves it.** Verified by `bun run verify`.
      The first draft wrote "or the tree is fixed", which made it unfalsifiable in both branches.
- [ ] **A1b — every vscode test file passes run alone.** `bun test packages/vscode/src/<f>.test.ts`
      exits 0 for each of the five, checked by a script rather than by my remembering. This is the
      `sdlc/025` guard and it is the one criterion here that is about the consolidation's real
      risk rather than about the checker.
- [ ] **A2 — it fails when a needed key is absent.** Removing `Uri` from the shared stub makes
      the check fail, naming `Uri.parse`. Verified against the real tree by a test that reads the
      stub with `Uri` removed from an in-memory copy — no mutation of the checked-in file.

      Restated: the first draft named "delete `env` from `statusbar.test.ts`" as the mutation,
      which its own union model could not have caught (three other stubs define `env`), and
      demanded the failure name `env.isTelemetryEnabled` — a member that **does not exist as a
      `vscode.env.X` token in any source file**. `extension.ts:45` reads it off a parenthesised
      cast, `(vscode.env as { isTelemetryEnabled?: unknown }).isTelemetryEnabled`, and the only
      literal occurrence in the tree is a JSDoc comment at `telemetry-gate.ts:19` — which A6
      strips. A2 and A6 contradicted each other outright.
- [ ] **A3 — the failure names the source file that needs the member.** The message must say
      `Uri.parse` is required by `commands.ts`. Today the same defect produces 5 failures in
      `commands.test.ts` and 16 in `extension.test.ts`, none of which name a cause. Verified by
      asserting the message content.
- [ ] **A4 — type positions are not required.** A fixture using `vscode.ExtensionContext` only as
      an annotation produces no requirement. Verified by unit test; fails against an implementation
      that greps `vscode\.[A-Za-z]+` blindly.
- [ ] **A5 — constructors are required.** A fixture with `new vscode.ThemeColor(...)` produces the
      requirement. Verified by unit test. A4 without A5 would pass on an implementation that
      required nothing at all.
- [ ] **A6 — comments and string literals are ignored.** A fixture whose only `vscode.foo` is
      inside a `//` comment, a `/* */` block and a string literal produces no requirement.
      Verified by unit test. This is the criterion the real tree needs: the docstrings this loop
      corrects mention `showErrorMessage`, so without it the check would demand the member it
      exists to report as unneeded.
- [ ] **A7 — surplus does not fail.** A fixture providing a member nothing requires exits 0 and
      prints a surplus line. Verified by unit test.
- [ ] **A8 — an empty provided set fails loudly.** Fixtures with source requirements and no stub
      at all produce failures, not a vacuous pass. Verified by unit test.
- [ ] **A9 — sub-keys are distinguished from their parents.** Providing bare `window` does not
      satisfy a requirement for `window.createStatusBarItem`. Verified by unit test; this is the
      difference between a check and a formality.
- [ ] **A10 — the corrected docstrings say what the code does.** Both files assert
      `showInformationMessage` is reached from `commands.ts` and no longer assert
      `showErrorMessage` is. A phrase-pin, kept only as a **secondary** check to A17 — and note a
      negative pin on `showErrorMessage` is unsatisfiable while the stub still defines the key.
- [ ] **A12 — the check is actually in the gate.** `scripts/verify.ts`'s `STEPS` contains
      `vscodeStubCover` between `fenceCheck` and `test`, **and** root `package.json` declares a
      `vscodeStubCover` script. Asserted by a test over `verify.ts`'s source. `verify.ts` records
      the trap in its own comment — steps must be package scripts, not `scripts/*.ts` paths,
      because `scripts/env.test.ts`'s sandbox stubs steps by script name — and `sdlc/033` shipped
      it wrong once.
- [ ] **A13 — a failure fails the process.** A fixture tree missing a member makes the CLI exit
      non-zero, asserted on the **exit code**, not on `compare()`'s return value. Without this,
      A1 and A11 are both satisfied by a script that always exits 0.
- [ ] **A14 — the sandbox stays green.** `scripts/env.test.ts`'s sandbox `package.json` gains the
      new script name and its four cases still pass.
- [ ] **A15 — one factory, and the check says so.** A fixture with two inline
      `mock.module('vscode', …)` factories fails, naming both files.
- [ ] **A16 — a present-but-undefined key is not provided.** A stub with `Uri: undefined` fails
      for `Uri.parse`. This is the shape both of this loop's real mutations produced —
      `TypeError: undefined is not an object` — and a key-collecting scanner counts it as present.
- [ ] **A17 — the docstring claim is checked against the code, not pinned as a phrase.** A test
      computes `requiredMembers()` over `commands.ts` and asserts it contains
      `window.showInformationMessage`, `env.openExternal` and `Uri.parse`, and does **not** contain
      `window.showErrorMessage`. A phrase-pin passes the moment the phrase is typed;
      `scripts/env.test.ts:312` records that exact weakness from `sdlc/021`.
- [ ] **A11 — the gate is green** and the `oxlint` warning set is unchanged against
      `.oxlint-budget.json`. Verified by `bun run verify`.

**Which criteria are evidence and which are fences.** A2, A3, A6 and A9 fail against a plausible
wrong implementation of this spec. A4, A5, A7, A8 fence the edges. A1, A10 and A11 are state
assertions about the tree. None of them fail against *today's* tree, because today's tree has no
check at all — this loop adds a guard rather than fixing a live defect, and saying otherwise
would overstate it.

## Rejected alternatives

- ~~**Consolidate the four stubs into one shared module.**~~ **Adopted** — it is now the design.
  The first draft deferred it on the grounds that it "changes what four test files resolve at load
  time" and that a mistake would be expensive because an `extension.test.ts` without its own
  `./core-bridge.js` mock makes a live authenticated request. The second half is true and
  irrelevant: consolidating the **`vscode`** stub touches neither `./core-bridge.js` nor
  `./extension-bridge.js` nor the `globalThis.fetch` thrower. The first half is the point of the
  change — load order is exactly what must stop mattering.
- **Keep four stubs and enforce per-file completeness.** The other sound option, and the one the
  review offered first. Rejected because a per-file invariant forces every stub to carry every
  member, which makes the four objects identical — and four identical hand-maintained objects is
  the problem restated, not solved. One module is the same invariant with nothing to keep in sync.
- ~~**Make the stubs a literal superset of each other.**~~ Moot once there is one stub. Recorded
  because the first draft rejected it with the wrong reason: it called the union "what has to
  hold", and the union is precisely what does not.
- ~~**Use the TypeScript compiler API.**~~ **Adopted** — see Behavior 1. The rejection reasoned
  that the repo's other harness scripts are hand-rolled, which is true and was the wrong
  comparison: `mock-topology.ts` and `fence-check.ts` scan for *tokens*, where a syntactic rule is
  the whole job. This check has to decide *type versus value*, which is a question about the AST.
  Four shapes in the tree today defeat the syntactic rule, and A4/A5 as first drafted used
  disjoint fixtures and would both have passed an implementation that classifies per member rather
  than per occurrence — so the criteria named to catch it would not have.
- **Fail on surplus.** Would force a decision about two `showErrorMessage` definitions that harm
  nothing, and would make the check hostile to ordinary scaffolding.
- **Extend `scripts/mock-topology.ts` instead of adding a script.** Its rules are about *local*
  specifiers and code under test; `vscode` is a bare specifier it deliberately ignores. Loop 026
  built R1 and R2 against specific observations, and editing them as a side effect of a different
  concern is how a guard stops meaning what it says.

---

**Next stage:** Build — run `/sdlc-plan 039-vscode-stub-model` to turn this into `plan.md`.
