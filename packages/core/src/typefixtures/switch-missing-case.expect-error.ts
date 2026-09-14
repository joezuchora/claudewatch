/**
 * EXPECTED: TS2322 — the `never` fallback rejects the unhandled member.
 *
 * The shape of `failurePolicy`, `statusLessClassOf` and `errorLineFor`, reduced to the part
 * under test: an exhaustive `switch` over a closed string union, with a case deliberately
 * missing. If this file ever compiles, all three of those switches have stopped being
 * exhaustive checks and have become ordinary switches with an unreachable tail.
 */
type Colour = 'red' | 'green' | 'blue';

export function widthOf(colour: Colour): number {
  switch (colour) {
    case 'red':
      return 1;
    case 'green':
      return 2;
    // 'blue' deliberately absent.
  }
  const unhandled: never = colour;
  throw new Error(String(unhandled));
}
