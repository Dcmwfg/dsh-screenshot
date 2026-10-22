# dsh-screenshot

**给 DeepSeek Harness 输入框用的区域截图插件。**

输入框 `+` 菜单里多一行。点它、选模式，DSH 窗口先让开，一个原生选区盖住整个桌面，
你在真屏幕上拖出想要的区域、随手标注，按绿勾 —— PNG 就落进输入框，作为
**待发送的附件**，跟下一条消息一起发出去。

这个仓库出**两个包**，一个平台一个 —— 两边的原生半没有一行共用代码：

| 包 | 平台 | 选区是谁 | 路由前缀 |
| --- | --- | --- | --- |
| [`packages/windows`](packages/windows) — `dsh-screenshot` | Windows 10/11 | 插件自己的 WinForms 窗体，盖住整个虚拟屏 | `/dsh-shot/*` |
| [`packages/macos`](packages/macos) — `dsh-screenshot-mac` | macOS | 系统自带的 `screencapture -i` 选区 | `/dsh-shot-mac/*` |

装机器面前那一个就行。两个包各自声明了 `os`，装错了会自己说一声，而不是闷着不干活。

[English](README.md) | 中文

---

## 能得到什么

| 动作 | 结果 |
| --- | --- |
| 输入框 `+` → **截图** | 两个版本菜单完全一样，都是下面两项 |
| **隐藏窗口截图** | 窗口先让开——外壳窗口隐藏、浏览器最小化——截完自动回来 |
| **保留窗口截图** | 客户端留在屏幕上，也可以被框进去 |
| 在冻结的桌面上拖 | 拉出选区，覆盖**整个**虚拟屏，1:1 |
| 拖白色抓手 | 改选区大小（8 个抓手，最小 6×6） |
| 在框内任意处拖 | 平移整个选区（内侧窄边条同样） |
| 按住 `Ctrl` 在框内拖 | 画一个矩形标注 |
| `Ctrl+Z` / ↶ 按钮 | 撤销最后一笔 |
| `Enter` / 绿勾 | 确认，把 PNG 放进输入框 |
| `Esc` / 红叉 / 右键 | 取消 |

选的模式记在 `localStorage` 里（Windows 是 `dsh-screenshot.mode`，macOS 是
`dsh-screenshot-mac.mode`）。

从「在冻结的桌面上拖」到「`Ctrl+Z` `撤销最后一笔`」这几行，都是 **Windows** 选区自己的行为。
macOS 上选区完全归苹果那套 UI —— 准星、放大镜、实时像素读数、空格切整窗、`Esc` 取消 ——
插件只负责把截好的那一块拿走、把应用放回来。这是有意的：用 AppKit 重画一遍，只会做出一个
更差的复制品。

## 哪个窗口让开

「隐藏窗口截图」时才需要认出「承载这个页面的那个窗口」。**这一节讲的是 Windows 的判定**；
macOS 上认不出标题（系统不给别家的标题），所以它只用「点下去落在哪个前台应用」这一条，
浏览器最小化、别的应用隐藏 —— 细节见下面「平台与已知边界」。

Windows 侧能托着页面的宿主有三种：

| 宿主 | 怎么认 | 怎么让开 |
| --- | --- | --- |
| 桌面版（页面在 `dsh-app://app`） | 标题对口 | **隐藏** |
| 任意套壳启动器（Tauri / Electron / CEF / WebView2 包装） | **窗口拥有 webview 子窗口**（`WRY_WEBVIEW`、`Chrome_RenderWidgetHostHWND`、`Chrome_WidgetWin_0`、`CefBrowserWindow`、`WebViewHost`、`EdgeWebViewHost`） | **隐藏** |
| 真浏览器标签页 | 进程在白名单里（`chrome`、`msedge`、`firefox`、`brave`、`opera`、`vivaldi` 等） | **最小化** |

外壳**按结构认，不按进程名认**。早先只认 `dsh` / `dsh-x` / `dshx` 三个名字，那只能盖住
当时知道的那几个启动器；名字本身也证明不了什么——任何程序都能叫 `dsh`。现在只要窗口
拥有一个内嵌 webview 子窗口就算外壳，所以还没被听说过的启动器一样能认出来。

反过来，编辑器、聊天客户端、记事本之外的 Electron 程序同样拥有 webview，所以「有 webview」
单独一条不够：控制台（`powershell`、`pwsh`、`cmd`、`conhost`、`windowsterminal`…）
和系统外壳（`explorer`、`dwm` 等）一律排除，浏览器先判为浏览器。

指认顺序（auto 模式）：前台窗口是外壳 → 用它；前台窗口是浏览器 → 用它；再按标题找；
再按「前台浏览器 + 标题对得上」找；最后才落到外壳候选，此时按「标题命中 → 进程名像本应用
（`dsh*`）→ 只剩一个候选」逐级取舍，剩下的候选超过一个就**一个都不动**。
理由是浏览器是外壳唯一不可能是的宿主，认出一个浏览器比猜一个外壳更硬；而在一堆无关窗口里
瞎猜就是去隐藏别人的程序，画面里带着自己反而更好。

外壳隐藏、浏览器最小化，这个区分是故意的：最小化的窗口在任务栏留按钮，回来就是普通的
`SW_RESTORE`，窗口落回用户原来的位置。成功判据也按模式分开——隐藏必须
`IsWindowVisible === false`，最小化必须 `IsIconic === true`。

页面上 `http://` 时标题什么都证明不了（十几个标签页可以顶同一个标题），所以宿主绝不在只有
标题的情况下动窗口；实在认不出来就**一个窗口都不碰**、照常截图，图照样送达，客户端在控制台
打一条警告。画面里带着窗口，好过收走一个认不出来的窗口。

版本判定只认 `location.protocol === 'dsh-app:'`，没有别的猜测。

## 为什么选区在原生层，不在页面里

选区以前是页面里的 DOM 覆盖层，那个形状注定不对：渲染进程的视口就是应用窗口，
覆盖层永远出不了窗口矩形，冻结的桌面只能缩着塞进去。你只能在「屏幕的照片」上框，
不是在屏幕上框。

现在是一个无父窗体、尺寸取 `SystemInformation.VirtualScreen`、置顶的 WinForms 窗体，
盖住每一台显示器，1:1。框选、八个抓手、内侧窄边条平移、标注工具栏都在它上面。
客户端半只负责把结果递过去。

这个形状带来两件事，都是故意的：

- **窗口只在你框选的那段时间让开。** 藏/恢复是一对包住选区的 `try/finally`，
  取消、超时、抛异常都会把 DSH 放回来。
- **只有一套坐标系。** 指针位置、裁切框、存下来的 PNG 全是真实屏幕像素，
  没有 `object-fit: contain` 的缩放要反算。

句柄在藏窗口之前先写进记录文件，驱动的 `-RestoreOnly`（Windows）/ `--restore-only`（macOS）
能在进程被杀之后兜底。

## 运行条件

- **Windows 10/11 或 macOS。** 两边各打一个包，做的事一样、走的路不同：
  `packages/windows` 用 WinForms 窗体盖住整个虚拟屏（`scripts\DshShot.cs` + `scripts\snip.ps1`），
  `packages/macos` 用 bash 直接开系统自带的 `screencapture -i` 框选（`scripts\snip-mac.sh`）。
  Linux 没有路径。
- 一个把 `commandUi` 服务与 `webServer` + `connection` 宿主服务暴露出来的 DSH 桌面版
  （发行版桌面 profile 就是）。
- Windows：PowerShell 5.1，系统自带。别的都不用装 —— C# 选区窗体由 `Add-Type` 现场编译。
- macOS：系统自带的 bash、`screencapture`、`osascript`。第一次截图前要在
  「系统设置 → 隐私与安全性 → 录屏与系统录音」里勾上 DSH，否则截出来只有壁纸。

## 安装

每个包都是一个普通的 DSH bundle：`package.json` + 宿主半（`index.js`）+ 客户端半
（`client.js`）+ `cordis.patch.yml` + `scripts/` 里的原生驱动。仓库根目录只是 workspace
容器，**别把根目录本身链进 profile**。

克隆一次，然后挑机器对应的那个包：

```powershell
git clone https://github.com/Dcmwfg/dsh-screenshot.git E:\dsh-plugins\dsh-screenshot
```

| 机器 | 包目录 | bundle 名 |
| --- | --- | --- |
| Windows 10/11 | `packages/windows` | `dsh-screenshot` |
| macOS | `packages/macos` | `dsh-screenshot-mac` |

下面以 Windows 版为例（`<profile>` 是 profile 目录，比如
`%USERPROFILE%\.dsh\profiles\desktop`）：

1. 加依赖 —— 注意路径要指到包，不是仓库根：

   ```json
   "dependencies": { "dsh-screenshot": "link:E:/dsh-plugins/dsh-screenshot/packages/windows" }
   ```

2. 同一个文件里加 bundle 名：

   ```json
   "dsh": { "profile": { "bundles": ["...", "dsh-screenshot"] } }
   ```

3. 链进 profile 的 `node_modules`：

   ```powershell
   New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-screenshot" `
     -Target "E:\dsh-plugins\dsh-screenshot\packages\windows"
   ```

4. **重启 DSH。** 新 bundle 在启动时组好；之后再改文件要等下一次启动。

macOS 换成 `packages/macos`、名字 `dsh-screenshot-mac`、profile 在 `~/.dsh/profiles/desktop`
（或 `web`）。形状完全一样：`link:<checkout>/packages/macos`，`bundles` 里写
`"dsh-screenshot-mac"`。

用 junction 而不是拷贝，意思是改完源码重启就生效。

## 用法

1. 打开输入框的 `+` 菜单。那行叫 **截图**，紧挨着 **文件** —— 宿主把 Add 段写死成
   `file/goal/plan/feedback`，其它贡献一律塞进 Commands 段，所以本插件会把自己那一行
   重排一次，挪到文件旁边。
2. 选一个模式。选择会被记住。
3. 桌面在暗幕下冻住。拖出区域。框内直接拖是移动它，抓手改大小，要标注按 `Ctrl` 再拖。
4. 按 `Enter` 或绿勾。
5. 图片出现在输入框上方，是草稿。打字回车才发出去。

提交之前什么都不发 —— 截图是附件，不是消息。

## 怎么搭的

| 半边 | 文件 | 干什么 |
| --- | --- | --- |
| 宿主 | `index.js` | `POST /dsh-shot/shot`（Windows）或 `POST /dsh-shot-mac/shot`（macOS）→ 起对应平台的驱动，回一张成品 PNG 的 data URL。配套的 `/ping` 是存活探针，不起子进程。 |
| 客户端 | `client.js` | 注册 `shot` 命令与两种模式，等选择面板消失，发请求，把回来的 PNG 放进输入框。两边的 `client.js` 几乎一样，只有模块 id、locale 命名空间、路由前缀和存模式的键不同。 |
| 原生（Windows） | `scripts/snip.ps1` + `scripts/DshShot.cs` | 藏窗口（可选）→ 拷贝虚拟屏 → 置顶全屏选区（框选、抓手、平移、标注）→ 合成裁切 → 存 PNG → 恢复。也能用 `-RestoreOnly` 按需恢复。 |
| 原生（macOS） | `scripts/snip-mac.sh` | 把前台应用让开（浏览器最小化、别的隐藏）→ `screencapture -i` → 还原 → 回一行 JSON。也能用 `--restore-only` 按需恢复。 |

两条路由都过 `ctx.connection.requestRejection(req)`，继承宿主正常的请求策略，
不开没鉴权的洞。

### HTTP 面

| 路由 | 方法 | 请求体 | 回答 |
| --- | --- | --- | --- |
| `/dsh-shot/shot` | `POST` | `{"title": string, "hide": boolean, "host": "title"\|"auto"}` | `{"ok":true,"dataUrl":"data:image/png;base64,…","width":W,"height":H,"hidden":bool,"restored":true,"bytes":N}` 或 `{"ok":false,"reason":"cancelled"\|"failed","message":"…"}` |
| `/dsh-shot/ping` | `GET` | — | `{"ok":true,"platform":"win32","driver":"…","shell":"…"}` |
| `/dsh-shot-mac/shot` | `POST` | `{"title": string, "hide": boolean, "host": "auto"\|"shell"}` | 同上，另加 `"mode":"hide"\|"minimize"\|""` |
| `/dsh-shot-mac/ping` | `GET` | — | `{"ok":true,"platform":"darwin","driver":"…","shell":"/bin/bash"}` |

两个包的请求体上限都是 4 KB，选区上限都是 180 s；`width`/`height` 都是**裁完之后**的尺寸，
不是桌面尺寸。

`title` 拿去匹配窗口标题找要让开的那个窗口 —— **只有 Windows 这么做**，macOS 拿不到别家应用的
标题。匹配不到就一个窗口都不动、照常截图，并回 `"hidden":false`，让客户端把话说出来。
`host` 决定怎么让开：`"title"` 表示这页在桌面外壳里，`"auto"` 表示在浏览器里；驱动对外壳做隐藏、
对浏览器做最小化。

### 为什么合成一个 `drop` 事件

输入框接收文件走的是 `dsh-client-ui-attachment` 装在 document 上的拖放监听
（`installDocumentDropEvents`）。所以带上真 `DataTransfer` 派一个
`DragEvent('drop')`，走的就是人手动拖进去那条路，不用伸手去够版本之间会变的输入框内部。

### 为什么要轮询面板

宿主的 `PopupSelectController` 先置 `submitting`、await `onSelect`，然后才关面板。
所以这里的 `onSelect` 立刻返回，由一段轮询等面板离开 DOM 之后再开快门 ——
否则「保留窗口截图」会把选项面板一起冻进画面。轮询最多等 1.5 s，等不到也照拍。

## 自检

```powershell
cd packages\windows
node --check index.js
node --check client.js

# 固定区域、窗口不动：打印一行 JSON 并写出 PNG
powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass `
  -File scripts\snip.ps1 -OutPath "$env:TEMP\shot.png" -AutoSelect '200,150,800,500' -HideWindow 0

# 收起窗口、截、放回去
powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass `
  -File scripts\snip.ps1 -OutPath "$env:TEMP\shot2.png" -AutoSelect '100,100,640,360' `
  -HideWindow 1 -TitleFragment 'DeepSeek Harness' -Record "$env:TEMP\shot2.parked"

# 兜底：万一哪次被杀在半路
powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass `
  -File scripts\snip.ps1 -RestoreOnly -Record "$env:TEMP\shot2.parked"
```

预期：一行 JSON 里 `"ok":true`，第一条命令的 `"width":800,"height":500` 是**裁出来的
尺寸**、不是桌面尺寸。带 `-AutoSelect` 就跳过选区窗体，所以这一条能无人值守跑。
第三条命令的 `"restored":true` 表示窗口回来了。

不带 `-AutoSelect` 就是真的弹出选区，阻塞到你确认或按 `Esc`；取消会回
`{"ok":false,"reason":"cancelled"}`。

macOS 是另一个包，回答的契约一样：

```bash
cd packages/macos
node --check index.js
node --check client.js
bash scripts/snip-mac.sh --out /tmp/shot.png --region '200,150,800,500' --hide 0
bash scripts/snip-mac.sh --restore-only --record /tmp/shot2.parked
```

同样是一行 JSON。带上 `--region` 就不弹系统选区（等价于 Windows 的 `-AutoSelect`），
所以这一条也能无人值守跑；不带就开系统的准星框选，`Esc` 取消。第一次跑之前记得在
「系统设置 → 隐私与安全性 → 录屏与系统录音」里勾上 DSH —— 没勾的话 `screencapture`
一样会写出文件，只是写出来的是一张壁纸。

## 出问题看这里

| 现象 | 原因 / 修法 |
| --- | --- |
| `+` 菜单里没有那一行 | bundle 没被组合。查 `bundles` 数组和 `node_modules` 的 junction，然后重启。 |
| 控制台里 `Screenshot failed` | 驱动报了错。跑上面的自检 —— 同一个脚本，会打印原因。 |
| 窗口一直藏着不出来 | 驱动被杀在半路。跑 `scripts\snip.ps1 -RestoreOnly -Record <那个 .parked 文件>`（macOS 是 `bash scripts/snip-mac.sh --restore-only --record <同一文件>`），或点任务栏 / Dock 里的 DSH。 |
| 截图里带上了选项面板 | 面板还没关完。刷新页面；客户端会先轮询等面板（上限 1.5 s）再拍。 |
| 选区比屏幕小一圈 | 机器报的是缩放后的虚拟屏，进程不是 DPI 感知的。`DshShot.cs` 在量尺寸之前会调 `SetProcessDpiAwarenessContext`；如果被外层剥掉了，照上面带 `-STA` 跑。 |
| 控制台里 `this build only runs on macOS` | 装错包了。把 profile 里的 `dsh-screenshot` 换成 `dsh-screenshot-mac`（或反过来）。 |
| Linux 上没反应 | 正常，插件只有 Windows 和 macOS 两条路径。 |

## 平台与已知边界

- Windows 10/11 与 macOS，是两个独立的包；Linux 没有路径。在 macOS 上装 Windows 包
  （或反过来）只会打一行警告，不会假装在干活。
- **macOS 用的是系统那套框选。** 准星、放大镜、逐像素尺寸读数、空格切整窗、Esc 取消都是
  `screencapture` 自带的；移动选区、拖手柄调整大小、`Ctrl` 标注这些是本插件在 Windows 上
  另做的，macOS 侧没有对应物 —— macOS 已经有了更好的，重画一个是退步。
- macOS 让路：浏览器走「最小化窗口」（Chrome 系与 Safari 原生支持，不需要辅助功能授权），
  别的应用走「隐藏应用」（`NSRunningApplication`，同样不吃授权，System Events 只作兜底）。
  认不出承载页面的应用就一个都不动，照常截图，只是画面里带着它。
- 选区（Windows）横跨整个虚拟屏，所以跨显示器能用，但不同 DPI 的显示器会被拉平到同一套坐标上；
  macOS 的跨屏选区由系统处理。
- 标注只有一种颜色（红）的矩形；`Ctrl+Z` 只撤最后一笔。标注要按住 `Ctrl` 才能画，因为不按
  `Ctrl` 的框内拖拽留给了移动选区。（Windows）
- 冻结帧是快照：选区开着的时候，后面别处变了不会反映。（Windows）
- 「保留窗口截图」截的是当前屏幕上的一切，所以想截 DSH 自己得先把它切到前台。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
