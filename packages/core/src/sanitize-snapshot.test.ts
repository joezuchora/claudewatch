import { describe, expect, test } from 'bun:test';
import { sanitizeSnapshot, SANITIZED_FIELDS } from './sanitize-snapshot.js';
import { makeTestSnapshot, makeRichTestSnapshot } from './test-helpers.js';
import {
  ACCOUNT_TIERS, AUTH_STATES, PRIMARY_WINDOWS, STALE_REASONS, USAGE_ENDPOINT_STATES,
  isAccountTier, isAuthState, isPrimaryWindow, isStaleReason, isUsageEndpointState,
} from './closed-sets.js';

/** A snapshot-shaped object with arbitrary extra keys, for probing what survives. */
function withExtras(): Record<string, unknown> {
  const s = JSON.parse(JSON.stringify(makeRichTestSnapshot())) as Record<string, unknown>;
  s.EVIL_SNAPSHOT = 'x';
  (s.source as Record<string, unknown>).EVIL_SOURCE = 'x';
  (s.display as Record<string, unknown>).EVIL_DISPLAY = 'x';
  (s.fiveHour as Record<string, unknown>).EVIL_WINDOW = 'x';
  (s.enterprise as Record<string, unknown>).EVIL_ENTERPRISE = 'x';
  return s;
}

describe('T4 — unknown keys are dropped at every level', () => {
  test('all five levels', () => {
    const out = JSON.stringify(sanitizeSnapshot(withExtras()));
    const levels = ['EVIL_SNAPSHOT', 'EVIL_SOURCE', 'EVIL_DISPLAY', 'EVIL_WINDOW', 'EVIL_ENTERPRISE'];
    // Collected rather than asserted one by one, so a failure NAMES the level that leaked. The
    // first version of this wrote `expect(`${k}: ${out}`).not.toContain(k)` — which can never pass,
    // because the label contains the needle. The test caught it immediately; a label built from the
    // same variable you are searching for is not a label.
    expect(levels.filter((k) => out.includes(k))).toEqual([]);
    // Positive precondition: the fixture really did carry them, and `enterprise` really is present
    // — a rebuild that nulled it would drop EVIL_ENTERPRISE for the wrong reason.
    expect(JSON.stringify(withExtras())).toContain('EVIL_ENTERPRISE');
    expect(sanitizeSnapshot(withExtras()).enterprise).not.toBeNull();
  });

  test('the enterprise level was NEVER probed before sdlc/032, and is the one A2 asserted', () => {
    // The spec's own edge-case table and A2 both claimed five levels while the probe behind them
    // covered four. Pinned separately so the gap cannot silently reopen.
    const s = JSON.parse(JSON.stringify(makeRichTestSnapshot())) as Record<string, unknown>;
    (s.enterprise as Record<string, unknown>).EVIL_ONLY_HERE = 'x';
    expect(JSON.stringify(sanitizeSnapshot(s))).not.toContain('EVIL_ONLY_HERE');
  });
});

describe('T7 — every closed set covers its union', () => {
  test('each predicate accepts every member and rejects everything else', () => {
    const cases: Array<[string, readonly string[], (v: unknown) => boolean]> = [
      ['usageEndpoint', USAGE_ENDPOINT_STATES, isUsageEndpointState],
      ['authState', AUTH_STATES, isAuthState],
      ['primaryWindow', PRIMARY_WINDOWS, isPrimaryWindow],
      ['tier', ACCOUNT_TIERS, isAccountTier],
      ['staleReason', STALE_REASONS, isStaleReason],
    ];
    for (const [name, members, predicate] of cases) {
      // Positive precondition: a set that had collapsed to one member would make the loop below
      // pass while checking nothing.
      expect(members.length).toBeGreaterThan(1);
      expect(members.filter((m) => !predicate(m))).toEqual([]);
      const rejected = ['', 'Valid', '/home/someone', null, 42, {}];
      expect(rejected.filter((bad) => predicate(bad))).toEqual([]);
      void name;
    }
    // The exhaustiveness half is a COMPILE-time guard (`Exclude<...> = never` in closed-sets.ts),
    // frozen by the existing typefixtures/array-missing-member.expect-error.ts rather than a fourth
    // copy of the same three lines. CLAUDE.md: reuse before adding.
  });
});

describe('T11 — every UsageSnapshot key has a rule', () => {
  test('SANITIZED_FIELDS covers a real snapshot, key for key', () => {
    // intent.md outcome 7: one place names every validated field, so a field added to
    // UsageSnapshot without a rule is RED rather than silently dropped by the whitelist.
    const actual = Object.keys(makeTestSnapshot()).toSorted();
    expect([...SANITIZED_FIELDS].toSorted() as string[]).toEqual(actual);
    // Positive precondition: the reflection saw a real snapshot, not an empty object.
    expect(actual.length).toBeGreaterThan(8);
  });

  test('the rebuild emits exactly those keys and no others', () => {
    expect(Object.keys(sanitizeSnapshot(withExtras())).toSorted())
      .toEqual([...SANITIZED_FIELDS].toSorted() as string[]);
  });
});

describe('coherence — independent degradation invents states no producer can emit', () => {
  test('T12 — a nulled enterprise forces tier and display to unknown', () => {
    // normalize() sets tier:'enterprise' only inside its `enterprise !== null` branch, so the pair
    // is unreachable from the producer. Poison ONE enterprise number and, without coupling, `tier`
    // survives because 'enterprise' is a valid member — and the result renders a plausible line
    // with nothing indicating corruption.
    const s = JSON.parse(JSON.stringify(makeRichTestSnapshot())) as Record<string, unknown>;
    (s.enterprise as Record<string, unknown>).utilizationPct = 'POISON';

    const out = sanitizeSnapshot(s);
    expect(out.enterprise).toBeNull();
    expect(out.tier).toBe('unknown');
    expect(out.display.primaryWindow).toBe('unknown');
    expect(out.display.primaryUtilizationPct).toBeNull();

    // Positive control: the coupling must NOT over-fire on a coherent snapshot.
    const good = sanitizeSnapshot(makeRichTestSnapshot());
    expect(good.tier).toBe('enterprise');
    expect(good.display.primaryWindow).toBe('enterprise');
  });

  test('T13 — a nulled primary window degrades primaryWindow', () => {
    const s = JSON.parse(JSON.stringify(makeTestSnapshot())) as Record<string, unknown>;
    (s.fiveHour as Record<string, unknown>).utilizationPct = 'POISON';

    const out = sanitizeSnapshot(s);
    expect(out.fiveHour.utilizationPct).toBeNull();
    expect(out.display.primaryWindow).toBe('unknown');
    expect(out.display.primaryUtilizationPct).toBeNull();

    // Positive control: an intact primary window keeps its name and its number.
    const good = sanitizeSnapshot(makeTestSnapshot());
    expect(good.display.primaryWindow).toBe('fiveHour');
    expect(good.display.primaryUtilizationPct).toBe(42);
  });
});
