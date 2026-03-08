import * as vscode from 'vscode';

const DASHBOARD_URL = 'https://claude.ai/settings/usage';

/**
 * Open the Claude AI usage dashboard in the default browser.
 */
export function openDashboard(): void {
  vscode.env.openExternal(vscode.Uri.parse(DASHBOARD_URL));
}
