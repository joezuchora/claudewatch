/**
 * Environment switches for the development gate.
 *
 * Separate from `junit.ts` deliberately — that module parses junit XML, and a consent switch has
 * no cohesion with it. Separate from `verify.ts` because `verify.ts` executes on import, so
 * anything tested has to live beside it rather than in it (sdlc/020's recursion lesson).
 */

/** The variable name, exported so tests and docs cannot drift from the code. */
export const VERIFY_METRICS_ENV = 'CLAUDEWATCH_VERIFY_METRICS';

/**
 * Whether `bun run verify` may write a `verify_run` event to the local spool.
 *
 * **Default: off.** The first draft of sdlc/021 argued for on-by-default, on the premise that the
 * gate "runs only when someone types `bun run verify`". That premise was false —
 * `deploy/systemd/claudewatch-sdlc-loop.service` runs it hourly and unattended — and the
 * counterfactual built on it ("off-by-default would have collected nothing") assumed the person
 * who wrote that unit would never add one line to it. The unit now sets this to `1` explicitly,
 * so the continuous series is unaffected and a contributor who clones the repo is not recorded
 * without asking.
 *
 * The token table is a copy of `parseBooleanEnvValue` in `packages/core/src/config.ts`, not an
 * import: `verify.ts` must not depend on core, because a syntax error there would stop the gate
 * before it could report the syntax error. `env.test.ts` asserts the two agree — the test imports
 * core, the gate does not.
 *
 * An unrecognised value falls back to the default, which is the fail-closed direction for
 * consent. But it fails closed against someone trying to switch it ON — `=enabled` would get
 * silence and no data — so that case also warns. Only when the variable is set and unparseable;
 * an unset variable is the ordinary case and says nothing.
 */
export function shouldRecordVerifyMetrics(
  env: Record<string, string | undefined>,
  warn: (message: string) => void = (m) => { process.stderr.write(`${m}\n`); },
): boolean {
  const raw = env[VERIFY_METRICS_ENV];
  if (raw === undefined) return false;

  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off' || v === '') return false;

  // The VALUE is not echoed. Under the systemd unit this goes to journald, and an environment
  // value is arbitrary text of arbitrary length — the one place in this change where something
  // unsanitized could reach an output channel. Naming the accepted tokens is more useful to
  // whoever typo'd it anyway. (sdlc/021 security pass, S6.)
  warn(`verify: ${VERIFY_METRICS_ENV} is set to an unrecognised value, not recording. ` +
    `Accepted: 1, true, yes, on (or 0, false, no, off to disable).`);
  return false;
}
