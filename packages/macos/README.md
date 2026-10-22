# dsh-screenshot-mac (macOS package)

Region screenshot for the DeepSeek Harness composer on macOS. The frontmost app steps aside
(a browser is minimized, anything else is hidden), the system's own `screencapture -i` selector
frames the region, the app comes back, and the finished PNG lands in the composer as a pending
attachment.

Route prefix: `/dsh-shot-mac/*`.

This is the macOS half. The Windows half is `../windows` (`dsh-screenshot`), and the
documentation for both lives in the repository root: [README.md](../../README.md) /
[README.zh-CN.md](../../README.zh-CN.md).

Bundle id: `dsh-screenshot-mac`. Requires the bundled bash, `screencapture` and `osascript`;
tick DSH under System Settings → Privacy & Security → Screen Recording before the first capture.
