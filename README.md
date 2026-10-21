# dsh-screenshot

**Region screenshot for the DeepSeek Harness composer.**

One row in the composer's `+` menu. Click it, the DSH window steps aside, the screen
freezes, you drag a rectangle over whatever you actually wanted to capture, annotate it,
press the green tick — and the PNG lands in the composer as a **pending attachment**,
ready to send with your next message.

English | [中文](README.zh-CN.md)

---

## What you get

| Action | Result |
| --- | --- |
| Composer `+` → **Screenshot** | Opens the two-mode picker |
| **Hide this window, then capture** | DSH is hidden first, so the shot shows what is behind it |
| **Keep this window visible** | DSH stays on screen and you crop DSH itself |
| Drag on the frozen screen | Selection rectangle |
| Drag a white grip | Resize the selection (8 grips, min 6×6) |
| Drag the inner border strip, or `Ctrl`+drag anywhere inside | Move the selection |
| Drag inside the frame | Draw a rectangle annotation |
| `Ctrl+Z` / ↶ button | Undo the last mark |
| `Enter` / green ✓ | Accept, restore the window, drop the PNG in the composer |
| `Esc` / red ✕ / right click | Cancel; the window still comes back |

The chosen mode is remembered in `localStorage` under `dsh-screenshot.mode`.

## Why hiding matters

Most screenshot tools crop the screen the app is already covering, which is useless when
the thing you want to show is *behind* the app. This one hides its own window for the
duration of the shot and puts it back afterwards:

```
click  →  SW_HIDE the DSH window  →  wait for the compositor
       →  freeze the whole virtual screen
       →  overlay: drag / resize / annotate
       →  composite the crop + marks into one PNG
       →  SW_RESTORE + SetForegroundWindow   (in a finally block)
       →  data URL  →  synthetic document drop  →  composer draft
```

The restore lives in a `finally` block inside the native helper, so a cancelled or failed
capture still brings the window back. If the helper process is killed outright, the window
handle was written to a record file first and `scripts/restore.ps1` can unhide it.

## Requirements

- **Windows 10/11.** Window hiding, screen capture and the selection surface are all
  Win32 / WinForms calls. There is no macOS or Linux path.
- A DSH desktop build whose composer exposes the `commandUi` service and the
  `webServer` + `connection` host services (the shipping desktop profile does).
- Windows PowerShell 5.1, which ships with Windows. Nothing else to install — the C#
  helper is compiled on demand by `Add-Type`.

## Install

The plugin is a plain DSH bundle: `package.json` + host half (`index.js`) + client half
(`client.js`) + `cordis.patch.yml` + a native helper in `scripts/`.

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
| Host | `index.js` | `POST /dsh-screenshot/snip` → spawns PowerShell with `scripts/snip.ps1`, answers one PNG data URL. `GET /dsh-screenshot/ping` is a liveness probe. |
| Client | `client.js` | Registers the `shot` command with its two modes, waits for the picker sheet to close, then fires the capture and hands the PNG to the composer. |
| Native | `scripts/snip.ps1` + `scripts/DshShot.cs` | Hide (optional) → freeze → selection window → composite → save PNG → restore. |
| Safety net | `scripts/restore.ps1` | Unhides the window by its recorded handle if the helper died. |

Both routes go through `ctx.connection.requestRejection(req)`, so they inherit the host's
normal request policy instead of opening an unauthenticated hole.

### HTTP surface

| Route | Method | Body | Answer |
| --- | --- | --- | --- |
| `/dsh-screenshot/snip` | `POST` | `{"title": string, "hide": boolean}` | `{"ok":true,"dataUrl":"data:image/png;base64,…","width":W,"height":H,"bytes":N}` or `{"ok":false,"reason":"cancelled"\|"failed","message":"…"}` |
| `/dsh-screenshot/ping` | `GET` | — | `{"ok":true,"powershell":"…","scripts":"…"}` |

The body is capped at 8 KB and the helper at 180 s.

### Why a synthetic `drop` event

The composer accepts files through the document-level drop listener that
`dsh-client-ui-attachment` installs (`installDocumentDropEvents`). Dispatching one
`DragEvent('drop')` with a real `DataTransfer` therefore rides the exact same upload and
preview path as a human drag-and-drop, without reaching into composer internals that move
between releases.

## Self-test

```powershell
node --check index.js
node --check client.js

# Full native chain without touching the mouse: hide -> fixed region -> restore
powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass `
  -File scripts\snip.ps1 -OutPath "$env:TEMP\shot.png" `
  -AutoSelect '100,100,800,450' -TitleFragment 'DeepSeek Harness' -TimeoutSeconds 20

# Same chain, window left visible
powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass `
  -File scripts\snip.ps1 -OutPath "$env:TEMP\shot2.png" `
  -AutoSelect '0,0,640,360' -HideWindow 0 -TimeoutSeconds 20
```

Expected: one JSON line with `{"ok":true,…,"width":800,"height":450}`. After the first run
the DSH window is visible again (`IsWindowVisible` true, `IsIconic` false); in the second
run it never left.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| No `+` menu row | The bundle is not composed. Check the `bundles` array and the `node_modules` junction, then restart. |
| `Screenshot failed` in the console | The helper printed an error. Run the self-test above — it uses the same script and prints the reason. |
| Window stays hidden | The helper was killed mid-capture. Run `scripts\restore.ps1 -TargetFile <the .hwnd file referenced in the error>`, or click DSH on the taskbar. |
| Capture shows the picker panel | The mode picker had not finished closing. Reload the page; the client polls for the sheet (1.5 s cap) before firing. |
| Nothing happens on a non-Windows host | Expected — the plugin is Windows-only. |

## Platform and known limits

- Windows 10/11 only.
- The whole virtual screen is frozen as one canvas, so multi-monitor regions work, but
  monitors with different DPI are flattened onto one coordinate grid.
- Annotations are rectangles in one colour (red); `Ctrl+Z` undoes the last mark only.
  The arrow drawing primitive exists in `DshShot.cs` but no toolbar button selects it yet.
- The frozen frame is a snapshot: anything that changes behind the overlay is not reflected.
- "Keep this window visible" captures whatever is on screen, so bring DSH to the front
  first if you want to crop DSH itself.
- The toolbar's three glyphs are painted paths, not font glyphs — that is why the undo tick
  and cross share a stroke weight and optical centre.

## License

MIT — see [LICENSE](LICENSE).
