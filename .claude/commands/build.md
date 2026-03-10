---
description: Build ClaudeWatch packages
allowed-tools: Bash
---

Build ClaudeWatch packages. By default, build all packages. If a specific package is mentioned in the arguments, build only that one.

Arguments: $ARGUMENTS

Available build targets:
- **core**: `bun run --filter @claudewatch/core build`
- **statusline**: `bun run --filter @claudewatch/statusline build`
- **vscode**: `bun run --filter claudewatch-vscode build`

Steps:
1. If no arguments, build all three packages in dependency order (core first, then statusline and vscode in parallel)
2. If a package name is given (core, statusline, vscode), build only that package
3. Report success or failure for each build target
