# dsh-screenshot (Windows package)

Region screenshot for the DeepSeek Harness composer on Windows 10/11. A full-virtual-screen
WinForms form frames the region (drag the frame, eight grips, `Ctrl`+drag to annotate), then
the finished PNG lands in the composer as a pending attachment.

Route prefix: `/dsh-shot/*`.

This is the Windows half. The macOS half is `../macos` (`dsh-screenshot-mac`), and the
documentation for both lives in the repository root: [README.md](../../README.md) /
[README.zh-CN.md](../../README.zh-CN.md).

Bundle id: `dsh-screenshot`. Requires PowerShell 5.1 only; `scripts/DshShot.cs` is compiled
on demand by `Add-Type`.
