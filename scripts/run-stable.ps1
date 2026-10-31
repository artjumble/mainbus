# Starts the stable build named in current.txt, or in previous.txt with -Previous (the rollback).
# The stable build always uses the stable data home, so test and dev overrides are cleared first.
# Compatible with Windows PowerShell 5.1.
param([switch]$Previous)
$ErrorActionPreference = 'Stop'

# Mainbus sets MAINBUS_AGENT for its agents: an agent must never start or replace the user's stable build.
if ($env:MAINBUS_AGENT) {
    throw 'Refusing to start the stable build: MAINBUS_AGENT is set, so this is running inside a Mainbus agent. Run scripts\run-stable.ps1 from your own terminal.'
}

$appRoot = Join-Path $env:LOCALAPPDATA 'Mainbus\app'
$file = if ($Previous) { 'previous.txt' } else { 'current.txt' }
$pointer = Join-Path $appRoot $file
$name = ''
if (Test-Path -LiteralPath $pointer) { $name = "$(Get-Content -LiteralPath $pointer -Raw)".Trim() }
if (-not $name) {
    $hint = if ($Previous) { 'There is no earlier build to roll back to yet.' } else { 'Run scripts\build-stable.ps1 first.' }
    throw "$file in $appRoot is missing or empty. $hint"
}

$exe = Join-Path (Join-Path $appRoot $name) 'Mainbus.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "$exe does not exist" }

foreach ($variable in 'MAINBUS_HOME', 'MAINBUS_RUNTIME', 'MAINBUS_TEST_REPO', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL') {
    Remove-Item -LiteralPath "Env:$variable" -ErrorAction SilentlyContinue
}

$process = Start-Process -FilePath $exe -PassThru
# A second launch hands over to the running window and exits at once.
Start-Sleep -Milliseconds 800
if ($process.HasExited) {
    Write-Warning 'Mainbus is already running; close it first.'
    exit 1
}
Write-Host "Started $name (PID $($process.Id))"
