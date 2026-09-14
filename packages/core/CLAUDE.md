# packages/core

**All domain logic lives here.** If you are about to put business logic in a surface package,
put it here instead and have the surface call it. This is the architectural rule the whole
project is organized around.

## Responsibilities

Credential reading, HTTP client, normalization, the runtime state machine, thresholds, cache,
time handling, and formatting. See SPEC.md §8.3.

## Rules

- Strict TypeScript, no `any`. Data crossing a trust boundary — API responses, cache files,
  the credential file — is validated, not `as`-asserted into a type.
- Timestamps are UTC ISO strings internally. Local conversion belongs to the surfaces.
- Missing optional response fields are **omitted, not guessed** (SPEC.md §3.3).
- Enterprise `monthly_limit` and `used_credits` are **currency minor units** (cents), not
  whole units (SPEC.md §3.5).
- Cache writes are atomic: temp file then rename, directory `0700`, file `0600`.
- Credentials at `~/.claude/.credentials.json` are **read-only** — never written, refreshed,
  or moved.
- The access token must not reach any log, cache file, debug output, error message, or
  process argument.
- No third-party runtime dependencies. Keep it that way.

## Testing

- `packages/core/src/test-helpers.ts` is exported via the `./test-helpers` subpath and
  provides `makeTestSnapshot`, `makeTestEnterpriseSnapshot`, `makeTestEnvelope`,
  `makeTempCacheDir`, and `setupTestCacheDir`. Use them rather than hand-rolling fixtures.
- `contract.test.ts` covers every scenario in SPEC.md §15.2. A change to the API contract
  belongs there.
- Cache tests must use `setCacheBaseDir` for isolation — never touch the real cache path.
