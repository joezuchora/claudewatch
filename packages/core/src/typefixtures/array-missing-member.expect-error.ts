/**
 * EXPECTED: TS2322 — `Exclude` is non-empty, so it is not assignable to `never`.
 *
 * The shape of `FAILURE_CLASSES`'s companion guard: an `as const satisfies readonly T[]` array
 * that is missing a union member. `satisfies` alone does NOT catch this — it only rejects an
 * array member that is not in the union, never a union member the array lacks. The assignment
 * below is the half that catches the omission.
 */
// `export` on COLOURS below makes this a module. Without any export TypeScript treats the
// file as a global script and the fixtures collide on `Colour`, drowning the error under test
// in a pile of TS2300s.
type Colour = 'red' | 'green' | 'blue';

export const COLOURS = ['red', 'green'] as const satisfies readonly Colour[];

const allCovered: never = null as unknown as Exclude<Colour, (typeof COLOURS)[number]>;
void allCovered;
