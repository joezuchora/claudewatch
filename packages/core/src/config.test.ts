import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveTelemetryConfig, setConfigBaseDir, getConfigPath } from './config.js';

describe('resolveTelemetryConfig', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cw-config-'));
    setConfigBaseDir(dir);
  });
  afterEach(() => {
    setConfigBaseDir(null);
    rmSync(dir, { recursive: true, force: true });
  });

  const writeConfig = (obj: unknown) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(getConfigPath(), typeof obj === 'string' ? obj : JSON.stringify(obj));
  };

  test('defaults to disabled when nothing is configured', () => {
    expect(resolveTelemetryConfig(undefined, {})).toEqual({ enabled: false });
  });

  test('an explicit override wins over everything', () => {
    writeConfig({ telemetry: { enabled: false } });
    expect(resolveTelemetryConfig({ enabled: true }, { CLAUDEWATCH_TELEMETRY: '0' }))
      .toEqual({ enabled: true });
  });

  test('the environment wins over the config file', () => {
    writeConfig({ telemetry: { enabled: false } });
    expect(resolveTelemetryConfig(undefined, { CLAUDEWATCH_TELEMETRY: '1' }))
      .toEqual({ enabled: true });
  });

  test('the config file is used when the environment is silent', () => {
    writeConfig({ telemetry: { enabled: true } });
    expect(resolveTelemetryConfig(undefined, {})).toEqual({ enabled: true });
  });

  test.each(['1', 'true', 'TRUE', 'yes', 'on'])('env %s enables', (v) => {
    expect(resolveTelemetryConfig(undefined, { CLAUDEWATCH_TELEMETRY: v }).enabled).toBe(true);
  });

  test.each(['0', 'false', 'no', 'off', ''])('env %s disables', (v) => {
    expect(resolveTelemetryConfig(undefined, { CLAUDEWATCH_TELEMETRY: v }).enabled).toBe(false);
  });

  test('an uninterpretable env value is not a decision — it falls through', () => {
    writeConfig({ telemetry: { enabled: true } });
    expect(resolveTelemetryConfig(undefined, { CLAUDEWATCH_TELEMETRY: 'maybe' }).enabled).toBe(true);
  });

  test('a malformed config file is treated as absent, never as an error', () => {
    writeConfig('{ not json');
    expect(() => resolveTelemetryConfig(undefined, {})).not.toThrow();
    expect(resolveTelemetryConfig(undefined, {})).toEqual({ enabled: false });
  });

  test('a config file with the wrong shape is treated as absent', () => {
    writeConfig({ telemetry: 'yes please' });
    expect(resolveTelemetryConfig(undefined, {})).toEqual({ enabled: false });
  });

  test('an absent config file is not an error', () => {
    expect(resolveTelemetryConfig(undefined, {})).toEqual({ enabled: false });
  });
});
