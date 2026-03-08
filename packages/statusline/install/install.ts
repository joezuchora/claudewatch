#!/usr/bin/env bun
/**
 * ClaudeWatch status line installer for Claude Code.
 *
 * Usage:  bun run packages/statusline/install/install.ts
 *
 * What it does:
 *   1. Builds the statusline binary for the current platform.
 *   2. Copies the binary to ~/.claude/bin/claudewatch[.exe].
 *   3. Updates ~/.claude/settings.json so Claude Code uses it as the status line.
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';

const currentPlatform = platform();
if (currentPlatform !== 'win32' && currentPlatform !== 'linux') {
  console.error(
    `[claudewatch] ERROR: Unsupported platform "${currentPlatform}". ` +
    `ClaudeWatch v1 supports Windows and Linux only (macOS requires Keychain integration — see SPEC.md §1.3).`
  );
  process.exit(1);
}
const isWindows = currentPlatform === 'win32';
const claudeDir = join(homedir(), '.claude');
const binDir = join(claudeDir, 'bin');
const settingsPath = join(claudeDir, 'settings.json');
const binaryName = isWindows ? 'claudewatch.exe' : 'claudewatch';
const installedBinary = join(binDir, binaryName);

// Status line command — use forward slashes for cross-platform compat in Claude Code
const statusLineCommand = isWindows
  ? `~/.claude/bin/${binaryName}`
  : `~/.claude/bin/${binaryName}`;

function log(msg: string): void {
  console.log(`[claudewatch] ${msg}`);
}

function buildBinary(): void {
  log('Building statusline binary...');
  const projectRoot = join(import.meta.dir, '..', '..', '..');
  const buildScript = isWindows ? 'build:windows' : 'build:linux';
  execSync(`bun run --filter @claudewatch/statusline ${buildScript}`, {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  log('Build complete.');
}

function installBinary(): void {
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
    log(`Created ${binDir}`);
  }

  const distDir = join(import.meta.dir, '..', 'dist');
  const builtBinary = join(distDir, binaryName);

  if (!existsSync(builtBinary)) {
    console.error(`[claudewatch] ERROR: Built binary not found at ${builtBinary}`);
    process.exit(1);
  }

  // On Windows, the binary may be locked by a running process (e.g. Claude Code).
  // Rename the old binary out of the way first, then copy the new one.
  const oldBinary = installedBinary + '.old';
  if (existsSync(installedBinary)) {
    try {
      if (existsSync(oldBinary)) unlinkSync(oldBinary);
      renameSync(installedBinary, oldBinary);
    } catch {
      console.error(
        `[claudewatch] ERROR: Cannot replace ${installedBinary} — it may be locked by a running process.\n` +
        `Close Claude Code and try again.`
      );
      process.exit(1);
    }
  }

  copyFileSync(builtBinary, installedBinary);
  if (!isWindows) {
    execSync(`chmod +x "${installedBinary}"`);
  }

  // Clean up old binary
  try { if (existsSync(oldBinary)) unlinkSync(oldBinary); } catch { /* best effort */ }

  log(`Installed binary to ${installedBinary}`);
}

function updateSettings(): void {
  let settings: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      console.error(`[claudewatch] ERROR: Could not parse ${settingsPath}`);
      process.exit(1);
    }
  }

  const existing = settings.statusLine as Record<string, unknown> | undefined;
  if (existing?.command === statusLineCommand) {
    log('Claude Code settings already configured — no changes needed.');
    return;
  }

  // Back up previous status line config
  if (existing) {
    settings._statusLinePrevious = existing;
    log(`Backed up previous statusLine config to _statusLinePrevious.`);
  }

  settings.statusLine = {
    type: 'command',
    command: statusLineCommand,
  };

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  log(`Updated ${settingsPath}`);
}

// --- Run ---

try {
  log('Starting ClaudeWatch status line install...');
  buildBinary();
  installBinary();
  updateSettings();
  log('Done! Restart Claude Code to see ClaudeWatch in your status line.');
} catch (err) {
  console.error('[claudewatch] Install failed:', err);
  process.exit(1);
}
