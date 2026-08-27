import * as vscode from 'vscode';
import { readCache, formatTooltip } from './commands-bridge.js';
import type { CacheEnvelope } from './commands-bridge.js';

const DASHBOARD_URL = 'https://claude.ai/settings/usage';

/**
 * Print diagnostics: extension bundle path and formatter output.
 */
export async function showDiagnostics(): Promise<void> {
  const path = __filename;
  // `CacheEnvelope | null` is readCache's actual return type. The `&& cache.snapshot` guard below
  // is unreachable under it — CacheEnvelope.snapshot is non-nullable — and is RETAINED verbatim
  // anyway: deleting it would change what showDiagnostics displays, which sdlc/028's intent scopes
  // out. The no-cache case reaches that branch via `cache === null` only.
  let cache: CacheEnvelope | null = null;
  let formatted = '';
  try {
    cache = readCache();
    if (cache && cache.snapshot) {
      formatted = formatTooltip(cache.snapshot);
    } else {
      formatted = 'No cache or snapshot found.';
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    formatted = 'Error reading cache: ' + message;
  }
  const msg = [
    '**ClaudeWatch Diagnostics**',
    '',
    `**Extension bundle path:**`,
    '```',
    path,
    '```',
    '',
    `**Formatter output (from cache):**`,
    '```',
    formatted,
    '```',
  ].join('\n');
  vscode.window.showInformationMessage(msg, { modal: true });
}

/**
 * Open the Claude AI usage dashboard in the default browser.
 */
export function openDashboard(): void {
  vscode.env.openExternal(vscode.Uri.parse(DASHBOARD_URL));
}
