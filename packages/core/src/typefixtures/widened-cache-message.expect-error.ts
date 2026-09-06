/**
 * EXPECTED: exactly FOUR TS2322s, one per narrowed site, each naming `SurfaceableMessage`.
 *
 * `free-text-message.expect-error.ts` freezes the PRODUCER type (`FetchFailure.message`).
 * This freezes the four sites sdlc/030 narrowed downstream of it — the field actually
 * persisted, the two writers, and the shape actually rendered.
 *
 * It exists because sdlc/030's A3 shipped as a grep, and a grep is defeated by spelling. The
 * plan-to-diff audit demonstrated it: rewriting the field as `null | string` — semantically
 * identical to the widening the criterion exists to catch — left `tsc` at 0, the suite at 824
 * pass, and A3's grep silent. Worse, A3 was never wired into `verify` or CI at all; it lived
 * as prose in a review document. A fixture fails on the SEMANTICS regardless of spelling, and
 * it runs inside `bun test`, which `verify` runs.
 *
 * The count is asserted, not just "at least one". With four assignments in one file, a
 * `greaterThan(0)` assertion stays green while three of the four quietly widen.
 */
import type { CacheEnvelope } from '../types.js';
import type { makeCacheEnvelope } from '../cache.js';
import type { enterCooldown } from '../cooldown.js';
import type { LastErrorInfo } from '../format.js';

// Free text off a cache file — the value this whole loop is about.
declare const fromDisk: string;

// 1. The field persisted in the envelope.
export const persisted: CacheEnvelope['lastErrorMessage'] = fromDisk;

// 2. The writer that mints a new envelope.
export const written: Parameters<typeof makeCacheEnvelope>[4] = fromDisk;

// 3. The writer that stamps a cooldown onto an existing one.
export const cooled: Parameters<typeof enterCooldown>[3] = fromDisk;

// 4. The shape handed to the renderer (format.ts:405, tooltip.ts:51).
export const rendered: LastErrorInfo['message'] = fromDisk;
