import { readFileSync, lstatSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { CredentialResult, CredentialFile } from './types.js';

export function getCredentialPath(): string {
  return join(homedir(), '.claude', '.credentials.json');
}

export function resolveCredentials(): CredentialResult {
  const path = getCredentialPath();

  // Verify the credential file is a regular file, not a symlink
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) {
      return { authState: 'missing', accessToken: null };
    }
  } catch {
    return { authState: 'missing', accessToken: null };
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return { authState: 'missing', accessToken: null };
  }

  let parsed: CredentialFile;
  try {
    parsed = JSON.parse(raw) as CredentialFile;
  } catch {
    return { authState: 'missing', accessToken: null };
  }

  const oauth = parsed?.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) {
    return { authState: 'missing', accessToken: null };
  }

  // Check expiresAt if present
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt < Date.now()) {
    return { authState: 'invalid', accessToken: oauth.accessToken };
  }

  return { authState: 'valid', accessToken: oauth.accessToken };
}
