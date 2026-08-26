import * as vscode from 'vscode';
import { resolveExtensionTelemetry } from './telemetry-gate.js';
import {
  resolveCredentials,
  fetchUsage,
  normalize,
  readCache,
  writeCache,
  isCacheFresh,
  makeCacheEnvelope,
  isInCooldown,
  enterCooldown,
  clearCooldown,
  shouldCooldown,
  markStale,
  makeErrorSnapshot,
  extractLastError,
} from './core-bridge.js';
import type { UsageSnapshot, CacheEnvelope, LastErrorInfo } from './core-bridge.js';
import { StatusBarManager } from './statusbar.js';
import { openDashboard } from './commands.js';

let statusBar: StatusBarManager | undefined;
let pollingTimer: ReturnType<typeof setInterval> | undefined;
let refreshInFlight = false;

/**
 * Whether telemetry may be emitted right now.
 *
 * The AND of VS Code's global switch and our own setting, per VS Code's telemetry guidance:
 * if isTelemetryEnabled reports false, telemetry must not be sent even when our setting is
 * on. Re-evaluated on both change events rather than read once at activation — reading once
 * would keep collecting from a user who turned telemetry off mid-session until they reloaded.
 */
let telemetryAllowed = false;

function recomputeTelemetryGate(): void {
  let globalEnabled: unknown;
  let settingEnabled: unknown;

  // Either read can throw on a host that does not implement it. A failed read is not consent.
  try {
    globalEnabled = (vscode.env as { isTelemetryEnabled?: unknown }).isTelemetryEnabled;
  } catch {
    globalEnabled = null;
  }
  try {
    settingEnabled = vscode.workspace
      .getConfiguration('claudewatch')
      .get<boolean>('telemetry.enabled');
  } catch {
    settingEnabled = null;
  }

  telemetryAllowed = resolveExtensionTelemetry(globalEnabled, settingEnabled);
}

/** The override handed to core's resolveTelemetryConfig, which treats it as highest priority. */
export function telemetryOverride(): { enabled: boolean } {
  return { enabled: telemetryAllowed };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  recomputeTelemetryGate();

  // VS Code's global telemetry switch can change at any time; honour it immediately.
  if (typeof (vscode.env as { onDidChangeTelemetryEnabled?: unknown }).onDidChangeTelemetryEnabled === 'function') {
    context.subscriptions.push(
      (vscode.env as unknown as {
        onDidChangeTelemetryEnabled: (cb: () => void) => vscode.Disposable;
      }).onDidChangeTelemetryEnabled(() => recomputeTelemetryGate()),
    );
  }

  statusBar = new StatusBarManager();
  context.subscriptions.push({ dispose: () => statusBar?.dispose() });


  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('claudewatch.refresh', () => {
      doRefresh(true);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudewatch.openDashboard', openDashboard),
  );
  // Register diagnostics command
  const { showDiagnostics } = await import('./commands.js');
  context.subscriptions.push(
    vscode.commands.registerCommand('claudewatch.diagnostics', showDiagnostics),
  );

  // Initial fetch
  doRefresh(false);

  // Start polling (register dispose once; startPolling may be called again on config change)
  context.subscriptions.push({ dispose: () => {
    if (pollingTimer) clearInterval(pollingTimer);
  }});
  startPolling();

  // React to config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudewatch.refreshIntervalSeconds')) {
        startPolling();
      }
      if (
        e.affectsConfiguration('claudewatch.warningThresholdPct') ||
        e.affectsConfiguration('claudewatch.criticalThresholdPct')
      ) {
        statusBar?.updateThresholds();
      }
      if (e.affectsConfiguration('claudewatch.telemetry.enabled')) {
        recomputeTelemetryGate();
      }
    }),
  );
}

export function deactivate(): void {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = undefined;
  }
  statusBar?.dispose();
  statusBar = undefined;
}

function startPolling(): void {
  if (pollingTimer) {
    clearInterval(pollingTimer);
  }

  const config = vscode.workspace.getConfiguration('claudewatch');
  const intervalSec = Math.max(config.get<number>('refreshIntervalSeconds', 60), 30);

  pollingTimer = setInterval(() => {
    doRefresh(false);
  }, intervalSec * 1000);
}

async function doRefresh(manual: boolean): Promise<void> {
  // In-flight dedupe
  if (refreshInFlight) return;

  try {
    refreshInFlight = true;

    // Read cache
    const cached = readCache();

    // If not manual and cache is fresh, just render from cache
    if (!manual && cached && isCacheFresh(cached)) {
      statusBar?.update(cached.snapshot, false);
      return;
    }

    // Check cooldown (manual refresh still respects cooldown)
    if (cached && isInCooldown(cached)) {
      const staleSnapshot = markStale(cached.snapshot);
      if (
        !cached.snapshot.freshness.isStale ||
        cached.snapshot.freshness.staleReason !== 'fetchFailed'
      ) {
        writeCache(
          makeCacheEnvelope(
            staleSnapshot,
            cached.cooldownUntil,
            cached.lastErrorClass,
          ),
        );
      }
      statusBar?.update(staleSnapshot, false, extractLastError(cached));
      return;
    }

    // Show loading state
    statusBar?.update(cached?.snapshot ?? null, true);

    // Resolve credentials
    const creds = resolveCredentials();
    if (creds.authState === 'missing' || !creds.accessToken) {
      const snapshot = makeErrorSnapshot('missing');
      writeCacheFromSnapshot(snapshot, cached);
      statusBar?.update(snapshot, false);
      return;
    }

    if (creds.authState === 'invalid') {
      const snapshot = makeErrorSnapshot('invalid');
      writeCacheFromSnapshot(snapshot, cached);
      statusBar?.update(snapshot, false);
      return;
    }

    // Fetch usage data
    const result = await fetchUsage(creds.accessToken);

    if (result.ok) {
      const snapshot = normalize(result.data);
      const envelope = clearCooldown(makeCacheEnvelope(snapshot));
      writeCache(envelope);
      statusBar?.update(snapshot, false);
      return;
    }

    // Fetch failed
    if (result.failureClass === 'authInvalid') {
      const snapshot = makeErrorSnapshot('invalid');
      writeCacheFromSnapshot(snapshot, cached);
      statusBar?.update(snapshot, false);
      return;
    }

    // Service unavailable or other failure — stale-while-error
    const fetchError: LastErrorInfo = { httpStatus: result.status, message: result.message };
    if (cached?.snapshot) {
      const staleSnapshot = markStale(cached.snapshot);
      let envelope = makeCacheEnvelope(staleSnapshot, cached.cooldownUntil, cached.lastErrorClass);
      if (shouldCooldown(result.failureClass)) {
        envelope = enterCooldown(envelope, result.failureClass, result.status, result.message);
      }
      writeCache(envelope);
      statusBar?.update(staleSnapshot, false, fetchError);
    } else {
      // No cached data at all
      const snapshot = makeErrorSnapshot('unknown');
      let envelope = makeCacheEnvelope(snapshot);
      if (shouldCooldown(result.failureClass)) {
        envelope = enterCooldown(envelope, result.failureClass, result.status, result.message);
      }
      writeCache(envelope);
      statusBar?.update(snapshot, false, fetchError);
    }
  } catch {
    // Unexpected runtime error — don't crash the extension
    const cached = readCache();
    statusBar?.update(cached?.snapshot ?? null, false);
  } finally {
    refreshInFlight = false;
  }
}

function writeCacheFromSnapshot(snapshot: UsageSnapshot, existing: CacheEnvelope | null): void {
  const envelope = makeCacheEnvelope(
    snapshot,
    existing?.cooldownUntil ?? null,
    existing?.lastErrorClass ?? null,
  );
  writeCache(envelope);
}


