# dsh-screenshot

**Region screenshot for the DeepSeek Harness composer.**

One row in the composer's `+` menu. Click it, pick a mode, the DSH window steps aside, a
native selection form covers the whole desktop, you drag a rectangle over the part you
actually wanted, annotate it, press the green tick — and the PNG lands in the composer as a
**pending attachment**, ready to send with your next message.

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

The chosen mode is remembered in `localStorage` under `dsh-screenshot.mode`.

## Which window gives way

The selection step is always the same: one native form covers the whole virtual screen, with the
same grips and annotations. Only "how does the client get out of the way" differs, because three
kinds of host can be showing this page and they can name their own window very differently:

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

The handle is also written to a record file before the window is parked, and
`scripts\snip.ps1 -RestoreOnly` can pull it back if the process was killed outright.

## Requirements

- **Windows 10/11.** Parking a window and drawing over the desktop are Win32 calls. There is
  no macOS or Linux path.
- A DSH desktop build whose composer exposes the `commandUi` service and the
  `webServer` + `connection` host services (the shipping desktop profile does).
- Windows PowerShell 5.1, which ships with Windows. Nothing else to install — the C#
  selector is compiled on demand by `Add-Type`.

## Install

The plugin is a plain DSH bundle: `package.json` + host half (`index.js`) + client half
(`client.js`) + `cordis.patch.yml` + the native selector in `scripts/`.

1. Clone it somewhere outside the profile:

   ```powershell
   git clone https://github.com/Dcmwfg/dsh-screenshot.git E:\dsh-plugins\dsh-screenshot
   ```

2. In `<profile>/package.json` (on Windows that is
   `%USERPROFILE%\.dsh\profiles\desktop\package.json`) add the dependency:

   ```json
   "dependencies": { "dsh-screenshot": "link:E:/dsh-plugins/dsh-screenshot" }
   ```

3. Add the bundle name to the same file:

   ```json
   "dsh": { "profile": { "bundles": ["...", "dsh-screenshot"] } }
   ```

4. Link it into the profile's `node_modules`:

   ```powershell
   New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-screenshot" `
     -Target "E:\dsh-plugins\dsh-screenshot"
   ```

5. **Restart DSH.** New bundles are composed at boot; editing files afterwards takes effect
   on the next start.

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
| Host | `index.js` | `POST /dsh-shot/shot` → spawns PowerShell with `scripts/snip.ps1`, answers one finished PNG as a data URL. `GET /dsh-shot/ping` is a liveness probe. |
| Client | `client.js` | Registers the `shot` command with its two modes, waits for the picker sheet to close, fires the capture, and drops the returned PNG into the composer. |
| Native | `scripts/snip.ps1` + `scripts/DshShot.cs` | Park the window (optional) → blit the virtual screen → topmost full-screen selector (frame, grips, move, annotate) → crop composite → save PNG → restore. Also restores on demand with `-RestoreOnly`. |

Both routes go through `ctx.connection.requestRejection(req)`, so they inherit the host's
normal request policy instead of opening an unauthenticated hole.

### HTTP surface

| Route | Method | Body | Answer |
| --- | --- | --- | --- |
| `/dsh-shot/shot` | `POST` | `{"title": string, "hide": boolean}` | `{"ok":true,"dataUrl":"data:image/png;base64,…","width":W,"height":H,"restored":true,"bytes":N}` or `{"ok":false,"reason":"cancelled"\|"failed","message":"…"}` |
| `/dsh-shot/ping` | `GET` | — | `{"ok":true,"driver":"…","shell":"…"}` |

The body is capped at 4 KB and the selector at 180 s. `title` is matched against window
captions to find the window to park; when nothing matches, the capture fails instead of
guessing at whatever happens to be in front. `width`/`height` are the **cropped** size, not
the desktop size.

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

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| No `+` menu row | The bundle is not composed. Check the `bundles` array and the `node_modules` junction, then restart. |
| `Screenshot failed` in the console | The driver printed an error. Run the self-test above — it uses the same script and prints the reason. |
| Window stays hidden | The driver was killed mid-capture. Run `scripts\snip.ps1 -RestoreOnly -Record <the .parked file>`, or click DSH on the taskbar. |
| Capture shows the picker panel | The mode picker had not finished closing. Reload the page; the client polls for the sheet (1.5 s cap) before firing. |
| Selector is smaller than the screen | The machine reports a scaled virtual screen and the process is not DPI-aware. `DshShot.cs` calls `SetProcessDpiAwarenessContext` before measuring; if a wrapper strips it, run the script with `-STA` as above. |
| Nothing happens on a non-Windows host | Expected — the plugin is Windows-only. |

## Platform and known limits

- Windows 10/11 only.
- The selector spans the whole virtual screen, so multi-monitor regions work, but monitors
  with different DPI are flattened onto one coordinate grid.
- Annotations are rectangles in one colour (red); `Ctrl+Z` undoes the last mark only. Marking
  costs a modifier because the plain body drag belongs to moving the frame.
- The frozen frame is a snapshot: anything that changes behind the selector is not reflected.
- "Keep the window in the shot" captures whatever is on screen, so bring DSH to the front first
  if you want to include DSH itself.

## License

MIT — see [LICENSE](LICENSE).
