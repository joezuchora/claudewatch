# Intent: every published .vsix carries the build machine's absolute source path

- **ID:** 043-diagnostics-bakes-build-path
- **Stage:** 1 — Plan
- **Status:** accepted
- **Author:** the SDLC loop, from a finding filed during `sdlc/041`
- **Date:** 2026-09-11

## Problem

`packages/vscode/src/commands.ts:11` reads `__filename` to display the extension's own location:

```ts
export async function showDiagnostics(): Promise<void> {
  const path = __filename;
```

The intuition behind that line is that CommonJS resolves `__filename` at runtime, to wherever the
extension is installed on the user's machine. **That is not what the shipped bundle does.** Bun's
bundler emits a module-scope `var __filename` that *shadows* the CJS global, initialised to a string
literal fixed at build time. Measured against HEAD, on the built artifact rather than by reading:

```
$ bun run --filter claudewatch-vscode build
$ grep -n '__filename' packages/vscode/dist/extension.js
1135:  const path = __filename;
1168:var vscode3, __filename = "/home/user/claudewatch/packages/vscode/src/commands.ts", …

$ grep -o '/home/user/[^"]*' packages/vscode/dist/extension.js | sort -u
/home/user/claudewatch/packages/vscode/src/commands.ts
```

One line, one occurrence — `grep -rn '__filename\|__dirname'` over every package's `src/` and over
`scripts/` returns this and nothing else. So the blast radius is exactly one statement, and the fix
is correspondingly small. What makes it worth a loop is that the statement is wrong twice over.

### 1. It ships the build machine's filesystem layout to every user

The literal is the path of the **source file on whatever machine ran the build**. In this container
that is `/home/user/...`, which discloses little. On a developer's laptop it is
`/Users/<their-name>/...` or `/home/<their-name>/...`, and on a CI runner it is the runner's
workspace layout. Whatever it is, it is baked into the `.vsix` and shipped to everyone who installs
the extension.

This is not a `SPEC.md §12` trust-boundary violation as written — §12's invariants are about tokens,
TLS, credentials and file modes, and no token is involved. It is an **information disclosure in a
published artifact**, and the longer-term goal on the table is publishing this extension to the
Marketplace under the user's own name. A build path containing a real person's username is a poor
thing to discover after publication rather than before.

### 2. The diagnostic does not do what it says, and `SPEC.md` says it does

`SPEC.md` §10.5 (line 581) documents the command as showing *"the extension bundle path"*. The modal
labels its output **`**Extension bundle path:**`**. What a user actually sees is a path ending in
`src/commands.ts` — a **TypeScript source file that does not exist on their machine at all**, and
which is not a bundle.

The command has one job: tell a user which copy of the extension is loaded, so a bug report can say
whether they are running the build they think they are. It currently cannot answer that question for
anybody, and it answers it misleadingly rather than by failing — the string looks like a plausible
path, so a reader has no signal that it is fiction. That is the same shape as the defects loops 040
through 042 kept finding: not an absent answer, but a confident wrong one.

## Who is affected

- **Anyone who installs the extension**, once it is published: their diagnostics command reports a
  path belonging to someone else's computer.
- **Whoever publishes it** — their build-host directory layout, and plausibly their username, goes
  out in the artifact.
- **Anyone triaging a bug report**, who cannot use the one command that exists to establish which
  build is running.

## What "done" means

- The diagnostics modal reports a path that identifies the **running extension on the user's own
  machine**, or says plainly that it could not determine one. It never reports a path from the
  build machine.
- No absolute path from the build host survives in `packages/vscode/dist/extension.js`, and that is
  checked by the gate rather than by someone remembering to grep — this is a build-output property,
  so a source-level test cannot see it, and a regression would be invisible until publication.
- `SPEC.md` §10.5's description and the modal's own label agree with what the command does.
- The VS Code bundle stays CommonJS. `bun run verify` exits 0; the lint budget does not move.

## Explicitly out of scope

- **Any other `commands.ts` behavior.** The unreachable `&& cache.snapshot` guard at `:19` is
  retained verbatim by `sdlc/028`'s decision and stays retained; this loop does not revisit it.
- **The bundler's configuration in general.** If a build flag turns out to be the right fix, that is
  in scope; auditing the rest of the build for other inlined values is not.
- **Publishing, and the `joezuchora.claudewatch` rename.** Both remain the user's call.

## Notes for Stage 2

Three things the spec must settle by measurement rather than by assumption:

1. **What the replacement actually resolves to at runtime.** `showDiagnostics` is registered as a
   bare function reference (`registerCommand('claudewatch.diagnostics', showDiagnostics)`) and has
   no access to the `ExtensionContext`, so `context.extensionPath` is not reachable without a wiring
   change. `vscode.extensions.getExtension(...)` is, but depends on the extension ID matching the
   manifest — and the manifest's `publisher` is exactly what the user may yet change. Whatever is
   chosen must fail *closed and legibly* on a host where it returns `undefined`.
2. **Whether the gate can see it.** The check belongs on the built bundle, which no current test
   reads. `scripts/` already holds gates that run under `verify`; that is the likely home, and the
   spec should say how the check avoids passing vacuously when the bundle is missing or stale.
3. **A negative control.** A grep-for-absent-string check is exactly the kind that is green on an
   empty set. It needs a positive precondition in the same test, per the standing rule.
