import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync, lstatSync } from 'fs';
import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import type { CredentialResult } from './types.js';

/**
 * Credentials test strategy:
 *
 * resolveCredentials() reads from a hardcoded path: ~/.claude/.credentials.json
 * We can't mock fs without breaking other test files (mock.module leaks globally).
 *
 * Instead, we test:
 * 1. getCredentialPath - verifies the path is correct
 * 2. The credential parsing logic by directly testing the function behavior
 *    against the real file system. We back up and restore the real credential
 *    file if it exists.
 *
 * NOTE: Tests that need the real credential path must be careful not to corrupt
 * the user's actual credentials.
 */

const CLAUDE_DIR = join(homedir(), '.claude');
const CRED_PATH = join(CLAUDE_DIR, '.credentials.json');
const BACKUP_PATH = CRED_PATH + '.test-backup-' + randomBytes(4).toString('hex');

let originalExists: boolean;
let originalContent: string | null;

describe('getCredentialPath', () => {
  test('returns expected path under home directory', async () => {
    const { getCredentialPath } = await import('./credentials.js');
    const expected = join(homedir(), '.claude', '.credentials.json');
    expect(getCredentialPath()).toBe(expected);
  });
});

describe('resolveCredentials', () => {
  let resolveCredentials: () => CredentialResult;

  beforeEach(async () => {
    const mod = await import('./credentials.js');
    resolveCredentials = mod.resolveCredentials;

    // Ensure .claude dir exists
    if (!existsSync(CLAUDE_DIR)) {
      mkdirSync(CLAUDE_DIR, { recursive: true });
    }

    // Back up existing credential file
    originalExists = existsSync(CRED_PATH);
    if (originalExists) {
      // Check if it's a regular file before trying to read
      try {
        const stat = lstatSync(CRED_PATH);
        if (stat.isFile()) {
          originalContent = readFileSync(CRED_PATH, 'utf-8');
        } else {
          originalContent = null;
        }
      } catch {
        originalContent = null;
      }
      // Rename to backup
      try {
        const { renameSync } = await import('fs');
        renameSync(CRED_PATH, BACKUP_PATH);
      } catch {
        // If rename fails, just note that we couldn't back up
        originalExists = false;
      }
    } else {
      originalContent = null;
    }
  });

  afterEach(async () => {
    // Restore original credential file
    try {
      if (existsSync(CRED_PATH)) {
        rmSync(CRED_PATH, { force: true });
      }
    } catch {
      // best effort
    }

    if (originalExists && existsSync(BACKUP_PATH)) {
      try {
        const { renameSync } = await import('fs');
        renameSync(BACKUP_PATH, CRED_PATH);
      } catch {
        // best effort restore
      }
    }

    // Clean up backup if it still exists
    try {
      if (existsSync(BACKUP_PATH)) {
        rmSync(BACKUP_PATH, { force: true });
      }
    } catch {
      // best effort
    }
  });

  test('returns missing when credential file does not exist', () => {
    // Ensure no credential file exists (afterEach/beforeEach ensures backup)
    if (existsSync(CRED_PATH)) {
      rmSync(CRED_PATH, { force: true });
    }
    const result = resolveCredentials();
    expect(result).toEqual({ authState: 'missing', accessToken: null });
  });

  test('returns missing when file contains invalid JSON', () => {
    writeFileSync(CRED_PATH, 'not-valid-json{{{', 'utf-8');
    const result = resolveCredentials();
    expect(result).toEqual({ authState: 'missing', accessToken: null });
  });

  test('returns missing when claudeAiOauth key is absent', () => {
    writeFileSync(CRED_PATH, JSON.stringify({ someOtherKey: true }), 'utf-8');
    const result = resolveCredentials();
    expect(result).toEqual({ authState: 'missing', accessToken: null });
  });

  test('returns missing when claudeAiOauth is null', () => {
    writeFileSync(CRED_PATH, JSON.stringify({ claudeAiOauth: null }), 'utf-8');
    const result = resolveCredentials();
    expect(result).toEqual({ authState: 'missing', accessToken: null });
  });

  test('returns missing when accessToken is not a string', () => {
    writeFileSync(CRED_PATH, JSON.stringify({
      claudeAiOauth: { accessToken: 12345 },
    }), 'utf-8');
    const result = resolveCredentials();
    expect(result).toEqual({ authState: 'missing', accessToken: null });
  });

  test('returns missing when accessToken is empty string', () => {
    writeFileSync(CRED_PATH, JSON.stringify({
      claudeAiOauth: { accessToken: '' },
    }), 'utf-8');
    const result = resolveCredentials();
    expect(result).toEqual({ authState: 'missing', accessToken: null });
  });

  test('returns invalid when expiresAt is in the past', () => {
    writeFileSync(CRED_PATH, JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-expired-test',
        expiresAt: Date.now() - 60_000,
      },
    }), 'utf-8');
    const result = resolveCredentials();
    expect(result.authState).toBe('invalid');
    expect(result.accessToken).toBe('sk-ant-oat01-expired-test');
  });

  test('returns valid when expiresAt is in the future', () => {
    writeFileSync(CRED_PATH, JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-valid-test',
        expiresAt: Date.now() + 3600_000,
      },
    }), 'utf-8');
    const result = resolveCredentials();
    expect(result.authState).toBe('valid');
    expect(result.accessToken).toBe('sk-ant-oat01-valid-test');
  });

  test('returns valid when expiresAt is absent (no expiry check)', () => {
    writeFileSync(CRED_PATH, JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-noexpiry-test',
      },
    }), 'utf-8');
    const result = resolveCredentials();
    expect(result.authState).toBe('valid');
    expect(result.accessToken).toBe('sk-ant-oat01-noexpiry-test');
  });

  test('returns valid when expiresAt is not a number (skips expiry check)', () => {
    writeFileSync(CRED_PATH, JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-strexpiry-test',
        expiresAt: 'not-a-number',
      },
    }), 'utf-8');
    const result = resolveCredentials();
    expect(result.authState).toBe('valid');
    expect(result.accessToken).toBe('sk-ant-oat01-strexpiry-test');
  });

  test('returns missing when credential path is a directory (not a regular file)', () => {
    // Create a directory at the credential path to trigger the isFile() check
    if (existsSync(CRED_PATH)) {
      rmSync(CRED_PATH, { force: true, recursive: true });
    }
    mkdirSync(CRED_PATH, { recursive: true });
    const result = resolveCredentials();
    expect(result).toEqual({ authState: 'missing', accessToken: null });
    // Clean up the directory so afterEach can restore properly
    rmSync(CRED_PATH, { force: true, recursive: true });
  });

  test('returns valid with complete credential file including all fields', () => {
    writeFileSync(CRED_PATH, JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-complete-test',
        refreshToken: 'sk-ant-ort01-test',
        expiresAt: Date.now() + 7200_000,
        scopes: ['user:inference', 'user:profile'],
      },
    }), 'utf-8');
    const result = resolveCredentials();
    expect(result.authState).toBe('valid');
    expect(result.accessToken).toBe('sk-ant-oat01-complete-test');
  });
});
