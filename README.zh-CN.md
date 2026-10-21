# dsh-screenshot

**给 DeepSeek Harness 输入框用的区域截图插件。**

输入框 `+` 菜单里多一行。点它、选模式，DSH 窗口先让开，宿主那边拍一张桌面快照，
你在冻结的画面上拖出真正想要的区域、随手标注，按绿勾 —— PNG 就落进输入框，作为
**待发送的附件**，跟下一条消息一起发出去。

[English](README.md) | 中文

---

## 能得到什么

| 动作 | 结果 |
| --- | --- |
| 输入框 `+` → **截图** | 弹出两种模式的选项 |
| **隐藏本窗口后截图** | 先把 DSH 收走，截到它后面的东西 |
| **保持窗口可见** | DSH 留在屏幕上，截 DSH 自己 |
| 在冻结画面上拖 | 拉出选区 |
| 拖白色抓手 | 改选区大小（8 个抓手，最小 6×6） |
| 拖内侧窄边条，或按住 `Ctrl` 在框内任意处拖 | 平移选区 |
| 在框内拖 | 画一个矩形标注 |
| `Ctrl+Z` / ↶ 按钮 | 撤销最后一笔 |
| `Enter` / 绿勾 | 确认，把 PNG 放进输入框 |
| `Esc` / 红叉 / 右键 | 取消 |

选的模式记在 `localStorage` 的 `dsh-screenshot.mode` 里。

## 为什么要藏窗口

多数截图工具截的是「应用已经挡住的那块屏幕」。想给人看的东西偏偏在应用后面，就没辙。
这个插件把自己的窗口让开一次快门的时间，然后放回去：

```
点击  →  SW_MINIMIZE 收起 DSH 窗口  →  等合成器稳定
      →  BitBlt 把整个虚拟屏拷进一张位图
      →  SW_RESTORE + SetForegroundWindow        （写在 finally 里）
      →  浏览器覆盖层：在冻结帧上拖动 / 缩放 / 标注
      →  canvas 裁切 + 标注  →  一张 PNG  →  输入框草稿
```

这个形状带来两件事，都是故意的：

- **窗口只离开几毫秒。** 框选在之后、在页面里、在冻结的位图上做。没人需要在慢慢调矩形
  的时候一直让 DSH 藏着。
- **原生那半边没有界面。** 它只是一个快门，所以不存在两套选区控件互相同步的问题。

恢复写在 `finally` 里，所以失败或超时也照样把窗口拉回来。句柄事先写进记录文件，
`scripts\shutter.ps1 -RestoreOnly` 能在进程被杀之后兜底。

## 运行条件

- **Windows 10/11。** 隐藏窗口和拷贝桌面都是 Win32 调用，没有 macOS / Linux 路径。
- 一个把 `commandUi` 服务与 `webServer` + `connection` 宿主服务暴露出来的 DSH 桌面版
  （发行版桌面 profile 就是）。
- Windows PowerShell 5.1，系统自带。别的都不用装 —— C# 助手由 `Add-Type` 现场编译。

## 安装

插件就是一个普通的 DSH bundle：`package.json` + 宿主半（`index.js`）+ 客户端半
（`client.js`）+ `cordis.patch.yml` + `scripts/` 里的原生快门。

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
3. 拖出区域，用抓手调，想标注就标。
4. 按 `Enter` 或绿勾。
5. 图片出现在输入框上方，是草稿。打字回车才发出去。

提交之前什么都不发 —— 截图是附件，不是消息。

## 怎么搭的

| 半边 | 文件 | 干什么 |
| --- | --- | --- |
| 宿主 | `index.js` | `POST /dsh-shot/shot` → 起 PowerShell 跑 `scripts/shutter.ps1`，回一条 PNG data URL 加桌面原点。`GET /dsh-shot/ping` 是存活探针。 |
| 客户端 | `client.js` | 注册 `shot` 命令与两种模式，等选择面板消失，发请求，然后渲染负责裁切与标注的覆盖层。 |
| 原生 | `scripts/shutter.ps1` + `scripts/Snap.cs` | 藏窗口（可选）→ `BitBlt` 虚拟屏 → 存 PNG → 恢复。也能用 `-RestoreOnly` 按需恢复。 |

两条路由都过 `ctx.connection.requestRejection(req)`，继承宿主正常的请求策略，
不开没鉴权的洞。

### HTTP 面

| 路由 | 方法 | 请求体 | 回答 |
| --- | --- | --- | --- |
| `/dsh-shot/shot` | `POST` | `{"title": string, "hide": boolean}` | `{"ok":true,"dataUrl":"data:image/png;base64,…","width":W,"height":H,"left":X,"top":Y,"restored":true,"bytes":N}` 或 `{"ok":false,"reason":"failed","message":"…"}` |
| `/dsh-shot/ping` | `GET` | — | `{"ok":true,"driver":"…","shell":"…"}` |

请求体上限 4 KB，快门上限 180 s。`title` 拿去匹配窗口标题找要收起的那个窗口；
匹配不到就报错，不会去猜「反正最前面那个」。

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

# 拍一次，窗口不动：打印一行 JSON 并写出 PNG
powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass `
  -File scripts\shutter.ps1 -OutPath "$env:TEMP\shot.png" -Hide 0

# 收起窗口、拍照、放回去
powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass `
  -File scripts\shutter.ps1 -OutPath "$env:TEMP\shot2.png" -Hide 1 `
  -TitleFragment 'DeepSeek Harness' -Record "$env:TEMP\shot2.parked"

# 兜底：万一哪次被杀在半路
powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass `
  -File scripts\shutter.ps1 -RestoreOnly -Record "$env:TEMP\shot2.parked"
```

预期：一行 JSON 里 `"ok":true` 且尺寸是真实桌面（1080p 就是 1920×1080，不是被 DPI
缩过的 1536×864；快门开头先调 `SetProcessDPIAware`）。第二条命令里
`"restored":true` 表示窗口回来了。

## 出问题看这里

| 现象 | 原因 / 修法 |
| --- | --- |
| `+` 菜单里没有那一行 | bundle 没被组合。查 `bundles` 数组和 `node_modules` 的 junction，然后重启。 |
| 控制台里 `Screenshot failed` | 快门报了错。跑上面的自检 —— 同一个脚本，会打印原因。 |
| 窗口一直藏着不出来 | 快门被杀在半路。跑 `scripts\shutter.ps1 -RestoreOnly -Record <那个 .parked 文件>`，或点任务栏里的 DSH。 |
| 截图里带上了选项面板 | 面板还没关完。刷新页面；客户端会先轮询等面板（上限 1.5 s）再拍。 |
| 非 Windows 上没反应 | 正常，插件只支持 Windows。 |

## 平台与已知边界

- 只支持 Windows 10/11。
- 整个虚拟屏冻结成一张画布，所以跨显示器选区能用，但不同 DPI 的显示器会被拉平到
  同一套坐标上。
- 标注只有一种颜色（红）的矩形；`Ctrl+Z` 只撤最后一笔。
- 冻结帧是快照：覆盖层开着的时候，后面别处变了不会反映。
- 「保持窗口可见」截的是当前屏幕上的一切，所以想截 DSH 自己得先把它切到前台。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
