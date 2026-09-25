<#
    Creates Desktop and Start Menu shortcuts for Wrath.

    The shortcuts point at Wrath.vbs, which starts Wrath with no console window
    at all: the app window is the only thing that appears. Both launchers check
    for Node and install dependencies on first run.

    Use -Console for the old behaviour, a shortcut to Wrath.cmd that runs the
    proxy in a visible terminal. Handy when something is going wrong.

    Usage:
        powershell -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1
        powershell -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1 -Console
        powershell -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1 -Remove
#>

param(
    [switch]$Remove,
    [switch]$NoStartMenu,
    [switch]$Console
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$launcher = if ($Console) { Join-Path $root 'Wrath.cmd' } else { Join-Path $root 'Wrath.vbs' }
$icon = Join-Path $root 'assets\wrath.ico'

$targets = @(
    [PSCustomObject]@{ Name = 'Desktop'; Path = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Wrath.lnk' }
)
if (-not $NoStartMenu) {
    $startMenu = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'
    $targets += [PSCustomObject]@{ Name = 'Start Menu'; Path = Join-Path $startMenu 'Wrath.lnk' }
}

if ($Remove) {
    foreach ($target in $targets) {
        if (Test-Path $target.Path) {
            Remove-Item $target.Path -Force
            Write-Host "Removed the $($target.Name) shortcut."
        } else {
            Write-Host "No $($target.Name) shortcut to remove."
        }
    }
    exit 0
}

if (-not (Test-Path $launcher)) {
    Write-Error "Cannot find $launcher"
}

# build the icon if it's missing
if (-not (Test-Path $icon)) {
    Write-Host 'Generating the icon...'
    & node (Join-Path $root 'scripts\make-icon.js') | Out-Null
}

$shell = New-Object -ComObject WScript.Shell
foreach ($target in $targets) {
    $parent = Split-Path -Parent $target.Path
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }

    $shortcut = $shell.CreateShortcut($target.Path)
    # run through wscript so the console stays hidden
    if ($Console) {
        $shortcut.TargetPath = $launcher
    } else {
        $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
        $shortcut.Arguments = '"' + $launcher + '"'
    }
    $shortcut.WorkingDirectory = $root
    $shortcut.IconLocation = "$icon,0"
    $shortcut.Description = 'Wrath - Minecraft 1.8.9 proxy'
    $shortcut.WindowStyle = 1
    $shortcut.Save()

    Write-Host "Created the $($target.Name) shortcut: $($target.Path)"
}

Write-Host ''
if ($Console) {
    Write-Host 'Double-click Wrath to start the proxy in a console window.'
} else {
    Write-Host 'Double-click Wrath to open its window, then join localhost in Minecraft 1.8.9.'
}
Write-Host 'You can drag the shortcut onto your taskbar to pin it.'
