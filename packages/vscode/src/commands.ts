import * as vscode from 'vscode';


const DASHBOARD_URL = 'https://claude.ai/settings/usage';

/**
 * Print diagnostics: extension bundle path and formatter output.
 */
export async function showDiagnostics(): Promise<void> {
  const vscode = await import('vscode');
  const core = await import('@claudewatch/core');
  const path = __filename;
  let cache: any = null;
  let formatted = '';
  try {
    cache = core.readCache();
    if (cache && cache.snapshot) {
      formatted = core.formatTooltip(cache.snapshot);
    } else {
      formatted = 'No cache or snapshot found.';
    }
  } catch (err) {
    formatted = 'Error reading cache: ' + (err?.message || err);
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
