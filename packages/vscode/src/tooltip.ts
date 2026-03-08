import * as vscode from 'vscode';
import type { UsageSnapshot, RuntimeState, LastErrorInfo } from '@claudewatch/core';
import { formatTooltip } from '@claudewatch/core';

/** Error/degraded tooltip messages per SPEC §10.7 */
const ERROR_MESSAGES: Record<string, string> = {
  NotConfigured: 'Claude Code credentials not found. Install Claude Code and sign in.',
  AuthInvalid: 'Session token is invalid or expired. Re-authenticate via Claude Code.',
  Stale: 'Showing last known usage data. Latest refresh failed.',
  Degraded: 'Usage response format changed. The undocumented endpoint may have changed.',
  HardFailure: 'Usage response format changed. The undocumented endpoint may have changed.',
  Initializing: 'Loading usage data...',
};

/**
 * Build a MarkdownString tooltip from current state and snapshot.
 */
export function buildTooltip(
  state: RuntimeState,
  snapshot: UsageSnapshot | null,
  lastError?: LastErrorInfo | null,
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();

  if (state === 'Healthy' || state === 'Stale') {
    if (snapshot) {
      md.appendText(formatTooltip(snapshot, lastError));
      return md;
    }
  }

  // Error states
  md.appendText('ClaudeWatch\n\n');
  const message = ERROR_MESSAGES[state] ?? 'An unexpected error occurred.';
  md.appendText(message);

  return md;
}
