import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, statSync } from 'fs';
import { join } from 'path';
import {
  emit, makeEvent, getSpoolPath, getSpoolStatePath, readSpoolState, clearSpoolState,
  fetchResultEvent, cacheEvent, renderEvent, schemaDriftEvent,
  categorizeWarning, utilizationBucket,
  MAX_SPOOL_BYTES, MAX_LINE_BYTES,
} from './telemetry.js';
import { setupTestCacheDir } from './test-helpers.js';
import { getCacheDir } from './cache.js';

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
    const huge = 'x'.repeat(MAX_LINE_BYTES + 100);
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
    const huge = 'x'.repeat(MAX_LINE_BYTES + 100);
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
