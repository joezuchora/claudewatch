/**
 * EXPECTED: TS2322 — mentioning `'timeout'`, the omitted member.
 *
 * The same guard as the two above, but against the real `FailureClass` rather than a local
 * stand-in, so it fails if the union is ever loosened (widened to `string`, say) in a way that
 * makes `Exclude` collapse to `never` for any subset. That would leave the guards in
 * `cooldown.ts` compiling forever while checking nothing.
 */
import type { FailureClass } from '../types.js';

const SOME_CLASSES = [
  'notConfigured',
  'authInvalid',
  'serviceUnavailable',
  'malformedResponse',
  'unexpectedFailure',
] as const satisfies readonly FailureClass[];

const allCovered: never = null as unknown as Exclude<
  FailureClass,
  (typeof SOME_CLASSES)[number]
>;
void allCovered;
