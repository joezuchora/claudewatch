/**
 * The view of @claudewatch/core for `commands.ts`, and only `commands.ts`.
 *
 * Why this exists, stated narrowly because a wider claim would be false: `commands.ts` reached core
 * with `await import('@claudewatch/core')`, making it a fourth direct consumer standing outside the
 * arrangement the other three bridges implement. A test that mocks '@claudewatch/core' replaces the
 * real module for packages/core's own tests too — `mock.module` is process-wide and
 * `mock.restore()` does not undo it (sdlc/001, at the cost of 127 tests).
 *
 * What this does NOT buy: safety in mocking. `scripts/mock-topology.ts:25` is explicit that a
 * module with exactly one non-test importer still contaminates every test reaching it through that
 * importer, and `extension.ts` imports `./commands.js` both statically (:23) and dynamically (:99),
 * so `extension.test.ts` reaches this module through `commands.ts`. The sdlc/028 spec reviewer
 * probed for a live leak in both file orders and could not reproduce one for this topology, while
 * confirming the mechanism still fires on a synthetic pair on bun 1.3.11. Not a verified defect;
 * not a verified guarantee either. An earlier draft of the spec claimed "one importer makes it safe
 * to mock" and that claim is contradicted by the guard it cited.
 *
 * One importer is still required, so loop 026's R1 rule stays green — asserted by
 * `scripts/mock-topology.test.ts`'s A1(b), not by this docstring.
 *
 * Value re-binding, not `export ... from`: a static re-export keeps the mock linked to the original
 * module and the contamination survives.
 *
 * Re-exports only — logic here would violate SPEC.md §8.2.
 */
import * as core from '@claudewatch/core';

export const readCache = core.readCache;
export const formatTooltip = core.formatTooltip;

export type { CacheEnvelope } from '@claudewatch/core';
