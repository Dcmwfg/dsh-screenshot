#!/bin/bash
# dsh-screenshot native driver for macOS.
#
# Windows has snip.ps1 + DshShot.cs: a WinForms form covering the whole virtual
# desktop so the user frames the region 1:1 over every monitor. macOS already
# ships that experience - "screencapture -i" opens the system's own crosshair
# selector, with the magnifier, the live pixel-size readout, space to switch to
# grabbing a whole window, and Esc to cancel. Rebuilding it in AppKit would only
# be a worse copy of it, so this driver drives the system one and spends its own
# code on the half macOS does not do for you: getting the window that hosts the
# page out of the way, and putting it back afterwards.
#
# Output contract, always exactly one line on stdout:
#   {"ok":true,"path":"...","reason":"","message":"","width":W,"height":H,
#    "hidden":true|false,"mode":"hide"|"minimize"|"","window":0}
#   {"ok":false,...,"reason":"cancelled"|"failed",...}
#
# Written for the bash 3.2 that ships with macOS: no associative arrays, no
# upper-casing expansion, no mapfile.

set -u

OUT=""
RECORD=""
BUDGET=180
HIDE=1
TARGET_KIND="title"
HIDE_KIND="hide"
TITLE=""
REGION=""
RESTORE_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:-}"; shift 2 ;;
    --record) RECORD="${2:-}"; shift 2 ;;
    --timeout) BUDGET="${2:-180}"; shift 2 ;;
    --hide) HIDE="${2:-1}"; shift 2 ;;
    --target-kind) TARGET_KIND="${2:-title}"; shift 2 ;;
    # Accepted for symmetry with the Windows driver, which has to be told how to
    # step aside. Here the app itself decides: a browser is minimized, anything
    # else is hidden, so the flag is read and not needed.
    --hide-kind) HIDE_KIND="${2:-hide}"; shift 2 ;;
    # Read and not used: macOS gives a process no portable way to read another
    # app's window titles, so a caption cannot be matched here. The host half
    # sends one on every platform because Windows needs it.
    --title) TITLE="${2:-}"; shift 2 ;;
    --region) REGION="${2:-}"; shift 2 ;;
    --restore-only) RESTORE_ONLY=1; shift ;;
    *) shift ;;
  esac
done

SCREENCAPTURE="/usr/sbin/screencapture"
[ -x "$SCREENCAPTURE" ] || SCREENCAPTURE="screencapture"

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/ }"
  s="${s//$'\r'/ }"
  s="${s//$'\t'/ }"
  printf '%s' "$s"
}

emit() {
  printf '{"ok":%s,"path":"%s","reason":"%s","message":"%s","width":%s,"height":%s,"hidden":%s,"mode":"%s","window":0}\n' \
    "$1" "$(json_escape "$2")" "$(json_escape "$3")" "$(json_escape "$4")" \
    "${5:-0}" "${6:-0}" "$7" "$8"
}

# The app the user is looking at, asked of the window server rather than of
# System Events: NSWorkspace needs no Automation grant, while scripting System
# Events would put a permission prompt in front of a screenshot.
front_app() {
  local name
  name="$(osascript -l JavaScript \
    -e 'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.frontmostApplication.localizedName.js' \
    2>/dev/null)"
  if [ -z "$name" ] || [ "$name" = "undefined" ]; then
    name="$(osascript -e \
      'tell application "System Events" to get name of first application process whose frontmost is true' \
      2>/dev/null)"
  fi
  printf '%s' "$name"
}

# Browsers are the one host the app shell cannot be, so they are named: a
# browser is minimized (its Dock icon and window stay one click away) and
# anything else is hidden. The focused app wins over anything found by searching,
# for the same reason it does on Windows: it is the window the click landed in.
is_browser() {
  case "$1" in
    *Chrome*|*Chromium*|*Edge*|*Brave*|*Safari*|*Firefox*|*Arc*|*Opera*|*Vivaldi*|*Orion*|*LibreWolf*|*Waterfox*|*Yandex*)
      return 0 ;;
  esac
  return 1
}

# Never stepped aside: the desktop itself, and the consoles a launcher may spawn.
is_never() {
  case "$1" in
    Finder|Dock|SystemUIServer|"Control Center"|"Window Server"|loginwindow|Terminal|iTerm2|Alacritty|kitty|WezTerm|Hyper|Warp|Spotlight|"Notification Center"|osascript|bash|sh|"")
      return 0 ;;
  esac
  return 1
}

# Hiding and unhiding go through NSRunningApplication first: it is an ordinary
# AppKit call on another process, so it needs neither the Accessibility grant
# that System Events does nor the Automation prompt that comes with scripting
# another app. System Events stays as the fallback for when JXA is unavailable.
hide_app() {
  local name="$1"
  if DSH_TARGET="$name" osascript -l JavaScript -e '
    ObjC.import("AppKit");
    var want = $.NSProcessInfo.processInfo.environment.objectForKey("DSH_TARGET").js;
    var list = $.NSWorkspace.sharedWorkspace.runningApplications.js;
    for (var i = 0; i < list.length; i++) {
      var app = list[i];
      if (app.localizedName.js === want) {
        app.hide();
        if (app.isHidden.js) { "hidden"; } else { "still-visible"; }
        break;
      }
    }' 2>/dev/null | grep -q hidden; then
    return 0
  fi
  osascript -e "tell application \"System Events\" to set visible of process \"$name\" to false" >/dev/null 2>&1
}

show_app() {
  local name="$1"
  if DSH_TARGET="$name" osascript -l JavaScript -e '
    ObjC.import("AppKit");
    var want = $.NSProcessInfo.processInfo.environment.objectForKey("DSH_TARGET").js;
    var list = $.NSWorkspace.sharedWorkspace.runningApplications.js;
    for (var i = 0; i < list.length; i++) {
      var app = list[i];
      if (app.localizedName.js === want) {
        app.unhide();
        app.activateWithOptions(2);
        break;
      }
    }' >/dev/null 2>&1; then
    return 0
  fi
  osascript -e "tell application \"System Events\" to set visible of process \"$name\" to true" >/dev/null 2>&1
  osascript -e "tell application \"System Events\" to set frontmost of process \"$name\" to true" >/dev/null 2>&1
}

# Chrome-family and Safari expose "miniaturized" themselves, so the common case
# needs no Accessibility grant; the AX attribute is the generic fallback.
minimize_app() {
  if osascript -e "tell application \"$1\" to set miniaturized of window 1 to true" >/dev/null 2>&1; then
    return 0
  fi
  osascript -e "tell application \"System Events\" to set value of attribute \"AXMinimized\" of window 1 of process \"$1\" to true" >/dev/null 2>&1
}

unminimize_app() {
  if osascript -e "tell application \"$1\" to set miniaturized of window 1 to false" >/dev/null 2>&1; then
    return 0
  fi
  osascript -e "tell application \"System Events\" to set value of attribute \"AXMinimized\" of window 1 of process \"$1\" to false" >/dev/null 2>&1
}

# --restore-only is the host half's safety net for a driver that died before its
# own trap could run. The record file holds the mode on line 1, the app on line 2.
if [ "$RESTORE_ONLY" -eq 1 ]; then
  if [ -n "$RECORD" ] && [ -f "$RECORD" ]; then
    mode="$(sed -n '1p' "$RECORD")"
    app="$(sed -n '2p' "$RECORD")"
    if [ -n "$app" ]; then
      case "$mode" in
        minimize) unminimize_app "$app" ;;
        *) show_app "$app" ;;
      esac
      printf '{"ok":false,"restored":true,"reason":"","message":""}\n'
      exit 0
    fi
  fi
  printf '{"ok":false,"restored":false,"reason":"","message":"nothing parked on record"}\n'
  exit 0
fi

TARGET=""
MODE=""

if [ "$HIDE" -ne 0 ]; then
  front="$(front_app)"
  case "$TARGET_KIND" in
    browser)
      if is_browser "$front"; then TARGET="$front"; fi
      ;;
    shell|title|auto)
      # macOS gives a process no portable way to read another app's window
      # titles, so a caption cannot be matched here; the frontmost app is the
      # window the click landed in, which settles it without one.
      if [ -n "$front" ] && ! is_never "$front"; then TARGET="$front"; fi
      ;;
  esac

  if [ -n "$TARGET" ]; then
    if is_browser "$TARGET"; then
      if minimize_app "$TARGET"; then MODE="minimize"; fi
    else
      if hide_app "$TARGET"; then MODE="hide"; fi
    fi
    if [ -n "$MODE" ] && [ -n "$RECORD" ]; then
      printf '%s\n%s\n' "$MODE" "$TARGET" > "$RECORD" 2>/dev/null
    fi
    # Give the window server a beat to actually take the window down before the
    # shutter opens, or the capture catches it mid-fade.
    sleep 0.2
  fi
fi

cleanup() {
  if [ -n "$MODE" ] && [ -n "$TARGET" ]; then
    case "$MODE" in
      minimize) unminimize_app "$TARGET" ;;
      *) show_app "$TARGET" ;;
    esac
    rm -f "$RECORD" 2>/dev/null
  fi
}
trap cleanup EXIT

if [ -z "$OUT" ]; then
  emit false "" failed "no output path" 0 0 false ""
  exit 0
fi

# Everything below is no use without the system tool; say so instead of mistaking
# it for a cancelled selection.
if ! command -v "$SCREENCAPTURE" >/dev/null 2>&1; then
  if [ -n "$MODE" ]; then RESTORED=true; else RESTORED=false; fi
  emit false "" failed "screencapture is not available" 0 0 "$RESTORED" "$MODE"
  exit 0
fi

# The system selector: -i is the interactive one, -x mutes the shutter sound,
# -o drops the window shadow when the user grabs a window instead of a region.
#
# --region skips the selector and shoots that rectangle, the same way -AutoSelect
# does on Windows: it is what makes this driver testable without a human.
if [ -n "$REGION" ]; then
  "$SCREENCAPTURE" -x -o -t png -R "$REGION" "$OUT" &
else
  "$SCREENCAPTURE" -i -x -o -t png "$OUT" &
fi
SHOT_PID=$!
DEADLINE=$(( $(date +%s) + BUDGET ))
while kill -0 "$SHOT_PID" 2>/dev/null; do
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    kill "$SHOT_PID" 2>/dev/null
    wait "$SHOT_PID" 2>/dev/null
    if [ -n "$MODE" ]; then RESTORED=true; else RESTORED=false; fi
    emit false "" failed "the selector timed out" 0 0 "$RESTORED" "$MODE"
    exit 0
  fi
  sleep 0.2
done
wait "$SHOT_PID"
STATUS=$?

if [ -n "$MODE" ]; then RESTORED=true; else RESTORED=false; fi

if [ ! -s "$OUT" ]; then
  if [ "$STATUS" -eq 1 ] && [ -z "$REGION" ]; then
    # Esc ends the selector with exit 1 and no file: a cancel, not a broken
    # driver. With --region there was no selector to cancel, so it is a failure.
    emit false "" cancelled "" 0 0 "$RESTORED" "$MODE"
  else
    emit false "" failed "screencapture exited with $STATUS and wrote no file" 0 0 "$RESTORED" "$MODE"
  fi
  exit 0
fi

DIMS="$(sips -g pixelWidth -g pixelHeight "$OUT" 2>/dev/null \
  | awk '/pixelWidth:/{w=$2} /pixelHeight:/{h=$2} END{if (w != "" && h != "") print w" "h}')"
WIDTH="${DIMS%% *}"
HEIGHT="${DIMS##* }"

emit true "$OUT" "" "" "${WIDTH:-0}" "${HEIGHT:-0}" "$RESTORED" "$MODE"
exit 0
