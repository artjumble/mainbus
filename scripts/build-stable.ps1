# Builds the app and installs it as the newest stable build under %LOCALAPPDATA%\Mainbus\app.
# Keeps the 3 newest builds. current.txt names the build run-stable.ps1 starts; previous.txt the one
# before it (run-stable.ps1 -Previous rolls back to it). Also installs %LOCALAPPDATA%\Mainbus\bin\mainbus.cmd,
# the mainbus CLI and MCP server for agents (scripts\mainbus.cmd). Compatible with Windows PowerShell 5.1.
$ErrorActionPreference = 'Stop'

# Mainbus sets MAINBUS_AGENT for its agents: an agent must never replace the user's stable build.
if ($env:MAINBUS_AGENT) {
    throw 'Refusing to build the stable build: MAINBUS_AGENT is set, so this is running inside a Mainbus agent. Run scripts\build-stable.ps1 from your own terminal.'
}

$repo = Split-Path -Parent $PSScriptRoot
$appRoot = Join-Path $env:LOCALAPPDATA 'Mainbus\app'
$keep = 3

function Invoke-Step([string]$What, [scriptblock]$Run) {
    & $Run
    if ($LASTEXITCODE -ne 0) { throw "$What failed with exit code $LASTEXITCODE" }
}

# A pointer file's text, or '' when the file is missing or empty.
function Read-Name([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    return "$(Get-Content -LiteralPath $Path -Raw)".Trim()
}

function Write-Name([string]$Path, [string]$Name) {
    # UTF-8 without a BOM, so the name reads back clean.
    [System.IO.File]::WriteAllText($Path, $Name, (New-Object System.Text.UTF8Encoding($false)))
}

# The short commit id, with -dirty when the working tree has uncommitted changes; 'nogit' without git.
function Get-Revision {
    try {
        $sha = "$(git rev-parse --short HEAD)".Trim()
        if ($LASTEXITCODE -ne 0 -or -not $sha) { return 'nogit' }
        $changes = "$(git status --porcelain)".Trim()
        if ($LASTEXITCODE -eq 0 -and $changes) { return "$sha-dirty" }
        return $sha
    }
    catch {
        return 'nogit'
    }
}

Push-Location $repo
try {
    # Leftovers of an interrupted install (<name>.tmp) are never worth keeping.
    try {
        if (Test-Path -LiteralPath $appRoot) {
            Get-ChildItem -LiteralPath $appRoot -Directory -Filter '*.tmp' |
                ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
        }
    }
    catch {
        Write-Warning "Could not remove leftover temporary folders: $($_.Exception.Message)"
    }

    Invoke-Step 'npm run build' { npm run build }
    Invoke-Step 'electron-builder' { npx electron-builder --win dir }

    $name = '{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmm'), (Get-Revision)

    $source = Join-Path $repo 'dist\win-unpacked'
    if (-not (Test-Path -LiteralPath (Join-Path $source 'Mainbus.exe'))) { throw "No Mainbus.exe in $source" }
    if (-not (Test-Path -LiteralPath (Join-Path $source 'resources\cli\mainbus.cjs'))) { throw "No resources\cli\mainbus.cjs in $source" }

    New-Item -ItemType Directory -Force -Path $appRoot | Out-Null
    $target = Join-Path $appRoot $name
    $currentFile = Join-Path $appRoot 'current.txt'
    $previousFile = Join-Path $appRoot 'previous.txt'
    $old = Read-Name $currentFile

    # Copy to <name>.tmp first and rename once the copy is complete, so a failed copy never leaves a
    # half-built folder under a real name. A rebuild in the same minute replaces its folder only after
    # the new copy exists.
    $staging = "$target.tmp"
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    Copy-Item -LiteralPath $source -Destination $staging -Recurse
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    Rename-Item -LiteralPath $staging -NewName $name

    # Roll the pointers: what was current becomes previous, if that build is still on disk.
    if ($old -and $old -ne $name -and (Test-Path -LiteralPath (Join-Path $appRoot $old))) {
        Write-Name $previousFile $old
    }
    Write-Name $currentFile $name

    # The mainbus launcher for agents (bin\mainbus.cmd) runs whatever current.txt names, so it only needs
    # writing when its text changes. cmd reads a running batch file as it goes, and an MCP server started
    # through it may be running now: rewriting an unchanged file could break it for nothing.
    $binDir = Join-Path (Split-Path -Parent $appRoot) 'bin'
    $launcher = Join-Path $binDir 'mainbus.cmd'
    $launcherText = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'mainbus.cmd'))
    $installed = if (Test-Path -LiteralPath $launcher) { [System.IO.File]::ReadAllText($launcher) } else { $null }
    if ($installed -ne $launcherText) {
        New-Item -ItemType Directory -Force -Path $binDir | Out-Null
        [System.IO.File]::WriteAllText($launcher, $launcherText, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "Agent launcher written: $launcher"
    }

    # Keep the 3 newest builds, and never remove the one a pointer names. A build that cannot be
    # removed (still running, say) is only a warning: the install itself has succeeded.
    try {
        $pinned = @($name, (Read-Name $previousFile))
        Get-ChildItem -LiteralPath $appRoot -Directory |
            Where-Object { $_.Name -match '^\d{8}-\d{4}-' -and $_.Name -notlike '*.tmp' } |
            Sort-Object Name -Descending |
            Select-Object -Skip $keep |
            Where-Object { $pinned -notcontains $_.Name } |
            ForEach-Object {
                try { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
                catch { Write-Warning "Could not remove old build $($_.Name): $($_.Exception.Message)" }
            }
    }
    catch {
        Write-Warning "Could not prune old builds: $($_.Exception.Message)"
    }

    Write-Host "Stable build installed: $target"
}
finally {
    Pop-Location
}
