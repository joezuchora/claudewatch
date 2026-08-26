#!/usr/bin/env bun
/** Ship spooled product telemetry to the metrics service. Run from a timer, or by verify. */
import { ship } from './agent.js';
import { getSpoolPath } from '@claudewatch/core';

const endpoint = process.env.CLAUDEWATCH_METRICS_ENDPOINT;
if (!endpoint) {
  // Not an error: the overwhelmingly common case is telemetry simply not being configured.
  console.log('CLAUDEWATCH_METRICS_ENDPOINT not set — nothing to do.');
  process.exit(0);
}

const result = await ship({
  spoolPath: getSpoolPath(),
  endpoint,
  token: process.env.CLAUDEWATCH_METRICS_TOKEN ?? null,
});

console.log(
  `shipped ${result.shipped} events from ${result.filesShipped} file(s); ` +
  `retained ${result.filesRetained}, dropped ${result.filesDropped}, ` +
  `skipped ${result.skippedUnparseable} unparseable line(s)`,
);
process.exit(result.filesRetained > 0 ? 1 : 0);
