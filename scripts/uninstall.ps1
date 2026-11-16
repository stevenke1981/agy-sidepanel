#Requires -Version 5.1
<#
.SYNOPSIS
  Removes agy Bridge's Native Messaging registrations and installed files on Windows.

.DESCRIPTION
  Deletes the com.agy.bridge NativeMessagingHosts keys (Chrome, Chromium, Edge) under -RegistryRoot,
  "<InstallDir>.bak", and the installed files in -InstallDir. <InstallDir>\workspace is kept unless
  -Purge is given. The extension itself is removed from Chrome manually (chrome://extensions).

.PARAMETER InstallDir
  Install folder used by install.ps1. Default: %LOCALAPPDATA%\agy-bridge.

.PARAMETER RegistryRoot
  Root used by install.ps1. Default HKCU:\Software.

.PARAMETER Purge
  Also delete <InstallDir>\workspace (conversation working folder). Without it the workspace is kept.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -WhatIf

.NOTES
  Exit codes: 0 success (or -WhatIf); 2 invalid InstallDir; 5 removal failure.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'agy-bridge'),
    [string]$RegistryRoot = 'HKCU:\Software',
    [switch]$Purge
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$HostName = 'com.agy.bridge'
$WorkspaceName = 'workspace'

function Stop-Uninstall {
    param([int]$Code, [string]$Message)
    [Console]::Error.WriteLine("uninstall.ps1: ERROR: $Message")
    exit $Code
}

function Get-InstallRoot {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { Stop-Uninstall 2 '-InstallDir is empty' }
    $full = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path).TrimEnd('\')
    if ($full -notmatch '^[A-Za-z]:\\.+') { Stop-Uninstall 2 "-InstallDir must be an absolute local drive path: $Path" }
    return $full
}

function Get-NativeHostKeys {
    param([string]$Root)
    $base = $Root.TrimEnd('\')
    $vendors = @('Google\Chrome', 'Chromium', 'Microsoft\Edge')
    return @($vendors | ForEach-Object { "$base\$_\NativeMessagingHosts\$HostName" })
}

function Remove-RegistryKeys {
    param([string[]]$Keys)
    foreach ($key in $Keys) {
        if (-not (Test-Path -LiteralPath $key)) {
            Write-Host "not registered: $key"
            continue
        }
        if ($PSCmdlet.ShouldProcess($key, 'remove native host registration')) {
            Remove-Item -LiteralPath $key -Recurse -Force
            Write-Host "removed: $key"
        }
    }
}

function Remove-InstalledFiles {
    param([string]$Target, [bool]$KeepWorkspace)
    $backup = "$Target.bak"
    if (Test-Path -LiteralPath $backup) {
        if ($PSCmdlet.ShouldProcess($backup, 'remove backup')) { Remove-Item -LiteralPath $backup -Recurse -Force }
    }
    if (-not (Test-Path -LiteralPath $Target)) {
        Write-Host "nothing to remove at $Target"
        return
    }
    if (-not $KeepWorkspace) {
        if ($PSCmdlet.ShouldProcess($Target, 'remove install folder')) { Remove-Item -LiteralPath $Target -Recurse -Force }
        Write-Host "removed: $Target"
        return
    }
    $children = @(Get-ChildItem -LiteralPath $Target -Force | Where-Object { $_.Name -ne $WorkspaceName })
    foreach ($child in $children) {
        if ($PSCmdlet.ShouldProcess($child.FullName, 'remove')) { Remove-Item -LiteralPath $child.FullName -Recurse -Force }
    }
    $remaining = @(Get-ChildItem -LiteralPath $Target -Force)
    if ($remaining.Count -eq 0) {
        if ($PSCmdlet.ShouldProcess($Target, 'remove empty install folder')) { Remove-Item -LiteralPath $Target -Force }
        Write-Host "removed: $Target"
    } else {
        Write-Host "kept workspace (use -Purge to delete): $(Join-Path $Target $WorkspaceName)"
    }
}

try {
    $InstallDir = Get-InstallRoot $InstallDir
    if ($InstallDir.Length -le 3) { Stop-Uninstall 2 "refusing to remove a drive root: $InstallDir" }
    Remove-RegistryKeys -Keys (Get-NativeHostKeys $RegistryRoot)
    Remove-InstalledFiles -Target $InstallDir -KeepWorkspace (-not $Purge)
    Write-Host 'Done. Remove the agy Bridge extension from chrome://extensions if it is still loaded.'
    exit 0
} catch {
    Stop-Uninstall 5 $_.Exception.Message
}
