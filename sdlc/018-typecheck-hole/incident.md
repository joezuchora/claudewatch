# Incident: `bun run typecheck` does not typecheck the gate

- **ID:** 018-typecheck-hole
- **Stage:** 6 — Maintain
- **Status:** open
- **Detected:** 2026-08-26 16:2x UTC — incidentally, while reading `tsconfig.json` for an unrelated plan
- **Severity:** high. Every "typecheck passes" claim made about `scripts/` since `sdlc/001` was vacuous.

## What happened

`tsconfig.json` excludes `scripts`. `bun run typecheck` is `tsc --noEmit`, so **nothing in
`scripts/` has ever been typechecked**. Demonstrated rather than inferred — a deliberate error
planted in `scripts/perf.ts`:

```
const _deliberateTypeError: number = "not a number";
$ bun run typecheck
$ tsc --noEmit
(clean)
```

With the exclusion removed, three real errors surface immediately, all one root cause:

```
scripts/perf.ts(212,18): error TS2550: Property 'toSorted' does not exist on type 'number[]'.
                          Try changing the 'lib' compiler option to 'es2023' or later.
scripts/perf.ts(212,28): error TS7006: Parameter 'a' implicitly has an 'any' type.
scripts/perf.ts(212,31): error TS7006: Parameter 'b' implicitly has an 'any' type.
```

## Impact

`scripts/` contains **`verify.ts` — the gate itself** — and everything `sdlc/013` built. So the
verification gate has never verified its own implementation, and the two `implicit any` errors
are exactly what `CLAUDE.md`'s "no `any`" rule exists to prevent, sitting in the repo undetected.

No user impact: `scripts/` ships nothing. The damage is to trust in every green typecheck this
project has reported for that directory, mine included — I ran `bun run typecheck` after each
`perf.ts` edit this afternoon and reported it clean. It was clean because it was empty.

## Root cause

`tsconfig.json` has excluded `scripts` since it was written. That is a defensible default for a
`scripts/` directory of throwaway helpers — and it stopped being defensible the moment
`sdlc/001` moved the **gate** in there, and again when `sdlc/013` added a tested script with its
own test file.

The exclusion was never revisited because nothing forced it to be: `bun test` *does* discover
`scripts/perf.test.ts`, so runtime failures surfaced normally and the directory felt covered.
Type coverage and test coverage came apart silently.

- **Introduced by:** the original `tsconfig.json`; made consequential by `sdlc/001` (gate moved
  into `scripts/`) and `sdlc/013` (a real script with real types)
- **Stage that should have caught it:** Design, in `sdlc/001`. Moving the gate into an excluded
  directory is precisely the kind of thing a spec's compliance pass exists to notice.
- **Why it didn't:** the gate was judged by whether it *ran* the four steps, not by whether the
  four steps covered the gate. An instrument is not usually asked to measure itself.

## Mitigation and fix

Not a mitigation — this one has a real fix, and it is small:

1. `tsconfig.json` drops `scripts` from `exclude`, so the gate typechecks itself.
2. `lib` set to `ES2023`, which is what `toSorted` needs. Bun supports it at runtime; the
   compiler config was simply stale relative to the code.
3. The two implicit `any`s go away with the `lib` fix — they were a consequence of `toSorted`
   being unresolvable, not separate defects.

**Verified by planting a type error and watching the gate go red**, which is the only evidence
that counts for a check that was previously green while blind.

## Follow-up

| Follow-up | New intent ID | Status |
|---|---|---|
| Nothing. The fix is complete and the check now covers what it claims to. | — | — |

## What we are not changing

- **`toSorted` stays.** It is correct for the `lib` this project should be on, and reverting to
  `.sort()` purely to satisfy a stale `target` would trade a real config fix for a lint
  workaround — the same shape of decision that put `toSorted` there in the first place.
- **`packages/*/dist` and `node_modules` stay excluded.** Those are genuinely not source.
