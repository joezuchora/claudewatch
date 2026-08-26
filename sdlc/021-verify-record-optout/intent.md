# Intent: the gate's own metrics should be refusable

- **Status:** accepted
- **Stage:** 1 — Plan
- **Date:** 2026-08-26
- **Source:** `sdlc/020-which-test-failed/review.md`, security finding S8 — recorded there
  deliberately rather than fixed under that loop's fence.

## The problem

`record()` in `scripts/verify.ts` writes a `verify_run` event on **every** invocation of
`bun run verify`. There is no flag, no environment variable, and no config key that stops it.

That was defensible when the payload was five step durations and an outcome. The comment beside
it still says so:

> SDLC process metrics are always recorded. They contain no user data, never run in a shipped
> artifact, and are written to a local file — so they need no consent gate.

**Loop 020 changed the second half of that sentence and did not revisit the first.** The payload
now carries repo-relative source paths, test names, the enclosing describe chain, and a failure
type. Still not *user* data — but it is now a description of someone's private repository at a
moment when their tests were failing, written to a file an agent ships to a service.

The security pass raised exactly this: *"the always-on part is not new; the disclosure surface
is."*

## Who is affected

Anyone who runs `bun run verify` in a fork or a private branch. Today that is one person and one
container, which is precisely why it is worth fixing now rather than after the repository has
other contributors — a default that has never been questioned is harder to change later.

Not affected: the shipped product. Product telemetry is already off by default with no default
destination, and this loop does not touch it.

## The tension worth naming

The loop's own hourly cadence depends on this data. `metrics:detect` reads it, the p95 baseline
is built from it, and `sdlc/016` is deliberately waiting for several days of it. An opt-out that
gets switched on casually starves the thing it feeds.

So the design question is not "add a flag". It is: **what is the right default, and who is the
person choosing?** Those may have different answers for the repository owner running the loop and
for a stranger who cloned the repo to send a patch.

## What "done" means

- A documented way to stop `verify_run` from being written, which works without editing source.
- A decision on the default, argued in the spec rather than inherited — including the case for
  leaving it on, which is real.
- The existing comment in `verify.ts` corrected. It currently justifies the behaviour with a
  claim about the payload that loop 020 made false.
- Whatever the default, `bun run verify` still exits with the same code and prints the same
  output. The opt-out changes what is recorded, never what is verified.
- The three documents that describe the spool (`SPEC.md` §17, `SECURITY.md`, `deploy/README.md`)
  say how to refuse it.

## Explicitly not in scope

- Product telemetry consent. Already solved, already off by default.
- The spool's location or format.
- Retention or redaction on the service side. `deploy/README.md` already records that the agent
  ships lines verbatim; changing that is a different loop.
