# Review: one cache-seed helper, checked by the compiler

- **ID:** 024-cache-seed-helper
- **Stage:** 5 — Deploy
- **Range reviewed:** `7a0e0a8..06746b4`, plus the follow-up commit these findings produced
- **Date:** 2026-08-27

## Verdict

Three reviewers ran across two stages: `spec-reviewer` at Stage 2, and `plan-to-diff-auditor`
plus `security-reviewer` at Stage 5. Between them **one blocking finding** survived to Stage 5
(C-1) and is fixed. Six Stage-2 blockers had already reshaped the design.

The single most useful thing they found is not a bug in the code. It is that **this loop
committed, twice, the exact error it had just finished documenting.**

## Pass 1 — bugs and logical errors

**C-1 (BLOCKING, fixed).** `scripts/perf.test.ts:114` asserted
`envelope.snapshot.freshness.isStale === false`. It was dropped in the move with no replacement,
and the docstring I wrote to justify the drop was false:

> Staleness is recomputed from `fetchedAt` at render; the seeded `freshness` block is decorative
> and only its presence is checked.

True of `readCacheResult`. False of everything downstream: `isStale` has **nine** production
readers — `format.ts:82,138,402,429` (which append a literal `" stale"` to the rendered line),
`state.ts:29,40`, `main.ts:249`, `extension.ts:172`. The auditor proved the gap live and I
reproduced it: seeding `isStale: true` leaves **all 11 core, 7 smoke and 21 perf tests green**,
because every smoke assertion is `toContain("42%")` and a stale line reads `"42% stale"`. The
whole suite would have been exercising the stale render path with nothing to say so.

This is the same error as the spec's own finding **B3**, where the Stage 2 reviewer corrected my
claim that nothing reads `staleReason` (five readers). I recorded that correction, and then wrote
the identical false claim about `isStale` — in the source file, one section later. Writing the
lesson down did not confer immunity. It did not even survive the same document.

Fixed: docstring corrected with the readers named, assertion restored, and mutation-verified —
seeding a stale snapshot now fails.

**C-2 (advisory, fixed).** The `fetchedAt` default had no unit-level guard; only
`perf.test.ts`'s 2.2s spawn-the-binary mtime check caught a stale default — the layer this loop
was supposed to be pushing coverage *down* from. Now asserted directly against
`isCacheFresh`'s 600s TTL.

**C-4 (advisory, fixed).** `plan.md` claimed the delegation fixes "the missing
`lastHttpStatus`/`lastErrorMessage`". `makeTestEnvelope` was never missing them
(`7a0e0a8:test-helpers.ts:68-69`); the **hand-rolled seeds** were. Conflating the shared helper
with its copies, in the plan for the loop about that exact confusion.

**C-3 (advisory, fixed).** `plan.md`'s test table said A6 would fail if the mode were "set after
creation". It would not — Verification §3 of the same document says so. Two rows of one file
disagreeing.

**C-5 (advisory, fixed).** `SandboxSeed.utilizationPct` echoed the caller's argument, so a caller
passing `snapshot` got `42` reported regardless — making the field's own docstring ("assert on
THIS, never on a literal") a lie at the first use. Now derived from the snapshot seeded.

**C-6 (advisory, fixed).** A comment in `perf.test.ts` still named the deleted `makeSandbox`.

## Pass 2 — security (SPEC.md §12 trust boundary, §17 payload rule)

No blocking findings. Two majors, both fixed:

**#1 — the fixture credential was valid until the year 2100.** `expiresAt: 4102444800000` makes
`resolveCredentials` return `valid`, so every path that misses the cache — `seedCache: false`,
an expired TTL, a `CACHE_VERSION` bump, `--refresh` — falls through to a **live authenticated
GET carrying the token**. Hoisting the fixture into `core` widened that from two call sites to
anything importing `@claudewatch/core/test-helpers`.

I know this path is real because **I walked it by hand while scoping this loop.** The intent's
original evidence (`version 1 → "⊙ auth invalid"`) was a live request to the real API; `⊙ auth
invalid` comes only from an HTTP 401 (`client.ts:91`), and re-running it behind a dead proxy
changed nothing because bun ignored the override.

Fixed by defaulting `expiresAt` to the past. Verified the ordering it depends on: `main.ts:240`'s
fresh-cache branch runs *before* `resolveCredentials()` at `:261`, so cache-hit cases are
unaffected while every miss path now exits 2 before `fetchUsage`. The sandbox is network-inert
**by construction** rather than because each caller remembers to seed a valid cache.

**#2 — `smoke.test.ts` pinned `HOME` alone.** `os.homedir()` follows `USERPROFILE` on Windows, a
supported target (SPEC.md §13.1), so on a Windows dev box `bun test` would spawn the real binary
seven times against the developer's **real** credentials and cache. `perf.ts` has had all four
variables pinned since loop 013's security pass; `smoke.test.ts` never did — and this diff
*touched those very lines* and inherited the gap while the correct pattern was being moved in
next door. Fixed by carrying the env on the seed itself (`SandboxSeed.env`), so it cannot drift
again — which is the loop's own thesis applied to the thing the loop missed.

**#3 — prefix traversal (minor, fixed).** `mkdtempSync(join(tmpdir(), opts.prefix))` took an
unvalidated prefix, and this helper is now the only code in the repo that writes a file named
`.credentials.json`. Guarded.

Cleared after active re-checking: no token in any shipped artifact (`NOT-REAL` → 0 in the
compiled binary, the VSIX payload, and the core bundle; `test-helpers.ts` is not reachable from
any build entrypoint), no token in logs, argv, or the cache file, credentials still read-only,
TLS untouched, no new payload leaf. Modes measured on disk under `umask 0000` and `0077`: 0700
dirs, 0600 files. The removed `chmodSync` closed a window rather than opening one — and the old
`smoke.test.ts` genuinely had one, writing the credential at 0644 before chmodding it.

## Pass 3 — compliance

Fence held: exactly the seven declared files, no do-not-touch file altered, `verify` green, lint
at the standing 12. Domain logic stayed in `packages/core`; the surfaces stayed thin.

**One excursion, recorded rather than excused.** Acceptance criterion **A3 was rewritten inside
the implementation commit**, after seeing that it failed. The rewrite is correct on the merits —
the original mutation genuinely does not discriminate, because after the change `perf.ts` holds
no fixture and the error lands in `test-helpers.ts`, which was already in the pre-change failure
list, making the two file lists identical. But the auditor is right that moving a goalpost inside
the commit that fails it is exactly what a plan-to-diff fence exists to surface, and that the
replacement A3 has **no automated check** — it is prose evidence pasted into a document.

**Also recorded:** the plan was committed *with* the diff rather than before it, so the fence and
the thing it fences landed together. That is weaker evidence than the artifact chain implies.

## What is NOT done

- **A3 has no automated check.** Its evidence (typecheck exit 0 pre-change with an invalid
  fixture in `perf.ts`; TS2322 post-change) is real and reproducible by hand, but nothing in
  `verify` re-runs it. A future edit could reintroduce an untyped fixture and no gate would say
  so. A real check would assert no consumer contains a `JSON.stringify` of a snapshot-shaped
  literal — narrow and brittle, which is why it is recorded rather than built.
- **Three of `seedSandboxHome`'s options are unused by any consumer** — `snapshot`, `envelope`,
  `fetchedAt`. `snapshot` and `fetchedAt` now have tests; `envelope` has none and no caller.
  Kept because the cooldown and first-run cases they exist for are the next uses of this helper,
  but an unused parameter is a liability until then.
- **`'the fixture carries every field the envelope requires'` does not discriminate this
  change** — it passes against the pre-change literal, which already had all six keys. It is a
  durable key-drift guard against `makeCacheEnvelope`, not evidence for this loop. Disclosed
  rather than counted.
- **`readCacheResult` still accepts `staleReason: null`** and any malformed `freshness`/`display`
  contents. Out of scope by the intent's fence; a separate change touching SPEC.md §9.
- **`'two seeds never share a directory'`** is guaranteed by `mkdtempSync` and carries near-zero
  information.

## Mutation log

| Mutation | Predicted | Actual |
|---|---|---|
| `makeTestEnvelope` → `version: 1` | A2 fails | 2 fail ✓ |
| `seedSandboxHome` ignores `utilizationPct` | A4 fails | 2 fail ✓ |
| modes → trailing `chmodSync` | **inert** (same final mode inside a fresh `mkdtemp`) | inert ✓ — *predicted before running, which is what separates a faulty mutation from a test gap* |
| seed `isStale: true` | *(pre-fix)* nothing fails | nothing failed ✗ → **C-1**; now 1 fail ✓ |
| default `fetchedAt` 1h old | *(pre-fix)* only the binary-level check | now 1 fail ✓ |
| echo `utilizationPct` instead of deriving | now 1 fail | 1 fail ✓ |

## Retrospective

Two Stage-2 blockers and one Stage-5 blocker were all the same shape: **a criterion that reports
the same result whether or not the change exists.** A3 (twice), A4 as first written, and the
dropped `isStale` assertion. The repo's nine recorded vacuous tests are not a historical curio;
this loop produced three more before review caught them.

The reviewers earned their cost again. Neither the third consumer, the live-API path, the
Windows credential exposure, nor the `isStale` gap would have been found by re-reading the diff —
and I had already re-read it.
