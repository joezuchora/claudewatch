---
description: Create a pull request for the current branch
allowed-tools: Bash, Read, Grep, Glob
---

Create a pull request for the current branch. Follow these steps:

1. Check for any uncommitted changes. If there are any, commit them first with a clear message.
2. Push the current branch to origin.
3. Run `git log origin/main..HEAD --oneline` to understand all commits on this branch.
4. Draft a PR title (under 70 chars) and body using the project template format:

```
## Summary
- bullet points

## Test plan
- [ ] checklist items
```

5. Since `gh` is not available in this environment, output a ready-to-paste **single-line PowerShell command** using backtick-n for newlines:

```
gh pr create --title "title here" --body "## Summary`n- point 1`n`n## Test plan`n- [ ] item 1"
```

6. Also output a short reminder:
   - After creating: `gh pr merge --squash`
   - After merging: `git checkout main; git pull`

Arguments: $ARGUMENTS
