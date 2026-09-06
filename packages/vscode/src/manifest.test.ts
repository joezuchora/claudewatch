/**
 * Manifest assertions for Marketplace readiness.
 *
 * These check the published contract rather than the code, because a manifest field is
 * exactly the kind of thing that is correct on the day it is written and quietly wrong six
 * commits later. Assert presence and value, never key order.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The slice of package.json this file asserts on.
 *
 * Asserted fields are REQUIRED, not optional, and the shape attaches by declaration annotation
 * rather than `as` — `JSON.parse` returns `any`, so an annotation needs no cast operator at all.
 * Optional fields would reintroduce six TS18048s, because `expect(setting).toBeDefined()` does not
 * narrow for tsc. Declaring them required is an assertion about this repo's own manifest, which the
 * tests below then check. (sdlc/028 B3)
 */
interface TelemetrySetting {
  type: string;
  default: boolean;
  tags: string[];
  markdownDescription: string;
}
interface Manifest {
  publisher: string;
  license: string;
  icon: string;
  homepage: string;
  keywords: string[];
  categories: string[];
  repository?: { url?: string };
  bugs?: { url?: string };
  engines: { vscode: string };
  contributes: { configuration: { properties: Record<string, TelemetrySetting> } };
}

const manifest: Manifest = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf-8'),
);

describe('extension manifest: telemetry setting', () => {
  const setting = manifest.contributes?.configuration?.properties?.['claudewatch.telemetry.enabled'];

  test('the telemetry setting exists and is off by default', () => {
    expect(setting).toBeDefined();
    expect(setting.type).toBe('boolean');
    expect(setting.default).toBe(false);
  });

  test('it is tagged so VS Code and enterprise policy tooling can find it', () => {
    // Required by VS Code's telemetry guidance for custom extension telemetry settings.
    expect(setting.tags).toContain('telemetry');
    expect(setting.tags).toContain('usesOnlineServices');
  });

  test('its description states that VS Code global telemetry overrides it', () => {
    expect(setting.markdownDescription).toContain('telemetry.telemetryLevel');
    expect(setting.markdownDescription.toLowerCase()).toContain('off by default');
  });
});

describe('extension manifest: Marketplace listing fields', () => {
  test('carries the fields a listing needs', () => {
    expect(manifest.publisher).toBeTruthy();
    expect(manifest.license).toBe('MIT');
    expect(manifest.icon).toBeTruthy();
    expect(manifest.repository?.url).toContain('github.com');
    expect(manifest.homepage).toBeTruthy();
    expect(manifest.bugs?.url).toContain('issues');
    expect(Array.isArray(manifest.keywords)).toBe(true);
    expect(manifest.keywords.length).toBeGreaterThan(2);
  });

  test('is categorised as something more specific than Other', () => {
    expect(manifest.categories.length).toBeGreaterThan(1);
    expect(manifest.categories.some((c: string) => c !== 'Other')).toBe(true);
  });

  test('engines.vscode supports the telemetry API this change depends on', () => {
    // isTelemetryEnabled and onDidChangeTelemetryEnabled shipped in 1.55.
    const min = Number(/(\d+)\.(\d+)/.exec(manifest.engines.vscode)?.[2] ?? 0);
    expect(min).toBeGreaterThanOrEqual(55);
  });
});
