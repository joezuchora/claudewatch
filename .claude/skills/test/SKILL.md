---
description: Run the ClaudeWatch test suite
allowed-tools: Bash
---

Run the test suite for ClaudeWatch using `bun test`. If specific packages or test files are mentioned in the arguments, scope the run accordingly.

Arguments: $ARGUMENTS

Steps:
1. Run `bun test` (or scoped to the specified package/file if arguments provided)
2. Report results: total tests, passes, failures
3. If any tests fail, briefly summarize which tests failed and why
