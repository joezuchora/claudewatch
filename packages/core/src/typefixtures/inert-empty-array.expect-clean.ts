/**
 * EXPECTED: NO ERROR. This file is the negative control, and the whole reason the harness
 * exists.
 *
 * `sdlc/014`'s own spec proposed exactly this as the guard against a member missing from
 * `FAILURE_CLASSES`. It compiles clean with `'blue'` missing — an empty array literal is
 * assignable to every array type, `never[]` included — so it would have shipped as a guard
 * that never fires, in the loop whose entire subject is guards that never fire.
 *
 * Compare `array-missing-member.expect-error.ts`: same intent, same `Exclude`, one line
 * different, and that one catches it.
 */
// `export` on COLOURS below makes this a module. Without any export TypeScript treats the
// file as a global script and the fixtures collide on `Colour`, drowning the error under test
// in a pile of TS2300s.
type Colour = 'red' | 'green' | 'blue';

export const COLOURS = ['red', 'green'] as const satisfies readonly Colour[];

const allCovered: Exclude<Colour, (typeof COLOURS)[number]>[] = [];
void allCovered;
