# dsh-screenshot native driver.
#
# Two modes in one file:
#   default        take one shot  -> one JSON line on stdout
#   -RestoreOnly   put a parked window back (the safety net the Host half runs
#                  when the capture child dies before its own restore)
#
# Output contract, always exactly one line on stdout:
#   {"ok":true,"path":"...","width":W,"height":H,"left":X,"top":Y,
#    "restored":true|false,"reason":"","message":""}
#   {"ok":false,...,"reason":"failed","message":"..."}
#
# Exit code stays 0 for an answered run. A nonzero exit means this driver itself
# failed to start, and the caller should surface stderr instead.

[CmdletBinding()]
param(
  [string]$OutPath = '',
  [string]$TitleFragment = '',
  [int]$Hide = 1,
  [string]$Record = '',
  [int]$SettleMs = 700,
  [string]$SourceDir = '',
  [switch]$RestoreOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$RESTORE_INTEROP = @'
using System;
using System.Runtime.InteropServices;
public static class SnapRestore {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("dwmapi.dll")] public static extern int DwmFlush();
}
'@

function Write-Line([string]$text) {
  [Console]::Out.WriteLine($text)
}

if ($RestoreOnly) {
  if ([string]::IsNullOrEmpty($Record) -or -not (Test-Path -LiteralPath $Record)) {
    Write-Line '{"restored":false,"reason":"no parked window on record"}'
    return
  }
  $raw = (Get-Content -LiteralPath $Record -Raw).Trim()
  $value = [Int64]0
  if (-not [Int64]::TryParse($raw, [ref]$value)) {
    Write-Line '{"restored":false,"reason":"the record file is not a window handle"}'
    return
  }
  Add-Type -TypeDefinition $RESTORE_INTEROP
  $window = [IntPtr]$value
  if ($window -eq [IntPtr]::Zero -or -not [SnapRestore]::IsWindow($window)) {
    Write-Line '{"restored":false,"reason":"that window no longer exists"}'
    return
  }
  if ([SnapRestore]::IsIconic($window)) { [void][SnapRestore]::ShowWindowAsync($window, 9) }
  [void][SnapRestore]::SetForegroundWindow($window)
  [void][SnapRestore]::DwmFlush()
  Write-Line '{"restored":true,"reason":""}'
  return
}

if ([string]::IsNullOrEmpty($OutPath)) {
  Write-Line '{"ok":false,"path":"","width":0,"height":0,"left":0,"top":0,"restored":false,"reason":"failed","message":"-OutPath is required"}'
  return
}

if ([string]::IsNullOrEmpty($SourceDir)) { $SourceDir = $PSScriptRoot }

$helper = Join-Path $SourceDir 'Snap.cs'
if (-not (Test-Path -LiteralPath $helper)) {
  Write-Line ('{"ok":false,"path":"","width":0,"height":0,"left":0,"top":0,"restored":false,"reason":"failed","message":"missing Snap.cs next to this script"}')
  return
}

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
# Add-Type -Path compiles against a minimal reference set; hand it the drawing and
# forms assemblies that are actually loaded, or the usings will not resolve.
Add-Type -Path $helper -ReferencedAssemblies @(
  [System.Drawing.Bitmap].Assembly.Location
  [System.Windows.Forms.SystemInformation].Assembly.Location
)

try {
  $json = [Snap]::Run($OutPath, $Hide, $TitleFragment, $Record, $SettleMs)
  Write-Line $json
}
catch {
  $message = $_.Exception.Message -replace '\\', '/' -replace '"', "'"
  Write-Line ('{"ok":false,"path":"","width":0,"height":0,"left":0,"top":0,"restored":false,"reason":"failed","message":"' + $message + '"}')
}
