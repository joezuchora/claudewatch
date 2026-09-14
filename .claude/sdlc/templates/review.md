# Review findings: <short title>

- **ID:** <NNN>-<slug>
- **Stage:** 5 — Deploy
- **Reviewed against:** [`plan.md`](./plan.md) and [`/REVIEW.md`](../../REVIEW.md)
- **PR:** #<n>
- **Head commit:** <sha>

## Plan-to-diff audit

Output of the `plan-to-diff-auditor` subagent.

- **Files changed outside the scope fence:** <none | list, each with a justification>
- **Plan items with no corresponding change:** <none | list, each with a reason>

An excursion is not automatically a defect — but it must be recorded and explained here,
and if it was substantial, `plan.md` should be amended rather than quietly outgrown.

## Pass 1 — Bugs and logical errors

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | blocking / major / minor / nit | <finding> | fixed in <sha> / accepted, see note / rejected, see note |

## Pass 2 — Security and vulnerabilities

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | | | |

Standing invariants re-checked this round: <list which ones the diff could plausibly have
touched, and the verdict on each>.

## Pass 3 — Compliance

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | | | |

## Verification evidence

Paste the actual output, not a claim about it.

```
$ bun run verify
<output>
```

- [ ] `bun run verify` exits 0
- [ ] CI green on the PR head commit
- [ ] Every acceptance criterion in `spec.md` is checked off

## Findings deliberately not fixed

Anything left open, with the reason and where it is tracked. An empty section is a fine
answer; a silently dropped finding is not.

---

**Next stage:** Maintain — nothing to do until production says otherwise. If it does,
run `/sdlc-incident` to open an `incident.md` and restart the loop.
