# Memex MCP installer bootstrap (Windows PowerShell). Verifies Node ≥18, then runs the
# latest memex-ai installer via npx. Re-runnable; only side-effects are config-file edits.
#
# Source: {{API_BASE_URL}}/install.ps1

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  Memex MCP Installer" -ForegroundColor Cyan
Write-Host ""

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "  Node.js is not installed." -ForegroundColor Red
    Write-Host "  Install Node 18+ from https://nodejs.org and re-run this command."
    Write-Host ""
    exit 1
}

$version = (& node -p "process.versions.node.split('.')[0]")
if ([int]$version -lt 18) {
    Write-Host "  Node $version is too old; need >=18." -ForegroundColor Red
    Write-Host "  Upgrade Node and re-run this command."
    Write-Host ""
    exit 1
}

Write-Host "  Node $(node --version) detected." -ForegroundColor DarkGray
Write-Host "  Running: npx -y memex-ai" -ForegroundColor DarkGray
Write-Host ""

# Forward any extra args from the caller (PowerShell collects them in $args).
& npx -y memex-ai @args
exit $LASTEXITCODE
