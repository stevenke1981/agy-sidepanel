#Requires -Version 5.1
<#
.SYNOPSIS
  Installs or replaces agy Bridge (Chrome extension source + Native Messaging host) on Windows.

.DESCRIPTION
  Copies extension\ and host\ from -SourceDir into -InstallDir (test folders excluded), renders
  host\agy-bridge.cmd from host\agy-bridge.cmd.tpl, writes host\com.agy.bridge.json and registers it
  under HKCU for Google Chrome (plus Chromium and Microsoft Edge with -AllBrowsers).
  A previous extension\ and host\ are moved to "<InstallDir>.bak" first (older .bak is replaced) and
  restored automatically if the install fails. <InstallDir>\workspace is never touched.

.PARAMETER InstallDir
  Absolute install folder. Default: %LOCALAPPDATA%\agy-bridge. Must not contain % & or double quotes,
  and must be ASCII (the generated .cmd is ASCII).

.PARAMETER SourceDir
  Folder holding extension\ and host\. Default: parent folder of this script (repo root, or an
  extracted release zip with the same layout).

.PARAMETER NodePath
  Absolute path to node.exe (version 20 or newer). Default: node found on PATH.

.PARAMETER AllBrowsers
  Also register the host for Chromium and Microsoft Edge.

.PARAMETER RegistryRoot
  Root for the NativeMessagingHosts keys. Default HKCU:\Software. Tests pass a throwaway key.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1

.NOTES
  Exit codes: 0 success (or -WhatIf); 2 invalid InstallDir; 3 Node.js missing or too old;
  4 source tree incomplete; 5 install or registry failure.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'agy-bridge'),
    [string]$SourceDir,
    [string]$NodePath,
    [switch]$AllBrowsers,
    [string]$RegistryRoot = 'HKCU:\Software'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$HostName = 'com.agy.bridge'
$HostDescription = 'agy Bridge native messaging host'
$ExtensionOrigin = 'chrome-extension://dnildepikbjklalofggmgafohplflpgg/'
$MinNodeMajor = 20
$PayloadDirs = @('extension', 'host')
$RequiredSource = @(
    'extension\manifest.json',
    'extension\src\lib\protocol.js',
    'host\src\bridge.mjs',
    'host\agy-bridge.cmd.tpl'
)
$UnsafePathPattern = '[%&"]'
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Stop-Install {
    param([int]$Code, [string]$Message)
    [Console]::Error.WriteLine("install.ps1: ERROR: $Message")
    exit $Code
}

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message"
}

function Get-FullPath {
    param([string]$Path)
    return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path).TrimEnd('\')
}

function Assert-CmdSafe {
    param([string]$Value, [string]$Label)
    if ($Value -match $UnsafePathPattern) {
        Stop-Install 2 "$Label contains % & or a double quote, which cannot appear in agy-bridge.cmd: $Value"
    }
    if ($Value -match '[^\x00-\x7F]') {
        Stop-Install 2 "$Label must be ASCII-only because agy-bridge.cmd is ASCII: $Value"
    }
}

function Get-InstallRoot {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { Stop-Install 2 '-InstallDir is empty' }
    $full = Get-FullPath $Path
    if ($full -notmatch '^[A-Za-z]:\\.+') { Stop-Install 2 "-InstallDir must be an absolute local drive path: $Path" }
    Assert-CmdSafe $full '-InstallDir'
    return $full
}

function Get-SourceRoot {
    param([string]$Requested)
    $root = $Requested
    if (-not $root) {
        if (-not $PSScriptRoot) { Stop-Install 4 'cannot infer -SourceDir; pass it explicitly' }
        $root = Split-Path -Parent $PSScriptRoot
    }
    $root = Get-FullPath $root
    foreach ($rel in $RequiredSource) {
        if (-not (Test-Path -LiteralPath (Join-Path $root $rel) -PathType Leaf)) {
            Stop-Install 4 "source tree incomplete: missing $rel under $root"
        }
    }
    return $root
}

function Get-NodeExe {
    param([string]$Requested)
    $candidate = $Requested
    if (-not $candidate) {
        $found = Get-Command -Name node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $found) { Stop-Install 3 'node.exe was not found on PATH; install Node.js 20+ or pass -NodePath' }
        $candidate = $found.Source
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { Stop-Install 3 "node executable not found: $candidate" }
    $exe = (Resolve-Path -LiteralPath $candidate).ProviderPath
    Assert-CmdSafe $exe 'Node.js path'
    $output = (& $exe --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { Stop-Install 3 "'$exe --version' failed: $output" }
    if ($output -notmatch '^v(\d+)\.') { Stop-Install 3 "unexpected output from '$exe --version': $output" }
    $major = [int]$Matches[1]
    if ($major -lt $MinNodeMajor) { Stop-Install 3 "Node.js $MinNodeMajor or newer is required; $exe reports $output" }
    Write-Host "Node.js $output at $exe"
    return $exe
}

function Get-NativeHostKeys {
    param([string]$Root, [bool]$IncludeAllBrowsers)
    $base = $Root.TrimEnd('\')
    $vendors = @('Google\Chrome')
    if ($IncludeAllBrowsers) { $vendors += @('Chromium', 'Microsoft\Edge') }
    return @($vendors | ForEach-Object { "$base\$_\NativeMessagingHosts\$HostName" })
}

function Test-PayloadPresent {
    param([string]$InstallDir)
    foreach ($name in $PayloadDirs) {
        if (Test-Path -LiteralPath (Join-Path $InstallDir $name)) { return $true }
    }
    return $false
}

function Save-PreviousInstall {
    param([string]$InstallDir, [string]$BackupDir)
    if (Test-Path -LiteralPath $BackupDir) { Remove-Item -LiteralPath $BackupDir -Recurse -Force }
    New-Item -ItemType Directory -Path $BackupDir | Out-Null
    foreach ($name in $PayloadDirs) {
        $current = Join-Path $InstallDir $name
        if (Test-Path -LiteralPath $current) {
            Move-Item -LiteralPath $current -Destination (Join-Path $BackupDir $name)
        }
    }
}

function Restore-PreviousInstall {
    param([string]$InstallDir, [string]$BackupDir, [bool]$HadPrevious)
    foreach ($name in $PayloadDirs) {
        $current = Join-Path $InstallDir $name
        if (Test-Path -LiteralPath $current) {
            Remove-Item -LiteralPath $current -Recurse -Force -ErrorAction SilentlyContinue
        }
        $saved = Join-Path $BackupDir $name
        if ($HadPrevious -and (Test-Path -LiteralPath $saved)) {
            Move-Item -LiteralPath $saved -Destination $current
        }
    }
}

function Copy-Payload {
    param([string]$SourceRoot, [string]$InstallDir)
    foreach ($name in $PayloadDirs) {
        $dest = Join-Path $InstallDir $name
        Copy-Item -LiteralPath (Join-Path $SourceRoot $name) -Destination $dest -Recurse -Force
        $testDir = Join-Path $dest 'test'
        if (Test-Path -LiteralPath $testDir) { Remove-Item -LiteralPath $testDir -Recurse -Force }
    }
}

function Write-Utf8File {
    param([string]$Path, [string]$Text)
    [System.IO.File]::WriteAllText($Path, $Text, $Utf8NoBom)
}

function Write-HostCommandFile {
    param([string]$Template, [string]$OutPath, [string]$NodeExe)
    $raw = [System.IO.File]::ReadAllText($Template)
    if (-not $raw.Contains('{{NODE}}')) { Stop-Install 4 "template has no {{NODE}} placeholder: $Template" }
    $rendered = $raw.Replace('{{NODE}}', $NodeExe)
    if (-not $rendered.Contains('"' + $NodeExe + '"')) {
        Stop-Install 4 'template must wrap {{NODE}} in double quotes'
    }
    $lf = $rendered.Replace("`r`n", "`n")
    $crlf = $lf.Replace("`n", "`r`n").TrimEnd([char]13, [char]10) + "`r`n"
    if ($crlf -match '[^\x00-\x7F]') { Stop-Install 4 'agy-bridge.cmd.tpl contains non-ASCII characters' }
    [System.IO.File]::WriteAllBytes($OutPath, [System.Text.Encoding]::ASCII.GetBytes($crlf))
}

function ConvertTo-JsonLiteral {
    param([string]$Value)
    return '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
}

function Write-HostManifest {
    param([string]$OutPath, [string]$CmdPath)
    $lines = @(
        '{',
        ('  "name": ' + (ConvertTo-JsonLiteral $HostName) + ','),
        ('  "description": ' + (ConvertTo-JsonLiteral $HostDescription) + ','),
        ('  "path": ' + (ConvertTo-JsonLiteral $CmdPath) + ','),
        '  "type": "stdio",',
        ('  "allowed_origins": [ ' + (ConvertTo-JsonLiteral $ExtensionOrigin) + ' ]'),
        '}'
    )
    Write-Utf8File $OutPath (($lines -join "`n") + "`n")
}

function Register-NativeHost {
    param([string[]]$Keys, [string]$ManifestPath)
    foreach ($key in $Keys) {
        New-Item -Path $key -Force | Out-Null
        Set-Item -LiteralPath $key -Value $ManifestPath
        $actual = (Get-Item -LiteralPath $key).GetValue('')
        if ($actual -ne $ManifestPath) { throw "registry verification failed for $key" }
        Write-Host "registered: $key"
    }
}

function Install-Payload {
    param([string]$SourceRoot, [string]$InstallDir, [string]$NodeExe, [string]$CmdPath, [string]$ManifestPath)
    $backupDir = "$InstallDir.bak"
    $hadPrevious = Test-PayloadPresent $InstallDir
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    try {
        if ($hadPrevious) {
            Write-Step "backing up previous extension\ and host\ to $backupDir"
            Save-PreviousInstall $InstallDir $backupDir
        }
        Write-Step 'copying extension\ and host\'
        Copy-Payload $SourceRoot $InstallDir
        Write-Step 'rendering host\agy-bridge.cmd and host\com.agy.bridge.json'
        Write-HostCommandFile (Join-Path $SourceRoot 'host\agy-bridge.cmd.tpl') $CmdPath $NodeExe
        Write-HostManifest $ManifestPath $CmdPath
        # Mark the install root as ESM so Node does not reparse protocol.js or search parent dirs.
        Write-Utf8File (Join-Path $InstallDir 'package.json') "{ `"private`": true, `"type`": `"module`" }`n"
    } catch {
        Write-Host 'install failed; restoring previous files'
        Restore-PreviousInstall $InstallDir $backupDir $hadPrevious
        throw
    }
}

function Show-NextSteps {
    param([string]$InstallDir, [string[]]$Keys)
    Write-Host ''
    Write-Host "agy Bridge installed to $InstallDir"
    Write-Host 'Next steps:'
    Write-Host '  1. Open chrome://extensions and turn on Developer mode.'
    Write-Host "  2. First time only: Load unpacked -> $InstallDir\extension"
    Write-Host '     (after a reinstall, click the reload button on the agy Bridge card instead)'
    Write-Host "  3. Native host registered for $($Keys.Count) browser key(s); run uninstall.ps1 to remove."
}

try {
    $InstallDir = Get-InstallRoot $InstallDir
    if ($InstallDir.Length -le 3) { Stop-Install 2 "refusing to install into a drive root: $InstallDir" }
    $SourceDir = Get-SourceRoot $SourceDir
    if ($SourceDir -ieq $InstallDir -or $SourceDir.StartsWith("$InstallDir\", [System.StringComparison]::OrdinalIgnoreCase)) {
        Stop-Install 2 "SourceDir must not be inside InstallDir: $SourceDir"
    }
    $NodeExe = Get-NodeExe $NodePath
    $CmdPath = Join-Path $InstallDir 'host\agy-bridge.cmd'
    $ManifestPath = Join-Path $InstallDir 'host\com.agy.bridge.json'
    $Keys = Get-NativeHostKeys $RegistryRoot ([bool]$AllBrowsers)
    Write-Host "Source:  $SourceDir"
    Write-Host "Install: $InstallDir"
    foreach ($key in $Keys) { Write-Host "Registry: $key" }
    if (-not $PSCmdlet.ShouldProcess($InstallDir, "install $HostName")) {
        Write-Host 'WhatIf: no changes were made.'
        exit 0
    }
    Install-Payload -SourceRoot $SourceDir -InstallDir $InstallDir -NodeExe $NodeExe -CmdPath $CmdPath -ManifestPath $ManifestPath
    Write-Step 'registering native messaging host'
    Register-NativeHost -Keys $Keys -ManifestPath $ManifestPath
    Show-NextSteps -InstallDir $InstallDir -Keys $Keys
    exit 0
} catch {
    Stop-Install 5 $_.Exception.Message
}
