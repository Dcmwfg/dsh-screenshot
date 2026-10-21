# dsh-screenshot

**给 DeepSeek Harness 输入框用的区域截图插件。**

输入框 `+` 菜单里多一行。点它、选模式，DSH 窗口先让开，一个原生选区窗体盖住整个桌面，
你在真屏幕上拖出想要的区域、随手标注，按绿勾 —— PNG 就落进输入框，作为
**待发送的附件**，跟下一条消息一起发出去。

[English](README.md) | 中文

---

## 能得到什么

| 动作 | 结果 |
| --- | --- |
| 输入框 `+` → **截图** | 桌面版弹两种模式；浏览器版只有一种（见下） |
| **隐藏本窗口后截图** | 先把 DSH 收走，截到它后面的东西 |
| **保持窗口可见** | DSH 留在屏幕上，也可以被框进去 |
| 在冻结的桌面上拖 | 拉出选区，覆盖**整个**虚拟屏，1:1 |
| 拖白色抓手 | 改选区大小（8 个抓手，最小 6×6） |
| 在框内任意处拖 | 平移整个选区（内侧窄边条同样） |
| 按住 `Ctrl` 在框内拖 | 画一个矩形标注 |
| `Ctrl+Z` / ↶ 按钮 | 撤销最后一笔 |
| `Enter` / 绿勾 | 确认，把 PNG 放进输入框 |
| `Esc` / 红叉 / 右键 | 取消 |

选的模式记在 `localStorage` 的 `dsh-screenshot.mode` 里。

## 桌面版与浏览器版

选区这一步两边一样：都是那个盖住整个虚拟屏的原生窗体，框选、抓手、标注都不少。
差别只在「让不让 DSH 走开」：

- **桌面版**（页面跑在 `dsh-app://app`）两个模式都给。藏窗口靠标题找到 DSH 自己的
  浏览器窗口，隐藏完再放回来。
- **浏览器版**（`http://` 打开的 web 构建）只给一个「开始框选屏幕」，浏览器自己会留在
  画面里。**不提供隐藏**是故意的：浏览器版里没有可靠的「这就是 DSH 窗口」判据，
  照标题去藏有可能把你正在用的另一个窗口收走。要截别的窗口，先把浏览器挪开或缩到一边，
  再点开始框选。

判定只认 `location.protocol === 'dsh-app:'`，没有别的猜测。

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

句柄在藏窗口之前先写进记录文件，`scripts\snip.ps1 -RestoreOnly` 能在进程被杀之后兜底。

## 运行条件

- **Windows 10/11。** 收起窗口和在桌面上画东西都是 Win32 调用，没有 macOS / Linux 路径。
- 一个把 `commandUi` 服务与 `webServer` + `connection` 宿主服务暴露出来的 DSH 桌面版
  （发行版桌面 profile 就是）。
- Windows PowerShell 5.1，系统自带。别的都不用装 —— C# 选区窗体由 `Add-Type` 现场编译。

## 安装

插件就是一个普通的 DSH bundle：`package.json` + 宿主半（`index.js`）+ 客户端半
（`client.js`）+ `cordis.patch.yml` + `scripts/` 里的原生选区。

1. 克隆到 profile 之外的地方：

   ```powershell
   git clone https://github.com/Dcmwfg/dsh-screenshot.git E:\dsh-plugins\dsh-screenshot
   ```

2. 在 `<profile>/package.json`（Windows 上是
   `%USERPROFILE%\.dsh\profiles\desktop\package.json`）加依赖：

   ```json
   "dependencies": { "dsh-screenshot": "link:E:/dsh-plugins/dsh-screenshot" }
   ```

3. 同一个文件里加 bundle 名：

   ```json
   "dsh": { "profile": { "bundles": ["...", "dsh-screenshot"] } }
   ```

4. 链进 profile 的 `node_modules`：

   ```powershell
   New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-screenshot" `
     -Target "E:\dsh-plugins\dsh-screenshot"
   ```

5. **重启 DSH。** 新 bundle 在启动时组好；之后再改文件要等下一次启动。

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
| 宿主 | `index.js` | `POST /dsh-shot/shot` → 起 PowerShell 跑 `scripts/snip.ps1`，回一张成品 PNG 的 data URL。`GET /dsh-shot/ping` 是存活探针。 |
| 客户端 | `client.js` | 注册 `shot` 命令与两种模式，等选择面板消失，发请求，把回来的 PNG 放进输入框。 |
| 原生 | `scripts/snip.ps1` + `scripts/DshShot.cs` | 藏窗口（可选）→ 拷贝虚拟屏 → 置顶全屏选区（框选、抓手、平移、标注）→ 合成裁切 → 存 PNG → 恢复。也能用 `-RestoreOnly` 按需恢复。 |

两条路由都过 `ctx.connection.requestRejection(req)`，继承宿主正常的请求策略，
不开没鉴权的洞。

### HTTP 面

| 路由 | 方法 | 请求体 | 回答 |
| --- | --- | --- | --- |
| `/dsh-shot/shot` | `POST` | `{"title": string, "hide": boolean}` | `{"ok":true,"dataUrl":"data:image/png;base64,…","width":W,"height":H,"restored":true,"bytes":N}` 或 `{"ok":false,"reason":"cancelled"\|"failed","message":"…"}` |
| `/dsh-shot/ping` | `GET` | — | `{"ok":true,"driver":"…","shell":"…"}` |

请求体上限 4 KB，选区上限 180 s。`title` 拿去匹配窗口标题找要收起的那个窗口；
匹配不到就报错，不会去猜「反正最前面那个」。`width`/`height` 是**裁完之后**的尺寸，
不是桌面尺寸。

### 为什么合成一个 `drop` 事件

输入框接收文件走的是 `dsh-client-ui-attachment` 装在 document 上的拖放监听
（`installDocumentDropEvents`）。所以带上真 `DataTransfer` 派一个
`DragEvent('drop')`，走的就是人手动拖进去那条路，不用伸手去够版本之间会变的输入框内部。

### 为什么要轮询面板

宿主的 `PopupSelectController` 先置 `submitting`、await `onSelect`，然后才关面板。
所以这里的 `onSelect` 立刻返回，由一段轮询等面板离开 DOM 之后再开快门 ——
否则「保持窗口可见」会把选项面板一起冻进画面。轮询最多等 1.5 s，等不到也照拍。

## 自检

```powershell
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

## 出问题看这里

| 现象 | 原因 / 修法 |
| --- | --- |
| `+` 菜单里没有那一行 | bundle 没被组合。查 `bundles` 数组和 `node_modules` 的 junction，然后重启。 |
| 控制台里 `Screenshot failed` | 驱动报了错。跑上面的自检 —— 同一个脚本，会打印原因。 |
| 窗口一直藏着不出来 | 驱动被杀在半路。跑 `scripts\snip.ps1 -RestoreOnly -Record <那个 .parked 文件>`，或点任务栏里的 DSH。 |
| 截图里带上了选项面板 | 面板还没关完。刷新页面；客户端会先轮询等面板（上限 1.5 s）再拍。 |
| 选区比屏幕小一圈 | 机器报的是缩放后的虚拟屏，进程不是 DPI 感知的。`DshShot.cs` 在量尺寸之前会调 `SetProcessDpiAwarenessContext`；如果被外层剥掉了，照上面带 `-STA` 跑。 |
| 非 Windows 上没反应 | 正常，插件只支持 Windows。 |

## 平台与已知边界

- 只支持 Windows 10/11。
- 选区横跨整个虚拟屏，所以跨显示器能用，但不同 DPI 的显示器会被拉平到同一套坐标上。
- 标注只有一种颜色（红）的矩形；`Ctrl+Z` 只撤最后一笔。标注要按住 `Ctrl` 才能画，因为不按
  `Ctrl` 的框内拖拽留给了移动选区。
- 冻结帧是快照：选区开着的时候，后面别处变了不会反映。
- 「保持窗口可见」截的是当前屏幕上的一切，所以想截 DSH 自己得先把它切到前台。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
