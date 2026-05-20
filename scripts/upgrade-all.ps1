param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [switch]$OpenNewWindow
)

$ErrorActionPreference = "Stop"

Push-Location $RepoRoot
try {
  Write-Host "[claudewatch] Updating VS Code extension..."
  if ($OpenNewWindow) {
    & (Join-Path $RepoRoot "scripts\reinstall-vscode-extension.ps1") -RepoRoot $RepoRoot -OpenNewWindow
  } else {
    & (Join-Path $RepoRoot "scripts\reinstall-vscode-extension.ps1") -RepoRoot $RepoRoot
  }
  if ($LASTEXITCODE -ne 0) { throw "VS Code extension update failed." }

  Write-Host "[claudewatch] Updating Claude Code statusline binary..."
  bun run install-statusline
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[claudewatch] Statusline update failed."
    Write-Host "[claudewatch] If Claude Code is running, close it and rerun: bun run install-statusline"
    throw "Statusline update failed."
  }

  Write-Host "[claudewatch] Upgrade complete."
  Write-Host "[claudewatch] Next steps:"
  Write-Host "  1) VS Code: Developer: Restart Extension Host"
  Write-Host "  2) Claude Code: fully restart the app"
}
finally {
  Pop-Location
}
