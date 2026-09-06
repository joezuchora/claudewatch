/**
 * EXPECTED: TS2322 — a bare `string` assigned to a telemetry payload leaf.
 *
 * `SPEC.md §17` required this as prose for six loops, and `renderEvent`'s own comment asserted it:
 * "runtimeState and tier are constrained by their producing unions in types.ts" — the argument
 * sdlc/029-031 established is void for a value read off a cache file, written in the payload
 * builder itself.
 *
 * **Narrowing `renderEvent`'s two parameters does not deliver the guarantee.** sdlc/032's Stage 2
 * reviewer added a `newFreeText?: string` to `renderEvent`, passed it into the payload, and
 * `bun run typecheck` exited 0 — because `MetricEvent.payload` was
 * `Record<string, string | number | boolean | null>` and `string` was structurally legal. Narrowing
 * the payload's VALUE type is what closes it, and this fixture is what stops the union being
 * quietly widened back.
 */
import type { PayloadLeaf } from '../telemetry.js';

declare const freeText: string;

// A payload leaf that is not a member of any closed set this repo emits.
export const leaky: PayloadLeaf = freeText;
