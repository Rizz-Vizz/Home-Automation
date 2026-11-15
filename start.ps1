param(
    [switch]$ProductionPreview
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$GwDir = Join-Path $Root "gateway"
$UiDir = Join-Path $Root "dashboard"

if (-not (Test-Path (Join-Path $GwDir "node_modules"))) {
    Write-Host "Installing Gateway dependencies (npm install)..."
    Push-Location $GwDir
    npm install --no-audit --no-fund
    Pop-Location
}

if (-not (Test-Path (Join-Path $UiDir "node_modules"))) {
    Write-Host "Installing Dashboard dependencies (npm install)..."
    Push-Location $UiDir
    npm install --no-audit --no-fund
    Pop-Location
}

if (-not (Test-Path (Join-Path $GwDir ".env"))) {
    Write-Host "No gateway\.env yet: generating secrets and login PINs..."
    python (Join-Path $Root "firmware\tools\gen_secrets.py")
    Write-Host "Rebuild and flash the firmware now: .\flash-board.ps1 -Build"
}

if (-not (Test-Path (Join-Path $UiDir ".env"))) {
    Copy-Item (Join-Path $UiDir ".env.example") (Join-Path $UiDir ".env")
    Write-Host "Created dashboard\.env from .env.example"
}

Write-Host "Starting Home Automation Gateway (COM6 / MQTT :1883 / HTTP+WS :8080)..."
$gwProc = Start-Process -FilePath "node" -ArgumentList "src/index.js" -WorkingDirectory $GwDir -PassThru

$uiArgs = if ($ProductionPreview) { @("run", "preview") } else { @("run", "dev") }
Write-Host "Starting Home Automation Dashboard (http://127.0.0.1:5173)..."
$uiProc = Start-Process -FilePath "npm.cmd" -ArgumentList $uiArgs -WorkingDirectory $UiDir -PassThru

Write-Host ""
Write-Host "Home Automation started successfully:"
Write-Host "  Gateway       : http://127.0.0.1:8080/api/health"
Write-Host "  Dashboard URL : http://127.0.0.1:5173"
Write-Host "  Demo PINs     : 1 (Owner), 2 (Family), 3 (Guest)"
Write-Host "To stop both: Stop-Process -Id $($gwProc.Id),$($uiProc.Id)"
