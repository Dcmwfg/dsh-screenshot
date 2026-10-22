# dsh-screenshot native driver.
#
# Two modes in one file:
#   default        open the full-screen selector, crop, annotate -> one JSON line
#   -RestoreOnly   put a parked window back (the safety net the Host half runs
#                  when the capture child dies before its own restore)
#
# Output contract, always exactly one line on stdout:
#   {"ok":true,"path":"...","width":W,"height":H,"restored":true|false,
#    "reason":"","message":""}
#   {"ok":false,...,"reason":"cancelled"|"failed","message":"..."}
#
# Exit code stays 0 for an answered run. A nonzero exit means this driver itself
# failed to start, and the caller should surface stderr instead.

[CmdletBinding()]
param(
  [string]$OutPath = '',
  [int]$TimeoutSeconds = 180,
  [string]$TargetFile = '',
  [string]$AutoSelect = '',
  [string]$TitleFragment = '',
  [int]$HideWindow = 1,
  # Which window may be stepped aside:
  #   title   - the desktop build, found by the page caption (default)
  #   browser - a real browser tab; the foreground window, accepted only when
  #             its process is on the browser list
  #   shell   - a launcher that wraps the web build in its own window
  #   auto    - let the driver decide: foreground first, then caption, then the
  #             only window that hosts a webview
  [string]$TargetKind = 'title',
  # How to step aside: 'hide' removes it from the taskbar, 'minimize' leaves the
  # taskbar button so the restore is the ordinary one.
  [string]$HideKind = 'hide',
  [string]$Record = '',
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
  Write-Line '{"ok":false,"path":"","width":0,"height":0,"restored":false,"reason":"failed","message":"-OutPath is required"}'
  return
}

if ([string]::IsNullOrEmpty($SourceDir)) { $SourceDir = $PSScriptRoot }

$source = Join-Path $SourceDir 'DshShot.cs'
if (-not (Test-Path -LiteralPath $source)) {
  Write-Line '{"ok":false,"path":"","width":0,"height":0,"restored":false,"reason":"failed","message":"missing DshShot.cs next to this script"}'
  return
}

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
# Add-Type -Path compiles against a bare reference set; point it at the drawing
# and forms assemblies actually loaded above so the usings resolve.
Add-Type -Path $source -ReferencedAssemblies @(
  [System.Drawing.Bitmap].Assembly.Location
  [System.Windows.Forms.Form].Assembly.Location
)

# The handle record is how the Host half can still put the window back when this
# process is killed before DshShot's own finally block runs.
$parkedRecord = $Record
if ([string]::IsNullOrEmpty($parkedRecord)) { $parkedRecord = $TargetFile }

try {
  $json = [DshShot]::RunJson($OutPath, $TimeoutSeconds, $parkedRecord, $AutoSelect, $TitleFragment, ($HideWindow -ne 0), $TargetKind, $HideKind)
  Write-Line $json
}
catch {
  $message = $_.Exception.Message -replace '\\', '/' -replace '"', "'"
  Write-Line ('{"ok":false,"path":"","width":0,"height":0,"restored":false,"reason":"failed","message":"' + $message + '"}')
}
