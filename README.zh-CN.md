# dsh-screenshot

**给 DeepSeek Harness 输入框用的区域截图。**

输入框 `+` 菜单里的一行。点它，DSH 窗口先让开，屏幕冻住，你在真正想截的东西上拖一个框，
想标注就画两笔，按绿勾——PNG 作为**待发送附件**落进输入框，跟下一条消息一起发出去。

[English](README.md) | 中文

---

## 能干什么

| 操作 | 结果 |
| --- | --- |
| 输入框 `+` → **截图** | 弹出两种模式 |
| **隐藏本窗口后截图** | 先把 DSH 藏起来，截到它背后的东西 |
| **保持窗口可见** | DSH 留在屏幕上，框 DSH 自己 |
| 在冻结画面上拖 | 拉出选区 |
| 拖白色手柄 | 改选区大小（八个手柄，最小 6×6） |
| 拖框内侧窄边条，或 `Ctrl` + 拖框内任意处 | 整体平移选区 |
| 在框内拖 | 画矩形标注 |
| `Ctrl+Z` / ↶ 按钮 | 撤销最后一笔 |
| `Enter` / 绿 ✓ | 确认，恢复窗口，PNG 进输入框 |
| `Esc` / 红 ✕ / 右键 | 取消，窗口照样回来 |

选过的模式记在 `localStorage` 的 `dsh-screenshot.mode` 里。

## 为什么非要隐藏

大多数截图工具只能截「它自己已经遮住的屏幕」——想给自己看的东西正好被它挡着，就没用了。
这个先把自家窗口藏起来，截完再放回去：

```
点击  →  SW_HIDE 藏掉 DSH 窗口  →  等合成器刷完
      →  冻结整个虚拟屏幕
      →  遮罩层：拖框 / 改大小 / 标注
      →  把裁切区域和标注合成成一张 PNG
      →  SW_RESTORE + SetForegroundWindow   （在 finally 里）
      →  data URL  →  合成一次 document drop  →  输入框草稿
```

恢复放在原生助手的 `finally` 块里，所以取消、出错也照样把窗口放回来。助手进程若被硬杀，
窗口句柄事先写了记录文件，`scripts/restore.ps1` 能兜底解开。

## 环境要求

- **Windows 10/11。** 藏窗口、抓屏、选区窗体全是 Win32 / WinForms 调用，没有 macOS 或 Linux 路径。
- DSH 桌面版本，输入框侧要有 `commandUi` 服务，宿主侧要有 `webServer` 和 `connection`
  （现在的桌面 profile 都满足）。
- Windows 自带 PowerShell 5.1，不用另装——C# 助手由 `Add-Type` 在运行时按需编译。

## 安装

插件就是一个普通 DSH bundle：`package.json` + 宿主半（`index.js`）+ 客户端半
（`client.js`）+ `cordis.patch.yml` + `scripts/` 里的原生助手。

1. 克隆到 profile 之外：

   ```powershell
   git clone https://github.com/Dcmwfg/dsh-screenshot.git E:\dsh-plugins\dsh-screenshot
   ```

2. 在 `<profile>/package.json`（Windows 上是
   `%USERPROFILE%\.dsh\profiles\desktop\package.json`）的依赖里加：

   ```json
   "dependencies": { "dsh-screenshot": "link:E:/dsh-plugins/dsh-screenshot" }
   ```

3. 同一个文件里把包名加进 bundles：

   ```json
   "dsh": { "profile": { "bundles": ["...", "dsh-screenshot"] } }
   ```

4. 链接进 profile 的 `node_modules`：

   ```powershell
   New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-screenshot" `
     -Target "E:\dsh-plugins\dsh-screenshot"
   ```

5. **重启 DSH。** bundle 在启动时组装；改完文件要下次启动才生效。

用 junction 而不是拷贝，意味着改动 checkout 后重启即生效。

## 用法

1. 打开输入框的 `+` 菜单。那行叫 **截图**，排在 **文件** 后面——宿主把 Add 段写死成
   `file/goal/plan/feedback`，其它贡献一律丢进 Commands 段，所以插件自己重排了一次，
   让这一行挨着「文件」。
2. 选模式。选择器记住上次那次。
3. 拖出选区，用手柄调整，想标注就画。
4. 按 `Enter` 或点绿勾。
5. 图片出现在输入框上方作为草稿。打字、回车就发出去了。

发之前什么都没发出去——截图是附件，不是消息。

## 结构

| 半边 | 文件 | 干什么 |
| --- | --- | --- |
| 宿主 | `index.js` | `POST /dsh-screenshot/snip` → 起 PowerShell 跑 `scripts/snip.ps1`，回一条 PNG data URL。`GET /dsh-screenshot/ping` 是存活探针。 |
| 客户端 | `client.js` | 注册 `shot` 命令和两种模式；等选择面板关掉再发截图请求；把 PNG 交给输入框。 |
| 原生 | `scripts/snip.ps1` + `scripts/DshShot.cs` | 藏窗口（可选）→ 冻结 → 选区窗体 → 合成 → 存 PNG → 恢复。 |
| 兜底 | `scripts/restore.ps1` | 按记录里的句柄把窗口解藏回来。 |

两条路由都过 `ctx.connection.requestRejection(req)`，走宿主正常的请求策略，不开认证口子。

### HTTP 接口

| 路由 | 方法 | 请求体 | 返回 |
| --- | --- | --- | --- |
| `/dsh-screenshot/snip` | `POST` | `{"title": string, "hide": boolean}` | `{"ok":true,"dataUrl":"data:image/png;base64,…","width":W,"height":H,"bytes":N}`，或 `{"ok":false,"reason":"cancelled"\|"failed","message":"…"}` |
| `/dsh-screenshot/ping` | `GET` | — | `{"ok":true,"powershell":"…","scripts":"…"}` |

请求体上限 8 KB，助手超时 180 秒。

### 为什么用合成 drop 事件

输入框收文件走的是 `dsh-client-ui-attachment` 装的 document 级 drop 监听
（`installDocumentDropEvents`）。派发一次带真 `DataTransfer` 的 `DragEvent('drop')`，
就和真人拖拽走完全相同的上传与预览路径，不用碰那些每个版本都在动的输入框内部 API。

## 自检

```powershell
node --check index.js
node --check client.js

# 不碰鼠标跑完整原生链路：隐藏 → 固定区域截图 → 恢复
powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass `
  -File scripts\snip.ps1 -OutPath "$env:TEMP\shot.png" `
  -AutoSelect '100,100,800,450' -TitleFragment 'DeepSeek Harness' -TimeoutSeconds 20

# 同一条链路，但不隐藏窗口
powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass `
  -File scripts\snip.ps1 -OutPath "$env:TEMP\shot2.png" `
  -AutoSelect '0,0,640,360' -HideWindow 0 -TimeoutSeconds 20
```

预期输出一条 JSON：`{"ok":true,…,"width":800,"height":450}`。第一次跑完 DSH 窗口回来了
（`IsWindowVisible` 真、`IsIconic` 假）；第二次跑窗口全程没动。

## 排错

| 现象 | 原因 / 解法 |
| --- | --- |
| `+` 菜单里没有这一行 | bundle 没被组装。检查 `bundles` 数组和 `node_modules` 的 junction，然后重启。 |
| 控制台报 `Screenshot failed` | 助手打印了错误。跑上面的自检——同一个脚本，会告诉你原因。 |
| 窗口一直藏着不出来 | 助手截到一半被杀。跑 `scripts\restore.ps1 -TargetFile <错误里那个 .hwnd 文件>`，或点任务栏里的 DSH。 |
| 截图里带着选择面板 | 模式选择面板没关完。刷新页面；客户端发请求前会轮询面板消失（上限 1.5 秒）。 |
| 非 Windows 上什么也不发生 | 预期如此——只支持 Windows。 |

## 平台与已知边界

- 仅 Windows 10/11。
- 整个虚拟屏当一张画布冻结，多显示器能跨屏框选，但 DPI 不一致的显示器会被拉平到同一套坐标。
- 标注只有一种颜色（红）的矩形；`Ctrl+Z` 只撤最后一笔。`DshShot.cs` 里有画箭头的
  实现，但工具栏还没有按钮去选它。
- 冻结帧是快门那一刻的画面，拖框期间背后的东西变了不会反映。
- 「保持窗口可见」截的就是当前屏幕，想框 DSH 自己得先把 DSH 切到前台。
- 工具栏三个图标是代码画的路径，不走字体——所以撤销、勾、叉的笔画粗细和重心是一致的。

## 许可

MIT，见 [LICENSE](LICENSE)。
