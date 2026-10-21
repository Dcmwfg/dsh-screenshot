/**
 * Client half of the screenshot bundle.
 *
 * Entry point: a "Screenshot" row in the composer's "+" command menu. The row
 * opens a two-choice sheet (park this window first, or keep it), then asks the
 * host half for one capture.
 *
 * The selection UI is NOT here. It runs natively over the whole virtual desktop
 * (see scripts/DshShot.cs), because a DOM overlay can never leave the renderer
 * viewport: it can only ever offer a scaled-down picker confined to the app
 * window. The native form covers every monitor at 1:1 and does the framing,
 * the eight resize handles, the drag-to-move strip and the annotation toolbar
 * itself, so by the time this half sees pixels the crop is already final.
 *
 * The finished PNG is handed to the composer as a synthetic file drop, which is
 * the same path a real drag-and-drop takes: it uploads and previews like any
 * dropped image, and nothing is sent until the user submits.
 */
window.__ModuleLoader__.load({
  id: 'dsh-screenshot',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-screenshot'
    const ROW_NAME = 'shot'
    const ENDPOINT = '/dsh-shot/shot'
    const MODE_KEY = 'dsh-screenshot.mode'
    const MODES = ['hide', 'keep']

    /** The shell closes its command sheet only after onSelect resolves; poll for it. */
    const SHEET_CLOSE_TIMEOUT_MS = 1500
    const SHEET_PAINT_MS = 120

    /**
     * The desktop shell serves the page from dsh-app://app; a plain browser (the
     * web build, or the same build opened by hand) is on http(s). Only the shell
     * can be hidden and brought back, so the hide option is offered there alone:
     * in a browser the title match would hide whatever other window shares the
     * page title instead.
     */
    function inDesktopShell() {
      return typeof location !== 'undefined' && location.protocol === 'dsh-app:'
    }

    const zh = {
      command: '截图',
      commandHint: '全屏框选任意区域，可标注，把图片放进输入框',
      failed: '截图失败',
      restoreFailed: '窗口没能自动恢复，请点一下任务栏里的 DSH',
      hideLabel: '隐藏本窗口后截图',
      hideDetail: '截到后台的其它窗口',
      keepLabel: '保持窗口可见',
      keepDetail: '把 DSH 自己也留在画面里',
      webLabel: '开始框选屏幕',
      webDetail: '浏览器会留在画面里；要截别的窗口，先把浏览器挪开或缩到一边',
      searchPlaceholder: '选择截图方式',
      empty: '没有可选方式',
      noResults: '没有匹配的方式',
      shooting: '正在截图…',
      attachFailed: '图片没能放进输入框',
      unsupported: '这个界面不支持直接放图片',
    }

    const en = {
      command: 'Screenshot',
      commandHint: 'Frame any part of the screen, annotate it, and put the image in the composer',
      failed: 'Screenshot failed',
      restoreFailed: 'The window did not come back; click DSH on the taskbar.',
      hideLabel: 'Hide this window, then capture',
      hideDetail: 'Captures whatever is behind DSH',
      keepLabel: 'Keep this window visible',
      keepDetail: 'Leaves DSH itself in the picture',
      webLabel: 'Frame part of the screen',
      webDetail: 'The browser stays in the picture; move or shrink it first to reach other windows',
      searchPlaceholder: 'Pick a capture mode',
      empty: 'No capture modes',
      noResults: 'No matching mode',
      shooting: 'Capturing…',
      attachFailed: 'The image did not reach the composer',
      unsupported: 'This surface cannot take an image directly',
    }

    let t = (key) => key
    let busy = false
    let pending = false

    /** One remembered mode across restarts. */
    let mode = 'hide'
    try {
      const stored = window.localStorage.getItem(MODE_KEY)
      if (MODES.indexOf(stored) !== -1) mode = stored
    } catch (error) {
      // Storage can be blocked; the default still works.
    }

    // ---------------------------------------------------------------- store

    const watchers = new Set()
    let view = { phase: 'idle', error: '' }

    function publish(patch) {
      view = Object.assign({}, view, patch)
      watchers.forEach((fn) => {
        try {
          fn()
        } catch (error) {
          // a broken watcher must not stop the others
        }
      })
    }

    function subscribe(fn) {
      watchers.add(fn)
      return () => {
        watchers.delete(fn)
      }
    }

    function snapshot() {
      return view
    }

    // -------------------------------------------------------------- helpers

    function sleep(ms) {
      return new Promise((done) => {
        setTimeout(done, ms)
      })
    }

    function nextFrame() {
      return new Promise((done) => {
        if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(() => done())
        else setTimeout(done, 16)
      })
    }

    /**
     * True while the command sheet is still on screen. The anchor is the plug-in's
     * own placeholder text, so it survives the host renaming or hashing its class
     * names.
     */
    function sheetOpen() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return false
      const wanted = t('searchPlaceholder')
      const fields = document.querySelectorAll('input[placeholder]')
      for (let index = 0; index < fields.length; index += 1) {
        const node = fields[index]
        if (node && typeof node.getAttribute === 'function' && node.getAttribute('placeholder') === wanted) return true
      }
      return false
    }

    /** Wait for the sheet to be gone, then let the frame it was painting land. */
    async function waitForSheetGone() {
      const deadline = Date.now() + SHEET_CLOSE_TIMEOUT_MS
      await nextFrame()
      await nextFrame()
      while (sheetOpen() && Date.now() < deadline) await sleep(50)
      await nextFrame()
      await sleep(SHEET_PAINT_MS)
    }

    function stamp() {
      const now = new Date()
      const two = (value) => (value < 10 ? '0' + value : String(value))
      return (
        now.getFullYear() + two(now.getMonth() + 1) + two(now.getDate()) +
        '-' + two(now.getHours()) + two(now.getMinutes()) + two(now.getSeconds())
      )
    }

    function canDrop() {
      return typeof File === 'function' && typeof DataTransfer === 'function' && typeof DragEvent === 'function'
    }

    /** Turn the base64 payload back into a File the composer accepts. */
    function decodeFile(dataUrl, name) {
      const comma = dataUrl.indexOf(',')
      const raw = typeof atob === 'function' ? atob(dataUrl.slice(comma + 1)) : ''
      const bytes = new Uint8Array(raw.length)
      for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index)
      return new File([bytes], name, { type: 'image/png' })
    }

    /** Hand one file to the composer through its document-level drop target. */
    function dropIntoComposer(file) {
      const bag = new DataTransfer()
      bag.items.add(file)
      const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: bag })
      document.body.dispatchEvent(event)
    }

    // -------------------------------------------------------------- capture

    /**
     * Ask the host for one cropped PNG.
     * @param hideWindow - park this window so the desktop behind is on screen.
     */
    async function shoot(hideWindow) {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: document.title, hide: hideWindow !== false }),
      })
      const payload = await response.json().catch(() => null)
      if (payload === null) return { ok: false, reason: 'failed', message: '' }
      if (payload.ok !== true) {
        return {
          ok: false,
          reason: payload.reason === 'cancelled' ? 'cancelled' : 'failed',
          message: typeof payload.message === 'string' ? payload.message : '',
          restored: payload.restored,
        }
      }
      if (payload.restored === false) return { ok: false, reason: 'failed', message: t('restoreFailed') }
      if (typeof payload.dataUrl !== 'string' || payload.dataUrl === '') {
        return { ok: false, reason: 'failed', message: t('attachFailed') }
      }
      return { ok: true, payload }
    }

    /** Full flow: shoot, then put the finished crop in the composer. */
    async function beginCapture(hideWindow) {
      if (busy) return
      busy = true
      publish({ phase: 'shooting', error: '' })
      try {
        const result = await shoot(hideWindow)
        if (!result.ok) {
          publish({ phase: 'idle', error: result.message || '' })
          if (result.reason !== 'cancelled') {
            console.warn('[dsh-screenshot]', t('failed'), result.reason, result.message || '')
          }
          return
        }
        if (!canDrop()) {
          publish({ phase: 'idle', error: t('unsupported') })
          console.warn('[dsh-screenshot]', t('unsupported'))
          return
        }
        const file = decodeFile(result.payload.dataUrl, 'screenshot-' + stamp() + '.png')
        dropIntoComposer(file)
        publish({ phase: 'idle', error: '' })
      } catch (error) {
        const message = String(error && error.message ? error.message : error)
        publish({ phase: 'idle', error: message })
        console.warn('[dsh-screenshot]', t('failed'), error)
      } finally {
        busy = false
        pending = false
      }
    }

    // ----------------------------------------------------------------- glyphs

    function CameraIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M2 5.6h2.1l0.9-1.4h4l0.9 1.4H14v7H2z', strokeLinejoin: 'round' }),
        h('circle', { cx: 8, cy: 9, r: 2.3 }),
      )
    }

    function statusText() {
      if (view.phase === 'shooting') return t('shooting')
      return ''
    }

    return {
      // Both services are read through ctx, and cordis refuses a proxy property
      // that was not declared, so both are listed even though only locale is
      // spoken to directly here.
      inject: ['locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'screenshot.locale.zh')
        ctx.effect(() => ctx.locale.register(NS, 'en', en), 'screenshot.locale.en')
        const translate = ctx.locale.bind(NS)
        t = (key) => {
          const text = translate(key)
          return typeof text === 'string' && text !== '' ? text : key
        }

        ctx.inject(['commandUi'], (scope) => {
          const commands = scope.get('commandUi')
          scope.effect(
            () =>
              commands.register({
                name: ROW_NAME,
                label: () => (statusText() === '' ? t('command') : statusText()),
                description: () => t('commandHint'),
                icon: CameraIcon,
                available: () => !busy && !pending && view.phase === 'idle',
                ui: {
                  kind: 'popupSelect',
                  searchMode: 'substring',
                  searchLabels: () => ({
                    placeholder: t('searchPlaceholder'),
                    empty: t('empty'),
                    noResults: t('noResults'),
                  }),
                  // The shell calls .then on this, so it has to be a promise.
                  options: async () =>
                    inDesktopShell()
                      ? [
                          { id: 'hide', label: t('hideLabel'), detail: t('hideDetail'), active: mode === 'hide' },
                          { id: 'keep', label: t('keepLabel'), detail: t('keepDetail'), active: mode === 'keep' },
                        ]
                      : [{ id: 'keep', label: t('webLabel'), detail: t('webDetail'), active: true }],
                  // Must not await the capture: the shell closes the sheet only
                  // after this returns, and the shot has to happen with the
                  // sheet already gone.
                  onSelect: (option) => {
                    if (MODES.indexOf(option.id) === -1) return
                    mode = option.id
                    try {
                      window.localStorage.setItem(MODE_KEY, mode)
                    } catch (error) {
                      // the choice still applies for this run
                    }
                    if (pending) return
                    pending = true
                    const hideWindow = option.id === 'hide'
                    void waitForSheetGone().then(() => beginCapture(hideWindow))
                  },
                },
              }),
            'screenshot.command',
          )

          // The shell hard-codes its section table (add: file/goal/plan/feedback),
          // so a third-party row lands at the end of Commands. Lift this one up
          // next to "File" where a screenshot belongs.
          scope.effect(() => {
            if (typeof commands.candidates !== 'function') return
            const original = commands.candidates
            commands.candidates = async (session, request) => {
              const rows = await original.call(commands, session, request)
              if (!Array.isArray(rows) || request === undefined || request.query !== '') return rows
              const from = rows.findIndex((row) => row !== null && row.name === ROW_NAME)
              if (from === -1) return rows
              const anchor = rows.findIndex((row) => row !== null && row.name === 'file')
              const moved = rows.slice()
              const lifted = moved.splice(from, 1)[0]
              const section = rows[anchor === -1 ? 0 : anchor] === undefined ? undefined : rows[anchor === -1 ? 0 : anchor].section
              moved.splice(anchor === -1 ? 0 : anchor + 1, 0, Object.assign({}, lifted, { section }))
              return moved
            }
            return () => {
              delete commands.candidates
            }
          }, 'screenshot.command.section')
        })
      },
    }
  },
})
