# dsh-screenshot

**Region screenshot for the DeepSeek Harness composer.**

One row in the composer's `+` menu. Click it, pick a mode, the DSH window steps aside,
the host takes a single snapshot of the desktop, you drag a rectangle over the part you
actually wanted, annotate it, press the green tick — and the PNG lands in the composer as a
**pending attachment**, ready to send with your next message.

English | [中文](README.zh-CN.md)

---

## What you get

| Action | Result |
| --- | --- |
| Composer `+` → **Screenshot** | Opens the two-mode picker |
| **Hide this window, then capture** | DSH is parked first, so the shot shows what is behind it |
| **Keep this window visible** | DSH stays on screen and you crop DSH itself |
| Drag on the frozen screen | Selection rectangle |
| Drag a white grip | Resize the selection (8 grips, min 6×6) |
| Drag the inner border strip, or `Ctrl`+drag anywhere inside | Move the selection |
| Drag inside the frame | Draw a rectangle annotation |
| `Ctrl+Z` / ↶ button | Undo the last mark |
| `Enter` / green ✓ | Accept and drop the PNG in the composer |
| `Esc` / red ✕ / right click | Cancel |

The chosen mode is remembered in `localStorage` under `dsh-screenshot.mode`.

## Why hiding matters

Most screenshot tools crop the screen the app is already covering, which is useless when
the thing you want to show is *behind* the app. This one parks its own window for the
length of one shutter, then puts it back:

```
click  →  SW_MINIMIZE the DSH window  →  wait for the compositor
       →  BitBlt the whole virtual screen into one bitmap
       →  SW_RESTORE + SetForegroundWindow        (in a finally block)
       →  browser overlay: drag / resize / annotate over the frozen frame
       →  canvas crop + marks  →  one PNG  →  composer draft
```

Two things follow from that shape, and both are deliberate:

- **The window is only away for milliseconds.** Cropping happens afterwards, in the page,
  over a frozen bitmap. Nobody has to keep DSH hidden while they fiddle with a rectangle.
- **The native side has no UI.** It is a shutter and nothing else, so there is no second
  selection widget to keep in sync with the browser one.

The restore lives in a `finally` block, so a failed or timed-out capture still brings the
window back. The handle is also written to a record file first, and
`scripts\shutter.ps1 -RestoreOnly` can pull it back if the process was killed outright.

## Requirements

- **Windows 10/11.** Hiding a window and copying the desktop are Win32 calls. There is no
  macOS or Linux path.
- A DSH desktop build whose composer exposes the `commandUi` service and the
  `webServer` + `connection` host services (the shipping desktop profile does).
- Windows PowerShell 5.1, which ships with Windows. Nothing else to install — the C#
  helper is compiled on demand by `Add-Type`.

## Install

The plugin is a plain DSH bundle: `package.json` + host half (`index.js`) + client half
(`client.js`) + `cordis.patch.yml` + the native shutter in `scripts/`.

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
3. Drag the region, adjust it with the grips, annotate if you want.
4. Press `Enter` or the green tick.
5. The image appears above the input box as a draft. Typing and pressing Enter sends it.

Nothing is sent until you submit — the screenshot is an attachment, not a message.

## How it is built

| Half | File | Job |
| --- | --- | --- |
| Host | `index.js` | `POST /dsh-shot/shot` → spawns PowerShell with `scripts/shutter.ps1`, answers one PNG data URL plus the desktop origin. `GET /dsh-shot/ping` is a liveness probe. |
| Client | `client.js` | Registers the `shot` command with its two modes, waits for the picker sheet to close, fires the capture, then renders the overlay that crops and annotates. |
| Native | `scripts/shutter.ps1` + `scripts/Snap.cs` | Park the window (optional) → `BitBlt` the virtual screen → save PNG → restore. Also restores on demand with `-RestoreOnly`. |

Both routes go through `ctx.connection.requestRejection(req)`, so they inherit the host's
normal request policy instead of opening an unauthenticated hole.

### HTTP surface

| Route | Method | Body | Answer |
| --- | --- | --- | --- |
| `/dsh-shot/shot` | `POST` | `{"title": string, "hide": boolean}` | `{"ok":true,"dataUrl":"data:image/png;base64,…","width":W,"height":H,"left":X,"top":Y,"restored":true,"bytes":N}` or `{"ok":false,"reason":"failed","message":"…"}` |
| `/dsh-shot/ping` | `GET` | — | `{"ok":true,"driver":"…","shell":"…"}` |

The body is capped at 4 KB and the shutter at 180 s. `title` is matched against window
captions to find the window to park; when nothing matches, the capture fails instead of
guessing at whatever happens to be in front.

### Why a synthetic `drop` event

The composer accepts files through the document-level drop listener that
`dsh-client-ui-attachment` installs (`installDocumentDropEvents`). Dispatching one
`DragEvent('drop')` with a real `DataTransfer` therefore rides the exact same upload and
preview path as a human drag-and-drop, without reaching into composer internals that move
between releases.

### Why the sheet is polled

The host's `PopupSelectController` sets `submitting`, awaits `onSelect`, and only then
closes the sheet. So `onSelect` here returns immediately and the capture is fired from a
poll that waits for the sheet to leave the DOM — otherwise "keep this window visible" would
freeze the picker panel into the frame. The poll gives up after 1.5 s and shoots anyway.

## Self-test

```powershell
node --check index.js
node --check client.js

# One shutter, window left visible: prints one JSON line and writes a PNG
powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass `
  -File scripts\shutter.ps1 -OutPath "$env:TEMP\shot.png" -Hide 0

# Park the window, shoot, and put it back
powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass `
  -File scripts\shutter.ps1 -OutPath "$env:TEMP\shot2.png" -Hide 1 `
  -TitleFragment 'DeepSeek Harness' -Record "$env:TEMP\shot2.parked"

# Safety net, if a capture was killed mid-way
powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass `
  -File scripts\shutter.ps1 -RestoreOnly -Record "$env:TEMP\shot2.parked"
```

Expected: one JSON line containing `"ok":true` and the real desktop size (1920×1080 on a
1080p display — not a DPI-scaled 1536×864; the shutter calls `SetProcessDPIAware` first).
After the second command `"restored":true` means the window came back.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| No `+` menu row | The bundle is not composed. Check the `bundles` array and the `node_modules` junction, then restart. |
| `Screenshot failed` in the console | The shutter printed an error. Run the self-test above — it uses the same script and prints the reason. |
| Window stays hidden | The shutter was killed mid-capture. Run `scripts\shutter.ps1 -RestoreOnly -Record <the .parked file>`, or click DSH on the taskbar. |
| Capture shows the picker panel | The mode picker had not finished closing. Reload the page; the client polls for the sheet (1.5 s cap) before firing. |
| Nothing happens on a non-Windows host | Expected — the plugin is Windows-only. |

## Platform and known limits

- Windows 10/11 only.
- The whole virtual screen is frozen as one canvas, so multi-monitor regions work, but
  monitors with different DPI are flattened onto one coordinate grid.
- Annotations are rectangles in one colour (red); `Ctrl+Z` undoes the last mark only.
- The frozen frame is a snapshot: anything that changes behind the overlay is not reflected.
- "Keep this window visible" captures whatever is on screen, so bring DSH to the front
  first if you want to crop DSH itself.

## License

MIT — see [LICENSE](LICENSE).
