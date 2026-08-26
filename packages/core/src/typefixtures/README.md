# Type fixtures

Files here are **compiled on purpose to check that they fail**. They are excluded from the
root `tsconfig.json` project — if they were not, `bun run verify` would be permanently red.

`packages/core/src/exhaustive-guard.test.ts` runs `tsc --noEmit -p` against
`tsconfig.json` in this directory and asserts, per file:

- `*.expect-error.ts` — tsc reports the expected error code for that file
- `*.expect-clean.ts` — tsc reports **nothing** for that file

The negative control is not decoration. This loop's own spec shipped a compile-time guard of
the form `const _x: Exclude<A, B>[] = []`, which reports nothing when `Exclude` is non-empty,
because an empty array literal is assignable to `never[]`. A guard is only a guard once you
have watched it fail; `inert-empty-array.expect-clean.ts` is that bug, frozen.
