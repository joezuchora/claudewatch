import * as vscode from 'vscode';
import type { UsageSnapshot, RuntimeState, ThresholdLevel, LastErrorInfo } from '@claudewatch/core';
import { classify, evaluate, emitProcess, renderEvent, utilizationBucket } from './statusbar-bridge.js';
import { buildTooltip } from './tooltip.js';

export class StatusBarManager {
  private item: vscode.StatusBarItem;
  private warnPct: number;
  private critPct: number;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.command = 'claudewatch.openDashboard';
    this.item.name = 'ClaudeWatch';
    this.item.show();

    const config = vscode.workspace.getConfiguration('claudewatch');
    this.warnPct = config.get<number>('warningThresholdPct', 70);
    this.critPct = config.get<number>('criticalThresholdPct', 90);
  }

  updateThresholds(): void {
    const config = vscode.workspace.getConfiguration('claudewatch');
    this.warnPct = config.get<number>('warningThresholdPct', 70);
    this.critPct = config.get<number>('criticalThresholdPct', 90);
  }

  /**
   * Update the status bar to reflect the current state and snapshot.
   */
  update(
    snapshot: UsageSnapshot | null,
    loading: boolean = false,
    lastError?: LastErrorInfo | null,
  ): void {
    if (!snapshot) {
      // Initializing state
      if (loading) {
        this.item.text = '$(sync~spin) ClaudeWatch';
      } else {
        this.item.text = '$(warning) ClaudeWatch';
      }
      this.item.tooltip = buildTooltip('Initializing', null);
      this.item.color = undefined;
      this.item.backgroundColor = undefined;
      return;
    }

    const state = classify(snapshot);
    this.applyState(state, snapshot, loading, this.warnPct, this.critPct);
    this.item.tooltip = buildTooltip(state, snapshot, lastError);

    // The single funnel every status-bar render passes through, mirroring the statusline's
    // output(). doRefresh has twelve update() call sites; emitting at each would repeat the
    // multi-exit hazard loop 007 hit in client.ts.
    //
    // emitProcess reads the process consent that extension.ts pushed in from
    // recomputeTelemetryGate, so this call site cannot bypass VS Code's global switch — it
    // has no consent state of its own to get wrong.
    emitProcess(renderEvent({
      surface: 'vscode',
      runtimeState: state,
      tier: snapshot.tier,
      utilizationBucket: utilizationBucket(snapshot.display.primaryUtilizationPct),
      durationMs: null,
    }));
  }

  private applyState(
    state: RuntimeState,
    snapshot: UsageSnapshot,
    loading: boolean,
    warnPct: number,
    critPct: number,
  ): void {
    const pct = snapshot.display.primaryUtilizationPct;

    switch (state) {
      case 'Healthy':
      case 'Stale': {
        const pctText = pct !== null ? `${Math.round(pct)}%` : '—';
        if (loading) {
          this.item.text = `$(sync~spin) ${pctText}`;
        } else {
          this.item.text = `$(graph) ${pctText}`;
        }
        if (pct !== null) {
          this.applyThresholdColor(evaluate(pct, warnPct, critPct));
        } else {
          this.item.color = undefined;
          this.item.backgroundColor = undefined;
        }
        break;
      }

      case 'Enterprise': {
        // Enterprise utilization can span <1% to 100%, so use the same
        // sub-1% precision as the statusline rather than rounding to "0%".
        const ePct = snapshot.enterprise?.utilizationPct ?? null;
        const pctText = ePct === null
          ? 'E'
          : ePct >= 10 ? `E ${Math.round(ePct)}%`
          : ePct >= 1 ? `E ${ePct.toFixed(1)}%`
          : `E ${ePct.toFixed(2)}%`;
        if (loading) {
          this.item.text = `$(sync~spin) ${pctText}`;
        } else {
          this.item.text = `$(organization) ${pctText}`;
        }
        if (ePct !== null) {
          this.applyThresholdColor(evaluate(ePct, warnPct, critPct));
        } else {
          this.item.color = undefined;
          this.item.backgroundColor = undefined;
        }
        break;
      }

      case 'Degraded': {
        this.item.text = '$(warning) ClaudeWatch';
        this.item.color = new vscode.ThemeColor('errorForeground');
        this.item.backgroundColor = undefined;
        break;
      }

      case 'AuthInvalid': {
        this.item.text = '$(warning) ClaudeWatch';
        this.item.color = new vscode.ThemeColor('errorForeground');
        this.item.backgroundColor = undefined;
        break;
      }

      case 'NotConfigured': {
        this.item.text = '$(warning) ClaudeWatch';
        this.item.color = undefined;
        this.item.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.errorBackground',
        );
        break;
      }

      case 'HardFailure': {
        this.item.text = '$(warning) ClaudeWatch';
        this.item.color = new vscode.ThemeColor('errorForeground');
        this.item.backgroundColor = undefined;
        break;
      }

      default: {
        this.item.text = '$(warning) ClaudeWatch';
        this.item.color = undefined;
        this.item.backgroundColor = undefined;
      }
    }
  }

  private applyThresholdColor(level: ThresholdLevel): void {
    switch (level) {
      case 'normal':
        this.item.color = undefined;
        this.item.backgroundColor = undefined;
        break;
      case 'warning':
        this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      case 'critical':
        this.item.color = new vscode.ThemeColor('statusBarItem.errorForeground');
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
