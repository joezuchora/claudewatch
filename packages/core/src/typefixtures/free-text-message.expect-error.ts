/**
 * EXPECTED: TS2322 — a free-text message assigned to `FetchFailure.message`.
 *
 * This is the compile-time half of sdlc/029. `SPEC.md §12` requires redaction from all surfaced
 * errors; before 029 that held only by accident, because `client.ts`'s HTTP messages happened to be
 * constants and the network path's `err.message` happened to be generic on this runtime. The value
 * is persisted to the cache as `lastErrorMessage` and rendered in the VS Code tooltip.
 *
 * Narrowing the field to `SurfaceableMessage` means a producer that interpolates anything free-form
 * — a URL, a token fragment, a platform error string — cannot compile. That is strictly stronger
 * than a test, which has to be remembered and run. This fixture freezes the negative control so the
 * guarantee cannot be quietly widened back to `string`.
 */
import type { FetchFailure } from '../types.js';

declare const token: string;

// A producer of exactly the shape §12 forbids.
export const leaky: FetchFailure = {
  ok: false,
  status: 401,
  failureClass: 'authInvalid',
  message: `Authentication failed (401) for token ${token.slice(0, 8)}`,
};
