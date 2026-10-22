# dsh-screenshot

**Region screenshot for the DeepSeek Harness composer.**

One row in the composer's `+` menu. Click it, pick a mode, the DSH window steps aside, a
native selector covers the whole desktop, you drag a rectangle over the part you actually
wanted, annotate it, press the green tick — and the PNG lands in the composer as a
**pending attachment**, ready to send with your next message.

This repository ships **two packages**, one per platform, because the two native halves share
no code:

| Package | Platform | Selector | Route prefix |
| --- | --- | --- | --- |
| [`packages/windows`](packages/windows) — `dsh-screenshot` | Windows 10/11 | This plugin's own WinForms form over the whole virtual desktop | `/dsh-shot/*` |
| [`packages/macos`](packages/macos) — `dsh-screenshot-mac` | macOS | The system's own `screencapture -i` selector | `/dsh-shot-mac/*` |

Install only the one that matches the machine in front of you. Each package declares its own
`os` field, so installing the wrong one reports itself instead of failing quietly.

English | [中文](README.zh-CN.md)

---

## What you get

| Action | Result |
| --- | --- |
| Composer `+` → **Screenshot** | The same two modes on every build |
| **Hide the window, then capture** | The window gives way — a shell hides, a browser minimises — and comes back afterwards |
| **Keep the window in the shot** | The client stays on screen and can be part of the crop |
| Drag on the frozen desktop | Selection rectangle, over the **whole** virtual screen at 1:1 |
| Drag a white grip | Resize the selection (8 grips, min 6×6) |
| Drag anywhere inside the frame (or the inner border strip) | Move the selection |
| `Ctrl`+drag inside the frame | Draw a rectangle annotation |
| `Ctrl+Z` / ↶ button | Undo the last mark |
| `Enter` / green ✓ | Accept and drop the PNG in the composer |
| `Esc` / red ✕ / right click | Cancel |

The chosen mode is remembered in `localStorage` (`dsh-screenshot.mode` on Windows,
`dsh-screenshot-mac.mode` on macOS).

Everything from *Drag on the frozen desktop* down to *Ctrl+Z* is the **Windows** selector's own
behaviour. On macOS the selection belongs entirely to Apple's UI — crosshair, magnifier, live
pixel readout, space to grab a whole window, `Esc` to cancel — and the plugin only takes the
finished region and puts the app back. This is deliberate: rebuilding that selector in AppKit
would only produce a worse copy of it.

## Which window gives way

Only "how does the client get out of the way" differs, because several kinds of host can be
showing this page and they can name their own window very differently. **This section is the
Windows judgement**; macOS is not given other apps' window titles by the system, so it uses the
one fact it does have — which app the click landed in — and that is covered under
"Platform and known limits".

On Windows there are three kinds of host:

| Host | How it is recognised | How it gives way |
| --- | --- | --- |
| Desktop build (page on `dsh-app://app`) | the page origin | **hide** |
| Any launcher wrapping the page in its own native window (Tauri, Electron, CEF, WebView2) | the window **owns an embedded webview child** (`WRY_WEBVIEW`, `Chrome_RenderWidgetHostHWND`, `Chrome_WidgetWin_0`, `CefBrowserWindow`, `WebViewHost`, `EdgeWebViewHost`) | **hide** |
| A real browser tab | its process is on the browser list | **minimise** |

Shells are recognised by **structure, not by process name**. The first cut only accepted the
names `dsh` / `dsh-x` / `dshx`, which covers exactly the launchers known at the time — and a name
proves nothing anyway, since any program can be called `dsh`. Now any window that owns an
embedded webview child counts, so a launcher nobody has heard of yet is covered too.

The reverse case is why "owns a webview" cannot stand alone: editors, chat clients and every other
Electron app own one for their own sake. Consoles (`powershell`, `pwsh`, `cmd`, `conhost`,
`windowsterminal`, …) and the OS shell (`explorer`, `dwm`, …) are always excluded, and a browser
is classified as a browser before anything else.

Both shells are hidden the same way, so a launcher needs no second code path — the only thing
that changes is how the window is *found*. A browser is minimised rather than hidden: a minimised
window keeps its taskbar button, the restore is the ordinary `SW_RESTORE`, and it lands back
where the user left it.

Recognition never rests on a caption alone:

- the click that starts a capture lands in the window showing the page, so **the foreground
  window is the first fact** — if it is a shell or a browser, that settles it;
- then the page title is matched against a caption (four characters or more, consoles excluded);
- then any **known browser process** (`chrome`, `msedge`, `firefox`, `brave`, `opera`,
  `vivaldi`, …), because a browser is the one host a native shell cannot be;
- only when nothing else is named do the shell candidates get ranked: a caption carrying the page
  title, then a process name that looks like this app's own (`dsh*`), and **more than one
  candidate left means nothing is touched** — guessing among unrelated windows would hide
  somebody's program, and a picture that includes the client is the better failure.

Anything else is left alone and the capture proceeds with the screen as it stands. That is a
deliberate trade: a picture that happens to include the client beats moving a window we could not
identify. When it happens the client logs one warning and the shot is still delivered.

Success is checked per mode — hidden must report `IsWindowVisible === false`, minimised must
report `IsIconic === true` — and the answer says which happened (`mode: "hide" | "minimize"`)
plus the handle it touched (`window`).

The desktop build is the one host the page can name outright, so the client sends
`host: "title"` there and `host: "auto"` everywhere else; `auto` resolves from the window
itself.

## Using it from the browser build

The host half is plain `webServer` + `connection`, so the web profile takes the same bundle:
add `"dsh-screenshot": "link:..."` to `<profile>/package.json`, list `"dsh-screenshot"` in
`dsh.profile.bundles`, junction `node_modules/dsh-screenshot`, restart. The capture runs in the
DSH host process on the machine, so a browser on another device can drive it — the pixels come
from the host's desktop, not from the client.

## Why the selection is native, not in the page

The picker used to be a DOM overlay. It could never be correct: a renderer's viewport is the
app window, so the overlay was confined to the window rectangle and the frozen desktop had to
be scaled down to fit inside it. You could only ever frame a region on a picture of the
screen, not on the screen.

A WinForms form parented to nothing, sized to `SystemInformation.VirtualScreen` and marked
topmost, covers every monitor at 1:1. That is where the framing, the eight grips, the move
strip and the annotation toolbar live now. The client half only hands the result over.

Two things follow, and both are deliberate:

- **The window is only away while you frame it.** The park/restore pair is a `try/finally`
  around the selector, so cancelling, timing out, or an exception all put DSH back.
- **One coordinate space.** Pointer positions, the crop and the saved PNG are all in real
  screen pixels, because there is no `object-fit: contain` scaling step to invert.

The handle is also written to a record file before the window is parked, and the driver's
restore-only mode (`-RestoreOnly` on Windows, `--restore-only` on macOS) can pull it back if
the process was killed outright.

## Requirements

- **Windows 10/11 or macOS.** Each platform has its own package, doing the same job different
  ways: `packages/windows` ships a WinForms form that covers the whole virtual desktop
  (`scripts\DshShot.cs` + `scripts\snip.ps1`), `packages/macos` ships a bash driver that
  opens the system's own `screencapture -i` selector (`scripts\snip-mac.sh`). There is no
  Linux path.
- A DSH desktop build whose composer exposes the `commandUi` service and the
  `webServer` + `connection` host services (the shipping desktop profile does).
- Windows: PowerShell 5.1, which ships with Windows. Nothing else to install — the C#
  selector is compiled on demand by `Add-Type`.
- macOS: the bundled bash, `screencapture` and `osascript`, all of which ship with the OS.
  Before the first capture, tick DSH under System Settings → Privacy & Security →
  Screen Recording, or the shutter returns wallpaper only.

## Install

Each package is a plain DSH bundle: `package.json` + host half (`index.js`) + client half
(`client.js`) + `cordis.patch.yml` + the native driver in `scripts/`. The repository root is
only a workspace container — do not link the root itself into a profile.

Clone once, then pick the package for the machine:

```powershell
git clone https://github.com/Dcmwfg/dsh-screenshot.git E:\dsh-plugins\dsh-screenshot
```

| Machine | Package | Bundle name |
| --- | --- | --- |
| Windows 10/11 | `packages/windows` | `dsh-screenshot` |
| macOS | `packages/macos` | `dsh-screenshot-mac` |

Then, for the Windows build (`<profile>` is the profile directory, e.g.
`%USERPROFILE%\.dsh\profiles\desktop`):

1. Add the dependency — note the path ends at the package, not at the repository root:

   ```json
   "dependencies": { "dsh-screenshot": "link:E:/dsh-plugins/dsh-screenshot/packages/windows" }
   ```

2. Add the bundle name to the same file:

   ```json
   "dsh": { "profile": { "bundles": ["...", "dsh-screenshot"] } }
   ```

3. Link it into the profile's `node_modules`:

   ```powershell
   New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-screenshot" `
     -Target "E:\dsh-plugins\dsh-screenshot\packages\windows"
   ```

4. **Restart DSH.** New bundles are composed at boot; editing files afterwards takes effect
   on the next start.

On macOS use `packages/macos`, the name `dsh-screenshot-mac`, and the profile under
`~/.dsh/profiles/desktop` (or `web`). Both files take the same shape —
`link:<checkout>/packages/macos` and `"dsh-screenshot-mac"` in `bundles`.

A junction (rather than a copy) means edits to the checkout are live after a restart.

## Usage

1. Open the composer's `+` menu. The row is called **Screenshot** and sits right after
   **File** — the host hard-codes its Add section as `file/goal/plan/feedback` and pushes
   every other contribution into the Commands section, so this plugin re-sorts its own row
   once to sit next to File.
2. Pick a mode. The picker remembers the last choice.
3. The desktop freezes under a dim veil. Drag the region, adjust it with the grips (a plain
   drag inside the frame moves it, `Ctrl`+drag marks it), annotate
   if you want.
4. Press `Enter` or the green tick.
5. The image appears above the input box as a draft. Typing and pressing Enter sends it.

Nothing is sent until you submit — the screenshot is an attachment, not a message.

## How it is built

| Half | File | Job |
| --- | --- | --- |
| Host | `index.js` | `POST /dsh-shot/shot` (Windows) or `POST /dsh-shot-mac/shot` (macOS) → spawns the platform driver, and answers one finished PNG as a data URL. The matching `/ping` route is a liveness probe that starts no child process. |
| Client | `client.js` | Registers the `shot` command with its two modes, waits for the picker sheet to close, fires the capture, and drops the returned PNG into the composer. The two halves are near-identical; only the module id, locale namespace, route prefix and stored-mode key differ. |
| Native (Windows) | `scripts/snip.ps1` + `scripts/DshShot.cs` | Park the window (optional) → blit the virtual screen → topmost full-screen selector (frame, grips, move, annotate) → crop composite → save PNG → restore. Also restores on demand with `-RestoreOnly`. |
| Native (macOS) | `scripts/snip-mac.sh` | Step the frontmost app aside (minimize a browser, hide anything else) → `screencapture -i` → put it back → answer one JSON line. Also restores on demand with `--restore-only`. |

Both routes go through `ctx.connection.requestRejection(req)`, so they inherit the host's
normal request policy instead of opening an unauthenticated hole.

### HTTP surface

| Route | Method | Body | Answer |
| --- | --- | --- | --- |
| `/dsh-shot/shot` | `POST` | `{"title": string, "hide": boolean, "host": "title"\|"auto"}` | `{"ok":true,"dataUrl":"data:image/png;base64,…","width":W,"height":H,"hidden":bool,"restored":true,"bytes":N}` or `{"ok":false,"reason":"cancelled"\|"failed","message":"…"}` |
| `/dsh-shot/ping` | `GET` | — | `{"ok":true,"platform":"win32","driver":"…","shell":"…"}` |
| `/dsh-shot-mac/shot` | `POST` | `{"title": string, "hide": boolean, "host": "auto"\|"shell"}` | same shape as above, plus `"mode":"hide"\|"minimize"\|""` |
| `/dsh-shot-mac/ping` | `GET` | — | `{"ok":true,"platform":"darwin","driver":"…","shell":"/bin/bash"}` |

Both builds cap the body at 4 KB and the selector at 180 s, and `width`/`height` are the
**cropped** size, not the desktop size.

`title` is matched against window captions to find the window to step aside, **on Windows
only** — macOS is not given other apps' window titles. When nothing matches, nothing is
touched and the capture goes ahead with the window in frame, reporting `"hidden":false` so the
client can say so. `host` decides how it steps aside: `"title"` means "this page is in the
desktop shell", `"auto"` means a browser, and the driver hides a shell but minimizes a
browser.

### Why a synthetic `drop` event

The composer accepts files through the document-level drop listener that
`dsh-client-ui-attachment` installs (`installDocumentDropEvents`). Dispatching one
`DragEvent('drop')` with a real `DataTransfer` therefore rides the exact same upload and
preview path as a human drag-and-drop, without reaching into composer internals that move
between releases.

### Why the sheet is polled

The host's `PopupSelectController` sets `submitting`, awaits `onSelect`, and only then
closes the sheet. So `onSelect` here returns immediately and the capture is fired from a
poll that waits for the sheet to leave the DOM — otherwise "keep the window in the shot" would
freeze the picker panel into the frame. The poll gives up after 1.5 s and shoots anyway.

## Self-test

```powershell
cd packages\windows
node --check index.js
node --check client.js

# Fixed region, window left visible: prints one JSON line and writes a PNG
powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass `
  -File scripts\snip.ps1 -OutPath "$env:TEMP\shot.png" -AutoSelect '200,150,800,500' -HideWindow 0

# Park the window, shoot, and put it back
powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass `
  -File scripts\snip.ps1 -OutPath "$env:TEMP\shot2.png" -AutoSelect '100,100,640,360' `
  -HideWindow 1 -TitleFragment 'DeepSeek Harness' -Record "$env:TEMP\shot2.parked"

# Safety net, if a capture was killed mid-way
powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass `
  -File scripts\snip.ps1 -RestoreOnly -Record "$env:TEMP\shot2.parked"
```

Expected: one JSON line with `"ok":true` and `"width":800,"height":500` for the first
command (the crop size, not the desktop size). `-AutoSelect` skips the selector, so this
runs headless. `"restored":true` from the third command means the window came back.

Without `-AutoSelect` the same script opens the real selector and blocks until you confirm
or press `Esc`; a cancel answers `{"ok":false,"reason":"cancelled"}`.

macOS is a separate package with the same answer contract:

```bash
cd packages/macos
node --check index.js
node --check client.js
bash scripts/snip-mac.sh --out /tmp/shot.png --region '200,150,800,500' --hide 0
bash scripts/snip-mac.sh --restore-only --record /tmp/shot2.parked
```

One JSON line, same contract. `--region` skips the system selector (the macOS counterpart of
`-AutoSelect`), so that run is headless too; without it you get the armed crosshair and `Esc`
cancels. Before the first run, tick DSH under System Settings → Privacy & Security → Screen
Recording — without it `screencapture` still writes a file, it is just a picture of wallpaper.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| No `+` menu row | The bundle is not composed. Check the `bundles` array and the `node_modules` junction, then restart. |
| `Screenshot failed` in the console | The driver printed an error. Run the self-test above — it uses the same script and prints the reason. |
| Window stays hidden | The driver was killed mid-capture. Run `scripts\snip.ps1 -RestoreOnly -Record <the .parked file>` (on macOS `bash scripts/snip-mac.sh --restore-only --record <same file>`), or click DSH on the taskbar / Dock. |
| Capture shows the picker panel | The mode picker had not finished closing. Reload the page; the client polls for the sheet (1.5 s cap) before firing. |
| Selector is smaller than the screen | The machine reports a scaled virtual screen and the process is not DPI-aware. `DshShot.cs` calls `SetProcessDpiAwarenessContext` before measuring; if a wrapper strips it, run the script with `-STA` as above. |
| `this build only runs on macOS` in the console | The wrong package is installed for this machine. Swap `dsh-screenshot` for `dsh-screenshot-mac` (or back) in the profile. |
| Nothing happens on Linux | Expected — the plugin has Windows and macOS paths only. |

## Platform and known limits

- Windows 10/11 and macOS, as two separate packages; no Linux path. Installing the Windows
  package on macOS (or the reverse) logs one warning instead of pretending to work.
- **macOS uses the system selector.** The crosshair, the magnifier, the live pixel readout,
  space-to-grab-a-window and Esc are all `screencapture`'s; moving the frame, resizing by its
  handles and `Ctrl`-to-mark are this plugin's own work on Windows and have no macOS
  counterpart. macOS already ships the better version — redrawing it would be a step down.
- Stepping aside on macOS: a browser is minimized (Chrome-family and Safari support that
  natively, no Accessibility grant needed), anything else is hidden through
  `NSRunningApplication`, which needs no grant either; System Events is only the fallback.
  If the hosting app cannot be identified, nothing is touched and the capture goes ahead
  with it in frame.
- The Windows selector spans the whole virtual screen, so multi-monitor regions work, but
  monitors with different DPI are flattened onto one coordinate grid; on macOS the system
  handles multi-monitor itself.
- Annotations (Windows) are rectangles in one colour (red); `Ctrl+Z` undoes the last mark
  only. Marking costs a modifier because the plain body drag belongs to moving the frame.
- The frozen frame is a snapshot: anything that changes behind the selector is not reflected.
- "Keep the window in the shot" captures whatever is on screen, so bring DSH to the front first
  if you want to include DSH itself.

## License

MIT — see [LICENSE](LICENSE).
