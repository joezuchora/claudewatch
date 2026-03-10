import * as vscode from 'vscode';
import type { UsageSnapshot, RuntimeState, LastErrorInfo } from '@claudewatch/core';
import { formatTooltip } from '@claudewatch/core';

/** Error/degraded tooltip details per SPEC §10.7 */
const ERROR_DETAILS: Record<string, { message: string; remediation: string }> = {
  NotConfigured: {
    message: 'Claude Code credentials not found.',
    remediation: 'Install Claude Code and sign in to get started.',
  },
  AuthInvalid: {
    message: 'Session token is invalid or expired.',
    remediation: 'Re-authenticate via Claude Code to refresh your credentials.',
  },
  Degraded: {
    message: 'Usage response format has changed.',
    remediation: 'The undocumented API endpoint may have been updated. Check for a newer version of ClaudeWatch.',
  },
  HardFailure: {
    message: 'An unexpected error occurred.',
    remediation: 'The undocumented API endpoint may have changed. Check for a newer version of ClaudeWatch.',
  },
  Initializing: {
    message: 'Loading usage data...',
    remediation: 'This should only take a moment.',
  },
};

/**
 * Build a structured error tooltip with header, status, and remediation.
 */
function buildErrorTooltip(
  state: RuntimeState,
  lastError?: LastErrorInfo | null,
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  const details = ERROR_DETAILS[state] ?? {
    message: 'An unexpected error occurred.',
    remediation: 'Try restarting VS Code.',
  };

  const lines: string[] = ['ClaudeWatch', ''];
  lines.push('Status');
  lines.push(details.message);

  if (lastError?.message) {
    lines.push(`Last error: ${lastError.message}`);
  }

  lines.push('');
  lines.push('Next Steps');
  lines.push(details.remediation);
  lines.push('');
  lines.push('Click to open usage dashboard →');

  md.appendText(lines.join('\n'));
  return md;
}

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

  return buildErrorTooltip(state, lastError);
}
