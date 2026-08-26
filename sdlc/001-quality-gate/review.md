# Review findings: make the verification gate real

- **ID:** 001-quality-gate
- **Stage:** 5 — Deploy
- **Reviewed against:** [`plan.md`](./plan.md) and [`/REVIEW.md`](../../REVIEW.md)
- **Branch:** `claude/ai-sdlc-setup-plan-nqyqbk`

## Plan-to-diff audit

**Verdict: EXCURSIONS RECORDED.** The fence has been amended (see `plan.md`); the original is
preserved at commit `bbeff04`.

**Files changed outside the original fence — and why:**

| File(s) | Necessary or creep | Reason |
|---|---|---|
| `packages/vscode/src/{core-bridge.ts, statusbar.ts, statusbar.test.ts, tooltip.ts, tooltip.test.ts, extension.ts}` | **Necessary** | Design assumed one contaminating test file. There were two — `statusbar.test.ts` also mocks the shared core barrel. The gate cannot be green without fixing both. |
| `packages/core/src/{client,cooldown,credentials,types}.test.ts` | **Necessary** | The linter's first-ever run found unused imports here. `lint` is a gate step, so these block `verify`. |
| `.oxlintrc.README.md` | **Necessary** | `.oxlintrc.json` is JSON and cannot carry comments; the spec requires every disabled rule to state a reason, so the reasons need somewhere to live. |
| `bun.lock` | **Necessary** | Consequence of adding the `oxlint` devDependency. |
| `packages/statusline/src/deps.ts` → `core-deps.ts` | **Necessary** | Renamed. Two modules both named `deps.ts` produce the identical mock specifier `'./deps.js'` and collide — see Pass 1, finding 2. |

**Plan items with no corresponding change:** none.

**Test-mapping gaps:** none. The change adds no behavior, so its verification is execution
evidence rather than new unit tests, as `plan.md` states.

## Pass 1 — Bugs and logical errors

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | blocking | The spec's chosen isolation fix — a local module using `export … from '@claudewatch/core'` — **did not work**. A static re-export keeps the mock linked to the source module and contamination survived (127 of 341 still failing). | Fixed. `core-deps.ts` / `core-bridge.ts` use value re-binding (`import * as core; export const x = core.x`) instead. The spec's decision section has been left as written and this finding records the correction. |
| 2 | blocking | After both surfaces were routed through a local module, 17 tests still failed. Both modules were named `deps.ts`, so both tests mocked the identical specifier `'./deps.js'`. **Bun keys module mocks by specifier string, so the two collided** — each package passed when paired with core alone, and only the three-way run failed. | Fixed by giving them distinct names: `core-deps.ts` (statusline) and `core-bridge.ts` (vscode). |
| 3 | major | `packages/vscode/src/extension.ts` had `catch (err)` with the binding unused, silently discarding the error. | Changed to `catch {}`, making the discard explicit. The behavior was already to swallow; this only removes the misleading binding. **The swallowing itself is unchanged and remains worth revisiting** — see follow-ups. |

## Pass 2 — Security and vulnerabilities

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | minor | `packages/core/src/credentials.test.ts` read the user's **live `~/.claude/.credentials.json` into a variable that was never consumed**. The rename-to-backup is what actually protects the file; the `readFileSync` served no purpose and put a real OAuth token into process memory for the duration of the suite. | Fixed. The read and its variable are removed; the rename-based backup is untouched. Surfaced by `no-unused-vars` — the linter earning its place on its first run. |

**Invariants actively re-checked** (the diff touches import wiring and test setup, so each was
verified rather than assumed):

- **No token in logs/cache/debug/argv** — unchanged; no logging or serialization touched.
- **Credentials read-only** — improved, per the finding above. No new write path.
- **TLS and hardcoded `https://`** — `client.ts` untouched. `security.test.ts` still asserts
  the hardcoded URL and passes.
- **Atomic writes, `0700`/`0600`** — `cache.ts` untouched.
- **No telemetry** — no new network call anywhere in the diff.

`core-deps.ts` and `core-bridge.ts` are re-export-only and introduce no new trust boundary.

## Pass 3 — Compliance

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | minor | Do `core-deps.ts` / `core-bridge.ts` violate "surfaces contain no domain logic" (`SPEC.md §8.2`)? | **No.** Both are value re-bindings with no logic. Both carry a header comment saying so and directing future logic to `packages/core`. Flagged here so the question is answered on the record rather than re-litigated later. |
| 2 | minor | `packages/vscode/src/commands.ts:11` declares `let cache: any` — `CLAUDE.md` forbids `any`. | **Not fixed.** `commands.ts` is outside the fence and unrelated to the gate. oxlint's correctness set does not catch this (no type-aware rules, an accepted trade-off in `spec.md`). Recorded as a follow-up. |
| 3 | nit | `no-shadow` warns on `packages/vscode/src/commands.ts:10`, where a local `const vscode = await import('vscode')` shadows the module-level import. | **Not fixed, deliberately left visible.** Silencing it would hide a real smell in a file this change should not touch. Documented in `.oxlintrc.README.md`. |

## Verification evidence

```
$ bun run verify
$ tsc --noEmit
$ oxlint
packages/vscode/src/commands.ts:10:9: warning eslint(no-shadow): 'vscode' is already declared in the upper scope.
$ bun test
 341 pass
 0 fail
 639 expect() calls
Ran 341 tests across 16 files. [26.22s]
$ bun run --filter @claudewatch/core build && ... && bun run --filter claudewatch-vscode build
@claudewatch/core build: Exited with code 0
@claudewatch/statusline build: Exited with code 0
claudewatch-vscode build: Exited with code 0

VERIFY EXIT=0
```

**Negative tests — proving the gate can actually fail:**

| Seeded defect | Expected | Observed |
|---|---|---|
| `const broken: number = "not a number"` in `thresholds.ts` | typecheck fails | `error TS2322`, exit **2** |
| unused function + variable in `thresholds.ts` | lint fails | 2 × `error eslint(no-unused-vars)`, exit **1** |
| `expect(1).toBe(2)` in `thresholds.test.ts` | typecheck and lint pass, test fails | typecheck exit 0, lint exit 0, test step fails |

All seeds reverted; `verify` green afterward.

**VS Code bundle is still CommonJS:** 12 `require` / `module.exports` occurrences in
`packages/vscode/dist/extension.js`, zero top-level ESM `import`/`export`.

- [x] `bun run verify` exits 0
- [x] Every acceptance criterion in `spec.md` is met
- [ ] CI green on the PR head commit — pending push

## Findings deliberately not fixed

Each is real, each is outside this change's scope, and each should become its own `intent.md`:

1. **The core suite spends ~26 s in real `setTimeout` sleeps.** `contract.test.ts` alone takes
   22 s and `client.test.ts` 4 s, against 0.24 s of user CPU — it is almost entirely waiting.
   `RETRY_DELAY_MS` is a module constant in `client.ts` with no injection point, so retry tests
   sleep for real. This makes every `verify` run and every CI job ~26 s slower than it needs
   to be, and it is the single largest cost the new gate imposes.
2. **`commands.ts` uses `any`** — Pass 3, finding 2.
3. **`no-shadow` in `commands.ts`** — Pass 3, finding 3.
4. **`extension.ts` swallows unexpected errors** — Pass 1, finding 3. Now explicit, still silent.
5. **Nothing structurally prevents a recurrence.** A future test can mock a shared module again
   and re-break isolation. The gate would now *catch* it, which is the meaningful improvement;
   preventing it outright is not worth building until it happens twice.
6. **Four types in `types.test.ts` had no structural test** — `RawUsageResponse`,
   `CredentialFile`, `AuthState`, `FetchResult` were imported but never exercised. The imports
   are removed; the coverage gap they revealed is not filled here.

## Note on process

Two of the three blocking Pass 1 findings are **defects in this change's own `spec.md`**. The
design named an isolation strategy that did not survive contact with Bun's actual behavior,
and the correction took several empirical rounds. The loop's value here was not that the
design was right — it was that the design was written down specifically enough to be *proven
wrong quickly*, and that the correction is recorded rather than silently absorbed.

Worth carrying into loop 2: a design decision resting on an assumption about third-party
runtime behavior should be spiked before it is specified, not after.

---

**Next stage:** Maintain — nothing to do until production says otherwise.
