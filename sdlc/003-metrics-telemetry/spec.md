# Spec: a metrics pipeline the Maintain stage can observe

- **ID:** 003-metrics-telemetry
- **Stage:** 2 — Design
- **Status:** accepted
- **Derived from:** [`intent.md`](./intent.md)

## Summary

A new zero-dependency workspace package, `@claudewatch/metrics`, provides an HTTP metrics
service backed by SQLite, an agent that ships locally spooled events to it, and a dashboard.
`packages/core` gains a telemetry emitter that **writes to a local spool file and never opens
a socket**. A wrapper around `bun run verify` records SDLC process metrics directly.

## Design decisions

### The product never makes a network call for telemetry — it spools to disk

This is the decision everything else follows from, and it is forced by two constraints that
turn out to point the same way.

`SPEC.md §11.7` budgets **50 ms** from binary start to stdout on a cache hit. Any network
write in that path — even fire-and-forget — risks DNS, TLS and connect latency inside a budget
that small. And the statusline is a short-lived process that exits immediately after printing,
so a genuinely fire-and-forget request would frequently be killed mid-flight and lost anyway.

So the emitter appends one JSON line to a local spool file and returns. No socket, no
`fetch`, no timeout to tune, nothing that can block. A separate agent — run by the user, not
by the product — reads the spool and ships it.

The security consequence is the valuable part: **the shipped ClaudeWatch binary and extension
still never open a connection to anywhere but the documented usage endpoint.** The revised
"no phone home" claim in `SECURITY.md` is therefore not a weakened version of the old one; it
remains literally true of the product. Only the user's own agent talks to the user's own
service.

It also makes the pipeline offline-tolerant for free: if the metrics service is down, events
accumulate and ship later, rather than being dropped inside a process that has already exited.

### Storage is SQLite via `bun:sqlite`; transport is `Bun.serve`

Both are built into Bun. `packages/core`'s zero-third-party-runtime-dependency identity
(`SPEC.md §2.2`) is preserved, and it now extends to the metrics package too.

Rejected: a hosted backend (needs an account, contradicts `intent.md`), Prometheus + Grafana
(two more processes and a scrape model that fits poorly with short-lived CLI runs), and
flat-file JSONL as the store (no indexed queries, and loop 004 needs to ask "what did the last
50 verify runs do").

### One event table, two sources

`sdlc` and `product` events share a table with a typed core (`ts`, `source`, `kind`, `ok`,
`duration_ms`) and a JSON `payload` for the rest. The typed columns are the ones both sources
answer and loop 004 will query; the JSON column keeps either source free to evolve without a
migration that touches the other.

Rejected: separate tables per source (every cross-cutting query becomes a union) and a fully
schemaless blob (loop 004's control bounds would be string-parsing JSON in SQL).

### The service binds to loopback and requires a token when it does not

Default bind is `127.0.0.1`. Binding to any other interface **requires** `CLAUDEWATCH_METRICS_TOKEN`
to be set; the service refuses to start otherwise rather than silently exposing an
unauthenticated write endpoint on a home LAN. This matters specifically because the intended
home is a NUC that may be reachable from other devices.

### Telemetry field allowlist, enforced in code

`intent.md` forbids secrets and PII. A prose rule is not enough for something that will grow
new fields, so the emitter builds payloads from an **explicit allowlist of field names** and
the test suite asserts that the serialized payload of every event kind matches it exactly. A
new field that is not on the list cannot reach the spool.

## Behavior

### `packages/core` — the emitter

- `isTelemetryEnabled(config)` — true only when the user has set an endpoint **and** enabled it.
- `emit(event)` — appends one JSON line to the spool. Never throws, never blocks on network.
  On any filesystem error it returns silently: telemetry failure must never degrade the
  product.
- Spool: `~/.cache/claudewatch/metrics-spool.jsonl`, file mode `0600`, directory `0700`,
  matching the cache rules in `SPEC.md §9.6`.
- Spool is capped (default 5 MB / 10,000 lines). At the cap the emitter **drops new events**
  rather than growing without bound or deleting history, and records a `spool_full` counter.

Product event kinds: `fetch_result` (ok, status class, duration), `cache_event` (hit/miss/
corrupt/cooldown), `render` (surface, runtime state), `schema_drift` (a normalization warning
fired). Every one carries a `schema_version`.

### `packages/metrics` — service, agent, dashboard

- `POST /v1/events` — ingest a batch. Validates, rejects oversized bodies, returns counts.
- `GET /v1/events` — query by `source`, `kind`, `since`, `limit`.
- `GET /v1/stats` — aggregates loop 004 needs: run counts, pass rate, duration percentiles.
- `GET /health` — liveness plus store reachability.
- `GET /` — a dashboard, server-rendered, no external assets.
- `agent` — reads the spool, ships batches, truncates only what was accepted.

### The verify wrapper — SDLC process metrics

`bun run verify:metrics` runs the same four steps, timing each, and emits one `verify_run`
event with per-step durations and the outcome — including when a step is **killed or times
out**, which is the case the hang investigation depends on. A plain `bun run verify` is
unchanged and remains the gate.

## Data and types

| Item | Detail |
|---|---|
| `MetricEvent` | `{ ts, source, kind, ok, durationMs, schemaVersion, payload }` |
| `events` table | typed columns above + `payload` JSON + indices on `(source, kind, ts)` |
| Settings | `claudewatch.telemetry.enabled` (default **false**), `claudewatch.telemetry.endpoint` (default **empty**) |

## Edge cases

| Case | Expected behavior |
|---|---|
| Telemetry disabled or no endpoint | `emit` is a no-op. Zero cost, nothing written. **The default.** |
| Spool file unwritable / disk full | `emit` returns silently. Product unaffected. |
| Spool at cap | New events dropped, `spool_full` counted. History preserved. |
| Metrics service down | Agent fails, spool retained, ships on next run. |
| Agent interrupted mid-ship | Only accepted events are truncated. At-least-once, never lost. |
| Duplicate events from a retry | Accepted. Dashboards tolerate it; exactly-once is not worth the complexity here. |
| Non-loopback bind, no token | **Service refuses to start** with an explanatory error. |
| Oversized or malformed body | 413 / 400, nothing stored, service stays up. |
| Verify step killed by timeout | Recorded as `ok: false` with `outcome: 'timeout'` — the case that matters most. |
| Clock skew between emitter and service | Both `ts` (emitter) and `received_at` (service) stored. |

## Backward compatibility

- **A user who changes nothing sees no change.** Telemetry defaults off with no endpoint; the
  emitter short-circuits before touching the filesystem.
- No change to the usage endpoint contract, credential handling, cache format, exit codes, or
  CLI flags. `CACHE_VERSION` is untouched — the spool is a separate file.
- `bun run verify` is unchanged. `verify:metrics` is additive.
- New workspace package; existing package builds are untouched.

## Security

`SPEC.md §12`'s invariants are **re-asserted, not relaxed**:

- No access or refresh token in any spooled event — enforced by allowlist and tested.
- No hostname, username, filesystem path, project name, or account identifier.
- No URL other than the one the user configured; the product never resolves it.
- Credentials remain read-only; telemetry never reads the credential file.
- Spool file `0600`, directory `0700`, atomic append.
- The service uses parameterized SQL exclusively.

**Amendments required** (recorded here, applied to the documents in the same change):
`SPEC.md §12` gains the telemetry boundary; `SPEC.md §20`'s "No telemetry is shipped" becomes
"No telemetry is enabled by default and no default destination exists"; `SECURITY.md`'s
guarantee is rewritten in those terms rather than deleted.

## Acceptance criteria

- [ ] With telemetry unset, no spool file is created and `emit` performs no I/O — tested
- [ ] With telemetry enabled, each event kind appends exactly one well-formed line — tested
- [ ] **Serialized payloads contain no token, path, hostname or username** — asserted per kind
      in `security.test.ts` against the allowlist
- [ ] `emit` never throws, including when the spool path is unwritable — tested
- [ ] Spool cap drops new events and preserves history — tested
- [ ] Service ingests, stores and returns events; `/health` reports store state — tested
- [ ] Service refuses non-loopback bind without a token — tested
- [ ] Agent ships and truncates only accepted events; retains on failure — tested
- [ ] `verify:metrics` records a `verify_run` including a timeout outcome — tested
- [ ] Statusline cache-hit path shows no measurable regression against the 50 ms budget
- [ ] `bun run verify` exits 0

## Rejected alternatives

- **Direct POST from the product**, with a short timeout. Simpler, but spends the 50 ms budget,
  loses events when the process exits, and makes the "never opens a socket" property
  impossible to state.
- **Telemetry on by default with an opt-out.** Higher data volume, and it converts a promise
  into a surprise. Rejected outright.
- **Deleting the `SECURITY.md` telemetry section.** The change is worth making and worth
  stating; quietly dropping the paragraph would be the dishonest version.

---

**Next stage:** Build — run `/sdlc-plan 003-metrics-telemetry`.
