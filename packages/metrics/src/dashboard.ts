/**
 * Server-rendered dashboard. No external assets: it must work on a NUC with no internet,
 * and a metrics page that fetches from a CDN is a metrics page that fails when you most
 * want it.
 */
import type { Stats, StoredEvent } from './types.js';

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const ms = (v: number | null): string => (v === null ? '—' : `${(v / 1000).toFixed(1)}s`);
const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(0)}%`);

export function renderDashboard(stats: Stats, recent: StoredEvent[]): string {
  const verifyRuns = recent.filter((e) => e.kind === 'verify_run');

  const rows = verifyRuns.slice(0, 25).map((e) => {
    const outcome = String(e.payload.outcome ?? (e.ok ? 'pass' : 'fail'));
    const cls = outcome === 'pass' ? 'ok' : outcome === 'timeout' ? 'timeout' : 'fail';
    return `<tr>
      <td class="mono">${esc(e.receivedAt.replace('T', ' ').slice(0, 19))}</td>
      <td><span class="badge ${cls}">${esc(outcome)}</span></td>
      <td class="mono num">${esc(ms(e.durationMs))}</td>
      <td class="mono">${esc(e.payload.failedStep ?? '')}</td>
    </tr>`;
  }).join('\n');

  const sources = stats.bySource
    .map((s) => `<li><strong>${esc(s.source)}</strong> <span class="dim">${esc(s.count)}</span></li>`)
    .join('');

  // A hang is the anomaly this whole pipeline exists to catch, so it gets its own tile.
  const hangSuspect = stats.verify.maxDurationMs !== null && stats.verify.p95DurationMs !== null
    && stats.verify.maxDurationMs > stats.verify.p95DurationMs * 4;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ClaudeWatch Metrics</title>
<style>
:root{--bg:#fbfbfa;--fg:#1a1a19;--dim:#6b6b68;--line:#e4e4e1;--card:#fff;
--ok:#1a7f4b;--fail:#b3261e;--warn:#a3610a}
@media(prefers-color-scheme:dark){:root{--bg:#191918;--fg:#f0efec;--dim:#9a9a95;
--line:#33322f;--card:#232320;--ok:#4ac47f;--fail:#f0776c;--warn:#e0a33c}}
*{box-sizing:border-box}
body{margin:0;padding:2rem 1.25rem;background:var(--bg);color:var(--fg);
font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:60rem;margin:0 auto}
h1{font-size:1.35rem;margin:0 0 .25rem;letter-spacing:-.01em}
.sub{color:var(--dim);margin:0 0 1.75rem;font-size:.9rem}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.75rem;margin-bottom:1.5rem}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.85rem 1rem}
.tile .k{color:var(--dim);font-size:.72rem;text-transform:uppercase;letter-spacing:.06em}
.tile .v{font-size:1.5rem;font-weight:600;margin-top:.15rem;letter-spacing:-.02em}
.alert{background:var(--card);border:1px solid var(--warn);border-left-width:3px;
border-radius:8px;padding:.8rem 1rem;margin-bottom:1.5rem;font-size:.9rem}
.alert b{color:var(--warn)}
table{width:100%;border-collapse:collapse;background:var(--card);
border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:.5rem .85rem;border-bottom:1px solid var(--line);font-size:.86rem}
th{color:var(--dim);font-weight:500;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em}
tr:last-child td{border-bottom:0}
.num{text-align:right}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.82rem}
.badge{display:inline-block;padding:.05rem .45rem;border-radius:5px;font-size:.75rem;font-weight:500}
.badge.ok{background:color-mix(in srgb,var(--ok) 15%,transparent);color:var(--ok)}
.badge.fail{background:color-mix(in srgb,var(--fail) 15%,transparent);color:var(--fail)}
.badge.timeout{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}
ul{list-style:none;padding:0;margin:.35rem 0 0;display:flex;gap:1rem;flex-wrap:wrap;font-size:.85rem}
.dim{color:var(--dim)}
footer{margin-top:1.5rem;color:var(--dim);font-size:.78rem}
</style></head><body><div class="wrap">
<h1>ClaudeWatch Metrics</h1>
<p class="sub">SDLC loop and product health · ${esc(stats.totalEvents)} events retained</p>

${hangSuspect ? `<div class="alert"><b>Possible hang detected.</b> Slowest verify run
(${esc(ms(stats.verify.maxDurationMs))}) is more than 4&times; p95
(${esc(ms(stats.verify.p95DurationMs))}). This is the signal loop 005 is chasing.</div>` : ''}

<div class="tiles">
  <div class="tile"><div class="k">Verify runs</div><div class="v">${esc(stats.verify.runs)}</div></div>
  <div class="tile"><div class="k">Pass rate</div><div class="v">${esc(pct(stats.verify.passRate))}</div></div>
  <div class="tile"><div class="k">p50</div><div class="v">${esc(ms(stats.verify.p50DurationMs))}</div></div>
  <div class="tile"><div class="k">p95</div><div class="v">${esc(ms(stats.verify.p95DurationMs))}</div></div>
  <div class="tile"><div class="k">Slowest</div><div class="v">${esc(ms(stats.verify.maxDurationMs))}</div></div>
  <div class="tile"><div class="k">Timeouts</div><div class="v">${esc(stats.verify.timeouts)}</div></div>
</div>

<table>
  <thead><tr><th>Received</th><th>Outcome</th><th class="num">Duration</th><th>Failed step</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="4" class="dim">No verify runs recorded yet.</td></tr>'}</tbody>
</table>

<footer>Sources:<ul>${sources || '<li class="dim">none</li>'}</ul></footer>
</div></body></html>`;
}
