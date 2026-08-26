# Security policy

ClaudeWatch reads your Claude OAuth credentials in order to query your usage windows. The
blast radius of a mistake here is an access token, so security findings are taken seriously
even when they look theoretical.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's [Report a vulnerability][advisories] flow on this
repository, which opens a private security advisory visible only to the maintainer.

Please include what you can:

- What the issue is and where in the code it lives
- How to reproduce it, or what makes it exploitable
- What an attacker gets — token disclosure, arbitrary write, code execution
- Anything you already know about mitigations

This is a personal open-source project maintained by one person, so there is no formal SLA.
You can expect an acknowledgement within a few days and honest updates on progress. If you
plan to disclose publicly, please give a reasonable window to ship a fix first.

[advisories]: https://github.com/joezuchora/claudewatch/security/advisories/new

## Design guarantees

These are invariants, specified in `SPEC.md §12` and re-checked on every change by the
security pass in [`REVIEW.md`](./REVIEW.md). A violation of any of them is a vulnerability,
not a bug:

- **Your token is never written anywhere.** Not to logs, not to the cache file, not to
  `--debug` output, not to error messages, and not to process arguments where `ps` could
  see it.
- **Credentials are read-only.** ClaudeWatch reads `~/.claude/.credentials.json` and never
  writes, refreshes, or moves it. Claude Code owns that file.
- **TLS is never disabled.** The API base is hardcoded `https://`, verification is always
  on, and the request times out after 5 seconds.
- **Cache files are private.** Written atomically (temp file then rename), directory `0700`,
  file `0600`, with symlink targets checked before writing.
- **No telemetry.** Nothing is transmitted anywhere except the documented Anthropic usage
  endpoint. There is no analytics, no crash reporting, and no phone-home.
- **No third-party runtime dependencies** in `packages/core`, which keeps the supply-chain
  surface to Bun and the standard library.

## Scope

In scope: anything in this repository — the core library, the statusline binary, the VS Code
extension, the install scripts, and the CI workflows.

Out of scope: vulnerabilities in Bun, VS Code, or the Anthropic API itself. Please report
those to their respective maintainers.

## Known accepted items

`docs/audit-report.md` records informational findings that are open and tracked rather than
silently ignored — currently `execSync` argument interpolation in the installer, a
non-atomic write to `~/.claude/settings.json` during install, and `JSON.parse(...) as T`
assertions on data crossing a trust boundary. They are listed as standing checks in
`REVIEW.md`. If you can demonstrate one is exploitable rather than theoretical, that is very
much worth reporting.
