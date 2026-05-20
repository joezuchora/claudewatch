param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [switch]$OpenNewWindow
)

$ErrorActionPreference = "Stop"

function Resolve-CodeCli {
  $codeCmd = Get-Command "code.cmd" -ErrorAction SilentlyContinue
  $codeInsidersCmd = Get-Command "code-insiders.cmd" -ErrorAction SilentlyContinue

  $candidates = @(
    $(if ($codeCmd) { $codeCmd.Source } else { $null }),
    $(if ($codeInsidersCmd) { $codeInsidersCmd.Source } else { $null }),
    "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
    "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd",
    "$env:LOCALAPPDATA\Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd",
    "$env:ProgramFiles\Microsoft VS Code Insiders\bin\code-insiders.cmd"
  ) | Where-Object { $_ -and (Test-Path $_) }

  if ($candidates.Count -eq 0) {
    throw "Could not find VS Code CLI (code.cmd/code-insiders.cmd)."
  }

  return $candidates[0]
}

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' was not found in PATH."
  }
}

Require-Command "bun"
Require-Command "npx"
$codeCli = Resolve-CodeCli

Push-Location $RepoRoot
try {
  Write-Host "Building VS Code extension..."
  bun run --filter claudewatch-vscode build
  if ($LASTEXITCODE -ne 0) { throw "Build failed." }

  $vscodeDir = Join-Path $RepoRoot "packages\vscode"
  Push-Location $vscodeDir
  try {
    Write-Host "Packaging VSIX..."
    npx @vscode/vsce package --no-dependencies
    if ($LASTEXITCODE -ne 0) { throw "VSIX packaging failed." }

    $vsix = Get-ChildItem -Path $vscodeDir -Filter "claudewatch-vscode-*.vsix" |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1

    if (-not $vsix) {
      throw "No VSIX file found in packages/vscode."
    }

    Write-Host "Installing VSIX: $($vsix.FullName)"
    Write-Host "Uninstalling existing extension instance (if present)..."
    & $codeCli --uninstall-extension claudewatch.claudewatch-vscode | Out-Null
    Write-Host "Installing extension from fresh VSIX..."
    & $codeCli --install-extension "$($vsix.FullName)" --force
    if ($LASTEXITCODE -ne 0) { throw "VSIX install failed." }
  }
  finally {
    Pop-Location
  }

  if ($OpenNewWindow) {
    Write-Host "Opening workspace in a new VS Code window..."
    & $codeCli "$RepoRoot"
  } else {
    Write-Host "Reusing existing VS Code window..."
    & $codeCli -r "$RepoRoot"
  }

  Write-Host "Done. In VS Code, run: ClaudeWatch: Refresh Now"
}
finally {
  Pop-Location
}
