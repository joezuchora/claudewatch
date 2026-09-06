#!/usr/bin/env bun
/** Start the metrics service. Configured entirely by environment. */
import { startServer, ConfigurationError } from './server.js';
import { defaultDbPath } from './store.js';

const port = Number(process.env.CLAUDEWATCH_METRICS_PORT ?? 8787);
const hostname = process.env.CLAUDEWATCH_METRICS_HOST ?? '127.0.0.1';
const token = process.env.CLAUDEWATCH_METRICS_TOKEN ?? null;
const dbPath = process.env.CLAUDEWATCH_METRICS_DB ?? defaultDbPath();

try {
  const { server } = startServer({ port, hostname, token, dbPath });
  console.log(`claudewatch-metrics listening on http://${server.hostname}:${server.port}`);
  console.log(`  store: ${dbPath}`);
  console.log(`  auth:  ${token ? 'bearer token required' : 'none (loopback only)'}`);
} catch (err) {
  if (err instanceof ConfigurationError) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(2);
  }
  throw err;
}
