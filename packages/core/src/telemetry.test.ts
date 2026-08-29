import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, statSync, mkdtempSync, rmSync, symlinkSync, lstatSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  emit, makeEvent, getSpoolPath, getSpoolStatePath, getLegacySpoolPath, readSpoolState, clearSpoolState,
  fetchResultEvent, cacheEvent, renderEvent, schemaDriftEvent,
  categorizeWarning, utilizationBucket,
  MAX_SPOOL_BYTES, MAX_LINE_BYTES,
} from './telemetry.js';
import { setupTestCacheDir } from './test-helpers.js';
import { getCacheDir, getLegacyCacheDir, setCacheBaseDir } from './cache.js';

const ON: { enabled: boolean } = { enabled: true };
const OFF: { enabled: boolean } = { enabled: false };

describe('telemetry: emit', () => {
  let cleanup: () => void;
  beforeEach(() => { ({ cleanup } = setupTestCacheDir()); });
  afterEach(() => { cleanup(); });

  test('disabled config performs no I/O at all', () => {
    emit(OFF, makeEvent('product', 'render', true, 1, {}));
    expect(existsSync(getSpoolPath())).toBe(false);
    expect(existsSync(getSpoolStatePath())).toBe(false);
  });

  test('enabled config appends exactly one well-formed line per event', () => {
    emit(ON, makeEvent('product', 'render', true, 5, { surface: 'statusline' }));
    emit(ON, makeEvent('product', 'render', true, 6, { surface: 'vscode' }));

    const lines = readFileSync(getSpoolPath(), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.schemaVersion).toBe(1);
      expect(typeof parsed.eventId).toBe('string');
      expect(parsed.source).toBe('product');
    }
  });

  test('spool file is created 0600 inside the cache dir', () => {
    emit(ON, makeEvent('product', 'render', true, 1, {}));
    // The spool must live under the cache dir so setCacheBaseDir governs both and tests
    // cannot write into a developer's real ~/.cache.
    expect(getSpoolPath()).toBe(join(getCacheDir(), 'metrics-spool.jsonl'));
    const mode = statSync(getSpoolPath()).mode & 0o777;
    // Windows reports advisory modes; assert only where it is meaningful.
    if (process.platform !== 'win32') expect(mode).toBe(0o600);
  });

  test('every event carries a unique id, so the store can dedupe retries', () => {
    for (let i = 0; i < 20; i++) emit(ON, makeEvent('product', 'render', true, 1, {}));
    const ids = readFileSync(getSpoolPath(), 'utf-8').trim().split('\n')
      .map((l) => JSON.parse(l).eventId);
    expect(new Set(ids).size).toBe(20);
  });

  test('never throws when the spool cannot be written', () => {
    // Point the cache dir at a path that cannot hold a file.
    const bad = join(getSpoolPath(), '..', 'blocked');
    mkdirSync(bad, { recursive: true });
    chmodSync(bad, 0o500);
    // Even if the emit fails internally, the caller must never see it.
    expect(() => emit(ON, makeEvent('product', 'render', true, 1, {}))).not.toThrow();
    chmodSync(bad, 0o700);
  });

  test('an oversized line is dropped and counted, not written', () => {
    // `as never` is load-bearing since sdlc/032 narrowed `PayloadLeaf`: these cases park an
    // oversized string in a payload to exercise the BYTE CAP, which means constructing a value the
    // type now forbids. The cast is the point, not a smell — and no assertion here changed.
    const huge = 'x'.repeat(MAX_LINE_BYTES + 100) as never;
    emit(ON, makeEvent('product', 'render', true, 1, { surface: huge }));
    expect(existsSync(getSpoolPath())).toBe(false);
    expect(readSpoolState().droppedCount).toBe(1);
  });

  test('the byte cap drops new events while preserving history', () => {
    // Pre-fill past the cap.
    writeFileSync(getSpoolPath(), 'x'.repeat(MAX_SPOOL_BYTES + 1), { mode: 0o600 });
    const before = statSync(getSpoolPath()).size;

    emit(ON, makeEvent('product', 'render', true, 1, {}));

    expect(statSync(getSpoolPath()).size).toBe(before); // history untouched
    expect(readSpoolState().droppedCount).toBe(1);
  });

  test('the drop counter survives across processes via the sidecar', () => {
    // `as never` is load-bearing since sdlc/032 narrowed `PayloadLeaf`: these cases park an
    // oversized string in a payload to exercise the BYTE CAP, which means constructing a value the
    // type now forbids. The cast is the point, not a smell — and no assertion here changed.
    const huge = 'x'.repeat(MAX_LINE_BYTES + 100) as never;
    emit(ON, makeEvent('product', 'render', true, 1, { surface: huge }));
    emit(ON, makeEvent('product', 'render', true, 1, { surface: huge }));

    // Re-read from disk, as a separate process would.
    const state = readSpoolState();
    expect(state.droppedCount).toBe(2);
    expect(state.firstDroppedAt).not.toBeNull();

    clearSpoolState();
    expect(readSpoolState().droppedCount).toBe(0);
  });
});

describe('telemetry: payload builders', () => {
  test('fetch_result carries attempts and an enumerated status class', () => {
    const e = fetchResultEvent({ ok: false, statusClass: '5xx', attempts: 2, durationMs: 120 });
    expect(e.payload).toEqual({ statusClass: '5xx', attempts: 2 });
    expect(e.durationMs).toBe(120);
  });

  test('cache_event is ok only on a hit', () => {
    expect(cacheEvent({ outcome: 'hit' }).ok).toBe(true);
    expect(cacheEvent({ outcome: 'versionMismatch' }).ok).toBe(false);
  });

  test('render emits a decile bucket, never a raw utilization', () => {
    const e = renderEvent({
      surface: 'statusline', runtimeState: 'Healthy', tier: 'standard',
      utilizationBucket: utilizationBucket(87), durationMs: 12,
    });
    expect(e.payload.utilizationBucket).toBe(8);
    // Assert against the PAYLOAD, not the whole event. The event carries a random UUID
    // eventId, and a 32-character hex string contains any given 2-char substring about half
    // the time — so `JSON.stringify(e)).not.toContain('87')` passes or fails by luck. It
    // passed locally and failed in CI, which is exactly how that class of test behaves.
    expect(JSON.stringify(e.payload)).not.toContain('87');
  });

  test('schema_drift carries a category, never warning text', () => {
    const e = schemaDriftEvent({ category: categorizeWarning('five_hour.resets_at is not a valid ISO timestamp'), count: 1 });
    expect(e.payload.category).toBe('timestamp');
  });

  test('utilizationBucket clamps and handles null', () => {
    expect(utilizationBucket(null)).toBeNull();
    expect(utilizationBucket(0)).toBe(0);
    expect(utilizationBucket(100)).toBe(10);
    expect(utilizationBucket(Infinity)).toBeNull();
  });
});

/**
 * sdlc/034 — every path derived from `getCacheDir()` moves together.
 *
 * A3 asserts all of them rather than one, because three are derived and a fix to the resolver is
 * not automatically a fix to its consumers. The spool is the file that matters most: a lost
 * `usage.json` costs one token-bearing refetch, a lost spool costs measurements that exist nowhere
 * else.
 */
describe('spool paths follow XDG_CACHE_HOME (sdlc/034)', () => {
  const saved = process.env.XDG_CACHE_HOME;
  afterEach(() => {
    setCacheBaseDir(null);
    if (saved === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = saved;
  });

  test('the spool, its cursor and the cache dir all move to the XDG location', () => {
    setCacheBaseDir(null);
    process.env.XDG_CACHE_HOME = '/xdg-abs';
    const root = join('/xdg-abs', 'claudewatch');
    expect(getCacheDir()).toBe(root);
    expect(getSpoolPath()).toBe(join(root, 'metrics-spool.jsonl'));
    expect(getSpoolStatePath()).toBe(join(root, 'metrics-spool.state.json'));
  });

  test('the LEGACY spool path does not move, which is what makes a drain possible', () => {
    setCacheBaseDir(null);
    process.env.XDG_CACHE_HOME = '/xdg-abs';
    expect(getLegacySpoolPath()).toBe(join(getLegacyCacheDir(), 'metrics-spool.jsonl'));
    // Positive precondition: the two really are different, so the drain condition can fire.
    expect(getLegacySpoolPath()).not.toBe(getSpoolPath());
  });

  test('with the variable unset the legacy and resolved spools coincide, so no drain happens', () => {
    setCacheBaseDir(null);
    delete process.env.XDG_CACHE_HOME;
    expect(getLegacySpoolPath()).toBe(getSpoolPath());
  });
});

/**
 * sdlc/034 security pass, F2 — never append THROUGH a symlink.
 *
 * `appendFileSync` follows one. Before this loop the spool was always inside `$HOME`; honouring
 * `$XDG_CACHE_HOME` made the directory arbitrary, and the reviewer watched a JSON event land in an
 * unrelated file that way. Dropping the event is the right failure: recording a metric must never
 * be the reason something else gets written.
 */
describe('the spool is never appended through a symlink (sdlc/034 F2)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cw-spool-link-')); setCacheBaseDir(dir); });
  afterEach(() => { setCacheBaseDir(null); rmSync(dir, { recursive: true, force: true }); });

  test('an event appended to a symlinked spool does not reach the target', () => {
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'original\n');
    symlinkSync(victim, getSpoolPath());

    // Positive precondition: the link is in place and resolves to the victim.
    expect(lstatSync(getSpoolPath()).isSymbolicLink()).toBe(true);

    emit(ON, makeEvent('product', 'render', true, 1, {}));

    expect(readFileSync(victim, 'utf-8')).toBe('original\n');
  });

  test('a regular spool still receives the event — the guard is not a blanket refusal', () => {
    emit(ON, makeEvent('product', 'render', true, 1, {}));
    expect(existsSync(getSpoolPath())).toBe(true);
    expect(readFileSync(getSpoolPath(), 'utf-8')).toContain('render');
  });
});
